import {
  PAUSED_STATES,
  TERMINAL_STATES,
  type ApprovalDecision,
  type Attempt,
  type Checkpoint,
  type EventEnvelope,
  type EventPayload,
  type EventType,
  type Failure,
  type FallbackConfig,
  type Project,
  type ProviderErrorCategory,
  type RouteRef,
  type Run,
  type RunState,
  type Session,
  type ToolAction,
} from '@wots/protocol';
import {
  assertTransition,
  categoryOf,
  classifyShellCommand,
  decide,
  routeKey,
  selectNextRoute,
  systemClock,
  type AdapterEventEnvelope,
  type AttemptHandle,
  type AttemptOutcome,
  type Clock,
  type ProviderAdapter,
  type RouteCandidate,
  type UsageWindow,
} from '@wots/core';
import type { Store } from '@wots/storage';
import { buildHandoff, DEFAULT_BUDGET } from '@wots/context';
import { buildManifest, diffManifests, gitBaseline, gitStatusLines, workspaceDiff, type WorkspaceLeases } from '@wots/workspace';
import { canonicalHash, newId, redact } from '@wots/security';

export const DEFAULT_FALLBACK: FallbackConfig = {
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

export const MOCK_FALLBACK: FallbackConfig = {
  ...DEFAULT_FALLBACK,
  routes: [
    { connectionId: 'mock-claude', modelId: 'claude-opus-5-5' },
    { connectionId: 'mock-codex', modelId: 'gpt-6-astra' },
  ],
};

export class RelayError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
  }
}

interface ActiveRun {
  runId: string;
  sessionId: string;
  cancelRequested: boolean;
  handle: AttemptHandle | null;
  attemptId: string | null;
  done: Promise<void>;
}

type UsageRecord = { percent: number; resetAt: string | null; observedAt: string };

interface DriveStart {
  route: RouteRef;
  prompt: string;
  tried: Set<string>;
  parentAttemptId: string | null;
  // Native conversation to continue, valid only on the connection that created it.
  resume?: { connectionId: string; providerSessionId: string } | null;
}

export interface ControllerOptions {
  store: Store;
  leases: WorkspaceLeases;
  adapters: ProviderAdapter[];
  publish: (e: EventEnvelope) => void;
  clock?: Clock;
  random?: () => number;
  ownerId?: string;
}

// setTimeout fires at once for delays above this, so longer deadlines are clamped to it (~24.8 days).
const MAX_TIMER_MS = 2 ** 31 - 1;

const LIMIT_KINDS = new Set<Failure['kind']>(['usage_limit', 'usage_limit_suspected', 'transient_throttle', 'outage']);

export class RelayController {
  readonly store: Store;
  private readonly leases: WorkspaceLeases;
  private readonly adapters = new Map<string, ProviderAdapter>();
  private readonly publish: (e: EventEnvelope) => void;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly active = new Map<string, ActiveRun>();
  private readonly cooldowns = new Map<string, number>();
  private readonly messageIds = new Map<string, string>();

  constructor(opts: ControllerOptions) {
    this.store = opts.store;
    this.leases = opts.leases;
    for (const a of opts.adapters) this.adapters.set(a.connectionId, a);
    this.publish = opts.publish;
    this.clock = opts.clock ?? systemClock;
    this.random = opts.random ?? Math.random;
  }

  adapter(connectionId: string): ProviderAdapter | undefined {
    return this.adapters.get(connectionId);
  }

