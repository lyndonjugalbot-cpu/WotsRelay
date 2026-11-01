# ADR 0004 — Mobile gateway: pinned self-signed TLS, single-use pairing, allowlisted RPC

Status: accepted · 2026-11-01

## Context
The iPhone companion must follow and steer runner sessions from another device. The local Unix socket is user-only and must stay that way (ADR 0001). Spec §7 requires single-use pairing codes with a 2-minute expiry and rate limiting.

## Decision
- The runner hosts an optional HTTPS + WebSocket gateway (`apps/runner/src/server/gateway.ts`). **Off by default**; `wots gateway enable [--host] [--port]` turns it on. It binds to one address (default: the Mac's first LAN IPv4; a Tailscale IP works too). The setting persists, and the gateway restarts with the runner. If it fails to bind, the runner logs the error and keeps running.
- **TLS 1.3 with a self-signed P-256 certificate** generated once per runner home (`gateway/`, dir 0700, key 0600) via `openssl`. The phone **pins the certificate's SHA-256 fingerprint**, which arrives in the pairing link. No public CA, no hostname trust.
- **Pairing:** `wots gateway pair` (local socket only) issues a 128-bit code and a link `wotsrelay://pair?host=&port=&code=&fp=`. `POST /v1/pair {code, deviceName}` consumes the code with an atomic compare-and-set (single use, not after expiry). It returns a device id and a 256-bit bearer token (`wotsd_…`). Only the token's sha256 is stored; listings never include it, and `redact()` masks the prefix.
- **Rate limit:** 5 failed pair/auth attempts per remote address per 60 s. When blocked, even a valid code is refused (HTTP 429 / close 4429).
- **WebSocket `/v1/ws`:** the first frame must be `auth {deviceId, token}` within 10 s, or the socket closes with 4401. After that, frames use the same JSON-RPC envelope as the local socket and go through the same handlers, broadcast and replay-by-cursor.
- **Allowlist (`MOBILE_METHODS`):** a phone can read sessions and events, create sessions, send messages, interrupt/resume runs, decide approvals, and read fallback settings and exports. Runner control, project registration, fallback/consent changes, and gateway/device management are local-only and answer `unknown_method`.
- **Identity:** `approvals.decide` from a device is attributed to the authenticated device id. Any `deviceId` the client sends is ignored.
- **Revocation:** `wots devices revoke <id>` marks the device revoked and closes its live sockets at once with 4401. Every later frame is re-checked as well.
- Limits: 16 sockets, 1 MB frames, 4 KB pair bodies. A client that stops reading and buffers more than 8 MB is dropped; it recovers by replaying from its cursor. Pings every 30 s.

## Consequences
- The phone app must pin the fingerprint (custom trust evaluation). A stock RN `WebSocket` with system trust will reject the cert, by design.
- Reaching the Mac from outside the LAN needs the user's own VPN (e.g. Tailscale). There is no relay service.
- Open items: certificate rotation command, QR rendering in the desktop app, push notifications for approvals.
