# Compatibility and evidence matrix

Recorded 1 November 2026 on the build Mac (Apple Silicon, macOS 26.6.2, Node 26.7.0, pnpm 11.21.0).
Evidence levels: **live** = observed against the real installed tool; **schema** = taken from the tool's own generated schema;
**docs** = official documentation read on this date; **mock** = deterministic fixture only; **untested** = not yet exercised.

## Installed tools

| Tool | Version | Executable | Auth (documented status command) | Billing reported |
|---|---|---|---|---|
| Claude Code | 2.1.316 | `~/.local/bin/claude` | `claude auth status --json`: logged in, `authMethod: claude.ai`, `apiProvider: firstParty`, plan `pro` — **live** | subscription |
| Codex CLI | 0.166.0 | `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js` | app-server `account/read`: ChatGPT account, plan `plus` — **live** | subscription |

No credential file, keychain entry or token was read. Only the documented status outputs above were parsed, and only non-secret fields are kept.

## Models

| Preference | Route | Status |
|---|---|---|
| `claude-opus-5-5`, effort medium | Claude Code `--model` / `--effort` | **live** (2026-11-01): request succeeded on the Pro plan; stream reported the effective model as `claude-opus-5-5`. The stream does not echo effort back (`model.effective.effort = null`). |
| `gpt-6-astra`, effort medium | Codex app-server `thread/start` + `turn/start` | **live** (2026-11-01): turn succeeded on the Plus plan; effective model `gpt-6-astra`, effort `medium` confirmed by the provider. |

## Claude Code integration (docs + local `--help`)

- Sources: code.claude.com/docs/en/headless, /legal-and-compliance, /cli-reference (read 2026-11-01).
- Flags used: `-p --output-format stream-json --verbose --include-partial-messages --model --effort --setting-sources user --strict-mcp-config --permission-mode {acceptEdits|dontAsk} --permission-prompts none [--resume]`. All appear in `claude --help` for 2.1.316.
- `-p` runs show **no workspace-trust dialog** and would load project hooks and `.mcp.json` servers. `--bare` would avoid that but disables subscription (OAuth) auth, so WotsRelay instead passes `--setting-sources user` and `--strict-mcp-config` and requires explicit project trust.
- Interrupt: SIGINT ends the turn (documented); SIGTERM exits 143 leaving the turn unfinished. The adapter sends SIGINT, then escalates to SIGTERM/SIGKILL on the process group, and reports `quiescent` only when the group is gone.
- Limit signals: only `system/api_retry` with `error` categories (`rate_limit`, `billing_error`, `authentication_failed`, …) is documented. **There is no documented structured "subscription exhausted" signal.** Therefore a Claude limit is classified `usage_limit_suspected` → pause with a one-click "Continue with GPT-6 Astra". `CONFIRMED_LIMIT_SIGNATURES` in the adapter stays empty until a real limit is captured as a versioned fixture.
- Legal: running the unmodified binary with the user's own subscription sign-in is described as permitted; offering Claude login in a third-party app or intermediating credentials is not. Distribution of WotsRelay to other people needs a fresh review (Commercial Terms apply to products).
- Stream parsing: **live + fixtures** (2.1.316, 2026-11-01). Captured streams in `tests/fixtures/streams/claude-code-2.1.316/` (chat success, coding turn, interrupt) are replayed through the adapter in tests. `system/api_retry` and `permission_denied` are still docs-based.
- Stream start: with `--setting-sources user`, the owner's user-level hooks run (`system/hook_started`/`hook_response` lines before `init`), and `init` lists their plugins and skills.
- Interrupt (SIGINT): **live**. Claude Code still flushes the partial text as a final `assistant` message (`stop_reason: null`, same as a normal message), then `result` `subtype: error_during_execution`, `terminal_reason: aborted_streaming`, exit 0. The adapter drops `message.completed` after its own SIGINT, so the partial is recorded as `message.interrupted`.
- Usage: `rate_limit_event` → `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt,status}` — **live fixture** (5-hour at 0.99, `allowed_warning`). Mapped to `usage.observed`; drives the 95% switch (ADR 0005). Whether it is sent at low usage is unknown.
- Conversation continuity via `--resume <session_id>`: flag in `--help`; **untested live**.
- In the `edit` profile (`acceptEdits`), Claude created a file with `Bash` (`mkdir -p … && printf … > file`) without a prompt, rather than with `Write`.
- Process killed mid-turn (SIGTERM from outside): **live**. Classified `transport` → `paused_uncertain` with manual fallback offered; the completed `Write` stayed journalled.

