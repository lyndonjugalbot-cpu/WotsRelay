import { X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mockPair } from '@wots/adapter-mock';
import type { EventEnvelope, Session } from '@wots/protocol';
import { RunnerClient, startRunner } from '@wots/runner';
import { redact } from '@wots/security';
import { Store } from '@wots/storage';
import { FailureLimiter } from '../../apps/runner/src/server/gateway.ts';
import { tempDir, tempRepo } from '../helpers.ts';

type Pairing = { code: string; host: string; port: number; fingerprint: string; uri: string };

async function withGateway(scenario: string, fn: (ctx: { home: string; local: RunnerClient; port: number; ca: string; pairing: () => Promise<Pairing> }) => Promise<void>) {
  const home = tempDir('wg-');
  const runner = await startRunner({ home, adapters: () => mockPair(scenario), refreshOnStart: false });
  const local = await new RunnerClient(runner.paths.socket).connect();
  try {
    const st = await local.call<{ listening: { port: number } }>('gateway.configure', { enabled: true, host: '127.0.0.1', port: 0 });
    const ca = readFileSync(join(home, 'gateway', 'cert.pem'), 'utf8');
    await fn({ home, local, port: st.listening.port, ca, pairing: () => local.call<Pairing>('gateway.pair') });
  } finally {
    local.close();
    await runner.stop();
  }
}

function post(port: number, ca: string, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', ca, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

// Minimal phone: one JSON frame per message, same envelope as the local socket.
class Phone {
  readonly ws: WebSocket;
  readonly events: EventEnvelope[] = [];
  closed: Promise<number>;
  private next = 1;
  private readonly pending = new Map<number, (m: { result?: unknown; error?: { code: string } }) => void>();

  constructor(port: number, ca: string) {
    this.ws = new WebSocket(`wss://127.0.0.1:${port}/v1/ws`, { ca });
    this.closed = new Promise((r) => this.ws.on('close', (code) => r(code)));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.method === 'event') this.events.push(m.params);
      else this.pending.get(m.id)?.(m);
    });
  }

  open(): Promise<this> {
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve(this));
      this.ws.once('error', reject);
    });
  }

  call(method: string, params: unknown = {}): Promise<{ result?: any; error?: { code: string } }> {
    const id = this.next++;
    return new Promise((r) => {
      this.pending.set(id, r);
      this.ws.send(JSON.stringify({ v: 1, id, method, params }));
    });
  }
}

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

async function pairPhone(ctx: { port: number; ca: string; pairing: () => Promise<Pairing> }) {
  const p = await ctx.pairing();
  const res = await post(ctx.port, ctx.ca, '/v1/pair', { code: p.code, deviceName: 'Test iPhone' });
  expect(res.status).toBe(201);
  const phone = await new Phone(ctx.port, ctx.ca).open();
  const auth = await phone.call('auth', { deviceId: res.body.deviceId, token: res.body.token });
  expect(auth.result).toMatchObject({ deviceId: res.body.deviceId });
  return { phone, deviceId: res.body.deviceId as string, token: res.body.token as string };
}

