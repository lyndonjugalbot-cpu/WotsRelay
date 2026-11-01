// Phone-side client for the runner gateway (ADR 0004). No React Native imports: the app plugs in
// the pinned native transport, tests plug in Node's `ws`.
import type { EventEnvelope } from '../../../../packages/protocol/src/index.ts';

export interface Pairing {
  host: string;
  port: number;
  fingerprint: string;
  deviceId: string;
  token: string;
}

export interface PairingLink {
  host: string;
  port: number;
  code: string;
  fingerprint: string;
}

export interface TransportHandlers {
  onOpen(): void;
  onMessage(text: string): void;
  onClose(code: number, reason: string): void;
}

export interface Transport {
  open(url: string, fingerprint: string, h: TransportHandlers): { send(text: string): void; close(code: number): void };
  request(url: string, method: 'GET' | 'POST', body: string | null, fingerprint: string): Promise<{ status: number; body: string }>;
}

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'revoked';

export class RelayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const CLOSE_UNAUTHORIZED = 4401;
export const CLOSE_RATE_LIMITED = 4429;

// `wotsrelay://pair?host=…&port=…&code=…&fp=…` as printed by `wots gateway pair`.
export function parsePairingLink(link: string): PairingLink {
  let u: URL;
  try {
    u = new URL(link.trim());
  } catch {
    throw new RelayError('bad_link', 'That is not a WotsRelay pairing link.');
  }
  const q = u.searchParams;
  const host = q.get('host');
  const port = Number(q.get('port'));
  const code = q.get('code');
  const fingerprint = q.get('fp');
  if (u.protocol !== 'wotsrelay:' || !host || !code || !fingerprint || !Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new RelayError('bad_link', 'That is not a WotsRelay pairing link. On your Mac run: wots gateway pair');
  }
  return { host, port, code, fingerprint };
}

const base = (host: string, port: number) => `${host.includes(':') ? `[${host}]` : host}:${port}`;

// Exchanges a single-use code for this device's token. The certificate is pinned from the link.
export async function pairDevice(transport: Transport, link: PairingLink, deviceName: string): Promise<Pairing> {
  const res = await transport.request(`https://${base(link.host, link.port)}/v1/pair`, 'POST', JSON.stringify({ code: link.code, deviceName }), link.fingerprint);
  if (res.status === 401) throw new RelayError('invalid_code', 'This pairing link was already used or has expired. On your Mac run: wots gateway pair');
  if (res.status === 429) throw new RelayError('rate_limited', 'Too many attempts. Wait a minute and try again.');
  if (res.status !== 201) throw new RelayError('pair_failed', `Pairing failed (HTTP ${res.status}).`);
  const body = JSON.parse(res.body) as { deviceId: string; token: string };
  return { host: link.host, port: link.port, fingerprint: link.fingerprint, deviceId: body.deviceId, token: body.token };
}

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

export interface RelayClientOptions {
  // Delay before reconnect attempt n (1-based).
  backoffMs?: (attempt: number) => number;
  callTimeoutMs?: number;
}

const defaultBackoff = (n: number) => Math.min(30_000, 500 * 2 ** Math.min(n - 1, 6));

// One authenticated connection that survives drops: it re-authenticates, then re-subscribes each
// session from the last event it saw, so nothing is missed or shown twice.
export class RelayClient {
  state: ConnectionState = 'offline';
  private readonly pairing: Pairing;
  private readonly transport: Transport;
  private readonly backoff: (n: number) => number;
  private readonly callTimeoutMs: number;
  private socket: { send(text: string): void; close(code: number): void } | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly cursors = new Map<string, number>();
  private readonly eventListeners = new Set<(e: EventEnvelope) => void>();
  private readonly stateListeners = new Set<(s: ConnectionState) => void>();
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private waiters: Array<() => void> = [];

  constructor(pairing: Pairing, transport: Transport, opts: RelayClientOptions = {}) {
    this.pairing = pairing;
    this.transport = transport;
    this.backoff = opts.backoffMs ?? defaultBackoff;
    this.callTimeoutMs = opts.callTimeoutMs ?? 20_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.close(1000);
    this.socket = null;
    this.setState('offline');
  }

