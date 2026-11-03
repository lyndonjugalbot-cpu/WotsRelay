import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:https';
import { isIP, type AddressInfo, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { z } from 'zod';
import { MAX_FRAME_BYTES, PROTOCOL_VERSION, RpcRequest, type RpcResponse } from '@wots/protocol';
import { constantTimeEqualHex, newDeviceToken, newId, newPairingCode, PAIRING_TTL_MS, sha256 } from '@wots/security';
import type { Store } from '@wots/storage';
import { RelayError } from '../sessions/controller.ts';
import type { RpcServer } from './rpc.ts';

// What a paired phone may do: read sessions, send messages, steer runs and decide approvals.
// Runner control, project registration, fallback/consent settings and device management stay local.
export const MOBILE_METHODS: ReadonlySet<string> = new Set([
  'runner.status',
  'connections.list',
  'models.list',
  'projects.list',
  'sessions.create',
  'sessions.list',
  'sessions.get',
  'messages.send',
  'runs.interrupt',
  'runs.resume',
  'approvals.decide',
  'events.list',
  'events.subscribe',
  'events.unsubscribe',
  'fallback.get',
  'usage.get',
  'export',
]);

export const GatewayConfig = z.object({
  enabled: z.boolean().default(false),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(7443),
});
export type GatewayConfig = z.infer<typeof GatewayConfig>;
export const GatewayPatch = z.strictObject({ enabled: z.boolean(), host: z.string().min(1), port: z.number().int().min(0).max(65535) }).partial();

const PairBody = z.object({
  code: z.string().min(1).max(64),
  deviceName: z
    .string()
    .max(64)
    .transform((s) => s.replace(/[\p{Cc}\p{Cf}]/gu, '').trim())
    .pipe(z.string().min(1)),
});
const AuthParams = z.object({ deviceId: z.string().max(64), token: z.string().max(128) });

const MAX_SOCKETS = 16;
const MAX_BODY_BYTES = 4096;
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED_BYTES = 8 * MAX_FRAME_BYTES; // a phone that stops reading is dropped and replays by cursor
export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_RATE_LIMITED = 4429;

// Failed pairing/auth attempts per remote address within a sliding window.
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  blocked(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent.length >= this.max;
  }

  fail(key: string, now = Date.now()): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
  }
}

export function lanAddress(): string | null {
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

// Self-signed identity created once per runner home. The phone pins its SHA-256 fingerprint at
// pairing, so no public CA or hostname is involved.
export function ensureIdentity(dir: string, host: string): { key: string; cert: string; fingerprint: string } {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...(isIP(host) && host !== '0.0.0.0' && host !== '127.0.0.1' ? [`IP:${host}`] : [])].join(',');
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '825', '-subj', '/CN=WotsRelay runner', '-addext', `subjectAltName=${san}`, '-keyout', keyPath, '-out', certPath],
      { stdio: 'ignore' },
    );
    chmodSync(keyPath, 0o600);
  }
  const cert = readFileSync(certPath, 'utf8');
  return { key: readFileSync(keyPath, 'utf8'), cert, fingerprint: new X509Certificate(cert).fingerprint256 };
}

type DeviceSocket = { ws: WebSocket; deviceId: string };

export class Gateway {
  private readonly store: Store;
  private readonly rpc: RpcServer;
  private readonly dir: string;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private readonly sockets = new Set<DeviceSocket>();
  private readonly limiter = new FailureLimiter(5, 60_000);
  private identity: { cert: string; fingerprint: string } | null = null;
  private bound: { host: string; port: number } | null = null;

  constructor(opts: { store: Store; rpc: RpcServer; dir: string }) {
    this.store = opts.store;
    this.rpc = opts.rpc;
    this.dir = opts.dir;
  }

  config(): GatewayConfig {
    return GatewayConfig.parse(this.store.getSetting('gateway', {}));
  }

  status() {
    const cfg = this.config();
    return {
      ...cfg,
      listening: this.bound,
      fingerprint: this.identity?.fingerprint ?? null,
      connectedDevices: [...new Set([...this.sockets].map((s) => s.deviceId))],
    };
  }

  async configure(patch: Partial<GatewayConfig>) {
    const cfg = GatewayConfig.parse({ ...this.config(), ...patch });
    this.store.setSetting('gateway', cfg);
    await this.stop();
    if (cfg.enabled) await this.start();
    return this.status();
  }

