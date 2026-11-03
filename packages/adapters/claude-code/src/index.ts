// Controls the official, unmodified Claude Code binary through documented CLI flags only
// (code.claude.com/docs/en/headless, /cli-reference). Authentication stays entirely inside
// Claude Code: this adapter never reads its credential files or keychain entries.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  EventChannel,
  compareVersions,
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
import type { Connection, Failure, ModelCapability, PermissionProfile, RiskCategory } from '@wots/protocol';
import { detectBillingEnv, redact } from '@wots/security';

export const ADAPTER_VERSION = '0.1.0';
// --permission-prompts needs >= 2.1.259; Manual-mode default for -p needs >= 2.1.302.
export const MIN_VERSION = '2.1.302';
export const TESTED_VERSION = '2.1.316';

export interface ClaudeCodeOptions {
  connectionId?: string;
  executable?: string | null;
  env?: NodeJS.ProcessEnv;
  // Empty directory used as cwd for chat sessions so no project files are reachable.
  chatSandboxDir: string;
  capture?: CaptureFactory;
}

export function parseVersion(out: string | null): string | null {
  return out?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

// Documented permission modes per WotsRelay permission profile (see ADR 0002).
export function permissionArgs(profile: PermissionProfile): string[] {
  switch (profile) {
    case 'edit':
      return ['--permission-mode', 'acceptEdits', '--permission-prompts', 'none'];
    case 'read-only':
    case 'chat':
      return ['--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
  }
}

export function buildArgs(input: Pick<AttemptInput, 'model' | 'effort' | 'permissionProfile' | 'resumeProviderSessionId'>): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model', input.model,
    '--effort', input.effort,
    // Do not load project-level settings/hooks or project MCP servers: a -p run shows no
    // workspace-trust dialog, so repository content must not be able to execute here.
    '--setting-sources', 'user',
    '--strict-mcp-config',
    ...permissionArgs(input.permissionProfile),
  ];
  if (input.resumeProviderSessionId) args.push('--resume', input.resumeProviderSessionId);
  return args;
}

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite', 'WebSearch', 'WebFetch', 'ToolSearch']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function classifyToolRisk(name: string, input: unknown): RiskCategory {
  if (READ_TOOLS.has(name)) return 'read-only';
  if (WRITE_TOOLS.has(name)) return 'reversible-local-write';
  if (name === 'Bash') {
    const cmd = typeof (input as { command?: unknown })?.command === 'string' ? (input as { command: string }).command : '';
    return classifyShellCommand(cmd);
  }
  return 'unknown';
}

function toolPaths(input: unknown): string[] {
  const i = input as Record<string, unknown> | null;
  if (!i || typeof i !== 'object') return [];
  return ['file_path', 'path', 'notebook_path'].map((k) => i[k]).filter((v): v is string => typeof v === 'string');
}

// Error categories documented for system/api_retry events.
const RETRY_CATEGORY_TO_KIND: Record<string, Failure['kind']> = {
  authentication_failed: 'auth',
  oauth_org_not_allowed: 'auth',
  account_on_hold: 'auth',
  billing_error: 'usage_limit_suspected',
  rate_limit: 'usage_limit_suspected',
  overloaded: 'outage',
  server_error: 'outage',
  model_not_found: 'model_unavailable',
  cloud_credential_error: 'auth',
};

// Confirmed subscription-limit signatures, added only from captured, versioned fixtures.
// Empty until a real limit has been observed: a Claude limit therefore pauses with a
// one-click fallback instead of switching automatically (docs/compatibility.md).
export const CONFIRMED_LIMIT_SIGNATURES: Array<{ minVersion: string; matches: (result: Record<string, unknown>) => boolean }> = [];

export interface StreamState {
  lastRetryCategory: string | null;
  lastRetryStatus: number | null;
  sawResult: boolean;
  resultError: Record<string, unknown> | null;
  sessionId: string | null;
  currentMessageId: string | null;
}

export function newStreamState(): StreamState {
  return { lastRetryCategory: null, lastRetryStatus: null, sawResult: false, resultError: null, sessionId: null, currentMessageId: null };
}