  listAdapters(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  // ---- projects & sessions ---------------------------------------------------------------

  registerProject(input: { root: string; trusted: boolean; permissionProfile: Project['permissionProfile']; crossProviderConsent: boolean; name?: string }): Project {
    const existing = this.store.getProjectByRoot(input.root);
    const permissionChanged = existing && (existing.permissionProfile !== input.permissionProfile || existing.trusted !== input.trusted);
    const project: Project = {
      id: existing?.id ?? newId('prj'),
      root: input.root,
      name: input.name ?? input.root.split('/').pop() ?? input.root,
      trusted: input.trusted,
      workspaceMode: existing?.workspaceMode ?? 'in-place',
      permissionProfile: input.permissionProfile,
      permissionVersion: (existing?.permissionVersion ?? 0) + (permissionChanged ? 1 : 0),
      contextExclusions: existing?.contextExclusions ?? [],
      crossProviderConsent: input.crossProviderConsent,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    return this.store.upsertProject(project);
  }

  createSession(input: { projectId: string | null; title?: string; mode?: Session['mode']; fallback?: FallbackConfig }): Session {
    if (input.projectId && !this.store.getProject(input.projectId)) throw new RelayError('not_found', 'Unknown project');
    const mode = input.mode ?? 'real';
    const fallback = input.fallback ?? this.store.getSetting<FallbackConfig>(mode === 'mock' ? 'fallback.mock' : 'fallback', mode === 'mock' ? MOCK_FALLBACK : DEFAULT_FALLBACK);
    const now = new Date().toISOString();
    const s: Session = {
      id: newId('ses'),
      projectId: input.projectId,
      title: input.title ?? 'New chat',
      objective: '',
      fallback,
      mode,
      currentConnectionId: null,
      state: 'idle',
      latestSeq: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSession(s);
    return s;
  }

  // ---- messages / runs -------------------------------------------------------------------

  sendMessage(input: { sessionId: string; text: string; idempotencyKey: string }): { runId: string; messageId: string; replayed: boolean } {
    const session = this.requireSession(input.sessionId);
    const { result, replayed } = this.store.idempotent(input.idempotencyKey, `message:${session.id}`, () => {
      const busy = this.store.runsForSession(session.id).find((r) => !TERMINAL_STATES.has(r.state));
      if (busy) {
        throw new RelayError('session_busy', PAUSED_STATES.has(busy.state) ? 'This session has a paused run. Resume or cancel it first.' : 'A run is already active in this session.');
      }
      const messageId = newId('msg');
      const run: Run = { id: newId('run'), sessionId: session.id, userMessageId: messageId, state: 'idle', stateReason: null, activeAttemptId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.atomic(() => {
        this.store.insertRun(run);
        this.emit(session.id, run.id, null, 'user.message', { messageId, text: input.text });
        if (!session.objective) this.store.updateSession(session.id, { objective: input.text, title: session.title === 'New chat' ? input.text.slice(0, 60) : session.title });
      });
      return { runId: run.id, messageId };
    });
    if (!replayed) this.startRun(result.runId, input.text);
    return { ...result, replayed };
  }

  interrupt(runId: string): { ok: true; state: RunState } {
    const run = this.store.getRun(runId);
    if (!run) throw new RelayError('not_found', 'Unknown run');
    const a = this.active.get(runId);
    if (a) {
      a.cancelRequested = true;
      void a.handle?.interrupt('user stop');
    } else if (!TERMINAL_STATES.has(run.state)) {
      this.transition(run.id, 'cancelled', 'Stopped by user');
    }
    return { ok: true, state: this.store.getRun(runId)!.state };
  }

  async waitForRun(runId: string): Promise<Run> {
    await this.active.get(runId)?.done;
    return this.store.getRun(runId)!;
  }

  async decideApproval(input: { approvalId: string; decision: ApprovalDecision; expectedVersion: number; deviceId: string }): Promise<{ applied: boolean; status: string }> {
    const approval = this.store.getApproval(input.approvalId);
    if (!approval) throw new RelayError('not_found', 'Unknown approval');
    const run = this.store.getRun(approval.runId)!;
    const session = this.requireSession(run.sessionId);
    const project = session.projectId ? this.store.getProject(session.projectId) : null;
    // Approvals bind to the permission version current when requested.
    if (project && project.permissionVersion !== approval.permissionVersion) {
      this.store.resolveApproval(approval.id, 'reject', approval.version, 'system:stale-permission');
      return { applied: false, status: 'stale' };
    }
    const won = this.store.resolveApproval(approval.id, input.decision === 'reject' ? 'reject' : 'approve', input.expectedVersion, input.deviceId);
    if (!won) return { applied: false, status: this.store.getApproval(approval.id)!.status };
    this.emit(run.sessionId, run.id, approval.attemptId, 'approval.resolved', { approvalId: approval.id, decision: input.decision, deviceId: input.deviceId, version: input.expectedVersion + 1 });
    const a = this.active.get(run.id);
    if (a && a.attemptId === approval.attemptId && a.handle) {
      if (this.store.getRun(run.id)!.state === 'awaiting_approval' && this.store.pendingApprovals(session.id).length === 0) this.transition(run.id, 'running', null);
      await a.handle.answerApproval(approval.providerRequestId, input.decision);
    }
    return { applied: true, status: input.decision === 'reject' ? 'rejected' : 'approved' };
  }

  // Resume a paused run. `fallback` continues on the next route (user-confirmed switch);
  // `skipConnectionId` passes over that provider for this cycle ("Skip this provider").
  resume(sessionId: string, opts: { fallback: boolean; note?: string; skipConnectionId?: string }): { runId: string } {
    const run = [...this.store.runsForSession(sessionId)].reverse().find((r) => PAUSED_STATES.has(r.state));
    if (!run) throw new RelayError('not_paused', 'No paused run in this session');
    const session = this.requireSession(sessionId);
    if (opts.note) this.emit(sessionId, run.id, null, 'user.message', { messageId: newId('msg'), text: opts.note });
    const attempts = this.store.attemptsForRun(run.id);
    const last = attempts.at(-1) ?? null;
    const tried = new Set<string>();
    if (opts.fallback && last) tried.add(`${last.connectionId}:${last.requestedModel}`);
    const skip = opts.skipConnectionId;
    if (skip) for (const r of session.fallback.routes) if (r.connectionId === skip) tried.add(routeKey(r));
    const moving = opts.fallback || !!skip;
    const project = session.projectId ? this.store.getProject(session.projectId) : null;
    const pick = this.pickRoute(session, project, tried, moving ? (last?.connectionId ?? null) : null);
    if (!pick.route) throw new RelayError('no_route', `No eligible route: ${pick.reasons.join('; ')}`);
    let cp = this.store.latestCheckpoint(sessionId);
    const why = skip ? `User skipped ${skip}` : opts.fallback ? 'User-confirmed continuation on next provider' : 'Resumed by user';
    if (!cp || cp.runId !== run.id) cp = this.checkpoint(run, session, project, last, why);
    else if (opts.note) cp = this.checkpoint(run, session, project, last, cp.switchReason ?? 'Resumed by user');
    const handoff = buildHandoff(cp, this.budgetFor(pick.route));
    if (handoff.blockedBy) throw new RelayError('context_budget', handoff.blockedBy);
    this.transition(run.id, 'preparing', 'Resumed by user');
    if (last && pick.route.connectionId !== last.connectionId) {
      this.emit(sessionId, run.id, null, 'provider.switched', { from: { connectionId: last.connectionId, modelId: last.requestedModel }, to: pick.route, reason: skip ? `User skipped ${skip}` : 'User-confirmed fallback', simulated: false });
    }
    this.launch(run.id, { route: pick.route, prompt: handoff.prompt, tried, parentAttemptId: last?.id ?? null }, true);
    return { runId: run.id };
  }

  // Startup recovery: nothing that was mid-flight is assumed to have survived.
  recover(): { recovered: string[] } {
    const recovered: string[] = [];
    for (const run of this.store.runsInStates(['preparing', 'running', 'checkpointing', 'switching', 'awaiting_approval'])) {
      for (const a of this.store.attemptsForRun(run.id)) {
        const pgid = this.store.getSetting<number | null>(`proc:${a.id}`, null);
        if (pgid) {
          try {
            process.kill(-pgid, 'SIGTERM');
          } catch {
            /* already gone */
          }
          this.store.setSetting(`proc:${a.id}`, null);
        }
        if (!a.endedAt) this.store.updateAttempt(a.id, { endedAt: new Date().toISOString(), termination: 'runner_restart' });
        this.store.expireApprovalsForAttempt(a.id);
      }
      const intent = this.store.transitionIntent(run.id);
      const reason =
        run.state === 'switching' || intent
          ? 'The runner restarted during a provider switch. The checkpoint is saved; resume to continue with the next provider.'
          : `The runner restarted while the run was ${run.state}. Review the workspace, then resume.`;
      this.store.updateRun(run.id, { state: 'paused_uncertain', stateReason: reason });
      this.store.updateSession(run.sessionId, { state: 'paused_uncertain' });
      this.emit(run.sessionId, run.id, null, 'run.stateChanged', { from: run.state, to: 'paused_uncertain', reason });
      recovered.push(run.id);
    }
    this.leases.reapStale();
    return { recovered };
  }

  // ---- internals ---------------------------------------------------------------------------

  private requireSession(id: string): Session {
    const s = this.store.getSession(id);
    if (!s) throw new RelayError('not_found', 'Unknown session');
    return s;
  }

  private deferred: EventEnvelope[] | null = null;

  // Persist before publish: inside a transaction, events are broadcast only after commit.
  private emit<T extends EventType>(sessionId: string, runId: string | null, attemptId: string | null, type: T, payload: EventPayload<T>): EventEnvelope {
    const { event, duplicate } = this.store.appendEvent({ sessionId, runId, attemptId, eventId: newId('evt'), type, payload });
    if (!duplicate) {
      if (this.deferred) this.deferred.push(event);
      else this.publish(event);
    }
    return event;
  }

  private atomic<T>(fn: () => T): T {
    if (this.deferred) return fn();
    this.deferred = [];
    try {
      const out = this.store.tx(fn);
      const pending = this.deferred;
      this.deferred = null;
      for (const e of pending) this.publish(e);
      return out;
    } finally {
      this.deferred = null;
    }
  }

  private transition(runId: string, to: RunState, reason: string | null): void {
    const run = this.store.getRun(runId)!;
    assertTransition(run.state, to);
    this.atomic(() => {
      this.store.updateRun(runId, { state: to, stateReason: reason });
      this.store.updateSession(run.sessionId, { state: to });
      this.emit(run.sessionId, runId, run.activeAttemptId, 'run.stateChanged', { from: run.state, to, reason });
    });
  }

  // Cache documented connection status and catalogs; route eligibility reads this cache.
  async refreshConnections(): Promise<Array<{ connectionId: string; ok: boolean; error?: string }>> {
    const out: Array<{ connectionId: string; ok: boolean; error?: string }> = [];
    for (const a of this.adapters.values()) {
      try {
        const c = await a.getConnectionStatus();
        const models = c.authStatus === 'authenticated' ? await a.listModels().catch(() => []) : [];
        this.store.setSetting(`conn:${a.connectionId}`, { auth: c.authStatus, billing: c.billingMode, models: models.filter((m) => m.verification !== 'unavailable').map((m) => m.modelId), connection: c });
        for (const m of models) if (m.contextLimit) this.store.setSetting(`ctx:${a.connectionId}:${m.modelId}`, m.contextLimit);
        this.store.setSetting(`models:${a.connectionId}`, models);
        out.push({ connectionId: a.connectionId, ok: true });
      } catch (e) {
        out.push({ connectionId: a.connectionId, ok: false, error: redact((e as Error).message) });
      }
    }
    return out;
  }

  private startRun(runId: string, text: string): void {
    const run = this.store.getRun(runId)!;
    const session = this.requireSession(run.sessionId);
    const project = session.projectId ? this.store.getProject(session.projectId) : null;
    this.transition(runId, 'preparing', null);
    if (project && !project.trusted) {
      this.transition(runId, 'failed', 'Project is not trusted. Trust it explicitly before running coding tasks.');
      return;
    }
    // Return to the primary on a new run: each run starts from the top of the route list.
    // Earlier turns bind the conversation to the provider that answered last.
    const prior = this.lastAttemptBefore(session.id, runId);
    const pick = this.pickRoute(session, project, new Set(), prior?.connectionId ?? null);
    if (!pick.route) {
      this.transition(runId, 'paused_auth', `No eligible provider route: ${pick.reasons.join('; ')}`);
      return;
    }
    const route = pick.route;
    // Same provider: continue its own session, so the model keeps the full conversation.
    if (!prior || (route.connectionId === prior.connectionId && prior.providerSessionId)) {
      const resume = prior?.providerSessionId ? { connectionId: prior.connectionId, providerSessionId: prior.providerSessionId } : null;
      this.launch(runId, { route, prompt: text, tried: new Set(), parentAttemptId: null, resume }, false);
      return;
    }
    // Different provider (or no native session to resume): hand the conversation over explicitly.
    const reason = route.connectionId === prior.connectionId ? 'Continuing the conversation (no native session to resume)' : `Conversation continues on ${route.modelId}`;
    const cp = this.checkpoint(run, session, project, prior, reason);
    const handoff = buildHandoff(cp, this.budgetFor(route), `Respond to the user's newest message. You are taking over an ongoing conversation from ${prior.requestedModel}.\n\n${text}`);
    if (handoff.blockedBy) {
      this.transition(runId, 'paused_uncertain', `Conversation is too large to hand to ${route.modelId}: ${handoff.blockedBy}`);
      return;
    }
    if (route.connectionId !== prior.connectionId) {
      this.emit(session.id, runId, null, 'provider.switched', { from: { connectionId: prior.connectionId, modelId: prior.requestedModel }, to: route, reason: pick.reason ?? 'Preferred model for this conversation', simulated: false });
    }
    this.launch(runId, { route, prompt: handoff.prompt, tried: new Set(), parentAttemptId: prior.id }, false);
  }

  // Latest provider-reported usage per window, kept across restarts. Only percentages the
  // provider itself reported count; nothing is estimated.
  recordUsage(connectionId: string, o: { scope: string; value: number | null; unit: string | null; resetAt: string | null; observedAt: string; confidence: string }): void {
    if (o.unit !== 'percent' || o.value === null || o.confidence !== 'reported') return;
    const all = this.store.getSetting<Record<string, UsageRecord>>(`usage:${connectionId}`, {});
    all[o.scope] = { percent: o.value, resetAt: o.resetAt, observedAt: o.observedAt };
    this.store.setSetting(`usage:${connectionId}`, all);
  }

  usageWindows(connectionId: string): UsageWindow[] {
    return Object.entries(this.store.getSetting<Record<string, UsageRecord>>(`usage:${connectionId}`, {})).map(([scope, u]) => ({ scope, percent: u.percent, resetAt: u.resetAt ? Date.parse(u.resetAt) : null }));
  }

  // The most recent provider attempt in this session before the given run.
  private lastAttemptBefore(sessionId: string, runId: string): Attempt | null {
    const runs = this.store.runsForSession(sessionId).filter((r) => r.id !== runId);
    for (let i = runs.length - 1; i >= 0; i--) {
      const attempts = this.store.attemptsForRun(runs[i]!.id);
      if (attempts.length) return attempts.at(-1)!;
    }
    return null;
  }

  private launch(runId: string, start: DriveStart, resumed: boolean): void {
    const run = this.store.getRun(runId)!;
    const active: ActiveRun = { runId, sessionId: run.sessionId, cancelRequested: false, handle: null, attemptId: null, done: Promise.resolve() };
    this.active.set(runId, active);
    active.done = this.drive(active, start, resumed)
      .catch((e: unknown) => {
        const msg = redact(e instanceof Error ? e.message : String(e));
        this.emit(run.sessionId, runId, active.attemptId, 'diagnostic', { level: 'error', message: msg });
        const cur = this.store.getRun(runId)!;
        if (!TERMINAL_STATES.has(cur.state) && !PAUSED_STATES.has(cur.state)) {
          this.store.updateRun(runId, { state: 'paused_uncertain', stateReason: `Internal error: ${msg}` });
          this.store.updateSession(run.sessionId, { state: 'paused_uncertain' });
          this.emit(run.sessionId, runId, null, 'run.stateChanged', { from: cur.state, to: 'paused_uncertain', reason: `Internal error: ${msg}` });
        }
      })
      .finally(() => {
        this.active.delete(runId);
      });
  }

  private candidates(session: Session): RouteCandidate[] {
    return session.fallback.routes.map((route) => {
      const a = this.adapters.get(route.connectionId);
      const status = a ? this.store.getSetting<{ auth: string; billing: string; models: string[] } | null>(`conn:${route.connectionId}`, null) : null;
      return {
        route,
        authenticated: !!a && (a.isMock || status?.auth === 'authenticated'),
        billing: (status?.billing ?? (a?.isMock ? 'subscription' : 'unknown')) as RouteCandidate['billing'],
        modelAvailable: !!a && (a.isMock || !status || status.models.length === 0 || status.models.includes(route.modelId)),
        coolingDownUntil: this.cooldowns.get(routeKey(route)) ?? null,
        isMock: a?.isMock ?? false,
        usage: this.usageWindows(route.connectionId),
      };
    });
  }

  private pickRoute(session: Session, project: Project | null, tried: Set<string>, currentConnectionId: string | null) {
    const consent = project ? project.crossProviderConsent : this.store.getSetting<boolean>('chat.crossProviderConsent', false);
    const allowMock = session.mode === 'mock';
    const cands = this.candidates(session).filter((c) => c.isMock === allowMock);
    // Disabling a provider reaches existing sessions too: honour both the session's own list and the global setting.
    const globalOff = this.store.getSetting<{ disabledConnections?: string[] } | null>('fallback', null)?.disabledConnections ?? [];
    const config = { ...session.fallback, disabledConnections: [...new Set([...(session.fallback.disabledConnections ?? []), ...globalOff])] };
    return selectNextRoute({ config, candidates: cands, tried, crossProviderConsent: consent, currentConnectionId, now: this.clock.now(), allowMock });
  }

  private budgetFor(route: RouteRef) {
    const limit = this.store.getSetting<number | null>(`ctx:${route.connectionId}:${route.modelId}`, null);
    return { ...DEFAULT_BUDGET, contextLimit: limit };
  }

  private async drive(active: ActiveRun, start: DriveStart, _resumed: boolean): Promise<void> {
    const runId = active.runId;
    let session = this.requireSession(active.sessionId);
    const project = session.projectId ? this.store.getProject(session.projectId) : null;
    const leaseOwner = `run:${runId}`;
    if (project) {
      try {
        this.leases.acquire(project.root, leaseOwner);
      } catch (e) {
        this.transition(runId, 'paused_uncertain', (e as Error).message);
        return;
      }
      if (!this.store.getSetting(`baseline:${runId}`, null)) {
        const base = gitBaseline(project.root);
        this.store.setSetting(`baseline:${runId}`, { manifest: buildManifest(project.root, { exclusions: project.contextExclusions }), head: base.head, dirty: base.dirtyPaths });
      }
    }
    try {
      let { route, prompt, parentAttemptId } = start;
      let resume = start.resume ?? null;
      const tried = start.tried;
      let throttleRetries = 0;
      let transportRetries = 0;
      let contextRetries = 0;

      for (;;) {
        if (active.cancelRequested) return this.cancel(runId);
        session = this.requireSession(active.sessionId);
        const adapter = this.adapters.get(route.connectionId)!;
        const attempt: Attempt = {
          id: newId('att'),
          runId,
          connectionId: route.connectionId,
          provider: adapter.provider,
          requestedModel: route.modelId,
          effectiveModel: null,
          requestedEffort: session.fallback.effort,
          effectiveEffort: null,
          providerSessionId: null,
          parentAttemptId,
          startedAt: new Date().toISOString(),
          endedAt: null,
          termination: null,
          retryCount: throttleRetries + transportRetries,
        };
        this.store.insertAttempt(attempt);
        this.store.updateRun(runId, { activeAttemptId: attempt.id });
        this.store.updateSession(session.id, { currentConnectionId: route.connectionId });
        active.attemptId = attempt.id;
        this.emit(session.id, runId, attempt.id, 'attempt.started', { connectionId: route.connectionId, provider: adapter.provider, model: route.modelId, parentAttemptId, isMock: adapter.isMock });
        if (this.store.getRun(runId)!.state !== 'running') this.transition(runId, 'running', null);

        const outcome = await this.runAttempt(active, adapter, attempt, {
          attemptId: attempt.id,
          cwd: project?.root ?? null,
          model: route.modelId,
          effort: session.fallback.effort,
          prompt,
          permissionProfile: project ? project.permissionProfile : 'chat',
          resumeProviderSessionId: resume && resume.connectionId === route.connectionId ? resume.providerSessionId : null,
          projectId: project?.id ?? null,
        }, session.fallback.attemptTimeoutMs ?? DEFAULT_FALLBACK.attemptTimeoutMs);

        if (active.cancelRequested) return this.cancel(runId);
        if (outcome.termination === 'completed') {
          this.transition(runId, 'completed', null);
          this.store.clearTransitionIntent(runId);
          return;
        }
        const failure: Failure = outcome.failure ?? { kind: 'unknown', message: `Attempt ended: ${outcome.termination}`, evidence: 'no structured error', retryAfterMs: null, resetAt: null, scope: null, simulated: false };
        if (LIMIT_KINDS.has(failure.kind)) this.emit(session.id, runId, attempt.id, 'limit.observed', { failure });
        if (failure.kind === 'usage_limit' && failure.resetAt) this.cooldowns.set(routeKey(route), Date.parse(failure.resetAt));

        const unresolvedTools = this.store.toolActionsForRun(runId).some((t) => t.attemptId === attempt.id && (t.status === 'unknown' || t.status === 'started'));
        const decision = decide(failure, { config: session.fallback, throttleRetries, transportRetries, contextRetries, unresolvedTools, random: this.random });
        if (decision.action === 'retry_same') {
          if (failure.kind === 'transport') transportRetries++;
          else throttleRetries++;
          this.emit(session.id, runId, attempt.id, 'diagnostic', { level: 'warn', message: `${decision.reason} in ${decision.delayMs} ms` });
          await this.clock.sleep(decision.delayMs);
          if (this.store.toolActionsForRun(runId).length) prompt = buildHandoff(this.checkpoint(this.store.getRun(runId)!, session, project, attempt, failure.kind === 'transport' ? 'Retry after lost connection' : 'Retry after throttle'), this.budgetFor(route)).prompt;
          parentAttemptId = attempt.id;
          continue;
        }
        if (decision.action === 'retry_compacted') {
          contextRetries++;
          const cp = this.checkpoint(this.store.getRun(runId)!, session, project, attempt, 'Context too large');
          prompt = buildHandoff(cp, { ...this.budgetFor(route), fallbackCap: 24_000 }).prompt;
          resume = null; // a compacted handoff starts a fresh provider session
          parentAttemptId = attempt.id;
          continue;
        }
        if (decision.action === 'fail') {
          this.transition(runId, 'failed', decision.reason);
          return;
        }

        // Both fallback and pause go through a checkpoint so nothing is lost.
        this.transition(runId, 'checkpointing', decision.reason);
        if (!outcome.quiescent) {
          this.transition(runId, 'paused_uncertain', 'Could not prove the previous provider process stopped. Check for running tools before continuing.');
          return;
        }
        const run = this.store.getRun(runId)!;
        const preview = this.pickRoute(session, project, new Set([...tried, routeKey(route)]), route.connectionId).route;
        const cp = this.checkpoint(run, session, project, attempt, decision.reason, { nextRoute: preview, category: categoryOf(failure.kind) });
        const uncertain = cp.unresolvedActions.filter((a) => a.risk === 'external-side-effect' || a.risk === 'unknown');
        if (uncertain.length) {
          this.transition(runId, 'paused_uncertain', `Work paused: confirm the outcome of ${uncertain.map((u) => `“${u.argsPreview}”`).join(', ')} before continuing.`);
          return;
        }
        if (active.cancelRequested) return this.cancel(runId);
        if (decision.action === 'pause') {
          this.transition(runId, decision.state, decision.reason);
          return;
        }

        this.transition(runId, 'switching', decision.reason);
        tried.add(routeKey(route));
        const pick = this.pickRoute(session, project, tried, route.connectionId);
        if (!pick.route) {
          this.transition(runId, 'paused_limits', `All routes unavailable. Checkpoint saved. ${pick.reasons.join('; ')}`);
          return;
        }
        const handoff = buildHandoff(cp, this.budgetFor(pick.route));
        if (handoff.blockedBy) {
          this.transition(runId, 'paused_uncertain', `Handoff does not fit the next route: ${handoff.blockedBy}`);
          return;
        }
        // User cancellation wins over a pending fallback (A09).
        if (active.cancelRequested) return this.cancel(runId);
        this.emit(session.id, runId, attempt.id, 'provider.switched', { from: route, to: pick.route, reason: decision.reason, simulated: failure.simulated });
        route = pick.route;
        prompt = handoff.prompt;
        parentAttemptId = attempt.id;
        throttleRetries = 0;
        transportRetries = 0;
      }
    } finally {
      if (project) this.leases.release(project.root, leaseOwner);
    }
  }

  private cancel(runId: string): void {
    const run = this.store.getRun(runId)!;
    if (!TERMINAL_STATES.has(run.state)) this.transition(runId, 'cancelled', 'Stopped by user');
    this.store.clearTransitionIntent(runId);
  }

  private async runAttempt(active: ActiveRun, adapter: ProviderAdapter, attempt: Attempt, input: Parameters<ProviderAdapter['startAttempt']>[0], timeoutMs: number): Promise<AttemptOutcome> {
    const sessionId = active.sessionId;
    const runId = active.runId;
    const handle = adapter.startAttempt(input);
    active.handle = handle;
    if (handle.pgid) this.store.setSetting(`proc:${attempt.id}`, handle.pgid);
    if (active.cancelRequested) void handle.interrupt('user stop');
    // The runner's own deadline: stop the attempt like an interrupt, then record a timeout.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void handle.interrupt('attempt timeout');
    }, Math.min(timeoutMs, MAX_TIMER_MS));
    try {
      return await this.collectAttempt(active, attempt, handle, () => timedOut, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
  }

  private async collectAttempt(active: ActiveRun, attempt: Attempt, handle: AttemptHandle, timedOut: () => boolean, timeoutMs: number): Promise<AttemptOutcome> {
    const sessionId = active.sessionId;
    const runId = active.runId;
    const partial = new Map<string, { id: string; text: string }>();
    const tag = () => {
      const a = this.store.getAttempt(attempt.id)!;
      return { connectionId: a.connectionId, provider: a.provider, model: a.effectiveModel ?? a.requestedModel };
    };

    for await (const raw of handle.events) {
      // Late events from a superseded attempt never mutate the active successor (A18).
      if (active.attemptId !== attempt.id) {
        this.store.quarantine(sessionId, attempt.id, 'late event from superseded attempt', raw);
        continue;
      }
      if (!raw || typeof raw !== 'object' || typeof (raw as { type?: unknown }).type !== 'string' || !isValidAdapterEvent(raw)) {
        this.store.quarantine(sessionId, attempt.id, 'malformed adapter event', raw);
        continue;
      }
      if (raw.providerEventId && this.store.seenProviderEvent(attempt.id, raw.providerEventId)) continue;
      this.applyAdapterEvent(sessionId, runId, attempt, raw, partial, tag);
    }
    let outcome = await handle.done;
    if (timedOut() && outcome.termination !== 'completed' && !active.cancelRequested) {
      outcome = {
        ...outcome,
        termination: 'interrupted',
        failure: { kind: 'timeout', message: `no result within ${timeoutMs} ms`, evidence: 'runner:attemptTimeoutMs', retryAfterMs: null, resetAt: null, scope: null, simulated: false },
      };
    }
    for (const [, p] of partial) this.emit(sessionId, runId, attempt.id, 'message.interrupted', { ...tag(), messageId: p.id, text: p.text, reason: outcome.termination });
    // Tool calls that never reported a result are now unknown — never assumed complete.
    for (const t of this.store.toolActionsForRun(runId).filter((t) => t.attemptId === attempt.id && t.status === 'started')) {
      this.store.upsertToolAction({ ...t, status: 'unknown', endedAt: new Date().toISOString() });
      this.emit(sessionId, runId, attempt.id, 'tool.unknown', { operationId: t.operationId, message: 'No result was recorded before the attempt ended' });
    }
    this.store.expireApprovalsForAttempt(attempt.id);
    this.store.updateAttempt(attempt.id, { endedAt: new Date().toISOString(), termination: outcome.failure ? `${outcome.termination}:${outcome.failure.kind}` : outcome.termination, providerSessionId: outcome.providerSessionId ?? this.store.getAttempt(attempt.id)!.providerSessionId });
    this.store.setSetting(`proc:${attempt.id}`, null);
    this.emit(sessionId, runId, attempt.id, 'attempt.ended', { termination: outcome.termination, quiescent: outcome.quiescent });
    active.handle = null;
    return outcome;
  }

  private applyAdapterEvent(
    sessionId: string,
    runId: string,
    attempt: Attempt,
    e: AdapterEventEnvelope,
    partial: Map<string, { id: string; text: string }>,
    tag: () => { connectionId: string; provider: Attempt['provider']; model: string },
  ): void {
    const project = (() => {
      const s = this.store.getSession(sessionId);
      return s?.projectId ? this.store.getProject(s.projectId) : null;
    })();
    switch (e.type) {
      case 'session.bound':
        this.store.updateAttempt(attempt.id, { providerSessionId: e.providerSessionId });
        return;
      case 'model.effective': {
        this.store.updateAttempt(attempt.id, { effectiveModel: e.model, effectiveEffort: e.effort });
        const note = e.model !== attempt.requestedModel ? (e.note ?? 'Provider served a different model than requested') : (e.note ?? null);
        this.emit(sessionId, runId, attempt.id, 'model.effective', { requested: attempt.requestedModel, effective: e.model, effort: e.effort, note });
        return;
      }
      case 'message.delta': {
        const key = `${attempt.id}:${e.messageKey}`;
        let p = partial.get(key);
        if (!p) {
          p = { id: this.messageIds.get(key) ?? newId('msg'), text: '' };
          this.messageIds.set(key, p.id);
          partial.set(key, p);
        }
        p.text += e.text;
        this.emit(sessionId, runId, attempt.id, 'message.delta', { ...tag(), messageId: p.id, text: e.text });
        return;
      }
      case 'message.completed': {
        const key = `${attempt.id}:${e.messageKey}`;
        const id = partial.get(key)?.id ?? this.messageIds.get(key) ?? newId('msg');
        partial.delete(key);
        this.emit(sessionId, runId, attempt.id, 'message.completed', { ...tag(), messageId: id, text: e.text });
        return;
      }
      case 'tool.started': {
        const t: ToolAction = {
          operationId: newId('op'),
          attemptId: attempt.id,
          providerToolId: e.providerToolId,
          name: e.name,
          argsHash: canonicalHash(e.args),
          argsPreview: redact(previewArgs(e.name, e.args)),
          risk: e.risk,
          cwd: project?.root ?? null,
          approvalId: null,
          paths: e.paths,
          status: 'started',
          resultDigest: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
        };
        this.store.upsertToolAction(t);
        this.emit(sessionId, runId, attempt.id, 'tool.started', { operationId: t.operationId, name: t.name, argsPreview: t.argsPreview, risk: t.risk, paths: t.paths });
        return;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.denied': {
        const t = this.store.findToolAction(attempt.id, e.providerToolId);
        if (!t) {
          this.store.quarantine(sessionId, attempt.id, 'tool result without start', e);
          return;
        }
        const status = e.type === 'tool.completed' ? 'completed' : e.type === 'tool.failed' ? 'failed' : 'denied';
        this.store.upsertToolAction({ ...t, status, resultDigest: e.type === 'tool.completed' ? canonicalHash(e.result ?? null) : null, endedAt: new Date().toISOString() });
        if (e.type === 'tool.completed') this.emit(sessionId, runId, attempt.id, 'tool.completed', { operationId: t.operationId, resultDigest: canonicalHash(e.result ?? null) });
        else this.emit(sessionId, runId, attempt.id, e.type, { operationId: t.operationId, message: redact(e.message) });
        return;
      }
      case 'approval.requested': {
        const t = e.providerToolId ? this.store.findToolAction(attempt.id, e.providerToolId) : null;
        const approvalId = newId('apr');
        this.store.insertApproval({
          id: approvalId,
          sessionId,
          runId,
          attemptId: attempt.id,
          operationId: t?.operationId ?? null,
          providerRequestId: e.providerRequestId,
          action: redact(e.action),
          scope: e.scope,
          risk: e.risk,
          permissionVersion: project?.permissionVersion ?? 0,
          status: 'pending',
          version: 0,
          resolvedBy: null,
        });
        if (t) this.store.upsertToolAction({ ...t, approvalId });
        this.emit(sessionId, runId, attempt.id, 'approval.requested', { approvalId, operationId: t?.operationId ?? null, action: redact(e.action), scope: e.scope, risk: e.risk, version: 0, canApproveForSession: e.canApproveForSession ?? false });
        if (this.store.getRun(runId)!.state === 'running') this.transition(runId, 'awaiting_approval', redact(e.action));
        return;
      }
      case 'usage.observed':
        this.emit(sessionId, runId, attempt.id, 'usage.observed', { observation: { ...e.observation, connectionId: attempt.connectionId } });
        this.recordUsage(attempt.connectionId, e.observation);
        return;
      case 'limit.observed':
        this.emit(sessionId, runId, attempt.id, 'limit.observed', { failure: e.failure });
        return;
      case 'diagnostic':
        this.emit(sessionId, runId, attempt.id, 'diagnostic', { level: e.level, message: redact(e.message) });
        return;
    }
  }

  // Deterministic, evidence-based checkpoint (spec §10). Never asks the model to summarize.
  checkpoint(run: Run, session: Session, project: Project | null, attempt: Attempt | null, reason: string, extra: { nextRoute?: RouteRef | null; category?: ProviderErrorCategory | null } = {}): Checkpoint {
    const events = this.store.listEvents(session.id);
    const actions = this.store.toolActionsForRun(run.id);
    const userMsgs = events.filter((e) => e.type === 'user.message').map((e) => (e.payload as EventPayload<'user.message'>).text);
    const recent = events
      .filter((e) => e.type === 'user.message' || e.type === 'message.completed' || e.type === 'message.interrupted')
      .slice(-10)
      .map((e) => {
        if (e.type === 'user.message') return { role: 'user' as const, provider: null, model: null, text: clip((e.payload as EventPayload<'user.message'>).text), interrupted: false };
        const p = e.payload as EventPayload<'message.completed'>;
        return { role: 'assistant' as const, provider: p.connectionId, model: p.model, text: clip(p.text), interrupted: e.type === 'message.interrupted' };
      });
    const failedMessages = events.filter((e) => e.type === 'tool.failed' && e.runId === run.id).map((e) => redact((e.payload as EventPayload<'tool.failed'>).message));
    const testEvidence = actions.filter((a) => a.status === 'completed' && isTestRun(a.name, a.argsPreview)).map((a) => `${a.name}: ${a.argsPreview}`);
    let manifest: Checkpoint['fileManifest'] = [];
    let changes: Checkpoint['changedFiles'] = [];
    let diff = '';
    const baseline = this.store.getSetting<{ manifest: Checkpoint['fileManifest']; head: string | null } | null>(`baseline:${run.id}`, null);
    if (project) {
      manifest = buildManifest(project.root, { exclusions: project.contextExclusions });
      changes = diffManifests(baseline?.manifest ?? [], manifest);
      diff = workspaceDiff(project.root, changes, undefined, project.contextExclusions);
    }
    const bindings: Record<string, string> = {};
    for (const a of this.store.attemptsForRun(run.id)) if (a.providerSessionId) bindings[a.connectionId] = a.providerSessionId;
    const body = {
      id: newId('cp'),
      sessionId: session.id,
      runId: run.id,
      objective: session.objective || userMsgs[0] || '',
      latestUserConstraints: userMsgs.slice(1).slice(-5),
      completedSteps: actions.filter((a) => a.status === 'completed').map((a) => `${a.name}: ${a.argsPreview}`),
      pendingSteps: ['Continue the objective from where the previous agent stopped'],
      decisionNotes: actions.filter((a) => a.status === 'denied').map((a) => `User denied: ${a.name} ${a.argsPreview} — do not retry it`),
      recentMessages: recent,
      baselineCommit: baseline?.head ?? null,
      fileManifest: manifest,
      changedFiles: changes,
      diff,
      testEvidence,
      providerBindings: bindings,
      unresolvedActions: actions
        .filter((a) => a.status === 'unknown' || a.status === 'started')
        .map((a) => ({ operationId: a.operationId, name: a.name, argsPreview: a.argsPreview, risk: a.risk, status: a.status })),
      permissionVersion: project?.permissionVersion ?? 0,
      switchReason: reason,
      nextRoute: extra.nextRoute ?? null,
      handoffCategory: extra.category ?? null,
      gitStatus: project ? gitStatusLines(project.root).map(redact) : [],
      knownErrors: failedMessages.slice(-10),
      permissionProfile: project?.permissionProfile ?? null,
      previousProvider: attempt ? { connectionId: attempt.connectionId, model: attempt.effectiveModel ?? attempt.requestedModel } : null,
      createdAtSeq: this.store.latestSeq(session.id),
      createdAt: new Date().toISOString(),
    };
    const { id: _id, createdAt: _c, ...hashed } = body;
    const cp: Checkpoint = { ...body, contentHash: canonicalHash(hashed) };
    this.store.commitCheckpoint(cp, { runId: run.id, kind: 'switch', detail: { reason, from: attempt?.connectionId ?? null } });
    this.emit(session.id, run.id, attempt?.id ?? null, 'checkpoint.created', { checkpointId: cp.id, contentHash: cp.contentHash, changedFiles: changes.length, omitted: [] });
    return cp;
  }
}

const TEST_COMMAND = /\b(test|vitest|jest|pytest|cargo test|go test|mocha)\b/;
// A shell action counts as a test run when it is a recognised command and names a test runner.
function isTestRun(name: string, argsPreview: string): boolean {
  if (!/^(bash|shell)$/i.test(name)) return false;
  return classifyShellCommand(argsPreview) !== 'external-side-effect' && TEST_COMMAND.test(argsPreview);
}

const ADAPTER_EVENT_TYPES = new Set([
  'session.bound',
  'model.effective',
  'message.delta',
  'message.completed',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.denied',
  'approval.requested',
  'usage.observed',
  'limit.observed',
  'diagnostic',
]);

function isValidAdapterEvent(e: AdapterEventEnvelope): boolean {
  if (!ADAPTER_EVENT_TYPES.has(e.type)) return false;
  switch (e.type) {
    case 'message.delta':
    case 'message.completed':
      return typeof e.messageKey === 'string' && typeof e.text === 'string';
    case 'tool.started':
      return typeof e.providerToolId === 'string' && typeof e.name === 'string' && Array.isArray(e.paths);
    case 'tool.completed':
    case 'tool.failed':
    case 'tool.denied':
      return typeof e.providerToolId === 'string';
    case 'approval.requested':
      return typeof e.providerRequestId === 'string' && typeof e.action === 'string';
    default:
      return true;
  }
}

function previewArgs(name: string, args: unknown): string {
  if (args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    for (const k of ['command', 'file_path', 'path', 'pattern', 'url']) if (typeof a[k] === 'string') return `${a[k] as string}`.slice(0, 300);
  }
  const s = JSON.stringify(args) ?? '';
  return `${name} ${s}`.slice(0, 300);
}

function clip(s: string, n = 4000): string {
  return s.length <= n ? s : `${s.slice(0, n)} …[truncated]`;
}
