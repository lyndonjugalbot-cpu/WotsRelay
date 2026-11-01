import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EventChannel,
  type AdapterEventEnvelope,
  type AttemptHandle,
  type AttemptInput,
  type AttemptOutcome,
  type ProbeResult,
  type ProviderAdapter,
} from '@wots/core';
import type { Connection, Failure, ModelCapability, ProviderCapabilities, RiskCategory } from '@wots/protocol';

export type MockStep =
  | { kind: 'text'; text: string }
  | { kind: 'write'; path: string; content: string }
  // Verify-then-act: writes each file only if it does not already hold the content.
  | { kind: 'writeRemaining'; files: Array<{ path: string; content: string }> }
  | { kind: 'fail'; failure: Omit<Failure, 'simulated'> }
  | { kind: 'toolStartNoResult'; name: string; args: unknown; risk: RiskCategory }
  | { kind: 'approval'; action: string; risk: RiskCategory; thenWrite?: { path: string; content: string } }
  | { kind: 'delay'; ms: number }
  | { kind: 'malformed' }
  | { kind: 'duplicateLast' }
  | { kind: 'hang' }
  | { kind: 'effectiveModel'; model: string; note: string }
  // A provider-reported usage window, like Claude's rate_limit_event or Codex's rateLimits.
  | { kind: 'usage'; scope: string; percent: number; resetInMs: number };

export type MockScript = (input: AttemptInput, attemptNumber: number) => MockStep[];

export interface MockAdapterOptions {
  connectionId: string;
  label: string;
  models: string[];
  script: MockScript;
  authenticated?: boolean;
  billingMode?: Connection['billingMode'];
  // Simulate a provider process that does not exit after interrupt.
  failsToQuiesce?: boolean;
}

export class MockAdapter implements ProviderAdapter {
  readonly provider = 'mock' as const;
  readonly kind = 'mock' as const;
  readonly isMock = true;
  readonly connectionId: string;
  private attempts = 0;
  readonly prompts: string[] = [];
  readonly inputs: AttemptInput[] = [];

  private readonly opts: MockAdapterOptions;

  constructor(opts: MockAdapterOptions) {
    this.opts = opts;
    this.connectionId = opts.connectionId;
  }

  capabilities(): ProviderCapabilities {
    return { streaming: true, nativeResume: true, approvals: 'bridged', edits: 'apply', usage: 'percent', models: 'fixed' };
  }

  async probe(): Promise<ProbeResult> {
    return { installed: true, executablePath: null, version: 'mock-1', supportedVersion: true, notes: ['Deterministic mock adapter. Not a real provider.'] };
  }

  async getConnectionStatus(): Promise<Connection> {
    return {
      id: this.connectionId,
      provider: 'mock',
      adapter: 'mock',
      adapterVersion: '1',
      toolVersion: 'mock-1',
      executablePath: null,
      credentialRef: 'none',
      authStatus: this.opts.authenticated === false ? 'unauthenticated' : 'authenticated',
      billingMode: this.opts.billingMode ?? 'subscription',
      lastChecked: new Date().toISOString(),
      verifiedModels: this.opts.models,
      capabilities: ['stream', 'interrupt', 'approvals'],
      limitations: ['MOCK: simulated behaviour only; no real model is called'],
      isMock: true,
    };
  }

  async listModels(): Promise<ModelCapability[]> {
    return this.opts.models.map((m) => ({
      modelId: m,
      displayName: `${m} (mock)`,
      supportedEfforts: ['low', 'medium', 'high'],
      speedOptions: ['standard'],
      inputModalities: ['text'],
      contextLimit: 200_000,
      verification: 'verified',
      verifiedAt: new Date().toISOString(),
      source: 'mock',
    }));
  }

