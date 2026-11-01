import { z } from 'zod';
import {
  ApprovalDecisionParams,
  CreateSessionParams,
  FallbackConfig,
  RegisterProjectParams,
  RouteRef,
  SendMessageParams,
  SubscribeParams,
  type EventEnvelope,
  type EventPayload,
  type ModelCapability,
} from '@wots/protocol';
import { promoteRoute, type ProviderAdapter } from '@wots/core';
import { Store } from '@wots/storage';
import { WorkspaceLeases, canonicalRoot, gitBaseline } from '@wots/workspace';
import { MockAdapter, SCENARIOS } from '@wots/adapter-mock';
import { ClaudeCodeAdapter } from '@wots/adapter-claude-code';
import { CodexAdapter } from '@wots/adapter-codex';
import { redact } from '@wots/security';
import { RelayController, RelayError } from './sessions/controller.ts';
import { RpcServer, type Handler } from './server/rpc.ts';
import { Gateway, GatewayPatch } from './server/gateway.ts';
import { fileCapture, listCaptures } from './capture.ts';
import { acquireDaemonLock, ensureHome, runnerPaths, type RunnerPaths } from './paths.ts';

export const RUNNER_VERSION = '0.1.0';

export interface Runner {
  paths: RunnerPaths;
  relay: RelayController;
  server: RpcServer;
  gateway: Gateway;
  stop(): Promise<void>;
}

export function buildAdapters(store: Store, paths: RunnerPaths, env: NodeJS.ProcessEnv = process.env): ProviderAdapter[] {
  const capture = fileCapture(paths.captures, () => store.getSetting('capture.streams', false));
  const scenario = () => SCENARIOS[store.getSetting('mock.scenario', 'quota-after-edit')] ?? SCENARIOS['quota-after-edit']!;
  return [
    new ClaudeCodeAdapter({ chatSandboxDir: paths.chatSandbox, env, capture }),
    new CodexAdapter({ chatSandboxDir: paths.chatSandbox, env, capture }),
    new MockAdapter({ connectionId: 'mock-claude', label: 'Mock Claude', models: ['claude-opus-5-5'], script: (i, n) => scenario().primary(i, n) }),
    new MockAdapter({ connectionId: 'mock-codex', label: 'Mock Codex', models: ['gpt-6-astra'], script: (i, n) => scenario().secondary(i, n) }),
  ];
}