  onEvent(fn: (e: EventEnvelope) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  // Waits for the connection (up to the call timeout) instead of failing while reconnecting.
  async call<T>(method: string, params: unknown = {}): Promise<T> {
    if (this.state === 'revoked') throw new RelayError('revoked', 'This phone is no longer paired.');
    if (this.state !== 'online') await this.whenOnline();
    return this.rawCall<T>(method, params);
  }

  // Replays everything after `after` (or after what this client already saw), then streams live.
  async subscribe(sessionId: string, after = 0): Promise<void> {
    const from = Math.max(after, this.cursors.get(sessionId) ?? 0);
    this.cursors.set(sessionId, from);
    if (this.state === 'online') await this.resubscribe(sessionId);
  }

  async unsubscribe(sessionId: string): Promise<void> {
    this.cursors.delete(sessionId);
    if (this.state === 'online') await this.rawCall('events.unsubscribe', { sessionId }).catch(() => {});
  }

  private connect(): void {
    this.setState('connecting');
    const url = `wss://${base(this.pairing.host, this.pairing.port)}/v1/ws`;
    let opened = false;
    this.socket = this.transport.open(url, this.pairing.fingerprint, {
      onOpen: () => {
        opened = true;
        void this.authenticate();
      },
      onMessage: (text) => this.handle(text),
      onClose: (code) => {
        this.socket = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new RelayError('offline', 'Connection to your Mac was lost.'));
          this.pending.delete(id);
        }
        if (code === CLOSE_UNAUTHORIZED) {
          this.stopped = true;
          this.setState('revoked');
          return;
        }
        if (this.stopped) return;
        this.setState('offline');
        this.attempts = opened ? 1 : this.attempts + 1;
        const delay = code === CLOSE_RATE_LIMITED ? 60_000 : this.backoff(this.attempts);
        this.retryTimer = setTimeout(() => this.connect(), delay);
      },
    });
  }

  private async authenticate(): Promise<void> {
    try {
      await this.rawCall('auth', { deviceId: this.pairing.deviceId, token: this.pairing.token });
    } catch {
      return; // the gateway closes the socket; onClose decides what happens next
    }
    this.attempts = 0;
    this.setState('online');
    for (const sessionId of this.cursors.keys()) await this.resubscribe(sessionId).catch(() => {});
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  private async resubscribe(sessionId: string): Promise<void> {
    const { replay } = await this.rawCall<{ replay: EventEnvelope[] }>('events.subscribe', { sessionId, after: this.cursors.get(sessionId) ?? 0 });
    for (const e of replay) this.deliver(e);
  }

  private deliver(e: EventEnvelope): void {
    const key = this.cursors.has(e.sessionId) ? e.sessionId : this.cursors.has('*') ? '*' : null;
    if (key === e.sessionId) {
      if (e.seq <= (this.cursors.get(key) ?? 0)) return; // already seen
      this.cursors.set(key, e.seq);
    }
    for (const fn of this.eventListeners) fn(e);
  }

  private handle(text: string): void {
    let msg: { id?: number; result?: unknown; error?: { code: string; message: string }; method?: string; params?: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.method === 'event' && msg.params) return this.deliver(msg.params as EventEnvelope);
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new RelayError(msg.error.code, msg.error.message));
    else p.resolve(msg.result);
  }

  private rawCall<T>(method: string, params: unknown): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new RelayError('offline', 'Not connected to your Mac.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError('timeout', `${method} timed out`));
      }, this.callTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      socket.send(JSON.stringify({ v: 1, id, method, params }));
    });
  }

  private whenOnline(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new RelayError('offline', 'Your Mac is not reachable. Is it awake, with phone access on (wots gateway enable)?'));
      }, this.callTimeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  private setState(s: ConnectionState): void {
    if (this.state === s) return;
    this.state = s;
    for (const fn of this.stateListeners) fn(s);
  }
}
