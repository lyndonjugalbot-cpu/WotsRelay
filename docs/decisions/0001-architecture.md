# ADR 0001 — Runner-owned orchestration, TypeScript monorepo

Status: accepted · 2026-11-01

## Context
The product must keep work running independent of the desktop window, share one history across desktop, CLI and phone, and switch providers safely.

## Decision
- pnpm TypeScript monorepo. Node 26 runs TypeScript directly (type stripping), so the runner and CLI have no build step; `erasableSyntaxOnly` keeps sources compatible.
- A standalone runner daemon (one per OS user, pid-file lock) owns all sessions, provider processes and the SQLite journal. Clients attach over a user-only Unix socket (`r.sock`, mode 0600) using newline-delimited JSON.
- Storage uses the built-in `node:sqlite` (WAL, single writer, append-only migrations). No native module compile.
- Persist-before-publish: every event gets a per-session sequence in the write transaction and is broadcast only after commit; clients replay by cursor.
- Pure decision logic (`@wots/core`: transition table, failure policy, route selection) is separate from I/O so every invariant is unit-tested.
- Electron + React + Vite for desktop (renderer sandboxed, context isolation, no Node, strict CSP, RPC allowlist). Vanilla three.js for the single 3D element.

## Consequences
- Requires Node ≥ 26 on the Mac. The desktop dev build launches the runner with the system Node from this checkout; a packaged build must bundle the runner (open item).
- Mobile will reach the runner through a separate authenticated HTTPS/WebSocket gateway, not the Unix socket.
