import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { mockPair } from '@wots/adapter-mock';
import type { EventEnvelope, Session } from '@wots/protocol';
import { RunnerClient, startRunner } from '@wots/runner';
import { pairDevice, parsePairingLink, RelayClient, type ConnectionState, type Transport } from '../../apps/mobile/src/relay/client.ts';
import { tempDir, tempRepo } from '../helpers.ts';

const norm = (fp: string) => fp.toUpperCase().replace(/[^0-9A-F]/g, '');
const peerOk = (s: TLSSocket, fp: string) => norm(s.getPeerCertificate().fingerprint256 ?? '') === norm(fp);

// Same contract as the Swift module: trust only the pinned certificate, never system trust.
function nodeTransport(): Transport & { sockets: WebSocket[] } {
  const sockets: WebSocket[] = [];
  return {
    sockets,
    open(url, fp, h) {
      const ws = new WebSocket(url, { rejectUnauthorized: false });
      sockets.push(ws);
      ws.on('upgrade', (res) => {
        if (!peerOk(res.socket as TLSSocket, fp)) ws.terminate();
      });
      ws.on('open', () => h.onOpen());
      ws.on('message', (d) => h.onMessage(d.toString()));
      ws.on('close', (code, reason) => h.onClose(code, reason.toString()));
      ws.on('error', () => {});
      return { send: (t) => ws.readyState === WebSocket.OPEN && ws.send(t), close: (c) => ws.close(c) };
    },
    request(url, method, body, fp) {
      return new Promise((resolve, reject) => {
        const req = request(url, { method, rejectUnauthorized: false, headers: { 'Content-Type': 'application/json' } }, (res) => {
          if (!peerOk(res.socket as TLSSocket, fp)) return reject(new Error('certificate does not match the pinned fingerprint'));
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode!, body: data }));
        });
        req.on('error', reject);
        req.end(body ?? undefined);
      });
    },
  };
}

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

async function withPhone(scenario: string, fn: (ctx: { local: RunnerClient; link: string; transport: ReturnType<typeof nodeTransport> }) => Promise<void>) {
  const runner = await startRunner({ home: tempDir('wmc-'), adapters: () => mockPair(scenario), refreshOnStart: false });
  const local = await new RunnerClient(runner.paths.socket).connect();
  try {
    await local.call('gateway.configure', { enabled: true, host: '127.0.0.1', port: 0 });
    const { uri } = await local.call<{ uri: string }>('gateway.pair');
    await fn({ local, link: uri, transport: nodeTransport() });
  } finally {
    local.close();
    await runner.stop();
  }
}

describe('phone relay client against the real gateway', () => {
  it('parses pairing links and rejects anything else', () => {
    expect(parsePairingLink('wotsrelay://pair?host=192.168.1.5&port=7443&code=abc&fp=AA%3ABB')).toEqual({ host: '192.168.1.5', port: 7443, code: 'abc', fingerprint: 'AA:BB' });
    for (const bad of ['https://example.com', 'wotsrelay://pair?host=x&port=0&code=a&fp=b', 'wotsrelay://pair?host=x&port=1', 'not a link']) {
      expect(() => parsePairingLink(bad)).toThrow(/pairing link/);
    }
  });

  it('refuses a server whose certificate does not match the link', async () => {
    await withPhone('success', async ({ link, transport }) => {
      const l = parsePairingLink(link);
      await expect(pairDevice(transport, { ...l, fingerprint: 'AA'.repeat(32) }, 'Phone')).rejects.toThrow(/pinned/);
    });
  });

  it('pairs once, follows a run live, survives a dropped connection without gaps or repeats', async () => {
    await withPhone('approval', async ({ local, link, transport }) => {
      const pairing = await pairDevice(transport, parsePairingLink(link), 'Test iPhone');
      await expect(pairDevice(transport, parsePairingLink(link), 'Again')).rejects.toMatchObject({ code: 'invalid_code' });

      const phone = new RelayClient(pairing, transport, { backoffMs: () => 50 });
      const events: EventEnvelope[] = [];
      const states: ConnectionState[] = [];
      phone.onEvent((e) => events.push(e));
      phone.onState((s) => states.push(s));
      phone.start();

      const { project } = await local.call<{ project: { id: string } }>('projects.register', { root: tempRepo(), trusted: true, permissionProfile: 'edit', crossProviderConsent: true });
      const s = await local.call<Session>('sessions.create', { projectId: project.id, mode: 'mock' });
      expect((await phone.call<Session[]>('sessions.list')).map((x) => x.id)).toContain(s.id);
      await phone.subscribe(s.id);
      await phone.call('messages.send', { sessionId: s.id, text: 'write it', idempotencyKey: 'phone-mc-1' });
      await until(() => events.some((e) => e.type === 'approval.requested'));

      // Drop the connection while the run waits for approval; the client reconnects and resumes.
      transport.sockets.at(-1)!.terminate();
      await until(() => states.includes('offline'));
      await until(() => phone.state === 'online');

      const view = await phone.call<{ pendingApprovals: Array<{ id: string; version: number }> }>('sessions.get', { sessionId: s.id });
      await phone.call('approvals.decide', { approvalId: view.pendingApprovals[0]!.id, decision: 'approve', expectedVersion: view.pendingApprovals[0]!.version });
      await until(() => events.some((e) => e.type === 'run.stateChanged' && (e.payload as { to: string }).to === 'completed'));

      const seqs = events.filter((e) => e.sessionId === s.id).map((e) => e.seq);
      expect(seqs).toEqual([...new Set(seqs)].sort((a, b) => a - b));
      expect(seqs[0]).toBe(1);
      expect(seqs.at(-1)! - seqs[0]! + 1).toBe(seqs.length); // contiguous: nothing missed
      phone.stop();
    });
  });

  it('a revoked phone stops reconnecting and says so', async () => {
    await withPhone('success', async ({ local, link, transport }) => {
      const pairing = await pairDevice(transport, parsePairingLink(link), 'Phone');
      const phone = new RelayClient(pairing, transport, { backoffMs: () => 50 });
      phone.start();
      await until(() => phone.state === 'online');
      await local.call('devices.revoke', { deviceId: pairing.deviceId });
      await until(() => phone.state === 'revoked');
      await expect(phone.call('sessions.list')).rejects.toMatchObject({ code: 'revoked' });
    });
  });
});