  startAttempt(input: AttemptInput): AttemptHandle {
    this.attempts++;
    this.prompts.push(input.prompt);
    this.inputs.push(input);
    const steps = this.opts.script(input, this.attempts);
    const channel = new EventChannel<AdapterEventEnvelope>();
    let interrupted = false;
    let wake: (() => void) | null = null;
    const approvals = new Map<string, (d: 'approve' | 'reject') => void>();
    // Resuming keeps the provider's session id, as Claude Code --resume and Codex thread/resume do.
    const providerSessionId = input.resumeProviderSessionId ?? `mock-session-${input.attemptId}`;
    let counter = 0;
    let last: AdapterEventEnvelope | null = null;
    const emit = (e: AdapterEventEnvelope) => {
      const withId = { ...e, providerEventId: e.providerEventId ?? `${providerSessionId}:${++counter}` };
      last = withId;
      channel.push(withId);
    };
    const sleep = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        wake = () => {
          clearTimeout(t);
          r();
        };
      });

    const run = async (): Promise<AttemptOutcome> => {
      emit({ type: 'session.bound', providerSessionId });
      emit({ type: 'model.effective', model: input.model, effort: input.effort });
      let msgN = 0;
      for (const step of steps) {
        if (interrupted) return this.end(channel, 'interrupted', null, providerSessionId);
        await Promise.resolve();
        switch (step.kind) {
          case 'usage':
            emit({ type: 'usage.observed', observation: { provider: this.provider, scope: step.scope, source: 'mock', observedAt: new Date().toISOString(), resetAt: new Date(Date.now() + step.resetInMs).toISOString(), value: step.percent, unit: 'percent', confidence: 'reported' } });
            break;
          case 'text': {
            const key = `m${++msgN}`;
            for (const chunk of step.text.match(/.{1,24}/gs) ?? []) emit({ type: 'message.delta', messageKey: key, text: chunk });
            emit({ type: 'message.completed', messageKey: key, text: step.text });
            break;
          }
          case 'write':
            this.write(emit, input, step.path, step.content);
            break;
          case 'writeRemaining':
            for (const f of step.files) {
              const abs = input.cwd ? join(input.cwd, f.path) : null;
              if (abs && existsSync(abs) && readFileSync(abs, 'utf8') === f.content) {
                emit({ type: 'diagnostic', level: 'info', message: `verified ${f.path} already complete; skipping` });
                continue;
              }
              this.write(emit, input, f.path, f.content);
            }
            break;
          case 'fail':
            return this.end(channel, 'failed', { ...step.failure, simulated: true }, providerSessionId);
          case 'toolStartNoResult':
            emit({ type: 'tool.started', providerToolId: `t${++counter}`, name: step.name, args: step.args, risk: step.risk, paths: [] });
            return this.end(channel, 'failed', { kind: 'transport', message: 'Provider stream disconnected during tool execution', evidence: 'mock:disconnect', retryAfterMs: null, resetAt: null, scope: null, simulated: true }, providerSessionId);
          case 'approval': {
            const reqId = `req${++counter}`;
            const toolId = `t${counter}`;
            emit({ type: 'tool.started', providerToolId: toolId, name: 'Write', args: step.thenWrite ?? { action: step.action }, risk: step.risk, paths: step.thenWrite ? [step.thenWrite.path] : [] });
            emit({ type: 'approval.requested', providerRequestId: reqId, providerToolId: toolId, action: step.action, scope: input.cwd ?? 'chat', risk: step.risk });
            const decision = await new Promise<'approve' | 'reject'>((resolve) => {
              approvals.set(reqId, resolve);
              wake = () => resolve('reject');
            });
            if (interrupted) return this.end(channel, 'interrupted', null, providerSessionId);
            if (decision === 'reject') emit({ type: 'tool.denied', providerToolId: toolId, message: 'User rejected the action' });
            else {
              if (step.thenWrite) appendFileSync(this.ensure(input, step.thenWrite.path), step.thenWrite.content);
              emit({ type: 'tool.completed', providerToolId: toolId, result: 'ok' });
            }
            break;
          }
          case 'delay':
            await sleep(step.ms);
            break;
          case 'malformed':
            channel.push({ type: 'tool.completed' } as unknown as AdapterEventEnvelope);
            break;
          case 'duplicateLast':
            if (last) channel.push(last);
            break;
          case 'hang':
            await new Promise<void>((r) => (wake = r));
            break;
          case 'effectiveModel':
            emit({ type: 'model.effective', model: step.model, effort: input.effort, note: step.note });
            break;
        }
      }
      if (interrupted) return this.end(channel, 'interrupted', null, providerSessionId);
      return this.end(channel, 'completed', null, providerSessionId);
    };

    const done = run();
    return {
      events: channel,
      done,
      interrupt: async () => {
        interrupted = true;
        wake?.();
      },
      answerApproval: async (id, d) => {
        approvals.get(id)?.(d === 'reject' ? 'reject' : 'approve');
        approvals.delete(id);
      },
    };
  }

  // Chat sessions have no project directory: never fall back to the process cwd.
  private ensure(input: AttemptInput, path: string): string {
    if (!input.cwd) throw new Error('no project directory');
    const abs = join(input.cwd, path);
    mkdirSync(dirname(abs), { recursive: true });
    return abs;
  }

  // Appends rather than overwrites so a repeated edit is detectable in tests.
  private write(emit: (e: AdapterEventEnvelope) => void, input: AttemptInput, path: string, content: string): void {
    const id = `w:${path}:${Math.random().toString(36).slice(2, 8)}`;
    emit({ type: 'tool.started', providerToolId: id, name: 'Write', args: { path, bytes: content.length }, risk: 'reversible-local-write', paths: [path] });
    if (!input.cwd || input.permissionProfile === 'chat') {
      emit({ type: 'tool.denied', providerToolId: id, message: 'Chat sessions have no file access' });
      return;
    }
    appendFileSync(this.ensure(input, path), content);
    emit({ type: 'tool.completed', providerToolId: id, result: `wrote ${content.length} bytes` });
  }

  private end(channel: EventChannel<AdapterEventEnvelope>, termination: AttemptOutcome['termination'], failure: Failure | null, providerSessionId: string): AttemptOutcome {
    channel.close();
    return { termination, failure, quiescent: !this.opts.failsToQuiesce, providerSessionId };
  }

  async dispose(): Promise<void> {}
}