export async function startRunner(opts: { home?: string; adapters?: (store: Store, paths: RunnerPaths) => ProviderAdapter[]; refreshOnStart?: boolean } = {}): Promise<Runner> {
  const paths = runnerPaths(opts.home);
  ensureHome(paths);
  const releaseLock = acquireDaemonLock(paths);
  const store = new Store(paths.db);
  let server: RpcServer | null = null;
  let gateway: Gateway | null = null;
  const relay = new RelayController({
    store,
    leases: new WorkspaceLeases(paths.leases),
    adapters: (opts.adapters ?? buildAdapters)(store, paths),
    publish: (e) => server?.broadcast(e),
  });
  const recovered = relay.recover();
  const startedAt = Date.now();
  let stopping: Promise<void> | null = null;

  const stop = () =>
    (stopping ??= (async () => {
      // Stop child process groups and let runs persist their final state before exit.
      for (const s of store.listSessions(1000)) for (const r of store.runsForSession(s.id)) if (r.state === 'running' || r.state === 'awaiting_approval') relay.interrupt(r.id);
      await Promise.race([Promise.all(store.runsInStates(['running', 'awaiting_approval', 'checkpointing', 'switching', 'preparing']).map((r) => relay.waitForRun(r.id))), new Promise((r) => setTimeout(r, 15_000))]);
      await gateway?.stop();
      await server?.close();
      store.close();
      releaseLock();
    })());

  const sessionView = (id: string) => {
    const s = store.getSession(id);
    if (!s) throw new RelayError('not_found', 'Unknown session');
    const runs = store.runsForSession(id);
    return { session: s, runs, attempts: runs.flatMap((r) => store.attemptsForRun(r.id)), pendingApprovals: store.pendingApprovals(id), checkpoint: store.latestCheckpoint(id) };
  };

  const handlers: Record<string, Handler> = {
    'runner.status': () => ({ pid: process.pid, version: RUNNER_VERSION, uptimeMs: Date.now() - startedAt, home: paths.home, recovered: recovered.recovered, sessions: store.listSessions(1000).length }),
    'runner.stop': () => {
      setTimeout(() => void stop().then(() => process.exit(0)), 10);
      return { stopping: true };
    },
    'connections.list': async (p) => {
      if (z.object({ refresh: z.boolean().default(false) }).parse(p).refresh) await relay.refreshConnections();
      return relay.listAdapters().map((a) => {
        const cached = store.getSetting<{ connection?: unknown } | null>(`conn:${a.connectionId}`, null);
        return { connectionId: a.connectionId, provider: a.provider, isMock: a.isMock, connection: cached?.connection ?? null };
      });
    },
    'models.list': () => Object.fromEntries(relay.listAdapters().map((a) => [a.connectionId, store.getSetting<ModelCapability[]>(`models:${a.connectionId}`, [])])),
    'projects.register': (p) => {
      const params = RegisterProjectParams.parse(p);
      const root = canonicalRoot(params.root);
      const project = relay.registerProject({ ...params, root });
      const base = gitBaseline(root);
      return { project, git: base };
    },
    'projects.list': () => store.listProjects(),
    'sessions.create': (p) => {
      const params = CreateSessionParams.extend({ mode: z.enum(['real', 'mock']).default('real'), mockScenario: z.string().optional() }).parse(p);
      if (params.mode === 'mock' && params.mockScenario) {
        if (!SCENARIOS[params.mockScenario]) throw new RelayError('invalid_params', `Unknown mock scenario. Options: ${Object.keys(SCENARIOS).join(', ')}`);
        store.setSetting('mock.scenario', params.mockScenario);
      }
      return relay.createSession({ projectId: params.projectId, title: params.title, mode: params.mode });
    },
    'sessions.list': () => store.listSessions(200),
    // /model: put the chosen model first for this session; the next run uses it.
    'sessions.setRoute': (p) => {
      const { sessionId, route } = z.object({ sessionId: z.string(), route: RouteRef }).parse(p);
      const s = store.getSession(sessionId);
      if (!s) throw new RelayError('not_found', 'Unknown session');
      const adapter = relay.adapter(route.connectionId);
      if (!adapter || adapter.isMock !== (s.mode === 'mock')) throw new RelayError('invalid_params', `${route.connectionId} cannot serve a ${s.mode} session`);
      return store.updateSession(sessionId, { fallback: { ...s.fallback, routes: promoteRoute(s.fallback.routes, route) } });
    },
    'sessions.get': (p) => sessionView(z.object({ sessionId: z.string() }).parse(p).sessionId),
    'messages.send': (p) => relay.sendMessage(SendMessageParams.parse(p)),
    'runs.interrupt': (p) => relay.interrupt(z.object({ runId: z.string() }).parse(p).runId),
    'runs.resume': (p) => {
      const params = z.object({ sessionId: z.string(), fallback: z.boolean().default(false), note: z.string().max(20_000).optional() }).parse(p);
      return relay.resume(params.sessionId, params);
    },
    // A paired device is identified by its authenticated id, never by what it claims.
    'approvals.decide': (p, conn) => relay.decideApproval({ ...ApprovalDecisionParams.parse(p), ...(conn.deviceId ? { deviceId: conn.deviceId } : {}) }),
    'events.list': (p) => {
      const { sessionId, after } = SubscribeParams.parse(p);
      return store.listEvents(sessionId, after);
    },
    // Synchronous replay-then-subscribe: no event can be published between the two steps.
    'events.subscribe': (p, conn) => {
      const { sessionId, after } = SubscribeParams.parse(p);
      if (sessionId !== '*' && !store.getSession(sessionId)) throw new RelayError('not_found', 'Unknown session');
      server!.subscribe(conn, sessionId);
      return { replay: sessionId === '*' ? [] : store.listEvents(sessionId, after) };
    },
    'events.unsubscribe': (p, conn) => {
      conn.subscriptions.delete(z.object({ sessionId: z.string() }).parse(p).sessionId);
      return { ok: true };
    },
    // Latest provider-reported usage windows and the switch threshold (spec: switch at 95%).
    'usage.get': () => {
      const cfg = store.getSetting<{ switchAtPercent?: number } | null>('fallback', null);
      return {
        switchAtPercent: cfg?.switchAtPercent ?? 95,
        connections: Object.fromEntries(relay.listAdapters().map((a) => [a.connectionId, relay.usageWindows(a.connectionId).map((w) => ({ scope: w.scope, percent: w.percent, resetAt: w.resetAt ? new Date(w.resetAt).toISOString() : null }))])),
      };
    },
    'fallback.get': () => ({ real: loadFallback(store), chatConsent: store.getSetting('chat.crossProviderConsent', false) }),
    'fallback.set': (p) => {
      const cfg = FallbackConfig.parse(p);
      if (cfg.routes.some((r) => relay.adapter(r.connectionId)?.isMock)) throw new RelayError('invalid_params', 'Mock routes cannot be part of the real fallback order');
      store.setSetting('fallback', cfg);
      return cfg;
    },
    'settings.setChatConsent': (p) => {
      const v = z.object({ consent: z.boolean() }).parse(p).consent;
      store.setSetting('chat.crossProviderConsent', v);
      return { consent: v };
    },
    // Local socket only: none of these are in the gateway's MOBILE_METHODS allowlist.
    'gateway.status': () => gateway!.status(),
    'gateway.configure': (p) => gateway!.configure(GatewayPatch.parse(p)),
    'gateway.pair': () => gateway!.pair(),
    'devices.list': () => store.listDevices(),
    'capture.get': () => ({ enabled: store.getSetting('capture.streams', false), dir: paths.captures, captures: listCaptures(paths.captures) }),
    'capture.set': (p) => {
      store.setSetting('capture.streams', z.object({ enabled: z.boolean() }).parse(p).enabled);
      return { enabled: store.getSetting('capture.streams', false), dir: paths.captures };
    },
    'devices.revoke': (p) => gateway!.revoke(z.object({ deviceId: z.string() }).parse(p).deviceId),
    export: (p) => {
      const { sessionId, format } = z.object({ sessionId: z.string(), format: z.enum(['markdown', 'json']).default('markdown') }).parse(p);
      const view = sessionView(sessionId);
      const events = store.listEvents(sessionId);
      return format === 'json' ? JSON.parse(redact(JSON.stringify({ ...view, events }))) : exportMarkdown(view.session.title, events);
    },
  };

  server = new RpcServer(handlers);
  await server.listen(paths.socket);
  gateway = new Gateway({ store, rpc: server, dir: paths.gateway });
  // A gateway that cannot bind (address gone, port taken) must not take the runner down with it.
  await gateway.start().catch((e: Error) => process.stderr.write(`wots-runner: gateway not started: ${redact(e.message)}\n`));
  if (opts.refreshOnStart !== false) void relay.refreshConnections();
  return { paths, relay, server, gateway, stop };
}