// Pure translation of one documented stream-json line into normalized adapter events.
export function translateLine(msg: Record<string, unknown>, st: StreamState, requestedModel: string): AdapterEventEnvelope[] {
  const out: AdapterEventEnvelope[] = [];
  const uuid = typeof msg.uuid === 'string' ? msg.uuid : undefined;
  const type = msg.type;
  if (type === 'system') {
    if (msg.subtype === 'init') {
      if (typeof msg.session_id === 'string') {
        st.sessionId = msg.session_id;
        out.push({ type: 'session.bound', providerSessionId: msg.session_id });
      }
      if (typeof msg.model === 'string') out.push({ type: 'model.effective', model: msg.model, effort: null, note: msg.model !== requestedModel ? 'Claude Code reported a different session model' : undefined });
    } else if (msg.subtype === 'api_retry') {
      st.lastRetryCategory = typeof msg.error === 'string' ? msg.error : null;
      st.lastRetryStatus = typeof msg.error_status === 'number' ? msg.error_status : null;
      out.push({ type: 'diagnostic', level: 'warn', message: `Claude Code retrying (${st.lastRetryCategory ?? 'unknown'}, attempt ${String(msg.attempt)}/${String(msg.max_retries)})`, providerEventId: uuid });
    } else if (msg.subtype === 'permission_denied') {
      const id = typeof msg.tool_use_id === 'string' ? msg.tool_use_id : null;
      if (id) out.push({ type: 'tool.denied', providerToolId: id, message: 'Denied by Claude Code permission rules (no approval host)' });
      else out.push({ type: 'diagnostic', level: 'warn', message: 'Claude Code denied a tool call under the current permission profile' });
    }
    return out;
  }
  // Usage per window, as reported by Claude Code (captured 2.1.316: `rate_limit_info.unifiedWindows`,
  // utilization 0–1 and resetsAt in epoch seconds).
  if (type === 'rate_limit_event') {
    const info = msg.rate_limit_info as Record<string, unknown> | undefined;
    const windows = (info?.unifiedWindows as Record<string, Record<string, unknown>> | undefined) ?? (info && typeof info.rateLimitType === 'string' ? { [info.rateLimitType]: info } : {});
    for (const [scope, w] of Object.entries(windows)) {
      if (typeof w.utilization !== 'number') continue;
      out.push({
        type: 'usage.observed',
        observation: { provider: 'anthropic', scope, source: 'claude rate_limit_event', observedAt: new Date().toISOString(), resetAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null, value: Math.round(w.utilization * 100), unit: 'percent', confidence: 'reported' },
        providerEventId: uuid ? `${uuid}:${scope}` : undefined,
      });
    }
    return out;
  }
  if (type === 'stream_event') {
    const ev = msg.event as Record<string, unknown> | undefined;
    if (msg.parent_tool_use_id) return out;
    if (ev?.type === 'message_start') {
      const m = ev.message as { id?: string; model?: string } | undefined;
      st.currentMessageId = m?.id ?? null;
    } else if (ev?.type === 'content_block_delta') {
      const d = ev.delta as { type?: string; text?: string } | undefined;
      if (d?.type === 'text_delta' && typeof d.text === 'string' && st.currentMessageId) out.push({ type: 'message.delta', messageKey: st.currentMessageId, text: d.text });
    }
    return out;
  }
  if (type === 'assistant' && !msg.parent_tool_use_id) {
    const m = msg.message as { id?: string; model?: string; content?: Array<Record<string, unknown>> } | undefined;
    if (m?.model && m.model !== requestedModel && !m.model.startsWith('<')) out.push({ type: 'model.effective', model: m.model, effort: null, note: 'Assistant message reports a different model' });
    const text = (m?.content ?? []).filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('');
    if (text && m?.id) out.push({ type: 'message.completed', messageKey: m.id, text, providerEventId: uuid });
    for (const b of m?.content ?? []) {
      if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        out.push({ type: 'tool.started', providerToolId: b.id, name: b.name, args: b.input ?? null, risk: classifyToolRisk(b.name, b.input), paths: toolPaths(b.input) });
      }
    }
    return out;
  }
  if (type === 'user') {
    const m = msg.message as { content?: Array<Record<string, unknown>> } | undefined;
    for (const b of Array.isArray(m?.content) ? m!.content! : []) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (b.is_error) out.push({ type: 'tool.failed', providerToolId: b.tool_use_id, message: redact(String(typeof b.content === 'string' ? b.content : 'tool error').slice(0, 500)) });
        else out.push({ type: 'tool.completed', providerToolId: b.tool_use_id, result: typeof b.content === 'string' ? b.content.slice(0, 2000) : undefined });
      }
    }
    return out;
  }
  if (type === 'result') {
    st.sawResult = true;
    if (msg.is_error || (typeof msg.subtype === 'string' && msg.subtype !== 'success')) st.resultError = msg;
    return out;
  }
  return out;
}

