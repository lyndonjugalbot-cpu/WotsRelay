// Codex app-server adapter (learn.chatgpt.com/docs/app-server). Method names and shapes come
// from `codex app-server generate-json-schema` for the tested version (tests/fixtures/codex-schema).
// Authentication uses Codex's own managed login; this adapter never handles tokens.
import { mkdirSync } from 'node:fs';
import {
  EventChannel,
  execVersion,
  lineReader,
  resolveExecutable,
  classifyShellCommand,
  spawnManaged,
  unwrapShell,
  type AdapterEventEnvelope,
  type AttemptHandle,
  type AttemptInput,
  type AttemptOutcome,
  type CaptureFactory,
  type ManagedProcess,
  type ProbeResult,
  type ProviderAdapter,
} from '@wots/core';
import type { ApprovalDecision, Connection, Failure, FailureKind, ModelCapability, PermissionProfile } from '@wots/protocol';
import { detectBillingEnv, redact } from '@wots/security';

export const ADAPTER_VERSION = '0.1.0';
export const TESTED_SCHEMA_VERSION = '0.166';
const CLIENT_INFO = { name: 'wotsrelay', title: 'WotsRelay', version: ADAPTER_VERSION };

type Json = Record<string, unknown>;

export function parseVersion(out: string | null): string | null {
  return out?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
}

// Structured codexErrorInfo → WotsRelay failure kind. Only `usageLimitExceeded` is a
// confirmed subscription limit; plain rate limiting is a transient throttle.
export function classifyCodexError(info: unknown): { kind: FailureKind; evidence: string } {
  if (typeof info === 'string') {
    const map: Record<string, FailureKind> = {
      usageLimitExceeded: 'usage_limit',
      sessionBudgetExceeded: 'usage_limit_suspected',
      rateLimitExceeded: 'transient_throttle',
      contextWindowExceeded: 'context_too_large',
      serverOverloaded: 'outage',
      internalServerError: 'outage',
      policyCapacityUnavailable: 'outage',
      flexUnavailable: 'outage',
      modelNotFound: 'model_unavailable',
      unauthorized: 'auth',
      cyberPolicy: 'policy_refusal',
      misalignmentPolicyViolation: 'policy_refusal',
      tooManyDenials: 'permission_denied',
      sandboxError: 'permission_denied',
    };
    return { kind: map[info] ?? 'unknown', evidence: `codexErrorInfo=${info}` };
  }
  if (info && typeof info === 'object') {
    const key = Object.keys(info)[0] ?? 'object';
    if (['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts'].includes(key)) {
      return { kind: 'transport', evidence: `codexErrorInfo=${key}` };
    }
    return { kind: 'unknown', evidence: `codexErrorInfo=${key}` };
  }
  return { kind: 'unknown', evidence: 'codexErrorInfo=absent' };
}

export function failureFromTurnError(err: Json | null | undefined): Failure {
  const { kind, evidence } = classifyCodexError(err?.codexErrorInfo);
  return { kind, evidence, message: redact(String(err?.message ?? 'Codex turn failed')).slice(0, 500), retryAfterMs: null, resetAt: null, scope: null, simulated: false };
}

// Decision strings from the pinned schema; acceptForSession exists only for commands.
export function codexApprovalAnswer(decision: ApprovalDecision, kind: 'command' | 'file'): 'accept' | 'acceptForSession' | 'decline' {
  if (decision === 'reject') return 'decline';
  return decision === 'approve_session' && kind === 'command' ? 'acceptForSession' : 'accept';
}

// Same window names as Claude so usage reads the same for both providers.
export function codexWindowScope(mins: unknown, fallback: string): string {
  if (mins === 300) return 'five_hour';
  if (mins === 10080) return 'seven_day';
  return typeof mins === 'number' ? `${mins}_min` : fallback;
}

export function sandboxFor(profile: PermissionProfile): 'read-only' | 'workspace-write' {
  return profile === 'edit' ? 'workspace-write' : 'read-only';
}

class RpcClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  onNotification: (method: string, params: Json) => void = () => {};
  onServerRequest: (id: number | string, method: string, params: Json) => void = () => {};
  onClose: () => void = () => {};

  readonly proc: ManagedProcess;

  constructor(proc: ManagedProcess) {
    this.proc = proc;
    proc.child.stdout.on(
      'data',
      lineReader((line) => {
        let msg: Json;
        try {
          msg = JSON.parse(line) as Json;
        } catch {
          return;
        }
        if ('id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)) {
          const p = this.pending.get(msg.id as number);
          if (!p) return;
          this.pending.delete(msg.id as number);
          if (msg.error) p.reject(new Error(redact(String((msg.error as Json).message ?? 'rpc error'))));
          else p.resolve(msg.result);
        } else if ('method' in msg && 'id' in msg) this.onServerRequest(msg.id as number, String(msg.method), (msg.params ?? {}) as Json);
        else if ('method' in msg) this.onNotification(String(msg.method), (msg.params ?? {}) as Json);
      }),
    );
    void proc.exited.then(() => {
      for (const p of this.pending.values()) p.reject(new Error('codex app-server exited'));
      this.pending.clear();
      this.onClose();
    });
  }

  private write(obj: Json): void {
    if (!this.proc.child.stdin.writable) return;
    const line = JSON.stringify(obj);
    this.proc.recordInput(line);
    this.proc.child.stdin.write(`${line}\n`);
  }

  request<T>(method: string, params: Json, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    this.write({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
    });
  }

  notify(method: string, params?: Json): void {
    this.write(params ? { method, params } : { method });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32601, message } });
  }
}

export interface CodexOptions {
  connectionId?: string;
  executable?: string | null;
  env?: NodeJS.ProcessEnv;
  chatSandboxDir: string;
  capture?: CaptureFactory;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = 'openai' as const;
  readonly kind = 'codex-app-server' as const;
  readonly isMock = false;
  readonly connectionId: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly exe: string | null;
  private version: string | null = null;

  private readonly opts: CodexOptions;

  constructor(opts: CodexOptions) {
    this.opts = opts;
    this.connectionId = opts.connectionId ?? 'codex';
    this.env = opts.env ?? process.env;
    this.exe = opts.executable === undefined ? resolveExecutable('codex', this.env) : opts.executable;
  }

  async probe(): Promise<ProbeResult> {
    if (!this.exe) return { installed: false, executablePath: null, version: null, supportedVersion: false, notes: ['Codex CLI not found on PATH. Install it from https://learn.chatgpt.com/docs'] };
    this.version = parseVersion(execVersion(this.exe));
    const supported = !!this.version && this.version.startsWith(`${TESTED_SCHEMA_VERSION}.`);
    return {
      installed: true,
      executablePath: this.exe,
      version: this.version,
      supportedVersion: supported,
      notes: supported ? [`Protocol schema pinned to ${TESTED_SCHEMA_VERSION}.x`] : [`Installed ${this.version} differs from pinned schema ${TESTED_SCHEMA_VERSION}.x. Regenerate the schema and re-run fixtures before use.`],
    };
  }

  private async session<T>(fn: (rpc: RpcClient) => Promise<T>, cwd: string): Promise<T> {
    const proc = spawnManaged(this.exe!, ['app-server'], { cwd, env: this.env });
    const rpc = new RpcClient(proc);
    try {
      await rpc.request('initialize', { clientInfo: CLIENT_INFO }, 30_000);
      rpc.notify('initialized');
      return await fn(rpc);
    } finally {
      proc.child.stdin.end();
      await proc.stop({ graceSignal: 'SIGTERM', graceMs: 3_000 });
    }
  }

