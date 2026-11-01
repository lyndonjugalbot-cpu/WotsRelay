import { chmodSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEventEnvelope, AttemptOutcome, ProviderAdapter } from '@wots/core';
import { ClaudeCodeAdapter } from '@wots/adapter-claude-code';
import { CodexAdapter } from '@wots/adapter-codex';
import { tempDir } from '../helpers.ts';

// Real captured provider streams (tests/fixtures/streams, sanitized) replayed through the real
// adapters. The replayer gates output on the adapter's own writes and signals, and exits 99 if the
// adapter sends a different JSON-RPC method than the real run did.
const REPLAY = resolve('tests/fixtures/replay-provider.ts');
const STREAMS = resolve('tests/fixtures/streams');

function replayExecutable(fixture: string): string {
  const exe = join(tempDir('wrp-'), 'provider');
  writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${REPLAY}" "${join(STREAMS, fixture)}" "$@"\n`);
  chmodSync(exe, 0o755);
  return exe;
}

async function replay(
  make: (exe: string, sandbox: string) => ProviderAdapter,
  fixture: string,
  opts: { model: string; code?: boolean; interruptOnDelta?: boolean; approval?: 'approve' | 'reject' },
): Promise<{ events: AdapterEventEnvelope[]; outcome: AttemptOutcome }> {
  const adapter = make(replayExecutable(fixture), tempDir('wsb-'));
  await adapter.probe();
  const h = adapter.startAttempt({
    attemptId: 'att_replay',
    cwd: opts.code ? tempDir('wrepo-') : null,
    model: opts.model,
    effort: 'medium',
    prompt: 'replayed prompt',
    permissionProfile: opts.code ? 'edit' : 'chat',
    resumeProviderSessionId: null,
  });
  const events: AdapterEventEnvelope[] = [];
  let interrupted = false;
  for await (const e of h.events) {
    events.push(e);
    if (opts.interruptOnDelta && !interrupted && e.type === 'message.delta') {
      interrupted = true;
      void h.interrupt('test');
    }
    if (e.type === 'approval.requested' && opts.approval) void h.answerApproval(e.providerRequestId, opts.approval);
  }
  const outcome = await h.done;
  await adapter.dispose();
  return { events, outcome };
}

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tempDir('whome-') };
const claude = (exe: string, sandbox: string) => new ClaudeCodeAdapter({ executable: exe, chatSandboxDir: sandbox, env });
const codex = (exe: string, sandbox: string) => new CodexAdapter({ executable: exe, chatSandboxDir: sandbox, env });
const of = <T extends AdapterEventEnvelope['type']>(events: AdapterEventEnvelope[], type: T) => events.filter((e): e is Extract<AdapterEventEnvelope, { type: T }> => e.type === type);
const noProblems = (events: AdapterEventEnvelope[]) => expect(of(events, 'diagnostic').filter((d) => d.level !== 'info')).toEqual([]);

describe('captured Claude Code 2.1.316 streams', () => {
  it('chat success', async () => {
    const { events, outcome } = await replay(claude, 'claude-code-2.1.316/chat-success.jsonl', { model: 'claude-opus-5-5' });
    expect(outcome).toMatchObject({ termination: 'completed', failure: null, quiescent: true });
    expect(of(events, 'session.bound')).toHaveLength(1);
    expect(of(events, 'model.effective')[0]).toMatchObject({ model: 'claude-opus-5-5' });
    expect(of(events, 'message.completed').map((e) => e.text)).toEqual(['pong']);
    // Real reading at capture time: the 5-hour window was 99% used.
    expect(of(events, 'usage.observed').map((e) => [e.observation.scope, e.observation.value])).toEqual([
      ['five_hour', 99],
      ['seven_day', 14],
    ]);
    noProblems(events);
  });

  // Asked to create a file, the model used Bash (mkdir + printf), not Write: shell writes carry no
  // paths, so handoff de-duplication must keep relying on the checkpoint's git diff.
  it('coding turn that writes a file through Bash', async () => {
    const { events, outcome } = await replay(claude, 'claude-code-2.1.316/code-shell-write.jsonl', { model: 'claude-opus-5-5', code: true });
    expect(outcome.termination).toBe('completed');
    const started = of(events, 'tool.started');
    expect(started.map((e) => e.name)).toEqual(['Bash']);
    expect(started[0]!.args).toMatchObject({ command: expect.stringContaining('notes/c.txt') });
    expect(of(events, 'tool.completed').map((e) => e.providerToolId)).toEqual(started.map((e) => e.providerToolId));
    noProblems(events);
  });

  it('interrupt mid-answer: partial text is not reported as a completed message', async () => {
    const { events, outcome } = await replay(claude, 'claude-code-2.1.316/chat-interrupt.jsonl', { model: 'claude-opus-5-5', interruptOnDelta: true });
    expect(outcome).toMatchObject({ termination: 'interrupted', quiescent: true });
    expect(of(events, 'message.delta').length).toBeGreaterThan(0);
    expect(of(events, 'message.completed')).toEqual([]);
  });
});

