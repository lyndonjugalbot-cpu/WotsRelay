import { describe, expect, it } from 'vitest';
import type { EventPayload } from '@wots/protocol';
import { nearLimit, selectNextRoute, type RouteCandidate } from '@wots/core';
import { harness, type Harness } from '../helpers.ts';

const HOUR = 3600_000;

async function say(h: Harness, sessionId: string, text: string) {
  const { runId } = h.relay.sendMessage({ sessionId, text, idempotencyKey: `k-${Math.random()}` });
  return h.relay.waitForRun(runId);
}

const usage = (percent: number, resetInMs: number) => ({ scope: 'five_hour', value: percent, unit: 'percent', resetAt: new Date(Date.now() + resetInMs).toISOString(), observedAt: new Date().toISOString(), confidence: 'reported' });
const switches = (h: Harness) => h.events.filter((e) => e.type === 'provider.switched').map((e) => e.payload as EventPayload<'provider.switched'>);

describe('conversation memory across turns', () => {
  it('a follow-up on the same provider resumes its native session with just the new text', async () => {
    const h = harness('success');
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    await say(h, s.id, 'My name is Ada.');
    await say(h, s.id, 'What is my name?');
    const [first, second] = h.primary.inputs;
    expect(first!.resumeProviderSessionId).toBeNull();
    expect(second!.resumeProviderSessionId).toBe(`mock-session-${first!.attemptId}`);
    expect(second!.prompt).toBe('What is my name?');
    expect(h.secondary.inputs).toHaveLength(0);
  });
});

describe('switching at 95% of a usage window', () => {
  it('moves the next message to the fallback with the conversation, then returns after the reset', async () => {
    const h = harness('success', { consent: true });
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    await say(h, s.id, 'My name is Ada.');

    h.relay.recordUsage('mock-claude', usage(96, HOUR));
    const run2 = await say(h, s.id, 'What is my name?');
    expect(run2.state).toBe('completed');
    expect(h.secondary.inputs).toHaveLength(1);
    const handoff = h.secondary.inputs[0]!.prompt;
    expect(handoff).toContain('My name is Ada.');
    expect(handoff).toContain('What is my name?');
    expect(h.secondary.inputs[0]!.resumeProviderSessionId).toBeNull();
    expect(switches(h).at(-1)).toMatchObject({ from: { connectionId: 'mock-claude' }, to: { connectionId: 'mock-codex' }, simulated: false });
    expect(switches(h).at(-1)!.reason).toMatch(/96% of its 5-hour limit/);

    // Codex keeps its own thread for the next turn while Claude is still near the limit.
    await say(h, s.id, 'And my favourite colour is green.');
    expect(h.secondary.inputs[1]!.resumeProviderSessionId).toBe(`mock-session-${h.secondary.inputs[0]!.attemptId}`);

    // After Claude's window resets, the preferred model is back and gets the whole conversation.
    h.relay.recordUsage('mock-claude', usage(96, -1));
    await say(h, s.id, 'Summarize what you know about me.');
    const back = h.primary.inputs.at(-1)!;
    expect(back.prompt).toContain('favourite colour is green');
    expect(switches(h).at(-1)).toMatchObject({ from: { connectionId: 'mock-codex' }, to: { connectionId: 'mock-claude' } });
  });

  it('without cross-provider consent the conversation stays put (the CLI asks first)', async () => {
    const h = harness('success', { consent: false });
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    await say(h, s.id, 'hello');
    h.relay.recordUsage('mock-claude', usage(97, HOUR));
    await say(h, s.id, 'again');
    expect(h.secondary.inputs).toHaveLength(0);
    expect(h.primary.inputs).toHaveLength(2);
  });

  it('a brand-new conversation starts on the fallback with no consent needed (nothing to share yet)', async () => {
    const h = harness('success', { consent: false });
    h.relay.recordUsage('mock-claude', usage(99, HOUR));
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    await say(h, s.id, 'hello');
    expect(h.primary.inputs).toHaveLength(0);
    expect(h.secondary.inputs).toHaveLength(1);
  });
});

describe('near-limit route policy', () => {
  const cand = (connectionId: string, usagePct?: number, resetAt: number | null = Date.now() + HOUR): RouteCandidate => ({
    route: { connectionId, modelId: `${connectionId}-model` },
    authenticated: true,
    billing: 'subscription',
    modelAvailable: true,
    coolingDownUntil: null,
    isMock: false,
    usage: usagePct === undefined ? [] : [{ scope: 'five_hour', percent: usagePct, resetAt }],
  });
  const config = (switchAtPercent?: number) => ({ routes: [{ connectionId: 'a', modelId: 'a-model' }, { connectionId: 'b', modelId: 'b-model' }], effort: 'medium' as const, speed: 'standard' as const, autoFallback: true, outageFallback: false, allowApiBilling: false, switchAtPercent: switchAtPercent as number, disabledConnections: [], attemptTimeoutMs: 3_600_000, transportRetries: 2, notifyOnSwitch: true });
  const pick = (cands: RouteCandidate[], switchAt?: number) => selectNextRoute({ config: config(switchAt), candidates: cands, tried: new Set(), crossProviderConsent: true, currentConnectionId: null, now: Date.now(), allowMock: false });

  it('switches at the threshold, not below it; the threshold is configurable', () => {
    expect(pick([cand('a', 94), cand('b')]).route?.connectionId).toBe('a');
    expect(pick([cand('a', 95), cand('b')]).route?.connectionId).toBe('b');
    expect(pick([cand('a', 85), cand('b')], 80).route?.connectionId).toBe('b');
  });

  it('ignores a window whose reset time has passed', () => {
    expect(pick([cand('a', 99, Date.now() - 1), cand('b')]).route?.connectionId).toBe('a');
  });

  it('when every route is near its limit, keeps working on the one with the most room', () => {
    const r = pick([cand('a', 99), cand('b', 96)]);
    expect(r.route?.connectionId).toBe('b');
    expect(r.reason).toMatch(/All routes are near their limits/);
  });

  it('nearLimit reports the fullest active window', () => {
    expect(nearLimit([{ scope: 'five_hour', percent: 96, resetAt: null }, { scope: 'seven_day', percent: 99, resetAt: null }], 95, Date.now())?.scope).toBe('seven_day');
    expect(nearLimit([], 95, Date.now())).toBeNull();
  });
});
