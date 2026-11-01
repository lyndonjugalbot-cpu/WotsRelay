import type { EventEnvelope, Project, Session, Run, Attempt, Checkpoint } from '@wots/protocol';

interface Bridge {
  call(method: string, params?: unknown): Promise<unknown>;
  onEvent(fn: (e: EventEnvelope) => void): () => void;
  onRunner(fn: (s: { online: boolean; error?: string }) => void): () => void;
  pickProject(): Promise<string | null>;
  reconnect(): Promise<boolean>;
}

declare global {
  interface Window {
    wots: Bridge;
  }
}

export const bridge = (): Bridge => window.wots;

export interface ConnectionRow {
  connectionId: string;
  provider: string;
  isMock: boolean;
  connection: { authStatus: string; billingMode: string; toolVersion: string | null; lastChecked: string; limitations: string[]; executablePath: string | null } | null;
}

export interface SessionView {
  session: Session;
  runs: Run[];
  attempts: Attempt[];
  pendingApprovals: Array<{ id: string; version: number }>;
  checkpoint: Checkpoint | null;
}

export const api = {
  sessions: () => bridge().call('sessions.list') as Promise<Session[]>,
  session: (sessionId: string) => bridge().call('sessions.get', { sessionId }) as Promise<SessionView>,
  createSession: (projectId: string | null, mode: 'real' | 'mock', mockScenario?: string) => bridge().call('sessions.create', { projectId, mode, mockScenario }) as Promise<Session>,
  send: (sessionId: string, text: string) => bridge().call('messages.send', { sessionId, text, idempotencyKey: crypto.randomUUID() }) as Promise<{ runId: string }>,
  interrupt: (runId: string) => bridge().call('runs.interrupt', { runId }),
  resume: (sessionId: string, fallback: boolean, note?: string) => bridge().call('runs.resume', { sessionId, fallback, note }) as Promise<{ runId: string }>,
  decide: (approvalId: string, decision: 'approve' | 'reject', expectedVersion: number) => bridge().call('approvals.decide', { approvalId, decision, expectedVersion, deviceId: 'desktop' }) as Promise<{ applied: boolean; status: string }>,
  subscribe: (sessionId: string, after: number) => bridge().call('events.subscribe', { sessionId, after }) as Promise<{ replay: EventEnvelope[] }>,
  unsubscribe: (sessionId: string) => bridge().call('events.unsubscribe', { sessionId }),
  connections: (refresh = false) => bridge().call('connections.list', { refresh }) as Promise<ConnectionRow[]>,
  fallback: () => bridge().call('fallback.get') as Promise<{ real: { routes: Array<{ connectionId: string; modelId: string }>; effort: string; speed: string; autoFallback: boolean }; chatConsent: boolean }>,
  setChatConsent: (consent: boolean) => bridge().call('settings.setChatConsent', { consent }),
  projects: () => bridge().call('projects.list') as Promise<Project[]>,
  registerProject: (root: string, crossProviderConsent: boolean) => bridge().call('projects.register', { root, trusted: true, permissionProfile: 'edit', crossProviderConsent }) as Promise<{ project: Project; git: { isRepo: boolean; dirtyPaths: string[] } }>,
  exportMarkdown: (sessionId: string) => bridge().call('export', { sessionId, format: 'markdown' }) as Promise<string>,
};