  async getConnectionStatus(): Promise<Connection> {
    const probe = await this.probe();
    const conflicts = detectBillingEnv(this.env, 'openai');
    let auth: Connection['authStatus'] = probe.installed ? 'unknown' : 'not-installed';
    let billing: Connection['billingMode'] = 'unknown';
    const limitations: string[] = ['Catalog models are listed, not proven: access is verified only by a successful request.'];
    if (probe.installed && probe.supportedVersion) {
      mkdirSync(this.opts.chatSandboxDir, { recursive: true, mode: 0o700 });
      try {
        const res = await this.session((rpc) => rpc.request<{ account: Json | null; requiresOpenaiAuth: boolean }>('account/read', {}), this.opts.chatSandboxDir);
        if (!res.account) auth = 'unauthenticated';
        else {
          auth = 'authenticated';
          if (res.account.type === 'chatgpt') {
            billing = 'subscription';
            limitations.push(`ChatGPT plan reported by Codex: ${String(res.account.planType)}.`);
          } else if (res.account.type === 'apiKey') billing = 'api';
        }
      } catch (e) {
        limitations.push(`Status check failed: ${redact((e as Error).message)}`);
      }
    } else if (probe.installed) limitations.push(...probe.notes);
    if (conflicts.length) limitations.push(`Environment variables ${conflicts.join(', ')} are set; Codex may use them. Billing shown is what Codex reports.`);
    limitations.push('Provider-side credit or extra-usage settings cannot be controlled from here.');
    return {
      id: this.connectionId,
      provider: 'openai',
      adapter: 'codex-app-server',
      adapterVersion: ADAPTER_VERSION,
      toolVersion: probe.version,
      executablePath: probe.executablePath,
      credentialRef: 'native:codex',
      authStatus: auth,
      billingMode: billing,
      lastChecked: new Date().toISOString(),
      verifiedModels: [],
      capabilities: ['stream', 'interrupt', 'approvals', 'rate-limits', 'effort'],
      limitations,
      isMock: false,
    };
  }

  async listModels(): Promise<ModelCapability[]> {
    if (!this.exe) return [];
    mkdirSync(this.opts.chatSandboxDir, { recursive: true, mode: 0o700 });
    const res = await this.session((rpc) => rpc.request<{ data: Json[] }>('model/list', { includeHidden: false, limit: 100 }), this.opts.chatSandboxDir);
    return res.data.map((m) => ({
      modelId: String(m.id),
      displayName: String(m.displayName ?? m.id),
      supportedEfforts: Array.isArray(m.supportedReasoningEfforts) ? (m.supportedReasoningEfforts as Json[]).map((e) => String(e.reasoningEffort)) : [],
      speedOptions: ['standard'],
      inputModalities: Array.isArray(m.inputModalities) ? (m.inputModalities as string[]) : ['text'],
      contextLimit: null,
      verification: 'listed-unverified' as const,
      verifiedAt: null,
      source: 'codex app-server model/list',
    }));
  }