describe('captured Codex 0.166.0 app-server streams', () => {
  it('chat success, with rate-limit observations', async () => {
    const { events, outcome } = await replay(codex, 'codex-0.166.0/chat-success.jsonl', { model: 'gpt-6-astra' });
    expect(outcome).toMatchObject({ termination: 'completed', failure: null });
    expect(of(events, 'model.effective')[0]).toMatchObject({ model: 'gpt-6-astra', effort: 'medium' });
    expect(of(events, 'message.completed').map((e) => e.text)).toEqual(['pong']);
    expect([...new Set(of(events, 'usage.observed').map((e) => e.observation.scope))].sort()).toEqual(['five_hour', 'seven_day']);
    noProblems(events);
  });

  it('coding turn that writes a file through a shell command', async () => {
    const { events, outcome } = await replay(codex, 'codex-0.166.0/code-shell-write.jsonl', { model: 'gpt-6-astra', code: true });
    expect(outcome.termination).toBe('completed');
    const started = of(events, 'tool.started');
    expect(started.map((e) => e.name)).toEqual(['Shell']);
    expect(started[0]!.args).toMatchObject({ command: expect.stringContaining('notes/d.txt') });
    expect(of(events, 'tool.completed').length).toBe(of(events, 'tool.started').length);
    noProblems(events);
  });

  it('interrupt mid-answer via turn/interrupt', async () => {
    const { events, outcome } = await replay(codex, 'codex-0.166.0/chat-interrupt.jsonl', { model: 'gpt-6-astra', interruptOnDelta: true });
    expect(outcome.termination).toBe('interrupted');
    expect(of(events, 'message.completed')).toEqual([]);
  });

  it('rejected approval: the command is denied and the turn still completes', async () => {
    const { events, outcome } = await replay(codex, 'codex-0.166.0/approval-reject.jsonl', { model: 'gpt-6-astra', code: true, approval: 'reject' });
    expect(outcome.termination).toBe('completed');
    const req = of(events, 'approval.requested');
    expect(req).toHaveLength(1);
    expect(req[0]!.action).toMatch(/^Run: curl /);
    expect(req[0]).toMatchObject({ risk: 'external-side-effect', canApproveForSession: true });
    expect(of(events, 'tool.denied').length).toBeGreaterThan(0);
  });
});

describe('capture and replay tooling', () => {
  it('replayer exits 99 when the adapter sends a different JSON-RPC method than the capture', async () => {
    const { spawn } = await import('node:child_process');
    const p = spawn(process.execPath, [REPLAY, join(STREAMS, 'codex-0.166.0/chat-success.jsonl'), 'app-server'], { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stdin.write(`${JSON.stringify({ id: 1, method: 'thread/start', params: {} })}\n`);
    const code = await new Promise<number | null>((r) => p.on('close', r));
    expect(code).toBe(99);
  });

  it('capture writer is off unless enabled, redacts secrets and writes user-only files', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { fileCapture } = await import('../../apps/runner/src/capture.ts');
    const dir = join(tempDir('wcapt-'), 'captures');
    let on = false;
    const factory = fileCapture(dir, () => on);
    expect(factory({ connectionId: 'codex', version: '0.166.0' })).toBeNull();
    on = true;
    const cap = factory({ connectionId: 'codex', version: '0.166.0' })!;
    cap.record({ d: 'start', args: ['app-server'] });
    cap.record({ d: 'in', line: 'token sk-ant-abcdefghijklmnopqrstuvwxyz0123' });
    cap.record({ d: 'out', line: '{"ok":true}' });
    cap.record({ d: 'exit', code: 0, signal: null });
    const [file] = readdirSync(dir);
    const text = readFileSync(join(dir, file!), 'utf8');
    expect(text).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(text).toContain('[REDACTED:anthropic-key]');
    expect(text.trim().split('\n').map((l) => JSON.parse(l).d)).toEqual(['meta', 'start', 'in', 'out', 'exit']);
    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, file!)).mode & 0o077).toBe(0);
  });
});
