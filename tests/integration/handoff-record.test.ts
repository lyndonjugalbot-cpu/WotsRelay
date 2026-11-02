import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockAdapter } from '@wots/adapter-mock';
import { containsSecret } from '@wots/security';
import { MOBILE_METHODS } from '../../apps/runner/src/server/gateway.ts';
import { buildHandoff } from '@wots/context';
import { handoffViewFor } from '../../apps/runner/src/sessions/handoffView.ts';
import { harness, runOnce, tempRepo } from '../helpers.ts';

const SECRET = 'api_key=sk-live-abcdef1234567890abcdef';
const quota = { kind: 'usage_limit', message: 'Simulated usage limit', evidence: 'mock:quota', retryAfterMs: null, resetAt: new Date(Date.now() + 3600_000).toISOString(), scope: 'account' } as const;

describe('inspectable handoff record', () => {
  it('records changed files, preserved git status, next route, category and the permission profile', async () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'scratch.txt'), 'untracked before the run\n');
    const h = harness('quota-after-edit', { repo });
    const { session } = await runOnce(h);
    const view = handoffViewFor(h.store, session.id);
    expect(view).not.toBeNull();
    expect(view!.changedFiles.length).toBeGreaterThan(0);
    expect(view!.gitStatus.some((l) => l.endsWith('scratch.txt'))).toBe(true);
    expect(view!.gitStatus.length).toBeGreaterThan(1);
    expect(view!.from?.connectionId).toBe('mock-claude');
    expect(view!.to?.connectionId).toBe('mock-codex');
    expect(view!.category).toBe('QUOTA_EXCEEDED');
    expect(view!.permissionProfile).toBe('edit');
    expect(view!.objective).toBe('Build the settings page.');
  });

  it('never exposes a secret from a tool output, lists .env by path only, and records tests and errors', async () => {
    const withTests = new MockAdapter({
      connectionId: 'mock-claude',
      label: 'a',
      models: ['claude-opus-5-5'],
      script: () => [
        { kind: 'write', path: '.env', content: `${SECRET}\n` },
        { kind: 'toolFailed', name: 'Bash', args: { command: 'npm run lint' }, message: `boom ${SECRET}` },
        { kind: 'toolDone', name: 'Bash', args: { command: 'pnpm test --run' }, risk: 'reversible-local-write', result: 'ok' },
        { kind: 'fail', failure: quota },
      ],
    });
    const fb = new MockAdapter({ connectionId: 'mock-codex', label: 'b', models: ['gpt-6-astra'], script: () => [{ kind: 'text', text: 'ok' }] });
    const h = harness('success', { adapters: [withTests, fb] });
    const { session } = await runOnce(h);
    const view = handoffViewFor(h.store, session.id)!;
    const json = JSON.stringify(view);
    expect(containsSecret(json)).toBe(false);
    expect(json).not.toContain('sk-live-abcdef');
    expect(view.gitStatus).toContain('?? .env');
    expect(view.testsExecuted.some((t) => t.includes('pnpm test'))).toBe(true);
    expect(view.testsExecuted.some((t) => t.includes('npm run lint'))).toBe(false);
    expect(view.knownErrors.length).toBeGreaterThan(0);
    expect(view.knownErrors.length).toBeLessThanOrEqual(10);
    expect(h.store.latestCheckpoint(session.id)!.diff).not.toContain('sk-live');
  });

  it('gives the next provider a "Do not repeat" section listing completed steps', async () => {
    const h = harness('quota-after-edit');
    await runOnce(h);
    const prompt = h.secondary.prompts[0]!;
    expect(prompt).toContain('## Do not repeat');
    expect(prompt).toMatch(/## Do not repeat[\s\S]*Write/);
    const cp = h.store.latestCheckpoint(h.store.listSessions(10)[0]!.id)!;
    expect(buildHandoff(cp).prompt).toContain('## Do not repeat');
  });

  it('is readable from the phone and local RPC allowlist', () => {
    expect(MOBILE_METHODS.has('handoff.get')).toBe(true);
  });

  it('skips a provider disabled after the session was created (ruling R5)', async () => {
    const h = harness('success');
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    const cfg = h.store.getSession(s.id)!.fallback;
    const [first, second] = cfg.routes.map((r) => r.connectionId) as [string, string];
    h.store.setSetting('fallback', { ...cfg, disabledConnections: [first] });
    const one = h.relay.sendMessage({ sessionId: s.id, text: 'hi', idempotencyKey: 'k1' });
    await h.relay.waitForRun(one.runId);
    expect(h.store.attemptsForRun(one.runId).map((a) => a.connectionId)).toEqual([second]);

    h.store.setSetting('fallback', { ...cfg, disabledConnections: [first, second] });
    const two = h.relay.sendMessage({ sessionId: s.id, text: 'again', idempotencyKey: 'k2' });
    const run = await h.relay.waitForRun(two.runId);
    expect(run.state).toBe('paused_auth');
    const stateEvent = h.events.filter((e) => e.type === 'run.stateChanged').at(-1)!.payload as { reason: string };
    expect(stateEvent.reason).toContain(`${first}: disabled by user`);
    expect(stateEvent.reason).toContain(`${second}: disabled by user`);
  });
});
