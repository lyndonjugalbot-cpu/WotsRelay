# ADR 0002 — Claude Code transport and approval mechanism

Status: accepted for v0.1 · 2026-11-01

## Context
WotsRelay must use the official, unmodified Claude Code binary with the user's own sign-in, never handle Claude credentials, and never bypass permissions. `claude -p` shows no workspace-trust dialog and, without `--bare`, loads project hooks and MCP servers. `--bare` disables subscription auth.

## Decision
- Transport: `claude -p --output-format stream-json --verbose --include-partial-messages` with the prompt on stdin (never in argv).
- Isolation from repository content: `--setting-sources user` and `--strict-mcp-config`; projects must be explicitly trusted in WotsRelay.
- Permissions by profile, using documented modes only:
  - `edit` → `--permission-mode acceptEdits --permission-prompts none`
  - `read-only` / `chat` → `--permission-mode dontAsk --permission-prompts none`; chat runs in an empty sandbox directory.
  Anything outside the profile is denied by Claude Code itself and surfaced as `tool.denied` (`permission_denied` events).
- No `--dangerously-skip-permissions`, no `--fallback-model` (native substitution would hide the effective model), no environment rewriting. If `ANTHROPIC_API_KEY` or similar is present, runs are blocked with an explanation instead of silently billing an API account.
- Interactive approvals are **not bridged** in v0.1. The documented route is `--permission-prompt-tool` (an MCP tool hosted by WotsRelay) and is the planned v0.2 work; no undocumented stdin control protocol is used.

## Consequences
- In `edit`, shell commands not covered by the user's own Claude Code allow-rules are denied rather than prompted. The user sees the denial and can run the command natively.
- Claude limits pause with a manual fallback button until a real limit fixture exists (see compatibility.md).