  async start(): Promise<void> {
    const cfg = this.config();
    if (!cfg.enabled || this.server) return;
    const id = ensureIdentity(this.dir, cfg.host);
    this.identity = { cert: id.cert, fingerprint: id.fingerprint };
    const server = createServer({ key: id.key, cert: id.cert, minVersion: 'TLSv1.3' }, (req, res) => void this.http(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      if (new URL(req.url ?? '/', 'https://x').pathname !== '/v1/ws' || this.sockets.size >= MAX_SOCKETS || this.limiter.blocked(remote(req))) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, remote(req)));
    });
    server.on('tlsClientError', (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(cfg.port, cfg.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    const addr = server.address() as AddressInfo;
    this.bound = { host: cfg.host, port: addr.port };
    this.server = server;
    this.wss = wss;
    this.heartbeat = setInterval(() => {
      for (const s of this.sockets) {
        const w = s.ws as WebSocket & { alive?: boolean };
        if (w.alive === false) w.terminate();
        else {
          w.alive = false;
          w.ping();
        }
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const s of this.sockets) s.ws.terminate();
    this.sockets.clear();
    this.wss?.close();
    this.wss = null;
    const server = this.server;
    this.server = null;
    this.bound = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  // Issued over the local socket only. The URI carries everything the phone needs, including
  // the certificate fingerprint it must pin.
  pair(): { code: string; expiresAt: string; host: string; port: number; fingerprint: string; uri: string } {
    if (!this.bound || !this.identity) throw new RelayError('gateway_disabled', 'Enable the gateway first: wots gateway enable');
    const host = this.bound.host === '0.0.0.0' ? (lanAddress() ?? '127.0.0.1') : this.bound.host;
    const { code, hash } = newPairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.store.insertPairingCode(hash, host, expiresAt);
    const q = new URLSearchParams({ host, port: String(this.bound.port), code, fp: this.identity.fingerprint });
    return { code, expiresAt: new Date(expiresAt).toISOString(), host, port: this.bound.port, fingerprint: this.identity.fingerprint, uri: `wotsrelay://pair?${q}` };
  }

  revoke(deviceId: string): { revoked: boolean } {
    const revoked = this.store.revokeDevice(deviceId);
    for (const s of this.sockets) if (s.deviceId === deviceId) s.ws.close(CLOSE_UNAUTHORIZED, 'revoked');
    return { revoked };
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? '/', 'https://x').pathname;
    if (req.method === 'GET' && path === '/v1/health') return reply(200, { ok: true, v: PROTOCOL_VERSION });
    if (req.method !== 'POST' || path !== '/v1/pair') return reply(404, { error: 'not_found' });

    const who = remote(req);
    if (this.limiter.blocked(who)) return reply(429, { error: 'rate_limited' });
    let body: z.infer<typeof PairBody>;
    try {
      body = PairBody.parse(JSON.parse(await readBody(req, MAX_BODY_BYTES)));
    } catch {
      this.limiter.fail(who);
      return reply(400, { error: 'invalid_request' });
    }
    if (!this.store.consumePairingCode(sha256(body.code))) {
      this.limiter.fail(who);
      return reply(401, { error: 'invalid_code' });
    }
    const { token, hash } = newDeviceToken();
    const deviceId = newId('dev');
    this.store.insertDevice({ id: deviceId, name: body.deviceName, tokenHash: hash, createdAt: new Date().toISOString(), lastSeenAt: null });
    reply(201, { deviceId, token, v: PROTOCOL_VERSION });
  }

  // First frame must authenticate; nothing else is dispatched until it does.
  private accept(ws: WebSocket, who: string): void {
    const timer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'auth timeout'), AUTH_TIMEOUT_MS);
    ws.once('message', (data: RawData, isBinary: boolean) => {
      clearTimeout(timer);
      let id: string | number = 0;
      try {
        const req = RpcRequest.parse(JSON.parse(isBinary ? '' : data.toString()));
        id = req.id;
        if (req.method !== 'auth') throw new Error('auth required');
        const { deviceId, token } = AuthParams.parse(req.params);
        const d = this.store.getDevice(deviceId);
        if (!d || d.revokedAt || !constantTimeEqualHex(sha256(token), d.tokenHash)) throw new Error('bad credentials');
        this.bind(ws, deviceId);
        this.store.touchDevice(deviceId);
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, result: { deviceId, v: PROTOCOL_VERSION } } satisfies RpcResponse));
      } catch {
        this.limiter.fail(who);
        ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, error: { code: 'unauthorized', message: 'Unauthorized' } } satisfies RpcResponse));
        ws.close(this.limiter.blocked(who) ? CLOSE_RATE_LIMITED : CLOSE_UNAUTHORIZED, 'unauthorized');
      }
    });
    ws.on('error', () => ws.terminate());
  }

  private bind(ws: WebSocket, deviceId: string): void {
    const entry = { ws, deviceId };
    this.sockets.add(entry);
    (ws as WebSocket & { alive?: boolean }).alive = true;
    ws.on('pong', () => ((ws as WebSocket & { alive?: boolean }).alive = true));
    const conn = {
      id: this.rpc.newConnectionId(),
      subscriptions: new Set<string>(),
      deviceId,
      allow: MOBILE_METHODS,
      send: (obj: unknown) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.terminate();
        else ws.send(JSON.stringify(obj));
      },
      close: () => ws.terminate(),
    };
    const detach = this.rpc.attach(conn);
    ws.on('message', (data: RawData, isBinary: boolean) => {
      // A device revoked from another path loses access on its next frame at the latest.
      if (isBinary || this.store.getDevice(deviceId)?.revokedAt) return ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
      void this.rpc.dispatch(data.toString(), conn);
    });
    ws.on('close', () => {
      detach();
      this.sockets.delete(entry);
    });
  }
}

function remote(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