## Codex app-server integration (schema + live)

- Schema generated with `codex app-server generate-json-schema` (pinned in `tests/fixtures/codex-schema/`, see `SOURCE.txt`). Tests assert every method the adapter calls exists in it.
- **Live:** `initialize` → `initialized` → `account/read` → `model/list` over stdio JSONL (no `jsonrpc` field required).
- **Live + fixtures** (2026-11-01, `tests/fixtures/streams/codex-0.166.0/`): `thread/start`, `turn/start`, agent message streaming, `commandExecution` and `fileChange` items, `account/rateLimits/updated` (recorded as `usage.observed`), `turn/interrupt` (→ `message.interrupted`), and a command approval request answered with reject (→ `tool.denied`; the turn completed). No quarantined lines.
- With the `edit` profile (`workspace-write` sandbox, `on-request` approvals), Codex ran read-only shell commands **without asking**. That matches the configured policy, but the adapter labels every shell command with risk `unknown`, because it doesn't classify commands.
- Both rate-limit windows (`primary` 300 min → `five_hour`, `secondary` 10080 min → `seven_day`) are mapped — **live fixture**.
- `thread/resume` (for later turns) and `acceptForSession` (approve for this session, command approvals only): **schema only, untested live**.
- Shell command risk is now classified (shared classifier for both providers) instead of always `unknown`.
- **Untested live:** approve (only reject was captured).
- Limit signals: structured `codexErrorInfo`. `usageLimitExceeded` = confirmed limit (auto-fallback); `rateLimitExceeded` = transient throttle; `sessionBudgetExceeded` = suspected; others mapped in `classifyCodexError`. Unknown values pause.
- Version policy: adapter runs only on `0.166.x`; other versions report "regenerate schema and re-run fixtures".

## Behaviour evidence

| Behaviour | Evidence |
|---|---|
| Fallback after confirmed limit, no duplicate edit (A03) | mock |
| Quota before answer (A04), both limited (A05), auth/policy (A06), uncertain action (A07) | mock |
| Crash recovery (A08), cancellation during switch (A09) | mock |
| Two clients on one session, ordered events, single controller (A10), cursor replay (A11) | mock (real Unix socket + daemon) |
| Secrets redacted from handoff (A13), dirty tree preserved (A14), injection inert (A15) | mock |
| Unsupported Codex version message (A16) | unit (probe logic); untested live |
| Native model fallback reported (A17), duplicate/malformed events (A18), concurrent approvals (A19) | mock |
| Phone pairing, revocation (gateway side) | integration tests over real TLS + WebSocket; no phone app yet |
| Reconnect on device (A11/A12 mobile), Mac sleep (A20) | **not built yet** |
| Real Claude request, real Codex turn | **live** (2026-11-01), one `pong` chat each; replayed from fixtures in every test run |
| Interrupt mid-answer (both providers) | **live fixtures** |
| Codex approval → reject → denied | **live fixture** |
| Real cross-provider handoff, no duplicate edit | **live** (2026-11-01): Claude wrote `notes/a.txt`; its process was killed → `paused_uncertain` → `wots resume --fallback` → Codex checked `a.txt`, created only `notes/b.txt`; `a.txt` mtime unchanged; parent attempt linked |
| Automatic fallback on a real usage limit | **unobserved** (needs a natural limit) |