// The stored real-session fallback, parsed so older saved configs gain new defaults. It never
// adds or reorders routes; new providers join only when the user enables them.
export function loadFallback(store: Pick<Store, 'getSetting'>): FallbackConfig {
  return FallbackConfig.parse(store.getSetting('fallback', null) ?? defaultFallback());
}

function defaultFallback() {
  return {
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
}

// Visible multi-provider timeline. Secrets are redacted; hidden reasoning is never recorded.
export function exportMarkdown(title: string, events: EventEnvelope[]): string {
  const out = [`# ${title}`, '', `Exported from WotsRelay ${new Date().toISOString()}`, ''];
  for (const e of events) {
    const t = e.ts.replace('T', ' ').slice(0, 19);
    switch (e.type) {
      case 'user.message':
        out.push(`## You · ${t}`, '', (e.payload as EventPayload<'user.message'>).text, '');
        break;
      case 'message.completed':
      case 'message.interrupted': {
        const p = e.payload as EventPayload<'message.completed'>;
        out.push(`## ${p.connectionId ?? 'assistant'} · ${p.model ?? ''} · ${t}${e.type === 'message.interrupted' ? ' · interrupted' : ''}`, '', p.text, '');
        break;
      }
      case 'provider.switched': {
        const p = e.payload as EventPayload<'provider.switched'>;
        out.push(`> Switched ${p.from.connectionId} → ${p.to.connectionId}: ${p.reason}${p.simulated ? ' (simulated)' : ''}`, '');
        break;
      }
      case 'tool.started': {
        const p = e.payload as EventPayload<'tool.started'>;
        out.push(`- tool \`${p.name}\` ${p.argsPreview} (${p.risk})`);
        break;
      }
      case 'run.stateChanged': {
        const p = e.payload as EventPayload<'run.stateChanged'>;
        if (p.to.startsWith('paused') || p.to === 'failed' || p.to === 'cancelled') out.push('', `> Run ${p.to}${p.reason ? `: ${p.reason}` : ''}`, '');
        break;
      }
    }
  }
  return redact(out.join('\n'));
}