export function classifyClaudeFailure(st: StreamState, exit: { code: number | null; signal: NodeJS.Signals | null }, version: string | null): Failure | null {
  const base = { retryAfterMs: null, resetAt: null, scope: null, simulated: false };
  if (st.sawResult && !st.resultError && exit.code === 0) return null;
  if (st.resultError) {
    for (const sig of CONFIRMED_LIMIT_SIGNATURES) {
      if (version && compareVersions(version, sig.minVersion) >= 0 && sig.matches(st.resultError)) {
        return { ...base, kind: 'usage_limit', message: 'Claude usage limit reached', evidence: 'claude-code:confirmed-signature' };
      }
    }
    if (st.lastRetryCategory && RETRY_CATEGORY_TO_KIND[st.lastRetryCategory]) {
      const kind = RETRY_CATEGORY_TO_KIND[st.lastRetryCategory]!;
      return { ...base, kind, message: `Claude Code ended after retries (${st.lastRetryCategory})`, evidence: `claude-code:api_retry.error=${st.lastRetryCategory}` };
    }
    const subtype = String(st.resultError.subtype ?? 'error');
    return { ...base, kind: 'unknown', message: `Claude Code result: ${subtype}`, evidence: `claude-code:result.subtype=${subtype}` };
  }
  if (exit.code === 143 || exit.signal) return { ...base, kind: 'transport', message: 'Claude Code process was terminated', evidence: `exit:${exit.code ?? exit.signal}` };
  return { ...base, kind: 'unknown', message: `Claude Code exited with code ${exit.code} without a result`, evidence: `exit:${exit.code}` };
}

