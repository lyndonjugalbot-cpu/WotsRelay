import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { chmodSync, existsSync } from 'node:fs';
import {
  SCHEMA_VERSION,
  type Attempt,
  type Checkpoint,
  type EventEnvelope,
  type EventType,
  type EventPayload,
  type Project,
  type Run,
  type RunState,
  type Session,
  type ToolAction,
  EventPayloads,
  Session as SessionSchema,
  Project as ProjectSchema,
  Checkpoint as CheckpointSchema,
} from '@wots/protocol';
import { MIGRATIONS } from './migrations.ts';

export { MIGRATIONS };

export interface AppendEventInput<T extends EventType = EventType> {
  sessionId: string;
  runId: string | null;
  attemptId: string | null;
  eventId: string;
  type: T;
  payload: EventPayload<T>;
  ts?: string;
}

export type ApprovalRow = {
  id: string;
  sessionId: string;
  runId: string;
  attemptId: string;
  operationId: string | null;
  providerRequestId: string;
  action: string;
  scope: string;
  risk: string;
  permissionVersion: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  version: number;
  resolvedBy: string | null;
};

export type DeviceRow = {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
};

const iso = () => new Date().toISOString();

export class Store {
  readonly db: DatabaseSync;

  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:' && existsSync(path)) chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  // ---- migrations ----------------------------------------------------------------------

  schemaVersion(): number {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const row = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    return row.v ?? 0;
  }

  private migrate(): void {
    const current = this.schemaVersion();
    for (const m of MIGRATIONS) {
      if (m.version <= current) continue;
      // Each migration and its version record commit atomically, so an interrupted
      // migration leaves the previous schema intact and is re-applied on next start.
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, iso());
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ---- key/value settings ------------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }

  // ---- projects ------------------------------------------------------------------------

