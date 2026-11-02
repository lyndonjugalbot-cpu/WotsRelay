// Controls the official Cursor CLI (`agent`) through documented flags only
// (cursor.com/docs/cli/reference/parameters, /output-format, read 2026-11-02). Authentication
// stays inside Cursor (`agent login` or CURSOR_API_KEY): this adapter never reads its credentials.
// Cursor is not installed on the development machine yet (D6), so the stream handling below is
// derived from the documented schema and tested against docs-derived fixtures only.
import { mkdirSync } from 'node:fs';
import {
  EventChannel,
  PROPOSED_ONLY_PREFIX,
  execVersion,
  lineReader,
  resolveExecutable,
  classifyShellCommand,
  spawnManaged,
  type AdapterEventEnvelope,
  type AttemptHandle,
  type AttemptInput,
  type AttemptOutcome,
  type CaptureFactory,
  type ProbeResult,
  type ProviderAdapter,
} from '@wots/core';
import type { Connection, Failure, ModelCapability, ProviderCapabilities, RiskCategory } from '@wots/protocol';
import { redact } from '@wots/security';

export const ADAPTER_VERSION = '0.1.0';
const VERSION_RE = /\d+\.\d+\.\d+/;
const SIGN_IN_NOTE = 'Sign-in is confirmed by the first run';
const MODELS_NOTE = 'Model list available after the first captured run';

export interface CursorOptions {
  connectionId?: string;
  executable?: string | null;
  env?: NodeJS.ProcessEnv;
  // Empty directory used as the workspace for chat sessions so no project files are reachable.
  chatSandboxDir: string;
  capture?: CaptureFactory;
  // Per-project opt-in (`cursor.applyEdits:<projectId>`, default off). Without it Cursor only proposes edits.
  applyEdits?: (projectId: string) => boolean;
}

export function parseVersion(out: string | null): string | null {
  return out?.match(VERSION_RE)?.[0] ?? null;
}

// `agent` is the documented executable; `cursor-agent` is a legacy name. A binary is accepted only
// when its --version output parses, so an unrelated `agent` on PATH is never driven.
export function resolveCursorExecutable(env: NodeJS.ProcessEnv): string | null {
  for (const name of ['agent', 'cursor-agent']) {
    const exe = resolveExecutable(name, env);
    if (exe && parseVersion(execVersion(exe))) return exe;
  }
  return null;
}

export function buildCursorArgs(input: Pick<AttemptInput, 'model' | 'cwd' | 'prompt' | 'permissionProfile' | 'resumeProviderSessionId'>, opts: { applyEdits: boolean }): string[] {
  const args = ['-p', '--output-format', 'stream-json', '--stream-partial-output'];
  // `default` means Cursor's account default model: no --model flag.
  if (input.model !== 'default') args.push('--model', input.model);
  if (input.cwd) args.push('--workspace', input.cwd);
  // --trust is headless-only and skips the workspace-trust prompt; the sandbox stays on regardless.
  args.push('--trust', '--sandbox', 'enabled');
  if (input.resumeProviderSessionId) args.push('--resume', input.resumeProviderSessionId);
  if (input.permissionProfile === 'chat') args.push('--mode', 'ask');
  else if (input.permissionProfile === 'read-only') args.push('--mode', 'plan');
  // Never --yolo or --approve-mcps. --force (apply edits, run allowed commands) only on the
  // project's explicit opt-in, and only for an edit-profile project (D1).
  else if (opts.applyEdits) args.push('--force');
  // The prompt is the final positional argument, the only documented form (`agent -p "prompt"`).
  // It is therefore visible in this machine's process list while the run is active; switch to
  // stdin once a live capture confirms -p reads it (R7). A leading space keeps a prompt that
  // starts with "-" from ever being parsed as a flag.
  args.push(input.prompt.startsWith('-') ? ` ${input.prompt}` : input.prompt);
  return args;
}

// Documented tool_call keys (readToolCall, writeToolCall) plus the obvious siblings. Anything not
// listed is 'unknown' risk.
const TOOL_KINDS: Record<string, { name: string; risk: RiskCategory | 'shell' }> = {
  readToolCall: { name: 'Read', risk: 'read-only' },
  lsToolCall: { name: 'LS', risk: 'read-only' },
  globToolCall: { name: 'Glob', risk: 'read-only' },
  grepToolCall: { name: 'Grep', risk: 'read-only' },
  writeToolCall: { name: 'Write', risk: 'reversible-local-write' },
  editToolCall: { name: 'Edit', risk: 'reversible-local-write' },
  shellToolCall: { name: 'Shell', risk: 'shell' },
};

