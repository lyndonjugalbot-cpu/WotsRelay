import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEventEnvelope, AttemptInput, AttemptOutcome, CaptureEntry } from '@wots/core';
import { CursorAdapter, buildCursorArgs, classifyCursorExit, newCursorStreamState, resolveCursorExecutable, translateCursorLine } from '@wots/adapter-cursor';
import { harness, tempDir } from '../helpers.ts';

// Cursor is not installed yet (D6): these streams are synthesised from the documented
// stream-json schema (cursor.com/docs/cli/reference/output-format) and replayed through the real
// adapter. Each fixture's meta line says "source": "docs"; real captures replace them later.
const REPLAY = resolve('tests/fixtures/replay-provider.ts');
const STREAMS = resolve('tests/fixtures/streams/cursor-docs');

function replayExecutable(fixture: string): string {
  const exe = join(tempDir('wcur-'), 'agent');
  writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${REPLAY}" "${join(STREAMS, fixture)}" "$@"\n`);
  chmodSync(exe, 0o755);
  return exe;
}

const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tempDir('whome-') };
const of = <T extends AdapterEventEnvelope['type']>(events: AdapterEventEnvelope[], type: T) => events.filter((e): e is Extract<AdapterEventEnvelope, { type: T }> => e.type === type);

async function replay(fixture: string, opts: { code?: boolean; interruptOnDelta?: boolean; model?: string } = {}) {
  const captured: CaptureEntry[] = [];
  const sandbox = tempDir('wsb-');
  const adapter = new CursorAdapter({ executable: replayExecutable(fixture), chatSandboxDir: sandbox, env, capture: () => ({ record: (e) => captured.push(e) }) });
  await adapter.probe();
  const h = adapter.startAttempt({ attemptId: 'att_replay', cwd: opts.code ? tempDir('wrepo-') : null, model: opts.model ?? 'default', effort: 'medium', prompt: 'replayed prompt', permissionProfile: opts.code ? 'edit' : 'chat', resumeProviderSessionId: null });
  const events: AdapterEventEnvelope[] = [];
  let interrupted = false;
  for await (const e of h.events) {
    events.push(e);
    if (opts.interruptOnDelta && !interrupted && e.type === 'message.delta') {
      interrupted = true;
      void h.interrupt('test');
    }
  }
  const outcome: AttemptOutcome = await h.done;
  return { events, outcome, captured, sandbox };
}

describe('Cursor docs-derived fixtures', () => {
  it('every fixture is labelled as synthesised from the docs', () => {
    for (const f of ['chat-success', 'code-write', 'chat-malformed-line', 'code-exit-no-result', 'chat-interrupt']) {
      const meta = JSON.parse(readFileSync(join(STREAMS, `${f}.jsonl`), 'utf8').split('\n')[0]!);
      expect(meta).toMatchObject({ d: 'meta', source: 'docs', connectionId: 'cursor' });
    }
  });
});

