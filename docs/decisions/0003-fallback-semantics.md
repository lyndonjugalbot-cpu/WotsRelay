# ADR 0003 — Fallback semantics and handoff

Status: accepted · 2026-11-01

- Only a **confirmed** usage limit triggers automatic fallback. "Confirmed" means a structured provider signal (Codex `codexErrorInfo=usageLimitExceeded`, or a versioned Claude fixture signature). Suspected limits, transport loss and unknown errors pause and offer an explicit "Continue with …" action.
- Every pause and switch first proves quiescence (process group gone), reconciles the action ledger, and commits a checkpoint + transition intent in one transaction.
- Unresolved actions with `external-side-effect` or `unknown` risk always pause. Local file writes are reconciled from the filesystem manifest.
- Route eligibility: configured, authenticated, not cooling down, never API-billed unless `allowApiBilling`, never mock in a real session, and cross-provider only with per-project (or chat-wide) consent. Each route at most once per cycle; a new run starts from the primary again.
- The handoff is assembled deterministically from durable evidence in spec priority order, redacted, and budgeted; non-critical sections shrink first, and if a critical section cannot fit the run pauses.
- Late events from a superseded attempt are quarantined; provider event ids are deduplicated.
