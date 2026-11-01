import CryptoKit
import ExpoModulesCore
import Foundation

// The runner's gateway uses a self-signed certificate. The phone trusts it only if its SHA-256
// matches the fingerprint delivered in the pairing link (ADR 0004); system trust is never used,
// so a CA-issued certificate for the same address is refused too.
class PinnedTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
  private let expected: String

  init(fingerprint: String) {
    expected = PinnedTrust.normalize(fingerprint)
  }

  static func normalize(_ fp: String) -> String {
    fp.uppercased().filter { $0.isHexDigit }
  }

  static func fingerprint(of trust: SecTrust) -> String? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
    let der = SecCertificateCopyData(leaf) as Data
    return SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined()
  }

  private func evaluate(_ challenge: URLAuthenticationChallenge, _ done: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
          let trust = challenge.protectionSpace.serverTrust,
          let actual = PinnedTrust.fingerprint(of: trust),
          !expected.isEmpty, actual == expected
    else {
      done(.cancelAuthenticationChallenge, nil)
      return
    }
    done(.useCredential, URLCredential(trust: trust))
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    evaluate(challenge, completionHandler)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    evaluate(challenge, completionHandler)
  }
}

// One pinned WebSocket. Events go back to JS tagged with the socket id.
final class PinnedSocket: PinnedTrust, URLSessionWebSocketDelegate {
  let id: String
  private weak var module: WotsPinnedModule?
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var closed = false

  init(id: String, url: URL, fingerprint: String, module: WotsPinnedModule) {
    self.id = id
    self.module = module
    super.init(fingerprint: fingerprint)
    let config = URLSessionConfiguration.ephemeral
    config.waitsForConnectivity = false
    config.timeoutIntervalForRequest = 15
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    self.session = session
    let task = session.webSocketTask(with: url)
    task.maximumMessageSize = 4_000_000
    self.task = task
    task.resume()
    receive()
  }

  private func receive() {
    task?.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(.string(let text)):
        self.module?.sendEvent("onSocketMessage", ["id": self.id, "data": text])
        self.receive()
      case .success(.data(let data)):
        self.module?.sendEvent("onSocketMessage", ["id": self.id, "data": String(decoding: data, as: UTF8.self)])
        self.receive()
      case .success:
        self.receive()
      case .failure(let error):
        self.finish(code: 1006, reason: error.localizedDescription)
      }
    }
  }

  func send(_ text: String) {
    task?.send(.string(text)) { [weak self] error in
      if let error, let self { self.finish(code: 1006, reason: error.localizedDescription) }
    }
  }

  func close(code: Int) {
    task?.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: nil)
  }

  private func finish(code: Int, reason: String) {
    if closed { return }
    closed = true
    module?.sendEvent("onSocketClose", ["id": id, "code": code, "reason": reason])
    session?.invalidateAndCancel()
    module?.forget(id)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    module?.sendEvent("onSocketOpen", ["id": id])
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    finish(code: closeCode.rawValue, reason: reason.map { String(decoding: $0, as: UTF8.self) } ?? "")
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // A cancelled pin check surfaces here as a failed handshake.
    finish(code: 1015, reason: error?.localizedDescription ?? "connection ended")
  }
}

public class WotsPinnedModule: Module {
  private var sockets: [String: PinnedSocket] = [:]
  private let lock = NSLock()

  func forget(_ id: String) {
    lock.lock()
    sockets[id] = nil
    lock.unlock()
  }

  public func definition() -> ModuleDefinition {
    Name("WotsPinned")

    Events("onSocketOpen", "onSocketMessage", "onSocketClose")

    // One HTTPS request (used for pairing). Resolves with status and body; rejects on a pin mismatch.
    AsyncFunction("request") { (url: String, method: String, body: String?, fingerprint: String, promise: Promise) in
      guard let target = URL(string: url), target.scheme == "https" else {
        promise.reject("ERR_URL", "Only https URLs are allowed")
        return
      }
      var req = URLRequest(url: target, timeoutInterval: 15)
      req.httpMethod = method
      if let body {
        req.httpBody = Data(body.utf8)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      let trust = PinnedTrust(fingerprint: fingerprint)
      let session = URLSession(configuration: .ephemeral, delegate: trust, delegateQueue: nil)
      session.dataTask(with: req) { data, response, error in
        defer { session.finishTasksAndInvalidate() }
        if let error {
          promise.reject("ERR_REQUEST", error.localizedDescription)
          return
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        promise.resolve(["status": status, "body": String(decoding: data ?? Data(), as: UTF8.self)])
      }.resume()
    }

    Function("connect") { (id: String, url: String, fingerprint: String) in
      guard let target = URL(string: url), target.scheme == "wss" else { throw Exception(name: "ERR_URL", description: "Only wss URLs are allowed") }
      let socket = PinnedSocket(id: id, url: target, fingerprint: fingerprint, module: self)
      self.lock.lock()
      self.sockets[id] = socket
      self.lock.unlock()
    }

    Function("send") { (id: String, text: String) in
      self.lock.lock()
      let socket = self.sockets[id]
      self.lock.unlock()
      socket?.send(text)
    }

    Function("close") { (id: String, code: Int) in
      self.lock.lock()
      let socket = self.sockets[id]
      self.lock.unlock()
      socket?.close(code: code)
    }
  }
}
