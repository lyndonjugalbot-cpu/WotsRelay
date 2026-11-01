// Append-only. Never edit a released migration; add a new version instead.
export const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), data TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), state TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX runs_state ON runs(state);
      CREATE TABLE attempts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL);
      CREATE TABLE events (
        session_id TEXT NOT NULL REFERENCES sessions(id),
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        run_id TEXT, attempt_id TEXT,
        ts TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE TABLE quarantined_events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, attempt_id TEXT, reason TEXT NOT NULL, raw TEXT NOT NULL, ts TEXT NOT NULL);
      CREATE TABLE provider_event_ids (attempt_id TEXT NOT NULL, provider_event_id TEXT NOT NULL, PRIMARY KEY (attempt_id, provider_event_id));
      CREATE TABLE tool_actions (operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), provider_tool_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX tool_actions_provider ON tool_actions(attempt_id, provider_tool_id);
      CREATE TABLE checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, content_hash TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE transition_intents (run_id TEXT PRIMARY KEY, kind TEXT NOT NULL, checkpoint_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE approvals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE idempotency (key TEXT NOT NULL, scope TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (key, scope));
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE devices (id TEXT PRIMARY KEY, data TEXT NOT NULL, revoked_at TEXT);
      CREATE TABLE pairing_challenges (code_hash TEXT PRIMARY KEY, host TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE usage_observations (id INTEGER PRIMARY KEY, connection_id TEXT NOT NULL, data TEXT NOT NULL, observed_at TEXT NOT NULL);
    `,
  },
];