describe('Cursor adapter (replay)', () => {
  it('success stream: session, model, deltas and one completed message', async () => {
    const { events, outcome, captured, sandbox } = await replay('chat-success.jsonl');
    expect(outcome).toMatchObject({ termination: 'completed', failure: null, quiescent: true, providerSessionId: '00000000-0000-4000-8000-0000000000c1' });
    expect(of(events, 'session.bound')).toHaveLength(1);
    expect(of(events, 'model.effective')[0]).toMatchObject({ model: 'Claude 4 Sonnet' });
    expect(of(events, 'message.delta').map((e) => e.text)).toEqual(['po', 'ng']);
    expect(of(events, 'message.completed').map((e) => e.text)).toEqual(['pong']);
    expect(of(events, 'diagnostic').filter((d) => d.level !== 'info')).toEqual([]);
    // The chat profile runs in the empty chat sandbox, in Cursor's ask mode.
    const start = captured.find((e) => e.d === 'start') as { args: string[] };
    expect(start.args).toEqual(expect.arrayContaining(['--workspace', sandbox, '--mode', 'ask']));
    expect(start.args.at(-1)).toBe('replayed prompt');
    expect(start.args).not.toContain('--model'); // `default` = the account's default model
  });

  it('partial deltas and the duplicate flushes never duplicate text', async () => {
    const { events, outcome } = await replay('code-write.jsonl', { code: true });
    expect(outcome.termination).toBe('completed');
    const completed = of(events, 'message.completed');
    expect(completed.map((e) => e.text)).toEqual(['Reading the README first.', 'Created notes/a.txt.']);
    // Every delta belongs to exactly one completed segment, and the text adds up.
    for (const c of completed) expect(of(events, 'message.delta').filter((d) => d.messageKey === c.messageKey).map((d) => d.text).join('')).toBe(c.text);
    expect(new Set(completed.map((c) => c.messageKey)).size).toBe(2);
    const started = of(events, 'tool.started');
    expect(started.map((e) => [e.name, e.risk, e.paths])).toEqual([
      ['Read', 'read-only', ['README.md']],
      ['Write', 'reversible-local-write', ['notes/a.txt']],
    ]);
    expect(of(events, 'tool.completed').map((e) => e.providerToolId)).toEqual(['call_1', 'call_2']);
  });

  it('a malformed line becomes a diagnostic, not a crash', async () => {
    const { events, outcome } = await replay('chat-malformed-line.jsonl');
    expect(outcome.termination).toBe('completed');
    expect(of(events, 'diagnostic').filter((d) => d.level === 'warn').map((d) => d.message)).toEqual(['Unparseable line from Cursor (ignored)']);
    expect(of(events, 'message.completed').map((e) => e.text)).toEqual(['pong']);
  });

  it('exit 1 without a result: unknown failure with redacted stderr; edits before it are reported', async () => {
    const { events, outcome } = await replay('code-exit-no-result.jsonl', { code: true });
    expect(outcome.termination).toBe('failed');
    expect(outcome.failure).toMatchObject({ kind: 'unknown', evidence: 'exit:1' });
    expect(outcome.failure!.message).toContain('request failed');
    expect(outcome.failure!.message).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(JSON.stringify(events)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
    expect(of(events, 'tool.started').map((e) => e.name)).toEqual(['Write']);
    expect(of(events, 'tool.completed').map((e) => e.providerToolId)).toEqual(['call_9']);
    // The stream ended early: the partial text is never reported as completed.
    expect(of(events, 'message.completed')).toEqual([]);
  });

  it('interrupt sends SIGINT (recorded in the capture) and ends as interrupted', async () => {
    const { events, outcome, captured } = await replay('chat-interrupt.jsonl', { interruptOnDelta: true });
    expect(outcome).toMatchObject({ termination: 'interrupted', failure: null, quiescent: true });
    expect(captured).toContainEqual({ d: 'signal', signal: 'SIGINT' });
    expect(of(events, 'message.delta').length).toBeGreaterThan(0);
    expect(of(events, 'message.completed')).toEqual([]);
  });
});

describe('Cursor adapter (controller)', () => {
  it('exit 1 with no result pauses the run as unknown and journals the edit', async () => {
    const cursor = new CursorAdapter({ executable: replayExecutable('code-exit-no-result.jsonl'), chatSandboxDir: tempDir('wsb-'), env });
    // Stands in for Cursor's write landing on disk (the replayer only plays the stream).
    const h = harness('success', { adapters: [cursor], onEvent: (e) => {
      if (e.type !== 'tool.started') return;
      mkdirSync(join(h.repo, 'notes'), { recursive: true });
      writeFileSync(join(h.repo, 'notes', 'a.txt'), 'hello\n');
    } });
    // Simulates a confirmed sign-in; Cursor's own status stays 'unknown' until a first run.
    h.store.setSetting('conn:cursor', { auth: 'authenticated', billing: 'subscription', models: [] });
    const s = h.relay.createSession({ projectId: h.projectId, mode: 'real', fallback: { routes: [{ connectionId: 'cursor', modelId: 'default' }], effort: 'medium', speed: 'standard', autoFallback: true, outageFallback: false, allowApiBilling: false, switchAtPercent: 95, disabledConnections: [], attemptTimeoutMs: 3_600_000, transportRetries: 2, notifyOnSwitch: true } });
    const { runId } = h.relay.sendMessage({ sessionId: s.id, text: 'Write notes', idempotencyKey: 'cursor-exit-1' });
    const run = await h.relay.waitForRun(runId);
    expect(run.state).toBe('paused_uncertain');
    const tools = h.store.toolActionsForRun(runId);
    expect(tools.map((t) => [t.name, t.status, t.paths])).toEqual([['Write', 'completed', ['notes/a.txt']]]);
    expect(h.events.some((e) => e.type === 'message.interrupted')).toBe(true);
    expect(h.events.some((e) => e.type === 'provider.switched')).toBe(false);
    // The checkpoint the next provider receives lists the edit as done and the file as changed.
    const cp = h.store.latestCheckpoint(s.id)!;
    expect(cp.completedSteps).toEqual(['Write: notes/a.txt']);
    expect(cp.changedFiles.map((f) => f.path)).toContain('notes/a.txt');
  });
});

describe('Cursor arguments', () => {
  const base: AttemptInput = { attemptId: 'a', cwd: '/repo', model: 'gpt-6-astra', effort: 'medium', prompt: 'do it', permissionProfile: 'edit', resumeProviderSessionId: null };

  it('documented flags only; sandbox always on; prompt last', () => {
    expect(buildCursorArgs(base, { applyEdits: false })).toEqual(['-p', '--output-format', 'stream-json', '--stream-partial-output', '--model', 'gpt-6-astra', '--workspace', '/repo', '--trust', '--sandbox', 'enabled', 'do it']);
    expect(buildCursorArgs({ ...base, resumeProviderSessionId: 'chat-1' }, { applyEdits: false })).toEqual(expect.arrayContaining(['--resume', 'chat-1']));
    expect(buildCursorArgs({ ...base, permissionProfile: 'chat' }, { applyEdits: false })).toEqual(expect.arrayContaining(['--mode', 'ask']));
    expect(buildCursorArgs({ ...base, permissionProfile: 'read-only' }, { applyEdits: false })).toEqual(expect.arrayContaining(['--mode', 'plan']));
  });

  it('never --yolo or --approve-mcps; --force only when edits are opted in for an edit-profile project', () => {
    for (const permissionProfile of ['edit', 'read-only', 'chat'] as const) {
      for (const applyEdits of [false, true]) {
        const args = buildCursorArgs({ ...base, permissionProfile }, { applyEdits });
        expect(args).not.toContain('--yolo');
        expect(args).not.toContain('--approve-mcps');
        expect(args).not.toContain('--dangerously-skip-permissions');
        expect(args.includes('--force') || args.includes('-f')).toBe(applyEdits && permissionProfile === 'edit');
        expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual(['--sandbox', 'enabled']);
      }
    }
  });

  it('a prompt that looks like a flag can never become one', () => {
    const args = buildCursorArgs({ ...base, prompt: '--force' }, { applyEdits: false });
    expect(args).not.toContain('--force');
    expect(args.at(-1)!.trim()).toBe('--force');
  });

  it('the chat profile runs in the chat sandbox even if a cwd is given', async () => {
    const captured: CaptureEntry[] = [];
    const sandbox = join(tempDir('wsb-'), 'chat');
    const adapter = new CursorAdapter({ executable: replayExecutable('chat-success.jsonl'), chatSandboxDir: sandbox, env, capture: () => ({ record: (e) => captured.push(e) }) });
    const h = adapter.startAttempt({ ...base, cwd: tempDir('wrepo-'), permissionProfile: 'chat' });
    for await (const _ of h.events);
    await h.done;
    const start = captured.find((e) => e.d === 'start') as { args: string[] };
    expect(start.args[start.args.indexOf('--workspace') + 1]).toBe(sandbox);
  });

  it('per-project edit opt-in drives --force and the reported capabilities', async () => {
    const captured: CaptureEntry[] = [];
    const adapter = new CursorAdapter({ executable: replayExecutable('code-write.jsonl'), chatSandboxDir: tempDir('wsb-'), env, applyEdits: (id) => id === 'prj_on', capture: () => ({ record: (e) => captured.push(e) }) });
    expect(adapter.capabilities()).toEqual({ streaming: true, nativeResume: true, approvals: 'none', edits: 'proposals-only', usage: 'none', models: 'listed' });
    expect(adapter.capabilities('prj_on').edits).toBe('apply');
    const h = adapter.startAttempt({ ...base, cwd: tempDir('wrepo-'), projectId: 'prj_on' });
    for await (const _ of h.events);
    await h.done;
    expect((captured.find((e) => e.d === 'start') as { args: string[] }).args).toContain('--force');
  });
});

describe('Cursor translation', () => {
  it('shell tool calls are classified by their command', () => {
    const st = newCursorStreamState();
    const ev = (command: string, id: string) => translateCursorLine({ type: 'tool_call', subtype: 'started', call_id: id, tool_call: { shellToolCall: { args: { command } } } }, st, 'default');
    expect(ev('ls -la', 'c1')[0]).toMatchObject({ type: 'tool.started', name: 'Shell', risk: 'read-only' });
    expect(ev('curl https://example.com', 'c2')[0]).toMatchObject({ risk: 'external-side-effect' });
  });

  it('function-form tool calls parse their arguments; unknown tools stay unknown risk', () => {
    const st = newCursorStreamState();
    const out = translateCursorLine({ type: 'tool_call', subtype: 'started', call_id: 'f1', tool_call: { function: { name: 'mystery', arguments: '{"x":1}' } } }, st, 'default');
    expect(out[0]).toMatchObject({ type: 'tool.started', name: 'mystery', args: { x: 1 }, risk: 'unknown' });
    // No documented result shape: the call is left unresolved (the runner marks it unknown).
    const done = translateCursorLine({ type: 'tool_call', subtype: 'completed', call_id: 'f1', tool_call: { function: { name: 'mystery', arguments: '{"x":1}' } } }, st, 'default');
    expect(done.some((e) => e.type === 'tool.completed')).toBe(false);
  });

  it('a tool result that is not success is reported as failed, redacted', () => {
    const st = newCursorStreamState();
    const out = translateCursorLine({ type: 'tool_call', subtype: 'completed', call_id: 'w1', tool_call: { writeToolCall: { args: { path: 'a' }, result: { error: { message: 'denied sk-ant-abcdefghijklmnopqrstuvwxyz0123' } } } } }, st, 'default');
    expect(out[0]).toMatchObject({ type: 'tool.failed', providerToolId: 'w1' });
    expect(JSON.stringify(out)).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123');
  });

  it('success needs a non-error result and exit 0', () => {
    const st = newCursorStreamState();
    expect(classifyCursorExit(st, { code: 0, signal: null })).toMatchObject({ kind: 'unknown' });
    translateCursorLine({ type: 'result', subtype: 'success', is_error: false, result: 'x' }, st, 'default');
    expect(classifyCursorExit(st, { code: 0, signal: null })).toBeNull();
    expect(classifyCursorExit(st, { code: 2, signal: null })).toMatchObject({ kind: 'unknown', evidence: 'exit:2' });
    const err = newCursorStreamState();
    translateCursorLine({ type: 'result', subtype: 'success', is_error: true, result: 'x' }, err, 'default');
    expect(classifyCursorExit(err, { code: 0, signal: null })).toMatchObject({ kind: 'unknown' });
  });
});

describe('Cursor install detection and status', () => {
  const fake = (dir: string, name: string, out: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\necho "${out}"\n`);
    chmodSync(join(dir, name), 0o755);
  };

  it('missing binary: probe reports not installed and attempts fail as auth', async () => {
    const adapter = new CursorAdapter({ executable: null, chatSandboxDir: tempDir('wsb-'), env });
    expect(await adapter.probe()).toMatchObject({ installed: false, executablePath: null });
    expect(resolveCursorExecutable({ PATH: tempDir('wempty-') })).toBeNull();
    const h = adapter.startAttempt({ attemptId: 'a', cwd: null, model: 'default', effort: 'medium', prompt: 'x', permissionProfile: 'chat', resumeProviderSessionId: null });
    expect((await h.done).failure).toMatchObject({ kind: 'auth', message: 'Cursor CLI is not installed' });
    expect((await adapter.getConnectionStatus()).authStatus).toBe('not-installed');
  });

  it('accepts `agent` or the legacy `cursor-agent` only when --version parses', () => {
    const a = tempDir('wpath-');
    const b = tempDir('wpath-');
    fake(a, 'agent', 'some other agent tool');
    fake(b, 'cursor-agent', '2026.10.28-abc1234');
    expect(resolveCursorExecutable({ PATH: `${a}:${b}` })).toBe(join(b, 'cursor-agent'));
    const c = tempDir('wpath-');
    fake(c, 'agent', '2026.10.28-abc1234');
    expect(resolveCursorExecutable({ PATH: `${c}:${b}` })).toBe(join(c, 'agent'));
  });

  it('connection status: sign-in unknown until the first run, billing unknown, models after a capture', async () => {
    const adapter = new CursorAdapter({ executable: replayExecutable('chat-success.jsonl'), chatSandboxDir: tempDir('wsb-'), env });
    const c = await adapter.getConnectionStatus();
    expect(c).toMatchObject({ id: 'cursor', provider: 'cursor', adapter: 'cursor-cli', authStatus: 'unknown', billingMode: 'unknown', toolVersion: '2026.10.28', isMock: false });
    expect(c.limitations).toEqual(expect.arrayContaining(['Sign-in is confirmed by the first run', 'Model list available after the first captured run']));
    expect(await adapter.listModels()).toEqual([]);
    expect(adapter).toMatchObject({ connectionId: 'cursor', provider: 'cursor', kind: 'cursor-cli', isMock: false });
  });
});
