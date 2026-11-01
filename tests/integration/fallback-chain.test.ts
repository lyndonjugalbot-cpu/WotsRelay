import { describe, expect, it } from 'vitest';
import { mockChain, mockPair, MockAdapter } from '@wots/adapter-mock';
import type { EventEnvelope, FallbackConfig, RunState } from '@wots/protocol';
import { RunnerClient, startRunner } from '@wots/runner';
import { MOBILE_METHODS } from '../../apps/runner/src/server/gateway.ts';
import type { RelayController } from '../../apps/runner/src/sessions/controller.ts';
import { fakeClock, harness, states, tempDir, types, type Harness } from '../helpers.ts';

const CHAIN: FallbackConfig = {
  routes: [
    { connectionId: 'mock-claude', modelId: 'claude-opus-5-5' },
    { connectionId: 'mock-codex', modelId: 'gpt-6-astra' },
    { connectionId: 'mock-cursor', modelId: 'default' },
    { connectionId: 'mock-gemini', modelId: 'gemini-3-pro' },
  ],
  effort: 'medium',
  speed: 'standard',
  autoFallback: true,
  outageFallback: false,
  allowApiBilling: true,
  switchAtPercent: 95,
  disabledConnections: [],
  attemptTimeoutMs: 3_600_000,
  transportRetries: 2,
  notifyOnSwitch: true,
};

type Chain = Harness & { mocks: Record<string, MockAdapter> };

async function chain(scenario: string, opts: { adapters?: MockAdapter[]; onEvent?: (e: EventEnvelope, relay: RelayController) => void; repo?: string; home?: string; dbPath?: string } = {}): Promise<Chain> {
  const adapters = opts.adapters ?? mockChain(scenario);
  // The pair harness() builds is unused here; the chain's own adapters are passed in.
  const h = harness('success', { adapters, onEvent: opts.onEvent, repo: opts.repo, home: opts.home, dbPath: opts.dbPath });
  // Route eligibility reads the cached connection status (billing mode included).
  await h.relay.refreshConnections();
  return { ...h, mocks: Object.fromEntries(adapters.map((a) => [a.connectionId, a])) };
}

function start(h: Harness, fallback: Partial<FallbackConfig> = {}, text = 'Build the settings page.') {
  const session = h.relay.createSession({ projectId: h.projectId, mode: 'mock', fallback: { ...CHAIN, ...fallback } });
  const { runId } = h.relay.sendMessage({ sessionId: session.id, text, idempotencyKey: `key-${Math.random()}` });
  return { session, runId };
}

async function run(h: Harness, fallback: Partial<FallbackConfig> = {}, text?: string) {
  const { session, runId } = start(h, fallback, text);
  return { session, run: await h.relay.waitForRun(runId) };
}

const attempted = (h: Harness, runId: string) => h.store.attemptsForRun(runId).map((a) => a.connectionId);
const switches = (h: Harness) => h.events.filter((e) => e.type === 'provider.switched').map((e) => (e.payload as { from: { connectionId: string }; to: { connectionId: string } })).map((p) => `${p.from.connectionId}->${p.to.connectionId}`);

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

const quotaAdapter = (connectionId: string, model: string) =>
  new MockAdapter({
    connectionId,
    label: connectionId,
    models: [model],
    billingMode: 'api',
    script: () => [{ kind: 'fail', failure: { kind: 'usage_limit', message: 'Simulated usage limit', evidence: 'mock:quota', retryAfterMs: null, resetAt: null, scope: 'account' } }],
  });