  upsertProject(p: Project): Project {
    ProjectSchema.parse(p);
    this.db
      .prepare(
        `INSERT INTO projects (id, root, data) VALUES (?, ?, ?)
         ON CONFLICT(root) DO UPDATE SET data = excluded.data`,
      )
      .run(p.id, p.root, JSON.stringify(p));
    return this.getProjectByRoot(p.root)!;
  }

  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Project) : null;
  }

  getProjectByRoot(root: string): Project | null {
    const row = this.db.prepare('SELECT data FROM projects WHERE root = ?').get(root) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Project) : null;
  }

  listProjects(): Project[] {
    return (this.db.prepare('SELECT data FROM projects ORDER BY rowid').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Project);
  }

  // ---- sessions ------------------------------------------------------------------------

  insertSession(s: Session): void {
    SessionSchema.parse(s);
    this.db.prepare('INSERT INTO sessions (id, project_id, data, updated_at) VALUES (?, ?, ?, ?)').run(s.id, s.projectId, JSON.stringify(s), s.updatedAt);
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id = ?').get(id) as { data: string } | undefined;
    if (!row) return null;
    const s = JSON.parse(row.data) as Session;
    s.latestSeq = this.latestSeq(id);
    return s;
  }

  updateSession(id: string, patch: Partial<Session>): Session {
    const s = this.getSession(id);
    if (!s) throw new Error(`Unknown session ${id}`);
    const next = { ...s, ...patch, updatedAt: iso() };
    this.db.prepare('UPDATE sessions SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(next), next.updatedAt, id);
    return next;
  }

  listSessions(limit = 100): Session[] {
    const rows = this.db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC LIMIT ?').all(limit) as { id: string }[];
    return rows.map((r) => this.getSession(r.id)!);
  }

  // ---- runs / attempts -----------------------------------------------------------------

  insertRun(r: Run): void {
    this.db.prepare('INSERT INTO runs (id, session_id, state, data) VALUES (?, ?, ?, ?)').run(r.id, r.sessionId, r.state, JSON.stringify(r));
  }

  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT data FROM runs WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Run) : null;
  }

  updateRun(id: string, patch: Partial<Run>): Run {
    const r = this.getRun(id);
    if (!r) throw new Error(`Unknown run ${id}`);
    const next = { ...r, ...patch, updatedAt: iso() };
    this.db.prepare('UPDATE runs SET state = ?, data = ? WHERE id = ?').run(next.state, JSON.stringify(next), id);
    return next;
  }

  runsForSession(sessionId: string): Run[] {
    return (this.db.prepare('SELECT data FROM runs WHERE session_id = ? ORDER BY rowid').all(sessionId) as { data: string }[]).map((r) => JSON.parse(r.data) as Run);
  }

  runsInStates(states: RunState[]): Run[] {
    const q = `SELECT data FROM runs WHERE state IN (${states.map(() => '?').join(',')})`;
    return (this.db.prepare(q).all(...states) as { data: string }[]).map((r) => JSON.parse(r.data) as Run);
  }

  insertAttempt(a: Attempt): void {
    this.db.prepare('INSERT INTO attempts (id, run_id, data) VALUES (?, ?, ?)').run(a.id, a.runId, JSON.stringify(a));
  }

  getAttempt(id: string): Attempt | null {
    const row = this.db.prepare('SELECT data FROM attempts WHERE id = ?').get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Attempt) : null;
  }

  updateAttempt(id: string, patch: Partial<Attempt>): Attempt {
    const a = this.getAttempt(id);
    if (!a) throw new Error(`Unknown attempt ${id}`);
    const next = { ...a, ...patch };
    this.db.prepare('UPDATE attempts SET data = ? WHERE id = ?').run(JSON.stringify(next), id);
    return next;
  }

  attemptsForRun(runId: string): Attempt[] {
    return (this.db.prepare('SELECT data FROM attempts WHERE run_id = ? ORDER BY rowid').all(runId) as { data: string }[]).map((r) => JSON.parse(r.data) as Attempt);
  }

  // ---- events --------------------------------------------------------------------------

  latestSeq(sessionId: string): number {
    const row = this.db.prepare('SELECT MAX(seq) AS s FROM events WHERE session_id = ?').get(sessionId) as { s: number | null };
    return row.s ?? 0;
  }

  // Persist-before-publish: allocates the next per-session sequence inside the write
  // transaction. Duplicate eventIds are ignored and return the original row (dedupe).
  appendEvent<T extends EventType>(input: AppendEventInput<T>): { event: EventEnvelope; duplicate: boolean } {
    const payload = EventPayloads[input.type].parse(input.payload);
    const existing = this.db.prepare('SELECT * FROM events WHERE event_id = ?').get(input.eventId) as EventRow | undefined;
    if (existing) return { event: rowToEvent(existing), duplicate: true };
    const doInsert = () => {
      const seq = this.latestSeq(input.sessionId) + 1;
      const ts = input.ts ?? iso();
      this.db
        .prepare('INSERT INTO events (session_id, seq, event_id, run_id, attempt_id, ts, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(input.sessionId, seq, input.eventId, input.runId, input.attemptId, ts, input.type, JSON.stringify(payload));
      return seq;
    };
    const seq = this.db.isTransaction ? doInsert() : this.tx(doInsert);
    return {
      event: { schemaVersion: SCHEMA_VERSION, sessionId: input.sessionId, runId: input.runId, attemptId: input.attemptId, seq, eventId: input.eventId, ts: input.ts ?? iso(), type: input.type, payload },
      duplicate: false,
    };
  }

  listEvents(sessionId: string, after = 0, limit = 10_000): EventEnvelope[] {
    const rows = this.db.prepare('SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?').all(sessionId, after, limit) as EventRow[];
    return rows.map(rowToEvent);
  }

  quarantine(sessionId: string, attemptId: string | null, reason: string, raw: unknown): void {
    this.db.prepare('INSERT INTO quarantined_events (session_id, attempt_id, reason, raw, ts) VALUES (?, ?, ?, ?, ?)').run(sessionId, attemptId, reason, JSON.stringify(raw), iso());
  }

  quarantined(sessionId: string): Array<{ reason: string; raw: unknown }> {
    return (this.db.prepare('SELECT reason, raw FROM quarantined_events WHERE session_id = ?').all(sessionId) as { reason: string; raw: string }[]).map((r) => ({ reason: r.reason, raw: JSON.parse(r.raw) }));
  }

  seenProviderEvent(attemptId: string, providerEventId: string): boolean {
    const r = this.db.prepare('INSERT OR IGNORE INTO provider_event_ids (attempt_id, provider_event_id) VALUES (?, ?)').run(attemptId, providerEventId);
    return r.changes === 0;
  }

  // ---- tool ledger ---------------------------------------------------------------------

  upsertToolAction(t: ToolAction): void {
    this.db
      .prepare(
        `INSERT INTO tool_actions (operation_id, attempt_id, provider_tool_id, status, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET status = excluded.status, data = excluded.data`,
      )
      .run(t.operationId, t.attemptId, t.providerToolId, t.status, JSON.stringify(t));
  }

  findToolAction(attemptId: string, providerToolId: string): ToolAction | null {
    const row = this.db.prepare('SELECT data FROM tool_actions WHERE attempt_id = ? AND provider_tool_id = ?').get(attemptId, providerToolId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ToolAction) : null;
  }

  toolActionsForRun(runId: string): ToolAction[] {
    return (
      this.db.prepare('SELECT t.data FROM tool_actions t JOIN attempts a ON a.id = t.attempt_id WHERE a.run_id = ? ORDER BY t.rowid').all(runId) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as ToolAction);
  }

  // ---- checkpoints + transition intent ------------------------------------------------

  // Spec §9 step 5: checkpoint and transition intent commit in one transaction.
  commitCheckpoint(cp: Checkpoint, intent: { runId: string; kind: string; detail: unknown }): void {
    CheckpointSchema.parse(cp);
    this.tx(() => {
      this.db.prepare('INSERT INTO checkpoints (id, session_id, run_id, content_hash, data) VALUES (?, ?, ?, ?, ?)').run(cp.id, cp.sessionId, cp.runId, cp.contentHash, JSON.stringify(cp));
      this.db
        .prepare('INSERT INTO transition_intents (run_id, kind, checkpoint_id, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET kind = excluded.kind, checkpoint_id = excluded.checkpoint_id, detail = excluded.detail, created_at = excluded.created_at')
        .run(intent.runId, intent.kind, cp.id, JSON.stringify(intent.detail), iso());
    });
  }

  latestCheckpoint(sessionId: string): Checkpoint | null {
    const row = this.db.prepare('SELECT data FROM checkpoints WHERE session_id = ? ORDER BY rowid DESC LIMIT 1').get(sessionId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as Checkpoint) : null;
  }

  transitionIntent(runId: string): { kind: string; checkpointId: string; detail: unknown } | null {
    const row = this.db.prepare('SELECT kind, checkpoint_id, detail FROM transition_intents WHERE run_id = ?').get(runId) as { kind: string; checkpoint_id: string; detail: string } | undefined;
    return row ? { kind: row.kind, checkpointId: row.checkpoint_id, detail: JSON.parse(row.detail) } : null;
  }

  clearTransitionIntent(runId: string): void {
    this.db.prepare('DELETE FROM transition_intents WHERE run_id = ?').run(runId);
  }

  // ---- approvals -----------------------------------------------------------------------

  insertApproval(a: ApprovalRow): void {
    this.db
      .prepare('INSERT INTO approvals (id, session_id, run_id, attempt_id, status, version, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.sessionId, a.runId, a.attemptId, a.status, a.version, JSON.stringify(a));
  }

  getApproval(id: string): ApprovalRow | null {
    const row = this.db.prepare('SELECT data, status, version FROM approvals WHERE id = ?').get(id) as { data: string; status: string; version: number } | undefined;
    if (!row) return null;
    return { ...(JSON.parse(row.data) as ApprovalRow), status: row.status as ApprovalRow['status'], version: row.version };
  }

  pendingApprovals(sessionId: string): ApprovalRow[] {
    const rows = this.db.prepare("SELECT id FROM approvals WHERE session_id = ? AND status = 'pending'").all(sessionId) as { id: string }[];
    return rows.map((r) => this.getApproval(r.id)!);
  }

  // Compare-and-set: exactly one caller wins even if desktop and phone decide together.
  resolveApproval(id: string, decision: 'approve' | 'reject', expectedVersion: number, by: string): boolean {
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const r = this.db
      .prepare("UPDATE approvals SET status = ?, version = version + 1, data = json_set(data, '$.resolvedBy', ?) WHERE id = ? AND status = 'pending' AND version = ?")
      .run(status, by, id, expectedVersion);
    return r.changes === 1;
  }

  expireApprovalsForAttempt(attemptId: string): void {
    this.db.prepare("UPDATE approvals SET status = 'expired', version = version + 1 WHERE attempt_id = ? AND status = 'pending'").run(attemptId);
  }

  // ---- paired devices --------------------------------------------------------------------

  insertPairingCode(codeHash: string, host: string, expiresAt: number): void {
    this.db.prepare('DELETE FROM pairing_challenges WHERE expires_at < ? OR used_at IS NOT NULL').run(Date.now());
    this.db.prepare('INSERT INTO pairing_challenges (code_hash, host, expires_at) VALUES (?, ?, ?)').run(codeHash, host, expiresAt);
  }

  // Compare-and-set: a code pairs at most one device, and never after it expires.
  consumePairingCode(codeHash: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE pairing_challenges SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, codeHash, now).changes === 1;
  }

  insertDevice(d: DeviceRow): void {
    this.db.prepare('INSERT INTO devices (id, data, revoked_at) VALUES (?, ?, NULL)').run(d.id, JSON.stringify(d));
  }

  getDevice(id: string): (DeviceRow & { revokedAt: string | null }) | null {
    const row = this.db.prepare('SELECT data, revoked_at FROM devices WHERE id = ?').get(id) as { data: string; revoked_at: string | null } | undefined;
    return row ? { ...(JSON.parse(row.data) as DeviceRow), revokedAt: row.revoked_at } : null;
  }

  // Token hashes stay inside the store; listings are safe to show.
  listDevices(): Array<Omit<DeviceRow, 'tokenHash'> & { revokedAt: string | null }> {
    const rows = this.db.prepare('SELECT id FROM devices ORDER BY rowid').all() as { id: string }[];
    return rows.map((r) => {
      const { tokenHash: _, ...d } = this.getDevice(r.id)!;
      return d;
    });
  }

  touchDevice(id: string): void {
    this.db.prepare("UPDATE devices SET data = json_set(data, '$.lastSeenAt', ?) WHERE id = ?").run(iso(), id);
  }

  revokeDevice(id: string): boolean {
    return this.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(iso(), id).changes === 1;
  }

  // ---- idempotency ---------------------------------------------------------------------

  idempotent<T>(key: string, scope: string, fn: () => T): { result: T; replayed: boolean } {
    const row = this.db.prepare('SELECT result FROM idempotency WHERE key = ? AND scope = ?').get(key, scope) as { result: string } | undefined;
    if (row) return { result: JSON.parse(row.result) as T, replayed: true };
    const result = fn();
    this.db.prepare('INSERT INTO idempotency (key, scope, result, created_at) VALUES (?, ?, ?, ?)').run(key, scope, JSON.stringify(result), iso());
    return { result, replayed: false };
  }

  // ---- generic run query helper -----------------------------------------------------------

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
}

type EventRow = { session_id: string; seq: number; event_id: string; run_id: string | null; attempt_id: string | null; ts: string; type: string; payload: string };

function rowToEvent(r: EventRow): EventEnvelope {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: r.session_id,
    runId: r.run_id,
    attemptId: r.attempt_id,
    seq: r.seq,
    eventId: r.event_id,
    ts: r.ts,
    type: r.type as EventType,
    payload: JSON.parse(r.payload),
  };
}