// ---- Scenario library (used by tests and `wots code --mock-scenario`) ------------------

const quota = (evidence = 'mock:usageLimitExceeded'): MockStep => ({
  kind: 'fail',
  failure: { kind: 'usage_limit', message: 'Simulated subscription usage limit', evidence, retryAfterMs: null, resetAt: new Date(Date.now() + 3600_000).toISOString(), scope: 'account' },
});

export const TASK_FILES = [
  { path: 'src/settings/SettingsPage.tsx', content: 'export function SettingsPage() {\n  return <h1>Settings</h1>;\n}\n' },
  { path: 'src/settings/settings.css', content: '.settings { display: grid; gap: 16px; }\n' },
  { path: 'src/settings/index.ts', content: "export { SettingsPage } from './SettingsPage';\n" },
];

export const SCENARIOS: Record<string, { primary: MockScript; secondary: MockScript; description: string }> = {
  'near-limit': {
    description: 'Primary answers but reports 96% of its 5-hour window; the next message should move',
    primary: () => [{ kind: 'usage', scope: 'five_hour', percent: 96, resetInMs: 3600_000 }, { kind: 'text', text: 'Hello from the primary.' }],
    secondary: () => [{ kind: 'text', text: 'Hello from the fallback, with the conversation so far.' }],
  },
  success: {
    description: 'Primary completes the task',
    primary: () => [{ kind: 'text', text: 'Building the settings page.' }, { kind: 'writeRemaining', files: TASK_FILES }, { kind: 'text', text: 'Done.' }],
    secondary: () => [],
  },
  'quota-after-edit': {
    description: 'Primary writes one file then hits a confirmed usage limit; secondary finishes',
    primary: () => [{ kind: 'text', text: 'Starting with the component.' }, { kind: 'write', ...TASK_FILES[0]! }, quota()],
    secondary: () => [{ kind: 'text', text: 'Verifying workspace, then continuing.' }, { kind: 'writeRemaining', files: TASK_FILES }, { kind: 'text', text: 'Settings page complete.' }],
  },
  'quota-before-answer': {
    description: 'Primary hits the limit before producing anything',
    primary: () => [quota()],
    secondary: () => [{ kind: 'text', text: 'Here is the answer from the fallback route.' }],
  },
  'both-limited': {
    description: 'Both routes report usage limits',
    primary: () => [quota()],
    secondary: () => [quota()],
  },
  'auth-failure': {
    description: 'Primary authentication expired',
    primary: () => [{ kind: 'fail', failure: { kind: 'auth', message: 'Not logged in', evidence: 'mock:unauthorized', retryAfterMs: null, resetAt: null, scope: null } }],
    secondary: () => [{ kind: 'text', text: 'should not run' }],
  },
  'policy-refusal': {
    description: 'Primary refuses on policy grounds; no switch allowed',
    primary: () => [{ kind: 'fail', failure: { kind: 'policy_refusal', message: 'Request declined', evidence: 'mock:policy', retryAfterMs: null, resetAt: null, scope: null } }],
    secondary: () => [{ kind: 'text', text: 'should not run' }],
  },
  'uncertain-action': {
    description: 'Primary starts an external side effect and disconnects',
    primary: () => [{ kind: 'toolStartNoResult', name: 'Bash', args: { command: 'npm run db:migrate' }, risk: 'external-side-effect' }],
    secondary: () => [{ kind: 'text', text: 'should not run automatically' }],
  },
  'throttle-then-ok': {
    description: 'Short throttle then success on retry',
    primary: (_i, n) =>
      n === 1
        ? [{ kind: 'fail', failure: { kind: 'transient_throttle', message: 'Slow down', evidence: 'mock:rateLimitExceeded', retryAfterMs: 10, resetAt: null, scope: null } }]
        : [{ kind: 'text', text: 'Recovered after throttle.' }],
    secondary: () => [],
  },
  'slow-quota': {
    description: 'Primary hangs (for cancellation tests)',
    primary: () => [{ kind: 'text', text: 'Working…' }, { kind: 'hang' }],
    secondary: () => [{ kind: 'text', text: 'should not run' }],
  },
  approval: {
    description: 'Primary needs approval to write a file',
    primary: () => [{ kind: 'approval', action: 'Write src/approved.txt', risk: 'reversible-local-write', thenWrite: { path: 'src/approved.txt', content: 'approved\n' } }, { kind: 'text', text: 'Approval handled.' }],
    secondary: () => [],
  },
  'native-model-fallback': {
    description: 'Provider silently serves a different model',
    primary: () => [{ kind: 'effectiveModel', model: 'claude-sonnet-5-5', note: 'provider native fallback' }, { kind: 'text', text: 'Answer from the provider’s fallback model.' }],
    secondary: () => [],
  },
  'duplicate-events': {
    description: 'Provider redelivers events and emits a malformed one',
    primary: () => [{ kind: 'text', text: 'one' }, { kind: 'duplicateLast' }, { kind: 'malformed' }, { kind: 'text', text: 'two' }],
    secondary: () => [],
  },
};

export function mockPair(scenario: keyof typeof SCENARIOS | string, opts: { failsToQuiesce?: boolean } = {}): [MockAdapter, MockAdapter] {
  const s = SCENARIOS[scenario];
  if (!s) throw new Error(`Unknown mock scenario ${scenario}`);
  return [
    new MockAdapter({ connectionId: 'mock-claude', label: 'Mock Claude', models: ['claude-opus-5-5'], script: s.primary, failsToQuiesce: opts.failsToQuiesce }),
    new MockAdapter({ connectionId: 'mock-codex', label: 'Mock Codex', models: ['gpt-6-astra'], script: s.secondary }),
  ];
}
