import { describe, expect, it } from 'vitest';
import { TRANSITIONS, assertTransition, canTransition, decide, selectNextRoute, type RouteCandidate } from '@wots/core';
import { RunState, type Failure, type FallbackConfig } from '@wots/protocol';

const cfg: FallbackConfig = {
  routes: [
    { connectionId: 'claude-code', modelId: 'claude-opus-5-5' },
    { connectionId: 'codex', modelId: 'gpt-6-astra' },
  ],
  effort: 'medium',
  speed: 'standard',
  autoFallback: true,
  outageFallback: false,
  allowApiBilling: false,
  switchAtPercent: 95,
  disabledConnections: [],
  attemptTimeoutMs: 3_600_000,
  transportRetries: 2,
  notifyOnSwitch: true,
};
const f = (kind: Failure['kind'], extra: Partial<Failure> = {}): Failure => ({ kind, message: kind, evidence: 'test', retryAfterMs: null, resetAt: null, scope: null, simulated: true, ...extra });
const ctx = { config: cfg, throttleRetries: 0, contextRetries: 0, random: () => 0.5 };

describe('state machine', () => {
  it('defines transitions for every state', () => {
    for (const s of RunState.options) expect(TRANSITIONS[s]).toBeDefined();
  });
  it('terminal states have no exits', () => {
    for (const s of ['completed', 'cancelled', 'failed'] as const) expect(TRANSITIONS[s]).toEqual([]);
  });
  it('every non-terminal state can be cancelled', () => {
    for (const s of RunState.options.filter((x) => !['completed', 'cancelled', 'failed'].includes(x))) expect(canTransition(s, 'cancelled')).toBe(true);
  });
  it('rejects invalid transitions', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(/Invalid/);
    expect(() => assertTransition('idle', 'switching')).toThrow();
    expect(() => assertTransition('switching', 'checkpointing')).toThrow();
  });
  it('the fallback path is legal', () => {
    const path = ['idle', 'preparing', 'running', 'checkpointing', 'switching', 'running', 'completed'] as const;
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1]!, path[i]!)).toBe(true);
  });
});

describe('failure policy (spec §9 table)', () => {
  it('confirmed usage limit falls back', () => expect(decide(f('usage_limit'), ctx).action).toBe('fallback'));
  it('usage limit with auto-fallback off pauses', () => expect(decide(f('usage_limit'), { ...ctx, config: { ...cfg, autoFallback: false } })).toMatchObject({ action: 'pause', state: 'paused_limits' }));
  it('suspected limit pauses and offers manual fallback', () => expect(decide(f('usage_limit_suspected'), ctx)).toMatchObject({ action: 'pause', offerManualFallback: true }));
  it('throttle retries at most twice, honoring retry hints', () => {
    expect(decide(f('transient_throttle', { retryAfterMs: 1000 }), ctx)).toMatchObject({ action: 'retry_same', delayMs: 1125 });
    expect(decide(f('transient_throttle'), { ...ctx, throttleRetries: 2 }).action).toBe('pause');
  });
  it('outage only falls back when opted in', () => {
    expect(decide(f('outage'), ctx).action).toBe('pause');
    expect(decide(f('outage'), { ...ctx, config: { ...cfg, outageFallback: true } }).action).toBe('fallback');
  });
  it('never switches to evade permission or policy boundaries', () => {
    expect(decide(f('permission_denied'), ctx).action).toBe('fail');
    expect(decide(f('policy_refusal'), ctx).action).toBe('fail');
  });
  it('auth, model, unknown, transport pause', () => {
    expect(decide(f('auth'), ctx)).toMatchObject({ action: 'pause', state: 'paused_auth' });
    expect(decide(f('model_unavailable'), ctx).action).toBe('pause');
    expect(decide(f('unknown'), ctx)).toMatchObject({ action: 'pause', state: 'paused_uncertain' });
    expect(decide(f('transport'), ctx).action).toBe('pause');
  });
  it('context too large retries once', () => {
    expect(decide(f('context_too_large'), ctx).action).toBe('retry_compacted');
    expect(decide(f('context_too_large'), { ...ctx, contextRetries: 1 }).action).toBe('pause');
  });
});

describe('route selection', () => {
  const cand = (connectionId: string, modelId: string, x: Partial<RouteCandidate> = {}): RouteCandidate => ({ route: { connectionId, modelId }, authenticated: true, billing: 'subscription', modelAvailable: true, coolingDownUntil: null, isMock: false, ...x });
  const base = { config: cfg, tried: new Set<string>(), crossProviderConsent: true, currentConnectionId: 'claude-code', now: 1000, allowMock: false };
  it('skips tried routes and picks the next', () => {
    expect(selectNextRoute({ ...base, candidates: [cand('claude-code', 'claude-opus-5-5'), cand('codex', 'gpt-6-astra')], tried: new Set(['claude-code:claude-opus-5-5']) }).route).toEqual({ connectionId: 'codex', modelId: 'gpt-6-astra' });
  });
  it('never selects an API-billed route without explicit permission', () => {
    const r = selectNextRoute({ ...base, candidates: [cand('codex', 'gpt-6-astra', { billing: 'api' })], tried: new Set(['claude-code:claude-opus-5-5']) });
    expect(r.route).toBeNull();
  });
  it('requires consent for cross-provider handoff', () => {
    const r = selectNextRoute({ ...base, crossProviderConsent: false, candidates: [cand('codex', 'gpt-6-astra')], tried: new Set(['claude-code:claude-opus-5-5']) });
    expect(r.route).toBeNull();
    expect('reasons' in r && r.reasons.join()).toContain('consented');
  });
  it('respects cooldowns, auth and mock isolation', () => {
    expect(selectNextRoute({ ...base, currentConnectionId: null, candidates: [cand('claude-code', 'claude-opus-5-5', { coolingDownUntil: 5000 }), cand('codex', 'gpt-6-astra', { authenticated: false })] }).route).toBeNull();
    expect(selectNextRoute({ ...base, currentConnectionId: null, candidates: [cand('claude-code', 'claude-opus-5-5', { isMock: true })] }).route).toBeNull();
  });
});