  startAttempt(input: AttemptInput): AttemptHandle {
    const channel = new EventChannel<AdapterEventEnvelope>();
    if (!this.exe) {
      channel.close();
      return { events: channel, done: Promise.resolve({ termination: 'failed', failure: { kind: 'auth', message: 'Codex is not installed', evidence: 'probe', retryAfterMs: null, resetAt: null, scope: null, simulated: false }, quiescent: true, providerSessionId: null }), interrupt: async () => {}, answerApproval: async () => {} };
    }
    mkdirSync(this.opts.chatSandboxDir, { recursive: true, mode: 0o700 });
    const cwd = input.permissionProfile === 'chat' || !input.cwd ? this.opts.chatSandboxDir : input.cwd;
    const proc = spawnManaged(this.exe, ['app-server'], { cwd, env: this.env, capture: this.opts.capture?.({ connectionId: this.connectionId, version: this.version }) });
    const rpc = new RpcClient(proc);
    let threadId: string | null = null;
    let turnId: string | null = null;
    let interrupted = false;
    let failure: Failure | null = null;
    let finish: (t: AttemptOutcome['termination']) => void = () => {};
    const finished = new Promise<AttemptOutcome['termination']>((r) => (finish = r));
    const pendingApprovals = new Map<string, { rpcId: number | string; kind: 'command' | 'file' }>();

    rpc.onNotification = (method, p) => {
      switch (method) {
        case 'item/agentMessage/delta':
          channel.push({ type: 'message.delta', messageKey: String(p.itemId), text: String(p.delta ?? '') });
          break;
        case 'item/started':
        case 'item/completed': {
          const item = p.item as Json;
          const id = String(item?.id);
          if (item?.type === 'agentMessage' && method === 'item/completed') channel.push({ type: 'message.completed', messageKey: id, text: String(item.text ?? '') });
          if (item?.type === 'commandExecution') {
            if (method === 'item/started') channel.push({ type: 'tool.started', providerToolId: id, name: 'Shell', args: { command: item.command }, risk: classifyShellCommand(String(item.command ?? '')), paths: [] });
            else if (item.status === 'completed' && (item.exitCode === 0 || item.exitCode === null)) channel.push({ type: 'tool.completed', providerToolId: id, result: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 2000) : undefined });
            else if (item.status === 'declined') channel.push({ type: 'tool.denied', providerToolId: id, message: 'Declined' });
            else channel.push({ type: 'tool.failed', providerToolId: id, message: `exit ${String(item.exitCode)} (${String(item.status)})` });
          }
          if (item?.type === 'fileChange') {
            const paths = Array.isArray(item.changes) ? (item.changes as Json[]).map((c) => String(c.path)) : [];
            if (method === 'item/started') channel.push({ type: 'tool.started', providerToolId: id, name: 'ApplyPatch', args: { paths }, risk: 'reversible-local-write', paths });
            else if (item.status === 'completed') channel.push({ type: 'tool.completed', providerToolId: id });
            else if (item.status === 'declined') channel.push({ type: 'tool.denied', providerToolId: id, message: 'Declined' });
            else channel.push({ type: 'tool.failed', providerToolId: id, message: String(item.status) });
          }
          break;
        }
        case 'model/rerouted':
          channel.push({ type: 'model.effective', model: String(p.toModel), effort: null, note: `Codex rerouted from ${String(p.fromModel)} (${String(p.reason)})` });
          break;
        case 'account/rateLimits/updated': {
          // Both windows (captured 0.166.0: primary 300 min, secondary 10080 min).
          const rl = p.rateLimits as Json;
          for (const key of ['primary', 'secondary'] as const) {
            const w = rl?.[key] as Json | null;
            if (!w || typeof w.usedPercent !== 'number') continue;
            channel.push({
              type: 'usage.observed',
              observation: { provider: 'openai', scope: codexWindowScope(w.windowDurationMins, key), source: 'codex account/rateLimits/updated', observedAt: new Date().toISOString(), resetAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null, value: w.usedPercent, unit: 'percent', confidence: 'reported' },
            });
          }
          break;
        }
        case 'error': {
          const err = p.error as Json;
          if (p.willRetry) channel.push({ type: 'diagnostic', level: 'warn', message: `Codex retrying: ${redact(String(err?.message ?? ''))}` });
          else failure = failureFromTurnError(err);
          break;
        }
        case 'turn/completed': {
          const turn = p.turn as Json;
          const status = String(turn?.status);
          if (status === 'failed') failure = failureFromTurnError(turn.error as Json);
          finish(status === 'completed' ? 'completed' : status === 'interrupted' ? 'interrupted' : 'failed');
          break;
        }
      }
    };

