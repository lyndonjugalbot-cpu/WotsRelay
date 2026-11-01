import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildArgs, classifyClaudeFailure, classifyToolRisk, newStreamState, translateLine } from '@wots/adapter-claude-code';
import { classifyCodexError, failureFromTurnError, sandboxFor } from '@wots/adapter-codex';

describe('Claude Code adapter (documented stream-json)', () => {
  it('builds only documented flags and keeps project hooks/MCP out of -p runs', () => {
    const args = buildArgs({ model: 'claude-opus-5-5', effort: 'medium', permissionProfile: 'edit', resumeProviderSessionId: null });
    expect(args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--model', 'claude-opus-5-5', '--effort', 'medium', '--setting-sources', 'user', '--strict-mcp-config', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none']));
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--fallback-model');
    expect(args.join(' ')).not.toMatch(/api.?key|token/i);
    expect(buildArgs({ model: 'm', effort: 'medium', permissionProfile: 'chat', resumeProviderSessionId: null })).toEqual(expect.arrayContaining(['--permission-mode', 'dontAsk']));
  });

  it('translates init, deltas, assistant text, tools and results', () => {
    const st = newStreamState();
    const ev = (m: object) => translateLine(m as Record<string, unknown>, st, 'claude-opus-5-5');
    expect(ev({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' })).toEqual([
      { type: 'session.bound', providerSessionId: 's1' },
      { type: 'model.effective', model: 'claude-opus-5-5', effort: null, note: undefined },
    ]);
    ev({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_1' } } });
    expect(ev({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } })).toEqual([{ type: 'message.delta', messageKey: 'msg_1', text: 'Hi' }]);
    const a = ev({ type: 'assistant', uuid: 'u1', parent_tool_use_id: null, message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/p/a.ts' } }] } });
    expect(a.map((e) => e.type)).toEqual(['message.completed', 'tool.started']);
    expect(a[1]).toMatchObject({ risk: 'reversible-local-write', paths: ['/p/a.ts'] });
    expect(ev({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'ok' }] } })[0]).toMatchObject({ type: 'tool.completed', providerToolId: 'tu1' });
    ev({ type: 'result', subtype: 'success', is_error: false });
    expect(classifyClaudeFailure(st, { code: 0, signal: null }, '2.1.316')).toBeNull();
  });

  it('reports a different served model (native fallback)', () => {
    const st = newStreamState();
    const out = translateLine({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm', model: 'claude-sonnet-5-5', content: [] } }, st, 'claude-opus-5-5');
    expect(out[0]).toMatchObject({ type: 'model.effective', model: 'claude-sonnet-5-5' });
  });

  it('classifies conservatively: a rate-limit retry is only a suspected limit; unknown errors stay unknown', () => {
    const st = newStreamState();
    translateLine({ type: 'system', subtype: 'api_retry', error: 'rate_limit', error_status: 429, attempt: 10, max_retries: 10 }, st, 'm');
    translateLine({ type: 'result', subtype: 'error_during_execution', is_error: true }, st, 'm');
    expect(classifyClaudeFailure(st, { code: 1, signal: null }, '2.1.316')!.kind).toBe('usage_limit_suspected');

    const st2 = newStreamState();
    translateLine({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'You have hit your usage limit' }, st2, 'm');
    // Prose is never used as a control signal.
    expect(classifyClaudeFailure(st2, { code: 1, signal: null }, '2.1.316')!.kind).toBe('unknown');

    const st3 = newStreamState();
    translateLine({ type: 'system', subtype: 'api_retry', error: 'authentication_failed', attempt: 3, max_retries: 3 }, st3, 'm');
    translateLine({ type: 'result', subtype: 'error_during_execution', is_error: true }, st3, 'm');
    expect(classifyClaudeFailure(st3, { code: 1, signal: null }, '2.1.316')!.kind).toBe('auth');
  });

  it('treats shell commands as unknown risk unless plainly read-only', () => {
    expect(classifyToolRisk('Bash', { command: 'git status' })).toBe('read-only');
    expect(classifyToolRisk('Bash', { command: 'git status; rm -rf x' })).toBe('unknown');
    expect(classifyToolRisk('Bash', { command: 'npm run deploy' })).toBe('unknown');
    expect(classifyToolRisk('Read', {})).toBe('read-only');
  });
});

describe('Codex adapter (app-server schema 0.166)', () => {
  it('maps structured codexErrorInfo; only usageLimitExceeded is a confirmed limit', () => {
    expect(classifyCodexError('usageLimitExceeded').kind).toBe('usage_limit');
    expect(classifyCodexError('rateLimitExceeded').kind).toBe('transient_throttle');
    expect(classifyCodexError('unauthorized').kind).toBe('auth');
    expect(classifyCodexError('cyberPolicy').kind).toBe('policy_refusal');
    expect(classifyCodexError('contextWindowExceeded').kind).toBe('context_too_large');
    expect(classifyCodexError({ responseStreamDisconnected: { httpStatusCode: null } }).kind).toBe('transport');
    expect(classifyCodexError('somethingNew').kind).toBe('unknown');
    expect(classifyCodexError(undefined).kind).toBe('unknown');
    expect(failureFromTurnError({ message: 'x', codexErrorInfo: 'usageLimitExceeded' })).toMatchObject({ kind: 'usage_limit', evidence: 'codexErrorInfo=usageLimitExceeded', simulated: false });
  });

  it('every mapped codexErrorInfo string exists in the pinned schema', () => {
    const schema = JSON.parse(readFileSync('tests/fixtures/codex-schema/codex_app_server_protocol.v2.schemas.json', 'utf8'));
    const known: string[] = schema.definitions.CodexErrorInfo.anyOf[0].enum;
    for (const k of ['usageLimitExceeded', 'rateLimitExceeded', 'unauthorized', 'modelNotFound', 'contextWindowExceeded', 'serverOverloaded', 'cyberPolicy', 'tooManyDenials']) expect(known).toContain(k);
  });

  it('every method the adapter calls exists in the pinned schema', () => {
    const raw = ['codex_app_server_protocol.v2.schemas.json', 'ServerRequest.json', 'ServerNotification.json', 'ClientRequest.json'].map((f) => readFileSync(`tests/fixtures/codex-schema/${f}`, 'utf8')).join('\n');
    for (const m of ['initialize', 'thread/start', 'turn/start', 'turn/interrupt', 'account/read', 'model/list', 'item/agentMessage/delta', 'turn/completed', 'item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'account/rateLimits/updated', 'model/rerouted']) {
      expect(raw).toContain(`"${m}"`);
    }
  });

  it('maps permission profiles to sandbox modes', () => {
    expect(sandboxFor('edit')).toBe('workspace-write');
    expect(sandboxFor('read-only')).toBe('read-only');
    expect(sandboxFor('chat')).toBe('read-only');
  });
});