describe('fallback chain across four providers (mock adapters)', () => {
  it('Claude → Codex → Cursor → Gemini, one confirmed limit at a time, with consent and API billing', async () => {
    const h = await chain('chain-quota');
    const { run: r } = await run(h);
    expect(r.state).toBe('completed');
    expect(attempted(h, r.id)).toEqual(['mock-claude', 'mock-codex', 'mock-cursor', 'mock-gemini']);
    expect(switches(h)).toEqual(['mock-claude->mock-codex', 'mock-codex->mock-cursor', 'mock-cursor->mock-gemini']);
    expect(states(h.events)).toEqual(['preparing', 'running', ...Array(3).fill(['checkpointing', 'switching', 'running']).flat(), 'completed']);
    expect(types(h.events).filter((t) => t === 'limit.observed')).toHaveLength(3);
    // Each successor receives the portable handoff, never another provider's session id.
    expect(h.mocks['mock-gemini']!.prompts[0]).toContain('Build the settings page.');
    expect(h.mocks['mock-gemini']!.inputs[0]!.resumeProviderSessionId).toBeNull();
  });

  it('Gemini is excluded when API billing is off', async () => {
    const h = await chain('chain-quota');
    const { run: r } = await run(h, { allowApiBilling: false });
    expect(r.state).toBe('paused_limits');
    expect(attempted(h, r.id)).toEqual(['mock-claude', 'mock-codex', 'mock-cursor']);
    expect(r.stateReason).toContain('mock-gemini:gemini-3-pro: API billing not enabled by the user');
    expect(h.mocks['mock-gemini']!.prompts).toHaveLength(0);
  });

  it('two disabled middle providers are skipped: Claude jumps straight to Gemini', async () => {
    const h = await chain('chain-quota');
    const { run: r } = await run(h, { disabledConnections: ['mock-codex', 'mock-cursor'] });
    expect(r.state).toBe('completed');
    expect(attempted(h, r.id)).toEqual(['mock-claude', 'mock-gemini']);
    expect(switches(h)).toEqual(['mock-claude->mock-gemini']);
    expect(h.mocks['mock-codex']!.prompts).toHaveLength(0);
    expect(h.mocks['mock-cursor']!.prompts).toHaveLength(0);
  });

  it('all routes unavailable: pauses on limits, the reason lists every route, the session is preserved', async () => {
    const adapters = mockChain('chain-quota').map((a) => (a.connectionId === 'mock-gemini' ? quotaAdapter('mock-gemini', 'gemini-3-pro') : a));
    const h = await chain('chain-quota', { adapters });
    const { run: r, session } = await run(h);
    expect(r.state).toBe('paused_limits');
    expect(attempted(h, r.id)).toEqual(['mock-claude', 'mock-codex', 'mock-cursor', 'mock-gemini']);
    for (const route of CHAIN.routes) expect(r.stateReason).toContain(`${route.connectionId}:${route.modelId}:`);
    expect(h.store.getSession(session.id)!.state).toBe('paused_limits');
    expect(h.store.latestCheckpoint(session.id)!.runId).toBe(r.id);
    expect(h.store.listEvents(session.id).some((e) => e.type === 'user.message')).toBe(true);
  });

  it('flaky network: two lost connections, then success on the same route with no switch', async () => {
    const h = await chain('flaky-network');
    const slept = fakeClock.slept.length;
    const { run: r } = await run(h);
    expect(r.state).toBe('completed');
    expect(attempted(h, r.id)).toEqual(['mock-claude', 'mock-claude', 'mock-claude']);
    expect(types(h.events)).not.toContain('provider.switched');
    expect(types(h.events)).not.toContain('limit.observed');
    expect(states(h.events)).toEqual(['preparing', 'running', 'completed']);
    // Bounded, jittered backoff from the shared throttle helper (random fixed at 0.5).
    expect(fakeClock.slept.slice(slept)).toEqual([2250, 4500]);
  });

  it('flaky network with transportRetries 0 pauses at once', async () => {
    const h = await chain('flaky-network');
    const { run: r } = await run(h, { transportRetries: 0 });
    expect(r.state).toBe('paused_uncertain');
    expect(r.stateReason).toMatch(/Connection to provider lost/);
    expect(attempted(h, r.id)).toEqual(['mock-claude']);
    expect(types(h.events)).not.toContain('provider.switched');
  });

  it('a lost connection after an unconfirmed tool call is never retried', async () => {
    const h = harness('uncertain-action');
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    const { runId } = h.relay.sendMessage({ sessionId: s.id, text: 'migrate', idempotencyKey: 'k-uncertain-chain' });
    const r = await h.relay.waitForRun(runId);
    expect(r.state).toBe('paused_uncertain');
    expect(h.primary.prompts).toHaveLength(1);
  });

  it('slow attempt past attemptTimeoutMs is interrupted, recorded as a timeout and paused', async () => {
    const h = await chain('slow');
    const { run: r } = await run(h, { attemptTimeoutMs: 50 });
    expect(r.state).toBe('paused_uncertain');
    expect(r.stateReason).toMatch(/timed out/);
    const [a] = h.store.attemptsForRun(r.id);
    expect(a!.termination).toBe('interrupted:timeout');
    const ended = h.events.find((e) => e.type === 'attempt.ended')!;
    expect(ended.payload).toMatchObject({ termination: 'interrupted', quiescent: true });
    expect(states(h.events)).toEqual(['preparing', 'running', 'checkpointing', 'paused_uncertain']);
    expect(types(h.events)).not.toContain('provider.switched');
    expect(h.mocks['mock-codex']!.prompts).toHaveLength(0);
  });

  it('cancellation during a switch wins: the next provider never starts', async () => {
    const h = await chain('chain-quota', {
      onEvent: (e, relay) => {
        if (e.type === 'run.stateChanged' && (e.payload as { to: RunState }).to === 'switching' && e.runId) relay.interrupt(e.runId);
      },
    });
    const { run: r } = await run(h);
    expect(r.state).toBe('cancelled');
    expect(attempted(h, r.id)).toEqual(['mock-claude']);
    expect(h.mocks['mock-codex']!.prompts).toHaveLength(0);
    expect(types(h.events)).not.toContain('provider.switched');
    expect(states(h.events)).toEqual(['preparing', 'running', 'checkpointing', 'switching', 'cancelled']);
  });

  it('runner restart mid-attempt on mock-cursor: recover() pauses, nothing resumes blindly', async () => {
    const home = tempDir('wchain-');
    const h1 = await chain('slow', { home });
    const { session, runId } = start(h1, { disabledConnections: ['mock-claude', 'mock-codex'] });
    await until(() => h1.store.getSession(session.id)!.state === 'running');
    expect(attempted(h1, runId)).toEqual(['mock-cursor']);
    const h2 = await chain('slow', { home, repo: h1.repo, dbPath: `${home}/wots.db` });
    expect(h2.relay.recover().recovered).toEqual([runId]);
    const r = h2.store.getRun(runId)!;
    expect(r.state).toBe('paused_uncertain');
    expect(r.stateReason).toMatch(/runner restarted/i);
    expect(h2.store.attemptsForRun(runId)[0]!.termination).toBe('runner_restart');
    expect(h2.mocks['mock-cursor']!.prompts).toHaveLength(0);
    // Let the abandoned controller's attempt end so nothing is left running.
    h1.relay.interrupt(runId);
    await h1.relay.waitForRun(runId);
  });

  it('cursor auth failure pauses; "skip this provider" resumes on Gemini', async () => {
    const h = await chain('cursor-auth');
    const { run: r, session } = await run(h);
    expect(r.state).toBe('paused_auth');
    expect(attempted(h, r.id)).toEqual(['mock-claude', 'mock-codex', 'mock-cursor']);
    expect(h.mocks['mock-gemini']!.prompts).toHaveLength(0);

    h.relay.resume(session.id, { fallback: false, skipConnectionId: 'mock-cursor' });
    const after = await h.relay.waitForRun(r.id);
    expect(after.state).toBe('completed');
    expect(attempted(h, r.id)).toEqual(['mock-claude', 'mock-codex', 'mock-cursor', 'mock-gemini']);
    expect(switches(h).at(-1)).toBe('mock-cursor->mock-gemini');
    expect(h.mocks['mock-cursor']!.prompts).toHaveLength(1);
    expect(h.mocks['mock-gemini']!.prompts[0]).toContain('Build the settings page.');
  });

  it('a failed tool in a completed turn never produces limit.observed', async () => {
    const adapters = mockChain('chain-quota').map((a) =>
      a.connectionId === 'mock-claude'
        ? new MockAdapter({
            connectionId: 'mock-claude',
            label: 'Mock Claude',
            models: ['claude-opus-5-5'],
            script: () => [{ kind: 'toolFailed', name: 'Bash', args: { command: 'npm test' }, message: 'Error 429: rate limit exceeded, usage limit reached' }, { kind: 'text', text: 'The tests failed; here is why.' }],
          })
        : a,
    );
    const h = await chain('chain-quota', { adapters });
    const { run: r } = await run(h);
    expect(r.state).toBe('completed');
    expect(attempted(h, r.id)).toEqual(['mock-claude']);
    expect(types(h.events)).toContain('tool.failed');
    expect(types(h.events)).not.toContain('limit.observed');
    expect(types(h.events)).not.toContain('provider.switched');
  });

  it('two sessions on one project: the second run pauses on the workspace lease and never edits', async () => {
    const h = await chain('slow');
    const first = start(h, { disabledConnections: ['mock-claude', 'mock-codex'] }, 'first');
    await until(() => h.store.getSession(first.session.id)!.state === 'running');
    const second = start(h, { disabledConnections: ['mock-claude', 'mock-codex'] }, 'second');
    const r2 = await h.relay.waitForRun(second.runId);
    expect(r2.state).toBe('paused_uncertain');
    expect(r2.stateReason).toMatch(/in use/);
    expect(h.store.attemptsForRun(second.runId)).toHaveLength(0);
    expect(h.mocks['mock-cursor']!.prompts).toEqual(['first']);
    h.relay.interrupt(first.runId);
    expect((await h.relay.waitForRun(first.runId)).state).toBe('cancelled');
  });
});

