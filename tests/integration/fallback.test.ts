import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TASK_FILES } from '@wots/adapter-mock';
import { harness, runOnce, states, types } from '../helpers.ts';

describe('vertical slice: Claude → Astra fallback (mock adapters)', () => {
  it('A03 quota after a completed edit: successor continues without repeating the edit', async () => {
    const h = harness('quota-after-edit');
    const { run, session } = await runOnce(h);

    expect(run.state).toBe('completed');
    // Append-mode writes would duplicate content if the edit had been repeated.
    for (const f of TASK_FILES) expect(readFileSync(join(h.repo, f.path), 'utf8')).toBe(f.content);

    const attempts = h.store.attemptsForRun(run.id);
    expect(attempts.map((a) => a.connectionId)).toEqual(['mock-claude', 'mock-codex']);
    expect(attempts[1]!.parentAttemptId).toBe(attempts[0]!.id);

    const switched = h.events.find((e) => e.type === 'provider.switched')!;
    expect(switched.payload).toMatchObject({ from: { connectionId: 'mock-claude' }, to: { connectionId: 'mock-codex' }, simulated: true });
    expect(states(h.events)).toEqual(['preparing', 'running', 'checkpointing', 'switching', 'running', 'completed']);

    // The successor received a portable handoff with evidence of the earlier change.
    const handoff = h.secondary.prompts[0]!;
    expect(handoff).toContain('Build the settings page.');
    expect(handoff).toContain('src/settings/SettingsPage.tsx');
    expect(handoff).toContain('Do not repeat completed steps');

    // Both providers' contributions are attributed.
    const authors = h.events.filter((e) => e.type === 'message.completed').map((e) => (e.payload as { connectionId: string }).connectionId);
    expect(new Set(authors)).toEqual(new Set(['mock-claude', 'mock-codex']));
    expect(h.store.latestCheckpoint(session.id)!.changedFiles.map((c) => c.path)).toContain('src/settings/SettingsPage.tsx');
  });

  it('A04 quota before any answer: exactly one successor attempt', async () => {
    const h = harness('quota-before-answer');
    const { run } = await runOnce(h, 'Explain closures');
    expect(run.state).toBe('completed');
    expect(h.store.attemptsForRun(run.id)).toHaveLength(2);
    expect(types(h.events).filter((t) => t === 'provider.switched')).toHaveLength(1);
  });

  it('A05 both routes limited: pauses with checkpoint, no loop, no paid fallback', async () => {
    const h = harness('both-limited');
    const { run, session } = await runOnce(h);
    expect(run.state).toBe('paused_limits');
    expect(h.store.attemptsForRun(run.id)).toHaveLength(2);
    expect(h.store.latestCheckpoint(session.id)).not.toBeNull();
    expect(run.stateReason).toMatch(/already tried|cooling down/);
  });

  it('A06 auth failure pauses without switching; policy refusal fails without switching', async () => {
    const a = harness('auth-failure');
    const ra = await runOnce(a);
    expect(ra.run.state).toBe('paused_auth');
    expect(a.secondary.prompts).toHaveLength(0);

    const p = harness('policy-refusal');
    const rp = await runOnce(p);
    expect(rp.run.state).toBe('failed');
    expect(p.secondary.prompts).toHaveLength(0);
  });

  it('A07 uncertain external action pauses and is not replayed', async () => {
    const h = harness('uncertain-action');
    const { run, session } = await runOnce(h);
    expect(run.state).toBe('paused_uncertain');
    expect(run.stateReason).toContain('npm run db:migrate');
    expect(h.secondary.prompts).toHaveLength(0);
    const cp = h.store.latestCheckpoint(session.id)!;
    expect(cp.unresolvedActions[0]).toMatchObject({ risk: 'external-side-effect', status: 'unknown' });
  });

  it('resume after reconciling an uncertain action continues on the fallback with an explicit note', async () => {
    const h = harness('uncertain-action');
    const { session, run } = await runOnce(h);
    h.relay.resume(session.id, { fallback: true, note: 'The migration did complete. Continue.' });
    const after = await h.relay.waitForRun(run.id);
    expect(after.state).toBe('completed');
    expect(h.secondary.prompts[0]).toContain('The migration did complete');
    expect(h.secondary.prompts[0]).toContain('DO NOT REPEAT');
  });

  it('pauses when cross-provider consent was not given', async () => {
    const h = harness('quota-after-edit', { consent: false });
    const { run } = await runOnce(h);
    expect(run.state).toBe('paused_limits');
    expect(run.stateReason).toContain('consented');
    expect(h.secondary.prompts).toHaveLength(0);
  });

  it('pauses when the old process cannot be proven stopped', async () => {
    const h = harness('quota-after-edit', { failsToQuiesce: true });
    const { run } = await runOnce(h);
    expect(run.state).toBe('paused_uncertain');
    expect(h.secondary.prompts).toHaveLength(0);
  });

  it('A09 user stop wins: no successor starts after cancellation', async () => {
    const h = harness('slow-quota');
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    const { runId } = h.relay.sendMessage({ sessionId: s.id, text: 'go', idempotencyKey: 'k-cancel-0001' });
    await new Promise((r) => setTimeout(r, 20));
    h.relay.interrupt(runId);
    const run = await h.relay.waitForRun(runId);
    expect(run.state).toBe('cancelled');
    expect(h.secondary.prompts).toHaveLength(0);
    const ended = h.events.find((e) => e.type === 'attempt.ended')!;
    expect(ended.payload).toMatchObject({ termination: 'interrupted', quiescent: true });
    expect(types(h.events)).not.toContain('provider.switched');
  });

  it('short throttle retries the same route with bounded backoff', async () => {
    const h = harness('throttle-then-ok');
    const { run } = await runOnce(h);
    expect(run.state).toBe('completed');
    expect(h.store.attemptsForRun(run.id).map((a) => a.connectionId)).toEqual(['mock-claude', 'mock-claude']);
    expect(h.primary.prompts).toHaveLength(2);
  });

  it('A14 pre-existing dirty changes stay intact', async () => {
    const h = harness('quota-after-edit');
    writeFileSync(join(h.repo, 'README.md'), '# demo\nlocal uncommitted edit\n');
    await runOnce(h);
    expect(readFileSync(join(h.repo, 'README.md'), 'utf8')).toBe('# demo\nlocal uncommitted edit\n');
  });

  it('A17 native model fallback is reported as the effective model', async () => {
    const h = harness('native-model-fallback');
    await runOnce(h, 'hi');
    const eff = h.events.find((e) => e.type === 'model.effective' && (e.payload as { effective: string }).effective !== 'claude-opus-5-5')!;
    expect(eff.payload).toMatchObject({ requested: 'claude-opus-5-5', effective: 'claude-sonnet-5-5' });
    const msg = h.events.find((e) => e.type === 'message.completed')!;
    expect((msg.payload as { model: string }).model).toBe('claude-sonnet-5-5');
  });

  it('A18 duplicate and malformed provider events are deduplicated or quarantined', async () => {
    const h = harness('duplicate-events');
    const { session } = await runOnce(h, 'hi');
    const completed = h.events.filter((e) => e.type === 'message.completed').map((e) => (e.payload as { text: string }).text);
    expect(completed).toEqual(['one', 'two']);
    expect(h.store.quarantined(session.id).map((q) => q.reason)).toContain('malformed adapter event');
  });

  it('A19 two clients approve at once: exactly one authoritative resolution', async () => {
    const h = harness('approval');
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    const { runId } = h.relay.sendMessage({ sessionId: s.id, text: 'write it', idempotencyKey: 'k-approval-01' });
    await new Promise((r) => setTimeout(r, 20));
    const [pending] = h.store.pendingApprovals(s.id);
    expect(pending).toBeDefined();
    const [a, b] = await Promise.all([
      h.relay.decideApproval({ approvalId: pending!.id, decision: 'approve', expectedVersion: 0, deviceId: 'desktop' }),
      h.relay.decideApproval({ approvalId: pending!.id, decision: 'approve', expectedVersion: 0, deviceId: 'phone' }),
    ]);
    expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1);
    const run = await h.relay.waitForRun(runId);
    expect(run.state).toBe('completed');
    expect(readFileSync(join(h.repo, 'src/approved.txt'), 'utf8')).toBe('approved\n');
    expect(types(h.events).filter((t) => t === 'approval.resolved')).toHaveLength(1);
  });

  it('idempotent message send does not start a second run', async () => {
    const h = harness('success');
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
    const one = h.relay.sendMessage({ sessionId: s.id, text: 'go', idempotencyKey: 'same-key-123' });
    const two = h.relay.sendMessage({ sessionId: s.id, text: 'go', idempotencyKey: 'same-key-123' });
    expect(two.replayed).toBe(true);
    expect(two.runId).toBe(one.runId);
    await h.relay.waitForRun(one.runId);
    expect(h.store.runsForSession(s.id)).toHaveLength(1);
  });

  it('real sessions never use mock routes', async () => {
    const h = harness('success');
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'real', fallback: { routes: [{ connectionId: 'mock-claude', modelId: 'claude-opus-5-5' }], effort: 'medium', speed: 'standard', autoFallback: true, outageFallback: false, allowApiBilling: false, switchAtPercent: 95, disabledConnections: [], attemptTimeoutMs: 3_600_000, transportRetries: 2, notifyOnSwitch: true } });
    const { runId } = h.relay.sendMessage({ sessionId: s.id, text: 'go', idempotencyKey: 'k-real-mock-1' });
    const run = await h.relay.waitForRun(runId);
    expect(run.state).toBe('paused_auth');
    expect(h.primary.prompts).toHaveLength(0);
  });

  it('chat sessions never write files, even when the provider tries to', async () => {
    const h = harness('success');
    h.store.setSetting('chat.crossProviderConsent', true);
    const s = h.relay.createSession({ projectId: null, mode: 'mock' });
    const { runId } = h.relay.sendMessage({ sessionId: s.id, text: 'hi', idempotencyKey: 'chat-nofs-1' });
    await h.relay.waitForRun(runId);
    expect(types(h.events).filter((t) => t === 'tool.denied')).toHaveLength(TASK_FILES.length);
    expect(h.store.toolActionsForRun(runId).every((a) => a.status === 'denied')).toBe(true);
  });

  it('events have strictly increasing per-session sequence numbers', async () => {
    const h = harness('quota-after-edit');
    const { session } = await runOnce(h);
    const seqs = h.store.listEvents(session.id).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(h.events.map((e) => e.seq)).toEqual(seqs);
  });
});