type Json = Record<string, unknown>;

function describeTool(toolCall: unknown): { name: string; args: unknown; risk: RiskCategory; result: unknown; documentedResult: boolean } | null {
  if (!toolCall || typeof toolCall !== 'object') return null;
  const tc = toolCall as Json;
  const fn = tc.function as { name?: unknown; arguments?: unknown } | undefined;
  if (fn && typeof fn.name === 'string') {
    let args: unknown = fn.arguments ?? null;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        /* keep the raw string */
      }
    }
    const kind = Object.values(TOOL_KINDS).find((k) => k.name.toLowerCase() === String(fn.name).toLowerCase());
    return { name: fn.name, args, risk: riskOf(kind?.risk ?? 'unknown', args), result: undefined, documentedResult: false };
  }
  const key = Object.keys(tc)[0];
  if (!key) return null;
  const body = (tc[key] ?? {}) as Json;
  const kind = TOOL_KINDS[key];
  const name = kind?.name ?? key.replace(/ToolCall$/, '');
  return { name, args: body.args ?? null, risk: riskOf(kind?.risk ?? 'unknown', body.args), result: body.result, documentedResult: true };
}

function riskOf(risk: RiskCategory | 'shell', args: unknown): RiskCategory {
  if (risk !== 'shell') return risk;
  const cmd = (args as { command?: unknown } | null)?.command;
  return typeof cmd === 'string' ? classifyShellCommand(cmd) : 'unknown';
}

function toolPaths(args: unknown): string[] {
  const a = args as Json | null;
  if (!a || typeof a !== 'object') return [];
  return ['path', 'file_path', 'filePath'].map((k) => a[k]).filter((v): v is string => typeof v === 'string');
}

export interface CursorStreamState {
  sessionId: string | null;
  sawResult: boolean;
  resultIsError: boolean;
  // Text segment between tool calls: deltas accumulate here until a flush or a tool call closes it.
  segment: number;
  segmentText: string;
  // Once any delta has arrived, every flush is a duplicate (even one after a trailing tool call).
  sawDelta: boolean;
  // Whether this attempt ran with --force. Without it Cursor only proposes edits.
  applyEdits: boolean;
  stderrTail: string;
}

export function newCursorStreamState(opts: { applyEdits?: boolean } = {}): CursorStreamState {
  return { sessionId: null, sawResult: false, resultIsError: false, segment: 0, segmentText: '', sawDelta: false, applyEdits: opts.applyEdits ?? false, stderrTail: '' };
}

export const PROPOSED_ONLY = `${PROPOSED_ONLY_PREFIX} — Cursor did not apply this change (edits are off for this project)`;
const EDIT_TOOLS = new Set(['Write', 'Edit']);