describe('providers.setEnabled (local RPC)', () => {
  async function withRunner(fn: (cl: RunnerClient) => Promise<void>) {
    const home = tempDir('wpe-');
    const runner = await startRunner({ home, adapters: () => mockPair('success'), refreshOnStart: false });
    const cl = await new RunnerClient(runner.paths.socket).connect();
    try {
      await fn(cl);
    } finally {
      cl.close();
      await runner.stop();
    }
  }
  const order = (cfg: FallbackConfig) => cfg.routes.map((r) => r.connectionId);

  it('enabling inserts the route at its canonical position; disabling keeps it listed but skipped', async () => {
    await withRunner(async (cl) => {
      const base = (await cl.call<{ real: FallbackConfig }>('fallback.get', {})).real;
      expect(order(base)).toEqual(['claude-code', 'codex']);

      const g = await cl.call<FallbackConfig>('providers.setEnabled', { connectionId: 'gemini', enabled: true, modelId: 'gemini-3-pro' });
      expect(order(g)).toEqual(['claude-code', 'codex', 'gemini']);
      const c = await cl.call<FallbackConfig>('providers.setEnabled', { connectionId: 'cursor', enabled: true, modelId: 'default' });
      expect(order(c)).toEqual(['claude-code', 'codex', 'cursor', 'gemini']);
      expect(c.routes[2]).toEqual({ connectionId: 'cursor', modelId: 'default' });

      const off = await cl.call<FallbackConfig>('providers.setEnabled', { connectionId: 'cursor', enabled: false });
      expect(off.disabledConnections).toEqual(['cursor']);
      expect(order(off)).toEqual(['claude-code', 'codex', 'cursor', 'gemini']);
      // Re-enabling an existing route needs no model and does not duplicate it.
      const on = await cl.call<FallbackConfig>('providers.setEnabled', { connectionId: 'cursor', enabled: true });
      expect(on.disabledConnections).toEqual([]);
      expect(order(on)).toEqual(['claude-code', 'codex', 'cursor', 'gemini']);
      // Persisted through the existing fallback setting.
      expect((await cl.call<{ real: FallbackConfig }>('fallback.get', {})).real).toEqual(on);
    });
  });

  it('rejects a missing model, unknown connections and mock connections', async () => {
    await withRunner(async (cl) => {
      await expect(cl.call('providers.setEnabled', { connectionId: 'cursor', enabled: true })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(cl.call('providers.setEnabled', { connectionId: 'nope', enabled: true, modelId: 'x' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(cl.call('providers.setEnabled', { connectionId: 'mock-claude', enabled: false })).rejects.toThrow(/Mock/);
      const cfg = (await cl.call<{ real: FallbackConfig }>('fallback.get', {})).real;
      expect(order(cfg)).toEqual(['claude-code', 'codex']);
      expect(cfg.disabledConnections).toEqual([]);
    });
  });

  it('is local-only: not reachable from paired devices', () => {
    expect(MOBILE_METHODS.has('providers.setEnabled')).toBe(false);
  });
});