export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly kind = 'claude-code-cli' as const;
  readonly isMock = false;
  readonly connectionId: string;
  private readonly env: NodeJS.ProcessEnv;
  private exe: string | null;
  private version: string | null = null;

  private readonly opts: ClaudeCodeOptions;

  constructor(opts: ClaudeCodeOptions) {
    this.opts = opts;
    this.connectionId = opts.connectionId ?? 'claude-code';
    this.env = opts.env ?? process.env;
    this.exe = opts.executable === undefined ? resolveExecutable('claude', this.env) : opts.executable;
  }

  async probe(): Promise<ProbeResult> {
    if (!this.exe) return { installed: false, executablePath: null, version: null, supportedVersion: false, notes: ['Claude Code not found on PATH. Install it from https://code.claude.com/docs/en/setup'] };
    this.version = parseVersion(execVersion(this.exe));
    const supported = !!this.version && compareVersions(this.version, MIN_VERSION) >= 0;
    const notes = [`Tested with ${TESTED_VERSION}; minimum ${MIN_VERSION}.`];
    if (this.version && compareVersions(this.version, TESTED_VERSION) > 0) notes.push('Installed version is newer than the tested version; re-run fixture capture.');
    return { installed: true, executablePath: this.exe, version: this.version, supportedVersion: supported, notes };
  }

  async getConnectionStatus(): Promise<Connection> {
    const probe = await this.probe();
    const conflicts = detectBillingEnv(this.env, 'anthropic');
    let auth: Connection['authStatus'] = probe.installed ? 'unknown' : 'not-installed';
    let billing: Connection['billingMode'] = 'unknown';
    const limitations: string[] = [
      'Subscription limit exhaustion has no documented structured signal yet: Claude limits pause with a one-click fallback instead of switching automatically.',
      'Interactive approvals are not bridged yet: tools outside the permission profile are denied and reported.',
    ];
    if (probe.installed && this.exe) {
      try {
        // Documented status command. Only non-secret fields are kept.
        const raw = execFileSync(this.exe, ['auth', 'status', '--json'], { encoding: 'utf8', timeout: 15_000, env: this.env, stdio: ['ignore', 'pipe', 'ignore'] });
        const s = JSON.parse(raw) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string };
        auth = s.loggedIn ? 'authenticated' : 'unauthenticated';
        if (s.authMethod === 'claude.ai' && s.apiProvider === 'firstParty') billing = 'subscription';
        else if (s.authMethod && /api.?key/i.test(s.authMethod)) billing = 'api';
        if (s.subscriptionType) limitations.push(`Plan reported by Claude Code: ${s.subscriptionType}. Model access is verified only by a successful request.`);
      } catch {
        auth = 'unknown';
      }
    }
    if (conflicts.length) {
      billing = 'api';
      limitations.push(`Environment variables ${conflicts.join(', ')} are set and may switch Claude Code to API billing. Runs are blocked until they are unset or API billing is enabled.`);
    }
    limitations.push('Provider-side extra-usage settings cannot be inspected from here; check claude.ai settings.');
    return {
      id: this.connectionId,
      provider: 'anthropic',
      adapter: 'claude-code-cli',
      adapterVersion: ADAPTER_VERSION,
      toolVersion: probe.version,
      executablePath: probe.executablePath,
      credentialRef: 'native:claude-code',
      authStatus: auth,
      billingMode: billing,
      lastChecked: new Date().toISOString(),
      verifiedModels: [],
      capabilities: ['stream', 'interrupt', 'resume', 'effort'],
      limitations,
      isMock: false,
    };
  }

  async listModels(): Promise<ModelCapability[]> {
    // Claude Code has no documented catalog command; list the user's preference as unverified.
    return [
      { modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', supportedEfforts: ['low', 'medium', 'high'], speedOptions: ['standard'], inputModalities: ['text'], contextLimit: null, verification: 'listed-unverified', verifiedAt: null, source: 'wotsrelay preference (code.claude.com/docs/en/model-config)' },
      { modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', supportedEfforts: ['low', 'medium', 'high'], speedOptions: ['standard'], inputModalities: ['text'], contextLimit: null, verification: 'listed-unverified', verifiedAt: null, source: 'wotsrelay preference (code.claude.com/docs/en/model-config)' },
      { modelId: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', supportedEfforts: ['low', 'medium', 'high'], speedOptions: ['standard'], inputModalities: ['text'], contextLimit: null, verification: 'listed-unverified', verifiedAt: null, source: 'wotsrelay preference (code.claude.com/docs/en/model-config)' },
    ];
  }

  startAttempt(input: AttemptInput): AttemptHandle {
    const channel = new EventChannel<AdapterEventEnvelope>();
    const conflicts = detectBillingEnv(this.env, 'anthropic');
    if (!this.exe || conflicts.length) {
      channel.close();
      const failure: Failure = conflicts.length
        ? { kind: 'billing_route_conflict', message: `${conflicts.join(', ')} set in the runner environment would change Claude Code billing. Unset them or enable API billing explicitly.`, evidence: 'env', retryAfterMs: null, resetAt: null, scope: null, simulated: false }
        : { kind: 'auth', message: 'Claude Code is not installed', evidence: 'probe', retryAfterMs: null, resetAt: null, scope: null, simulated: false };
      return { events: channel, done: Promise.resolve({ termination: 'failed', failure, quiescent: true, providerSessionId: null }), interrupt: async () => {}, answerApproval: async () => {} };
    }
    mkdirSync(this.opts.chatSandboxDir, { recursive: true, mode: 0o700 });
    const cwd = input.permissionProfile === 'chat' || !input.cwd ? this.opts.chatSandboxDir : input.cwd;
    const proc = spawnManaged(this.exe, buildArgs(input), { cwd, env: this.env, capture: this.opts.capture?.({ connectionId: this.connectionId, version: this.version }) });
    const st = newStreamState();
    let stderrTail = '';
    let interrupted = false;
    proc.child.stdout.on(
      'data',
      lineReader((line) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          channel.push({ type: 'diagnostic', level: 'warn', message: 'Unparseable line from Claude Code (ignored)' });
          return;
        }
        // After our SIGINT, Claude Code still flushes the partial text as a final `assistant`
        // message (result terminal_reason aborted_streaming, captured 2.1.316). Dropping it
        // lets the controller record the partial as message.interrupted.
        for (const e of translateLine(msg, st, input.model)) if (!(interrupted && e.type === 'message.completed')) channel.push(e);
      }),
    );
    proc.child.stderr.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-2000);
    });
    // Prompt goes over stdin so it never appears in the process list.
    proc.recordInput(input.prompt);
    proc.child.stdin.end(input.prompt);

    const done = (async (): Promise<AttemptOutcome> => {
      const exit = await proc.exited;
      const quiescent = await proc.ensureGroupGone();
      if (stderrTail.trim()) channel.push({ type: 'diagnostic', level: 'info', message: `claude stderr: ${redact(stderrTail.trim()).slice(-500)}` });
      channel.close();
      if (interrupted) return { termination: 'interrupted', failure: null, quiescent, providerSessionId: st.sessionId };
      const failure = classifyClaudeFailure(st, exit, this.version);
      return { termination: failure ? 'failed' : 'completed', failure, quiescent, providerSessionId: st.sessionId };
    })();

    return {
      events: channel,
      done,
      pgid: proc.pgid,
      // SIGINT ends the turn cleanly (documented); escalation follows if it lingers.
      interrupt: async () => {
        interrupted = true;
        await proc.stop({ graceSignal: 'SIGINT', graceMs: 5_000 });
      },
      answerApproval: async () => {
        // Not bridged in this version (ADR 0002): approvals are resolved by the permission profile.
      },
    };
  }

  async dispose(): Promise<void> {}
}