function textOf(msg: Json): string {
  const content = (msg.message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? content.filter((b: Json) => b?.type === 'text').map((b: Json) => String(b.text ?? '')).join('') : '';
}

const segmentKey = (st: CursorStreamState) => `${st.sessionId ?? 'cursor'}:${st.segment}`;

// Close the current text segment. The completed text is what the deltas carried; a flush's own
// text is used only when the attempt has streamed no delta at all (the flushes duplicate earlier
// deltas, per the docs, and the end-of-turn flush can repeat segments already closed).
function closeSegment(st: CursorStreamState, flushText: string): AdapterEventEnvelope[] {
  const text = st.segmentText || (st.sawDelta ? '' : flushText);
  const out: AdapterEventEnvelope[] = text ? [{ type: 'message.completed', messageKey: segmentKey(st), text }] : [];
  if (text) st.segment++;
  st.segmentText = '';
  return out;
}

// Pure translation of one documented stream-json line into normalized adapter events.
// With --stream-partial-output there are three kinds of `assistant` events: a streaming delta
// (timestamp_ms, no model_call_id) is the only one with new text; the pre-tool-call flush
// (timestamp_ms and model_call_id) and the end-of-turn flush (neither) repeat earlier text.
export function translateCursorLine(msg: Json, st: CursorStreamState, requestedModel: string): AdapterEventEnvelope[] {
  const out: AdapterEventEnvelope[] = [];
  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        if (typeof msg.session_id === 'string') {
          st.sessionId = msg.session_id;
          out.push({ type: 'session.bound', providerSessionId: msg.session_id });
        }
        if (typeof msg.model === 'string') {
          const note = requestedModel === 'default' ? 'Cursor account default model' : msg.model !== requestedModel ? 'Cursor reported a different session model' : undefined;
          out.push({ type: 'model.effective', model: msg.model, effort: null, note });
        }
      }
      return out;
    case 'assistant': {
      const text = textOf(msg);
      const isDelta = msg.timestamp_ms !== undefined && msg.model_call_id === undefined;
      if (isDelta) {
        if (text) {
          st.sawDelta = true;
          st.segmentText += text;
          out.push({ type: 'message.delta', messageKey: segmentKey(st), text });
        }
        return out;
      }
      return closeSegment(st, text);
    }
    case 'tool_call': {
      const id = typeof msg.call_id === 'string' ? msg.call_id : null;
      const tool = describeTool(msg.tool_call);
      if (!id || !tool) {
        out.push({ type: 'diagnostic', level: 'warn', message: 'Cursor tool_call without a call id or tool (ignored)' });
        return out;
      }
      if (msg.subtype === 'started') {
        out.push(...closeSegment(st, ''));
        out.push({ type: 'tool.started', providerToolId: id, name: tool.name, args: tool.args, risk: tool.risk, paths: toolPaths(tool.args) });
      } else if (msg.subtype === 'completed') {
        const r = tool.result as Json | undefined;
        if (r && typeof r === 'object' && 'success' in r && EDIT_TOOLS.has(tool.name) && !st.applyEdits) {
          // Without --force Cursor proposes the change but does not write it: never journal it as done (R9).
          out.push({ type: 'tool.denied', providerToolId: id, message: PROPOSED_ONLY });
        } else if (r && typeof r === 'object' && 'success' in r) {
          out.push({ type: 'tool.completed', providerToolId: id, result: JSON.stringify(r.success ?? null).slice(0, 2000) });
        } else if (r && typeof r === 'object') {
          const [key] = Object.keys(r);
          const detail = (r[key ?? ''] as { message?: unknown } | undefined)?.message;
          out.push({ type: 'tool.failed', providerToolId: id, message: redact(`Cursor reported ${key ?? 'a failure'}${typeof detail === 'string' ? `: ${detail}` : ''}`).slice(0, 500) });
        } else {
          // No documented result shape: leave the call unresolved so the runner records it as unknown.
          out.push({ type: 'diagnostic', level: 'info', message: `Cursor tool ${tool.name} completed without a documented result` });
        }
      }
      return out;
    }
    case 'result':
      st.sawResult = true;
      st.resultIsError = msg.is_error !== false || msg.subtype !== 'success';
      out.push(...closeSegment(st, ''));
      return out;
    default:
      return out;
  }
}

// Success needs a non-error result and exit 0. Cursor documents no structured error (a failed run
// exits non-zero with a message on stderr), so every failure is 'unknown' and pauses; no limit
// mapping exists without structured evidence.
export function classifyCursorExit(st: CursorStreamState, exit: { code: number | null; signal: NodeJS.Signals | null }): Failure | null {
  if (st.sawResult && !st.resultIsError && exit.code === 0) return null;
  const tail = redact(st.stderrTail.trim()).slice(-500);
  const what = st.sawResult && st.resultIsError ? 'Cursor reported an error result' : `Cursor exited with ${exit.signal ?? `code ${exit.code}`} without a result`;
  return { kind: 'unknown', message: tail ? `${what}: ${tail}` : what, evidence: `exit:${exit.code ?? exit.signal}`, retryAfterMs: null, resetAt: null, scope: null, simulated: false };
}

export class CursorAdapter implements ProviderAdapter {
  readonly provider = 'cursor' as const;
  readonly kind = 'cursor-cli' as const;
  readonly isMock = false;
  readonly connectionId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exe: string | null;
  private version: string | null = null;
  private readonly opts: CursorOptions;

  constructor(opts: CursorOptions) {
    this.opts = opts;
    this.connectionId = opts.connectionId ?? 'cursor';
    this.env = opts.env ?? process.env;
    this.exe = opts.executable === undefined ? resolveCursorExecutable(this.env) : opts.executable;
  }

  private applyEdits(projectId: string | null | undefined): boolean {
    return !!projectId && (this.opts.applyEdits?.(projectId) ?? false);
  }

  capabilities(projectId?: string | null): ProviderCapabilities {
    return { streaming: true, nativeResume: true, approvals: 'none', edits: this.applyEdits(projectId) ? 'apply' : 'proposals-only', usage: 'none', models: 'listed' };
  }