    rpc.onServerRequest = (id, method, p) => {
      if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
        const reqId = `${method}:${String(id)}`;
        const isCmd = method.includes('commandExecution');
        pendingApprovals.set(reqId, { rpcId: id, kind: isCmd ? 'command' : 'file' });
        const command = isCmd ? unwrapShell(String(p.command ?? '')) : '';
        const action = isCmd ? `Run: ${command || '(command)'}` : `Apply file changes${p.reason ? ` — ${String(p.reason)}` : ''}`;
        // Only command approvals define acceptForSession in the pinned 0.166 schema.
        channel.push({ type: 'approval.requested', providerRequestId: reqId, providerToolId: typeof p.itemId === 'string' ? p.itemId : null, action: redact(action), scope: String(p.cwd ?? cwd), risk: isCmd ? classifyShellCommand(command) : 'reversible-local-write', canApproveForSession: isCmd });
        return;
      }
      // Never answer token refreshes or unknown requests with fabricated data.
      rpc.respondError(id, `WotsRelay does not handle ${method}`);
    };

    rpc.onClose = () => finish(interrupted ? 'interrupted' : 'failed');

    const done = (async (): Promise<AttemptOutcome> => {
      try {
        await rpc.request('initialize', { clientInfo: CLIENT_INFO }, 30_000);
        rpc.notify('initialized');
        const threadOpts = { cwd, model: input.model, approvalPolicy: input.permissionProfile === 'edit' ? 'on-request' : 'untrusted', sandbox: sandboxFor(input.permissionProfile) };
        // Same thread for later turns of a conversation (schema 0.166: thread/resume takes the
        // thread/start options plus threadId).
        const thread = input.resumeProviderSessionId
          ? await rpc.request<{ thread: { id: string }; model: string; reasoningEffort: string | null }>('thread/resume', { threadId: input.resumeProviderSessionId, ...threadOpts })
          : await rpc.request<{ thread: { id: string }; model: string; reasoningEffort: string | null }>('thread/start', { ...threadOpts, ephemeral: false });
        threadId = thread.thread.id;
        channel.push({ type: 'session.bound', providerSessionId: threadId });
        channel.push({ type: 'model.effective', model: thread.model, effort: thread.reasoningEffort, note: thread.model !== input.model ? 'Codex started the thread on a different model' : undefined });
        const turn = await rpc.request<{ turn: { id: string } }>('turn/start', { threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], effort: input.effort, model: input.model });
        turnId = turn.turn.id;
      } catch (e) {
        if (!failure) {
          const msg = redact((e as Error).message);
          failure = { kind: /exited/.test(msg) ? 'transport' : 'unknown', message: msg, evidence: 'codex rpc', retryAfterMs: null, resetAt: null, scope: null, simulated: false };
        }
        finish('failed');
      }
      const termination = await finished;
      proc.child.stdin.end();
      const quiescent = await proc.stop({ graceSignal: 'SIGTERM', graceMs: 3_000 });
      channel.close();
      if (interrupted) return { termination: 'interrupted', failure: null, quiescent, providerSessionId: threadId };
      if (termination === 'failed' && !failure) failure = { kind: 'transport', message: 'Codex app-server ended without completing the turn', evidence: 'process-exit', retryAfterMs: null, resetAt: null, scope: null, simulated: false };
      return { termination, failure: termination === 'completed' ? null : failure, quiescent, providerSessionId: threadId };
    })();

    return {
      events: channel,
      done,
      pgid: proc.pgid,
      interrupt: async () => {
        interrupted = true;
        if (threadId && turnId) {
          await rpc.request('turn/interrupt', { threadId, turnId }, 5_000).catch(() => {});
          await Promise.race([finished, new Promise((r) => setTimeout(r, 5_000))]);
        }
        finish('interrupted');
      },
      answerApproval: async (providerRequestId, decision) => {
        const p = pendingApprovals.get(providerRequestId);
        if (!p) return;
        pendingApprovals.delete(providerRequestId);
        rpc.respond(p.rpcId, { decision: codexApprovalAnswer(decision, p.kind) });
      },
    };
  }

  async dispose(): Promise<void> {}
}