describe('mobile gateway', () => {
  it('is off by default and refuses to issue pairing codes', async () => {
    const home = tempDir('wg-');
    const runner = await startRunner({ home, adapters: () => mockPair('success'), refreshOnStart: false });
    const local = await new RunnerClient(runner.paths.socket).connect();
    try {
      expect(await local.call('gateway.status')).toMatchObject({ enabled: false, listening: null });
      await expect(local.call('gateway.pair')).rejects.toMatchObject({ code: 'gateway_disabled' });
    } finally {
      local.close();
      await runner.stop();
    }
  });

  it('serves TLS with the pinned fingerprint and keeps its key user-only', async () => {
    await withGateway('success', async ({ home, ca, pairing }) => {
      const p = await pairing();
      expect(p.fingerprint).toBe(new X509Certificate(ca).fingerprint256);
      expect(new URL(p.uri).searchParams.get('fp')).toBe(p.fingerprint);
      expect(statSync(join(home, 'gateway')).mode & 0o077).toBe(0);
      expect(statSync(join(home, 'gateway', 'key.pem')).mode & 0o077).toBe(0);
    });
  });

  it('pairing codes are single-use and tokens are stored only as hashes', async () => {
    await withGateway('success', async (ctx) => {
      const p = await ctx.pairing();
      const first = await post(ctx.port, ctx.ca, '/v1/pair', { code: p.code, deviceName: 'Phone\u0007 A' });
      expect(first.status).toBe(201);
      expect(String(first.body.token)).toMatch(/^wotsd_/);
      expect((await post(ctx.port, ctx.ca, '/v1/pair', { code: p.code, deviceName: 'Phone B' })).status).toBe(401);

      const devices = await ctx.local.call<Array<Record<string, unknown>>>('devices.list');
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ id: first.body.deviceId, name: 'Phone A', revokedAt: null });
      expect(devices[0]).not.toHaveProperty('tokenHash');
      const store = new Store(join(ctx.home, 'wots.db'));
      try {
        expect(JSON.stringify(store.all('SELECT * FROM devices'))).not.toContain(String(first.body.token));
      } finally {
        store.close();
      }
      expect(redact(`token ${first.body.token}`)).not.toContain(String(first.body.token));
    });
  });

  it('expired codes do not pair', () => {
    const store = new Store(':memory:');
    store.insertPairingCode('a'.repeat(64), '127.0.0.1', Date.now() - 1);
    expect(store.consumePairingCode('a'.repeat(64))).toBe(false);
    store.insertPairingCode('b'.repeat(64), '127.0.0.1', Date.now() + 60_000);
    expect(store.consumePairingCode('b'.repeat(64))).toBe(true);
    expect(store.consumePairingCode('b'.repeat(64))).toBe(false);
  });

  it('rate-limits failed pairing attempts, even against a valid code', async () => {
    await withGateway('success', async (ctx) => {
      for (let i = 0; i < 5; i++) expect((await post(ctx.port, ctx.ca, '/v1/pair', { code: `wrong-${i}`, deviceName: 'x' })).status).toBe(401);
      const p = await ctx.pairing();
      expect((await post(ctx.port, ctx.ca, '/v1/pair', { code: p.code, deviceName: 'x' })).status).toBe(429);
    });
    const l = new FailureLimiter(2, 1000);
    l.fail('a', 0);
    l.fail('a', 10);
    expect(l.blocked('a', 20)).toBe(true);
    expect(l.blocked('a', 1500)).toBe(false);
  });

  it('closes sockets that do not authenticate first', async () => {
    await withGateway('success', async (ctx) => {
      const p1 = await new Phone(ctx.port, ctx.ca).open();
      expect((await p1.call('sessions.list')).error?.code).toBe('unauthorized');
      expect(await p1.closed).toBe(4401);
      const p2 = await new Phone(ctx.port, ctx.ca).open();
      expect((await p2.call('auth', { deviceId: 'dev_nope', token: 'wotsd_nope' })).error?.code).toBe('unauthorized');
      expect(await p2.closed).toBe(4401);
    });
  });

  it('a paired phone cannot reach local-only methods', async () => {
    await withGateway('success', async (ctx) => {
      const { phone } = await pairPhone(ctx);
      expect(Array.isArray((await phone.call('sessions.list')).result)).toBe(true);
      for (const m of ['runner.stop', 'gateway.pair', 'gateway.configure', 'devices.list', 'devices.revoke', 'capture.get', 'capture.set', 'fallback.set', 'settings.setChatConsent', 'projects.register']) {
        expect((await phone.call(m, {})).error?.code, m).toBe('unknown_method');
      }
      expect(await ctx.local.call('runner.status')).toBeTruthy();
      phone.ws.close();
    });
  });

  it('phone follows a session live and its approvals are attributed to the paired device', async () => {
    await withGateway('approval', async (ctx) => {
      const { phone, deviceId } = await pairPhone(ctx);
      const { project } = await ctx.local.call<{ project: { id: string } }>('projects.register', { root: tempRepo(), trusted: true, permissionProfile: 'edit', crossProviderConsent: true });
      const s = await ctx.local.call<Session>('sessions.create', { projectId: project.id, mode: 'mock' });
      await phone.call('events.subscribe', { sessionId: s.id, after: 0 });
      await phone.call('messages.send', { sessionId: s.id, text: 'write it', idempotencyKey: 'phone-key-1' });
      await until(() => phone.events.some((e) => e.type === 'approval.requested'));
      const view = (await phone.call('sessions.get', { sessionId: s.id })).result;
      const approval = view.pendingApprovals[0];
      const decided = await phone.call('approvals.decide', { approvalId: approval.id, decision: 'approve', expectedVersion: approval.version, deviceId: 'local' });
      expect(decided.result).toMatchObject({ applied: true });
      await until(() => phone.events.some((e) => e.type === 'run.stateChanged' && (e.payload as { to: string }).to === 'completed'));
      expect(phone.events.find((e) => e.type === 'approval.resolved')!.payload).toMatchObject({ deviceId });
      phone.ws.close();
    });
  });

  it('revocation disconnects the device immediately and blocks reconnecting', async () => {
    await withGateway('success', async (ctx) => {
      const { phone, deviceId, token } = await pairPhone(ctx);
      expect(await ctx.local.call('devices.revoke', { deviceId })).toEqual({ revoked: true });
      expect(await phone.closed).toBe(4401);
      const again = await new Phone(ctx.port, ctx.ca).open();
      expect((await again.call('auth', { deviceId, token })).error?.code).toBe('unauthorized');
      expect(await again.closed).toBe(4401);
    });
  });
});