  async probe(): Promise<ProbeResult> {
    if (!this.exe) return { installed: false, executablePath: null, version: null, supportedVersion: false, notes: ['Cursor CLI not found on PATH. Install it from https://cursor.com/docs/cli/installation'] };
    this.version = parseVersion(execVersion(this.exe));
    return { installed: true, executablePath: this.exe, version: this.version, supportedVersion: !!this.version, notes: ['Stream handling follows the documented output format; not yet checked against a captured run.'] };
  }

  async getConnectionStatus(): Promise<Connection> {
    const probe = await this.probe();
    // `agent status` output is not captured yet (D6), so sign-in is not parsed from it.
    return {
      id: this.connectionId,
      provider: 'cursor',
      adapter: 'cursor-cli',
      adapterVersion: ADAPTER_VERSION,
      toolVersion: probe.version,
      executablePath: probe.executablePath,
      credentialRef: 'native:cursor',
      authStatus: probe.installed ? 'unknown' : 'not-installed',
      billingMode: 'unknown',
      lastChecked: new Date().toISOString(),
      verifiedModels: [],
      capabilities: ['stream', 'interrupt', 'resume'],
      limitations: [
        SIGN_IN_NOTE,
        MODELS_NOTE,
        'Edits are proposals only unless applying edits is switched on for the project.',
        'Cursor reports no structured errors or usage: every failure pauses for review.',
        ...(probe.installed ? [] : probe.notes),
      ],
      isMock: false,
    };
  }

  async listModels(): Promise<ModelCapability[]> {
    // `agent models` output format is unconfirmed until a captured fixture exists (R2).
    return [];
  }

  startAttempt(input: AttemptInput): AttemptHandle {
    const channel = new EventChannel<AdapterEventEnvelope>();
    if (!this.exe) {
      channel.close();
      const failure: Failure = { kind: 'auth', message: 'Cursor CLI is not installed', evidence: 'probe', retryAfterMs: null, resetAt: null, scope: null, simulated: false };
      return { events: channel, done: Promise.resolve({ termination: 'failed', failure, quiescent: true, providerSessionId: null }), interrupt: async () => {}, answerApproval: async () => {} };
    }
    mkdirSync(this.opts.chatSandboxDir, { recursive: true, mode: 0o700 });
    const cwd = input.permissionProfile === 'chat' || !input.cwd ? this.opts.chatSandboxDir : input.cwd;
    const applyEdits = this.applyEdits(input.projectId) && input.permissionProfile === 'edit';
    const args = buildCursorArgs({ ...input, cwd }, { applyEdits });
    const proc = spawnManaged(this.exe, args, { cwd, env: this.env, capture: this.opts.capture?.({ connectionId: this.connectionId, version: this.version }) });
    const st = newCursorStreamState({ applyEdits });
    let interrupted = false;
    proc.child.stdout.on(
      'data',
      lineReader((line) => {
        let msg: Json;
        try {
          msg = JSON.parse(line) as Json;
        } catch {
          channel.push({ type: 'diagnostic', level: 'warn', message: 'Unparseable line from Cursor (ignored)' });
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        // After our SIGINT a flush may still arrive; dropping completions lets the controller
        // record the partial text as message.interrupted.
        for (const e of translateCursorLine(msg, st, input.model)) if (!(interrupted && e.type === 'message.completed')) channel.push(e);
      }),
    );
    proc.child.stderr.on('data', (c: Buffer) => {
      st.stderrTail = (st.stderrTail + c.toString('utf8')).slice(-2000);
    });
    // The prompt travels in argv (see buildCursorArgs); nothing is written to stdin.
    proc.child.stdin.end();

    const done = (async (): Promise<AttemptOutcome> => {
      const exit = await proc.exited;
      const quiescent = await proc.ensureGroupGone();
      if (st.stderrTail.trim()) channel.push({ type: 'diagnostic', level: 'info', message: `cursor stderr: ${redact(st.stderrTail.trim()).slice(-500)}` });
      channel.close();
      if (interrupted) return { termination: 'interrupted', failure: null, quiescent, providerSessionId: st.sessionId };
      const failure = classifyCursorExit(st, exit);
      return { termination: failure ? 'failed' : 'completed', failure, quiescent, providerSessionId: st.sessionId };
    })();

    return {
      events: channel,
      done,
      pgid: proc.pgid,
      // Cursor documents no interrupt protocol: SIGINT first, then the usual escalation.
      interrupt: async () => {
        interrupted = true;
        await proc.stop({ graceSignal: 'SIGINT', graceMs: 5_000 });
      },
      answerApproval: async () => {
        // Cursor's headless mode has no approval bridge; edits follow the project's opt-in.
      },
    };
  }

  async dispose(): Promise<void> {}
}
