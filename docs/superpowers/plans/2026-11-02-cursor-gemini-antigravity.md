# Cursor, Gemini API and Antigravity Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Cursor CLI and the Gemini API as fallback-capable coding providers next to Claude Code and Codex. Antigravity gets detection and an independent Terminal launch only, never automation. Handoffs carry richer, inspectable task state.

**Architecture:** Each provider is one more implementation of the existing `ProviderAdapter` (`packages/core/src/adapter.ts`). The runner keeps owning routing, checkpoints, approvals and the journal. Cursor runs as a subprocess using its documented `-p --output-format stream-json` interface. Gemini is a model API with no agent of its own, so WotsRelay runs the agent loop itself through a new, tightly scoped local tool layer (`@wots/agent-tools`) that reuses the existing approval pipeline. Antigravity is a launcher, not an adapter.

**Tech Stack:** TypeScript on Node 26 (type stripping, erasable syntax only), zod 4, `node:sqlite`, Vitest 5, Google's official `@google/genai` SDK (version pinned ≥ 14 days old), Electron/React desktop, Expo SDK 58 mobile.

**Spec:** `docs/superpowers/specs/2026-11-02-cursor-gemini-antigravity.md`

## Decisions that need the owner's approval before Task 1

Each decision changes what gets built. The **proposed** option is what the tasks below assume.

- **D1 — Cursor file edits.** Cursor's docs say print mode "has access to all tools, including write and shell", but "Without `--force`, changes are only proposed, not applied". Cursor exposes no approval protocol that WotsRelay could answer, so WotsRelay cannot approve individual Cursor actions the way it does for Codex.
  - **Proposed:** Cursor runs without `--force` (it proposes changes only) until the user turns on a per-project opt-in, "Let Cursor apply edits and run commands without asking". With the opt-in on, runs add `--force --sandbox enabled`.
  - `--approve-mcps` and `--yolo` are never passed.
  - The settings page and `wots providers` show this limitation in plain words.
- **D2 — Gemini API key storage.**
  - **Proposed:** a macOS Keychain item owned by WotsRelay (service `WotsRelay Gemini API key`). It's written through `security -i` with the command on stdin, so the key never appears in a process list, and read with `security find-generic-password -w`. The `GEMINI_API_KEY` environment variable of the runner is also accepted.
  - WotsRelay never reads Google's or the Gemini CLI's own stored credentials (`~/.gemini`, ADC files).
  - `CLAUDE.md`'s rule "never read provider credential files or keychains" gets one clarifying sentence: a key the user explicitly hands to WotsRelay is WotsRelay's credential, not the provider's.
- **D3 — Gemini billing.** Gemini API usage is billed per request to the user's Google API project, separate from any consumer Gemini or Google One plan.
  - **Proposed:** a Gemini route is eligible only when the existing `FallbackConfig.allowApiBilling` is true *and* a key is present. The UI states plainly that Google bills the API project. This is the existing gate, unchanged.
- **D4 — Gemini agent tools.**
  - **Proposed:** six tools: `list_files`, `read_file`, `search_text`, `write_file`, `replace_in_file`, `run_command`.
  - All paths are confined to the project root (realpath check, with symlink escapes refused) and to non-secret paths.
  - `run_command` executes without asking only when `classifyShellCommand` says `read-only`. Everything else goes through the existing approval cards. The `chat` profile gets no tools; `read-only` gets the first three.
- **D5 — Provider ids.** The spec names `claude/codex/cursor/gemini/antigravity`. Renaming the existing ids would break stored sessions and settings.
  - **Proposed:** keep `claude-code` and `codex` as connection ids, add `cursor` and `gemini`, and show the spec's names in all UI.
  - Antigravity is not a connection id, because it is never routed to.
- **D6 — Live verification (owner action, may cost money).**
  - Installing the Cursor CLI uses its official `curl … | bash` installer, run by the owner, not by WotsRelay. After that: `agent login`.
  - A Gemini API key from Google AI Studio.
  - Until both exist, Cursor and Gemini are built against documented schemas and labelled "docs-based, not yet captured live" in `docs/compatibility.md`.

## Existing architecture (summary)

- **Adapters:** `packages/adapters/{claude-code,codex,mock}` implement `ProviderAdapter`: `probe()`, `getConnectionStatus()`, `listModels()`, `startAttempt(input) → AttemptHandle { events, interrupt, answerApproval, done }` and `dispose()`. External output is validated (`validateAdapterEvent` in the controller), unknown lines are quarantined, and failures use the closed `FailureKind` enum.
- **Runner** (`apps/runner/src/sessions/controller.ts`):
  - routes by `FallbackConfig.routes` through `selectNextRoute` (`packages/core/src/policy.ts`: consent, auth, billing, cooldown, 95% usage threshold, each route at most once per cycle);
  - turns failures into actions with `decide()` (retry / switch / pause / fail);
  - writes deterministic checkpoints and builds the handoff with `buildHandoff` (`packages/context`);
  - resumes conversations natively (`--resume`, `thread/resume`).
- **Boundaries:**
  - The CLI and desktop talk to the runner over a user-only Unix socket.
  - The phone talks to it over the pinned HTTPS/WebSocket gateway, restricted to the `MOBILE_METHODS` allowlist. There is no shell API for the phone.
  - All provider execution happens on the Mac.
- **Security already in place:** secret redaction (`@wots/security`), secret path patterns excluded from handoffs, a billing-environment guard, workspace leases, approvals bound to permission versions, a pinned mobile TLS connection, and captured-stream replay tests.

## Mapping the spec's adapter contract onto the existing interface

The spec's method names describe capabilities, not a new interface. Re-plumbing the working adapters would break the replay tests and fixtures.

| Spec method | Existing member |
|---|---|
| `detectInstallation()`, `getVersion()` | `probe()` |
| `checkAuthentication()`, `getStatus()` | `getConnectionStatus()` |
| `listModels()` | `listModels()` |
| `startSession()`, `sendPrompt()`, `streamResponse()` | `startAttempt()` (resume id selects the session; `events` is the stream) |
| `cancelExecution()` | `AttemptHandle.interrupt()` |
| `classifyError()` | per-adapter exported pure function (`classifyCodexError`, `classifyClaudeFailure`, new `classifyCursorExit`, `classifyGeminiError`) |
| `prepareHandoff()` | runner-owned `checkpoint()` + `buildHandoff()`, provider-independent by design |
| `dispose()` | `dispose()` |

New: `capabilities(): ProviderCapabilities` on every adapter, so unsupported features are reported, not simulated.

## Error categories

Keep `FailureKind` (stored in journals and fixtures). Add `timeout`. Add the spec's display categories as a pure mapping, `categoryOf(kind)`:

| Spec category | FailureKind(s) | Policy |
|---|---|---|
| RATE_LIMIT | `transient_throttle` | bounded backoff retries, then pause offering the next model |
| QUOTA_EXCEEDED | `usage_limit` (confirmed), `usage_limit_suspected` | confirmed → automatic fallback with consent; suspected → pause with one-step fallback |
| AUTH_EXPIRED | `auth` | pause; the menu offers **Reconnect** or **Skip this provider** (resume with fallback) |
| PROVIDER_UNAVAILABLE | `outage`, `model_unavailable` | existing `outageFallback` setting |
| NETWORK_ERROR | `transport` | **new:** up to `transportRetries` (default 2) retries on the same route, then pause with manual fallback |
| TIMEOUT | `timeout` (new) | the attempt exceeded `attemptTimeoutMs`; it's stopped like an interrupt, then pauses with manual fallback |
| PERMISSION_DENIED | `permission_denied`, `policy_refusal` | fail; never switch to get around a boundary (unchanged) |
| EXECUTION_ERROR | `context_too_large`, `billing_route_conflict`, `unsupported_version` | unchanged per kind |
| USER_CANCELLED | (run state `cancelled`) | unchanged |
| UNKNOWN | `unknown` | pause, never auto-switch (unchanged rule) |

Failed tests and rejected tools are tool events, not failures, so they can never trigger fallback. This is unchanged and pinned by a test in Task 2.

## Provider-specific limitations (verified 2026-11-02)

- **Cursor** (docs: overview, parameters, headless, output-format, permissions, authentication):
  - Executable is `agent` (`cursor-agent` is probed as a legacy name and accepted only if `--version` parses).
  - Interface: `-p`, `--output-format stream-json`, `--stream-partial-output`, `--model`, `--resume [chatId]`, `--workspace`, `--trust`, `--sandbox enabled|disabled`, `--force`. Models: `agent models` / `--list-models`. Auth: `agent login`, `agent status` (human-readable only), or `CURSOR_API_KEY` / `--api-key`.
  - **Errors are unstructured:** "exits non-zero … the stream may end without a terminal result event … error message to stderr". So there is no confirmed limit signal, and a Cursor failure pauses rather than switching automatically.
  - No usage reporting, so no percentages are shown.
  - Not installed on this Mac today.
- **Gemini API** (docs: models, generate-content, troubleshooting, api-errors):
  - `GET /v1beta/models` with pagination; models qualify only with `supportedGenerationMethods` ∋ `generateContent`.
  - Streaming generation, function calling, and `usageMetadata` token counts.
  - Documented errors: 401 `authentication`, 402 `payment_required`, 403 `permission_denied`, 404 `model_not_found`, 429 `rate_limit_exceeded` / `quota_exceeded` / `too_many_requests`, 5xx.
  - The docs are mid-migration (the newer "Interactions API" vs `generateContent`). Use the official SDK and pin its surface from the installed `.d.ts`.
- **Antigravity** (docs + terms):
  - `agy` 1.2.14 is installed and has `-p` / `--output-format stream-json`.
  - The terms (§6) treat "Using third party software, tools, or services to access the Service" as a breach, with suspension of "Antigravity and/or Gemini CLI accounts".
  - So WotsRelay never runs `agy -p`, and never wraps the installed `gemini` CLI either. It shows status, version and docs, and opens `agy` in a new Terminal window in the chosen folder.

## Global Constraints

- Node ≥ 26, erasable TypeScript only (no enums, namespaces or parameter properties); relative imports keep `.ts`.
- New npm dependencies pinned to versions published ≥ 14 days before install; mobile uses `npm install --before=<date>`.
- Never pass `--dangerously-skip-permissions`, `--bare`, base-URL overrides, `--yolo` or `--approve-mcps` to any provider. `--force` is passed to Cursor only under D1's opt-in.
- Never treat model prose as a control signal; never add an error mapping without a pinned schema or captured fixture; unknown → pause.
- Never read provider credential stores. Never run `agy -p` or the `gemini` CLI. Never download installers.
- Mock adapters stay labelled and are never eligible in real sessions.
- Tests never call real providers; live checks need the owner's explicit go-ahead and are marked as possibly billable.
- Default route order for new installs: `claude-code/claude-opus-5-5 → codex/gpt-6-astra → cursor/<first listed model> → gemini/<chosen model>`. Stored configs are never rewritten silently.

## Review Focus

1. **A Cursor run exits non-zero after editing a file, with no `result` event.** Expected: the edit is journalled, the run pauses (never switches automatically), and the next provider's handoff lists the file as changed. Pinned in Task 4.
2. **A Gemini tool call reaches outside the project** (`../x`, an absolute path, a symlink to `~/.ssh`, or `.env`). Expected: `tool.denied` with a reason, the run continues, nothing is read or written. Pinned in Task 5.
3. **A fallback config saved before this change** (only Claude and Codex routes, no new fields). Expected: it loads unchanged and keeps working, and Cursor/Gemini show as "not set up", not silently enabled. Pinned in Task 1.
4. **The next fallback is Gemini, but its key is missing or revoked.** Expected: the route is skipped as unauthenticated before any request, the pause reason names it, and the menu offers Reconnect or Skip. Pinned in Task 6.
5. **A project path containing quotes, spaces or `$(…)` is passed to the Antigravity launch.** Expected: Terminal opens in exactly that folder and nothing else executes. Pinned in Task 7.

---

### Task 1: Shared types, capabilities, config migration

**Files:**
- Modify: `packages/protocol/src/index.ts` (Provider, AdapterKind, FailureKind, FallbackConfig, Checkpoint, new ProviderErrorCategory, ProviderCapabilities)
- Modify: `packages/core/src/adapter.ts`, `packages/core/src/policy.ts`
- Modify: `packages/adapters/{claude-code,codex,mock}/src/index.ts` (add `capabilities()`)
- Modify: `packages/design-tokens/src/index.ts` (`laneC` for Cursor, `laneD` for Gemini; `laneFor` maps `cursor`, `gemini`, `mock-cursor`, `mock-gemini`)
- Modify: `apps/runner/src/runner.ts` (`loadFallback()` normalisation)
- Test: `tests/unit/providers-foundation.test.ts`

**Interfaces:**
- Produces:
  - `Provider = 'anthropic' | 'openai' | 'cursor' | 'google' | 'mock'`, `AdapterKind += 'cursor-cli' | 'gemini-api'`, `FailureKind += 'timeout'`.
  - `ProviderErrorCategory` (zod enum of the 10 spec names).
  - `categoryOf(kind: FailureKind): ProviderErrorCategory` in `packages/core/src/policy.ts`.
  - `ProviderCapabilities = { streaming: boolean; nativeResume: boolean; approvals: 'bridged' | 'none'; edits: 'apply' | 'proposals-only' | 'none'; usage: 'percent' | 'tokens' | 'none'; models: 'listed' | 'catalog' | 'fixed' }`; `ProviderAdapter.capabilities(): ProviderCapabilities`.
  - `FallbackConfig += { disabledConnections: string[] (default []), attemptTimeoutMs: int (default 3_600_000), transportRetries: int 0–5 (default 2), notifyOnSwitch: boolean (default true) }`.
  - `Checkpoint += { nextRoute: RouteRef | null, handoffCategory: ProviderErrorCategory | null, gitStatus: string[], knownErrors: string[], permissionProfile: PermissionProfile | null }`, all with defaults so old rows parse.
  - `loadFallback(store): FallbackConfig` in `apps/runner/src/runner.ts`.

- [ ] **Step 1: Write failing tests**
  - `categoryOf` covers every `FailureKind` (exhaustive over `FailureKind.options`).
  - `FallbackConfig.parse(<a config object saved before this change>)` keeps its routes and gains defaults.
  - `Checkpoint.parse` of an old row succeeds.
  - `laneFor('cursor') === 'laneC'` and `laneFor('gemini') === 'laneD'`.
  - Each real adapter's `capabilities()` matches this table:

    | Adapter | streaming | nativeResume | approvals | edits | usage | models |
    |---|---|---|---|---|---|---|
    | claude | true | true | none | apply | percent | fixed |
    | codex | true | true | bridged | apply | percent | listed |
    | mock | true | true | bridged | apply | percent | fixed |

- [ ] **Step 2:** `pnpm vitest run tests/unit/providers-foundation.test.ts` → FAIL.
- [ ] **Step 3:** Implement the types, defaults and capabilities. Choose `laneC`/`laneD` colours that pass WCAG AA on both grounds in light and dark, and document the contrast ratio in a comment.
- [ ] **Step 4:** `pnpm check` → all tests pass, including every existing test unchanged.
- [ ] **Step 5:** Commit `feat(core): provider categories, capabilities and config defaults for new providers`.

### Task 2: Fallback engine extensions

**Files:**
- Modify: `packages/core/src/policy.ts` (`decide`, `selectNextRoute`), `apps/runner/src/sessions/controller.ts`
- Modify: `packages/adapters/mock/src/index.ts`: `mockChain(scenario): MockAdapter[]` with `mock-claude, mock-codex, mock-cursor, mock-gemini`; scenarios `chain-quota` (each provider hits a confirmed limit in turn), `cursor-auth`, `flaky-network`, `slow`
- Test: `tests/integration/fallback-chain.test.ts`

**Interfaces:**
- Consumes: Task 1 config fields.
- Produces:
  - `selectNextRoute` skips `disabledConnections` with the reason `"<id>: disabled by user"`.
  - `decide()` returns `retry_same` for `transport` while `transportRetries` remain.
  - The controller enforces `attemptTimeoutMs` by interrupting the attempt and recording `Failure{ kind: 'timeout' }`.
  - `runs.resume` accepts `{ skipConnectionId?: string }` and adds that connection to `tried` for this cycle (the "Skip this provider" action).

- [ ] **Step 1: Write failing tests**, each asserting the event sequence and the route used:
  - Claude→Codex; Codex→Cursor; Cursor→Gemini (with consent and `allowApiBilling`); Gemini excluded when `allowApiBilling` is false.
  - Two middle providers disabled → jumps to the last.
  - All unavailable → `paused_limits`, the reasons list each route, the session is preserved.
  - `flaky-network`: two transport failures, then success on the same route, with no provider switch. With `transportRetries: 0` it pauses at once.
  - `slow` + `attemptTimeoutMs: 50` → paused with a `timeout` reason, and the process group is quiescent.
  - Cancellation during a switch → `cancelled`, the next provider never starts.
  - Runner restart mid-attempt on `mock-cursor` → `recover()` pauses as today.
  - `cursor-auth` → `paused_auth`; `runs.resume({ skipConnectionId: 'mock-cursor' })` continues on `mock-gemini`.
  - A failed tool in a completed turn never produces `limit.observed`.
  - Two sessions on the same project starting `mock-cursor` runs at once → the second pauses on the workspace lease and never edits concurrently (spec §14, concurrent execution conflicts).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Retry delays reuse the existing `throttleDelay` jitter helper.
- [ ] **Step 4:** `pnpm check` → PASS.
- [ ] **Step 5:** Commit `feat(runner): provider disable list, bounded network retries, attempt timeout, skip-provider resume`.

### Task 3: Inspectable handoff record

**Files:**
- Modify: `apps/runner/src/sessions/controller.ts` (`checkpoint()`), `packages/context/src/index.ts` (`buildHandoff` sections), `packages/workspace/src/index.ts` (`gitStatusLines(root): string[]` using `git status --porcelain=v1`, argument array, 5 s timeout)
- Modify: `apps/runner/src/runner.ts`: RPC `handoff.get { sessionId } → HandoffView` (local and mobile; read-only, redacted)
- Modify: `apps/runner/src/server/gateway.ts` (`MOBILE_METHODS += 'handoff.get'`)
- Test: `tests/integration/handoff-record.test.ts`

**Interfaces:**
- Produces:
  - `HandoffView = { checkpointId, createdAt, from: RouteRef | null, to: RouteRef | null, reason: string, category: ProviderErrorCategory | null, objective, completedSteps, pendingSteps, changedFiles: Array<{ path, change }>, gitStatus, testsExecuted: string[], knownErrors, unresolvedActions, permissionProfile }`. This is the spec's JSON record with existing field names kept and the spec's names aliased: `originalRequest = objective`, `modifiedFiles = changedFiles`, `handoffReason = category`.
  - `testsExecuted` is filled from completed shell tool actions whose command `classifyShellCommand` + the regex `/\b(test|vitest|jest|pytest|cargo test|go test|mocha)\b/` identifies as tests.
  - `knownErrors` is filled from `tool.failed` messages, redacted and capped at 10.
- [ ] **Step 1: Failing tests:**
  - After a `quota-after-edit` switch, `handoff.get` returns the changed files, git status lines that include an untracked file created before the run (preserved, not reset), and `nextRoute`.
  - A secret written into a tool output never appears (`containsSecret` false on the JSON).
  - `.env` changes are listed by path only, never by content.
  - The handoff prompt for the next provider contains the "Do not repeat" section and lists the completed step.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm check` PASS. **Step 5:** Commit `feat: inspectable handoff record (git status, tests, known errors)`.

### Task 4: Cursor CLI adapter

**Files:**
- Create: `packages/adapters/cursor/{package.json,src/index.ts}`
- Create fixtures: `tests/fixtures/streams/cursor-docs/*.jsonl`. These are **synthesised from the documented output-format schema**, and each file's `meta` line says `"source": "docs"`. Real captures replace them after D6.
- Modify: `apps/runner/src/runner.ts` (`buildAdapters` adds `new CursorAdapter({ chatSandboxDir, env, capture })`), root `package.json` devDeps
- Test: `tests/unit/cursor-adapter.test.ts` (replay through `tests/fixtures/replay-provider.ts`)

**Interfaces:**
- Produces:
  - `CursorAdapter implements ProviderAdapter` with `connectionId 'cursor'`, `provider 'cursor'`, `kind 'cursor-cli'`.
  - `resolveCursorExecutable(env): string | null` tries `agent`, then `cursor-agent`, and accepts a binary only if `--version` output parses with `/\d+\.\d+\.\d+/`.
  - `buildCursorArgs(input: AttemptInput, opts: { applyEdits: boolean }): string[]` returns `['-p', '--output-format', 'stream-json', '--stream-partial-output', '--model', m, '--workspace', cwd, '--trust', '--sandbox', 'enabled', ...(resume ? ['--resume', id] : []), ...(opts.applyEdits ? ['--force'] : [])]`. Chat profile adds `['--mode', 'ask']`; read-only adds `['--mode', 'plan']`. The prompt goes on stdin. **Verify at implementation time that `-p` reads stdin; if the docs don't confirm it, pass the prompt as the final argument and note that it is visible in the process list.**
  - `translateCursorLine(msg, state): AdapterEventEnvelope[]` handles `system/init` (session.bound; model.effective from `model`), `assistant` (message.delta when `timestamp_ms` is set and `model_call_id` is absent; otherwise message.completed), `tool_call/started|completed` (tool.started/completed; risk from tool kind: read → `read-only`, write/edit → `reversible-local-write`, shell → `classifyShellCommand(command)`), and `result/success`.
  - `classifyCursorExit(state, exit): Failure | null`: success needs `result` with `is_error: false` and exit 0. Anything else → `{ kind: 'unknown', message: redact(stderrTail) }`; `not installed` → `auth/not-installed`. No limit mapping exists (no structured evidence).
  - `listModels()` runs `agent models` and keeps lines matching a model-id pattern, with verification `listed-unverified`; it **returns [] with a note if the output format isn't confirmed by a captured fixture**.
  - `getConnectionStatus()` reports `authStatus 'unknown'` with the note "Sign-in is confirmed by the first run". That stays until `agent status` output is captured (D6); once it is, parse it with a fixture-backed test.
  - `capabilities()` → `{ streaming: true, nativeResume: true, approvals: 'none', edits: applyEdits ? 'apply' : 'proposals-only', usage: 'none', models: 'listed' }`.
  - Project opt-in setting key: `cursor.applyEdits:<projectId>` (boolean, default false), set through the local-only RPC `cursor.setApplyEdits { projectId, enabled } → { enabled }`.
- [ ] **Step 1: Failing tests (replay):**
  - Success stream → events plus a completed outcome.
  - Partial deltas → no duplicated text.
  - Malformed line → diagnostic, not a crash.
  - Exit 1 with no `result` → paused (`unknown`), edits journalled (Review Focus 1).
  - Interrupt → SIGINT recorded in the capture, termination `interrupted`.
  - Missing binary → probe `installed: false`.
  - Args never contain `--yolo`, `--approve-mcps` or `--force` unless `applyEdits`.
  - The `chat` profile cwd is the chat sandbox.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm check` PASS. **Step 5:** Commit `feat(adapters): Cursor CLI adapter (docs-based; proposals-only unless opted in)`.

### Task 5: Local agent tools for API-only providers

**Files:**
- Create: `packages/agent-tools/{package.json,src/index.ts,src/paths.ts,src/run.ts}`
- Test: `tests/unit/agent-tools.test.ts`

**Interfaces:**
- Consumes: `classifyShellCommand` (`@wots/core`), `DEFAULT_SECRET_PATH_PATTERNS`, `matchesAny`, `redact` (`@wots/security`).
- Produces:
  - `TOOL_DECLARATIONS: ToolDeclaration[]`, the JSON-schema shapes for the six D4 tools. `ToolDeclaration = { name, description, parameters: JSONSchema }`.
  - `class ToolHost { constructor(opts: { root: string; profile: PermissionProfile; requestApproval(req: { action: string; risk: RiskCategory }): Promise<'approve' | 'reject'>; signal: AbortSignal }); declarations(): ToolDeclaration[]; call(name: string, args: unknown): Promise<ToolResult> }`.
  - `ToolResult = { ok: true; output: string } | { ok: false; denied: boolean; error: string }`.
  - `resolveInside(root, p): string | null` (realpath of the existing parent; refuses `..` escapes, absolute paths outside the root, symlink escapes, and secret patterns).
  - `runCommand(cmd, root, signal, { timeoutMs: 120_000, maxOutput: 64_000 })` runs `/bin/sh -c` in its own process group, with an environment stripped of `BILLING_ENV_VARS`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `CURSOR_API_KEY` and any `*_TOKEN` / `*_SECRET` / `*_KEY` names. It kills the process group on abort or timeout.
  - Policy:
    - `chat`: no declarations.
    - `read-only`: the three read tools.
    - `edit`: all six. Writes need no approval (same as Claude `acceptEdits`).
    - `run_command`: `read-only` class runs directly; `reversible-local-write` / `unknown` / `external-side-effect` → `requestApproval` first.
    - `git push|reset --hard|clean`, `rm` and similar are always `external-side-effect`, so they always need approval.
  - Arguments are validated with zod per tool; invalid → `{ ok: false, error }`.
- [ ] **Step 1: Failing tests:**
  - `read_file('../outside')`, `read_file('/etc/passwd')`, a symlink to a temp dir outside the root, and `read_file('.env')` → denied (Review Focus 2).
  - `write_file` creates parent dirs inside the root only.
  - `replace_in_file` with zero matches or more than one match → error, no write.
  - `run_command('ls')` runs without approval.
  - `run_command('rm -rf build')` → approval requested; reject → denied with no side effect.
  - `run_command('echo $GEMINI_API_KEY')` with the key in the parent env → output contains no key.
  - `run_command('sleep 30')` with abort → finishes in < 2 s and the group is gone.
  - Output over 64 kB is truncated with a marker.
  - Injection attempts (`; curl x`, `` `id` ``, `$(id)`) are classified at the risk of their riskiest part.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm check` PASS. **Step 5:** Commit `feat(agent-tools): confined local tools with approval gating`.

### Task 6: Gemini API adapter and key storage

**Files:**
- Create: `packages/adapters/gemini/{package.json,src/index.ts,src/errors.ts}`; add `@google/genai@<pinned>` (published ≥ 14 days ago) to that package
- Create: `apps/runner/src/secrets.ts`
- Modify: `apps/runner/src/runner.ts`: adapters; RPC `gemini.setKey { key }` and `gemini.clearKey` (local-only, **not** in `MOBILE_METHODS`); `providers.status`
- Test: `tests/unit/gemini-adapter.test.ts`, `tests/unit/secrets.test.ts`

**Interfaces:**
- Consumes: `ToolHost` (Task 5).
- Produces:
  - `interface SecretStore { get(name: string): Promise<string | null>; set(name: string, value: string): Promise<void>; delete(name: string): Promise<void> }`. `KeychainSecretStore` writes through `spawn('security', ['-i'])` with stdin, so the value is never in argv. `MemorySecretStore` is for tests.
  - `GeminiAdapter implements ProviderAdapter` with `connectionId 'gemini'`, `provider 'google'`, `kind 'gemini-api'`, constructed as `new GeminiAdapter({ secrets: SecretStore, env, fetchImpl?: typeof fetch })`. `fetchImpl` lets tests inject responses through the SDK's documented fetch option; **if the pinned SDK has none, wrap the REST endpoints directly and record that in the ADR**.
  - Probe and connection status: a key in `env.GEMINI_API_KEY` or the store → `listModels()` call → `authenticated`. 401/403 → `unauthenticated` / `expired`. Billing `api`.
  - `listModels()` keeps models whose `supportedGenerationMethods` includes `generateContent`; `contextLimit = inputTokenLimit`; verification `listed-unverified`.
  - `startAttempt()` runs the agent loop:
    1. Send the system instruction (WotsRelay coding-agent instructions + project root + profile) with the tools from `ToolHost.declarations()`.
    2. Stream; text → `message.delta` / `message.completed`; `functionCall` → `tool.started` → `ToolHost.call` → `tool.completed` / `tool.failed` / `tool.denied` → `functionResponse`.
    3. Loop until a turn ends with no calls, capped at 50 tool turns.
    4. Approvals go out as `approval.requested` (`canApproveForSession: false`) and come back through `answerApproval`.
    5. `usageMetadata` → `usage.observed { unit: 'tokens', value: totalTokenCount, scope: 'request' }`. This is never a percentage, so it never affects the 95% rule.
  - Conversation memory: `providerSessionId` names a transcript file `<home>/gemini-sessions/<id>.json` (mode 0600, redacted), so later turns can resume it (`nativeResume: true`).
  - `classifyGeminiError(status: number, body: unknown): Failure`:

    | Status / code | FailureKind | Notes |
    |---|---|---|
    | 401 | `auth` | |
    | 403 | `auth` | message from the body, redacted |
    | 402 | `usage_limit` | `retryAfterMs: null`; never retried |
    | 404 | `model_unavailable` | |
    | 429 `rate_limit_exceeded` / `too_many_requests` | `transient_throttle` | |
    | 429 `quota_exceeded` | `usage_limit` | |
    | 429 with no code | `usage_limit_suspected` | |
    | 500/503/504 | `outage` | |
    | network/abort | `transport` / interrupted | |
    | anything else | `unknown` | |

  - `capabilities()` → `{ streaming: true, nativeResume: true, approvals: 'bridged', edits: 'apply', usage: 'tokens', models: 'listed' }`.
  - RPC `providers.status → ProviderStatus[]` (local and mobile, read-only), where `ProviderStatus = { connectionId, displayName, provider, installed, version, authStatus, billingMode, capabilities: ProviderCapabilities, enabled: boolean, position: number | null, primaryModel: string | null, usage: Array<{ scope, percent, resetAt }>, notes: string[] }`. Add it to `MOBILE_METHODS`.
- [ ] **Step 1: Failing tests (injected fetch; no network):**
  - Valid key → models listed and filtered.
  - Invalid key → `unauthenticated`, and the route is skipped by `selectNextRoute` (Review Focus 4).
  - A streamed reply → deltas and completion.
  - A function-call round trip edits a file through `ToolHost`.
  - A command that needs approval waits for `answerApproval`.
  - Each status in the table above → the expected kind.
  - 402 is not retried.
  - The key never appears in events, captures, the journal or errors (assert `!JSON.stringify(allEvents).includes(key)`).
  - Abort mid-stream → `interrupted`.
  - 51 tool turns → stops with `unknown` ("tool-turn limit reached").
  - `KeychainSecretStore.set` is spawned with no key in argv (assert spawn args).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm check` PASS. **Step 5:** Commit `feat(adapters): Gemini API adapter with WotsRelay-run tools (API billing, opt-in)`.

### Task 7: Antigravity standalone launcher

**Files:**
- Create: `apps/runner/src/antigravity.ts`
- Modify: `apps/runner/src/runner.ts`: RPC `antigravity.status → { installed, path, version, docsUrl }` and `antigravity.open { root }` (both local-only)
- Test: `tests/unit/antigravity.test.ts`

**Interfaces:**
- Produces:
  - `antigravityStatus(env): { installed: boolean; path: string | null; version: string | null; docsUrl: 'https://antigravity.google/docs/getting-started?tab=cli' }`. It runs only `agy --version` with a 10 s timeout.
  - `openInTerminal(root: string, spawnImpl = spawn): Promise<void>` requires `root` to be an existing directory (realpath). It runs `osascript -e <script>` where the script is built by `appleScriptString(shellQuote(...))`, i.e. `tell application "Terminal" to do script "cd '<root>' && agy"`, with the path single-quote-escaped for the shell and then backslash/quote-escaped for AppleScript.
  - No other `agy` arguments exist anywhere in the codebase (enforced by a test that greps the source for `'agy'` followed by `-p` / `--print` / `--prompt`).
- [ ] **Step 1: Failing tests:**
  - A hostile path (`it's "$(touch /tmp/pwned)"`) produces an osascript argument whose shell command is exactly `cd '<escaped>' && agy` (Review Focus 5). The spawn is captured, not executed.
  - A non-directory root → error.
  - The source contains no headless `agy` invocation.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm check` PASS. **Step 5:** Commit `feat: Antigravity detection and independent Terminal launch (no automation)`.

### Task 8: Terminal UX

**Files:**
- Modify: `apps/cli/src/main.ts`, `apps/cli/src/interactive.ts`
- Test: `tests/unit/cli-providers.test.ts`, `tests/e2e/repl/providers.exp`, add a case to `tests/e2e/repl.test.ts`

**Interfaces:**
- Consumes: RPCs from Tasks 2, 3, 6 and 7 (`providers.status`, `gemini.setKey`, `handoff.get`, `antigravity.*`), plus `fallback.set` with `disabledConnections`.
- Produces commands (all additive; `wots` stays the CLI name):
  - `wots providers` (table: provider, installed/version, sign-in, billing, edits capability, enabled, position) and `wots providers check` (refresh).
  - `wots providers enable|disable <cursor|gemini|claude|codex>`; `wots provider <id> [model]` (make primary; same effect as `/model`).
  - `wots fallback on|off` (`autoFallback`).
  - `wots cursor apply-edits on|off [--project path]` (D1 opt-in, with a warning that names `--force`).
  - `wots gemini key set` (hidden prompt; reads stdin when piped, never from an argument), `wots gemini key clear`, and `wots fallback api-billing on|off`.
  - `wots antigravity [status|open [path]]`; `wots handoff show <session-id>`.
  - REPL: `/model` lists all enabled providers' models, grouped; `/providers`; `/handoff`. The pause menu adds "Skip <provider>" for `paused_auth`.
  - `wots fallback set` resolves model→connection through `models.list` instead of the `startsWith('claude')` heuristic at `apps/cli/src/main.ts:248`.
- [ ] **Step 1: Failing tests:**
  - Parsing and dispatch for each command against a runner with `mockChain`.
  - `gemini key set` given a key as an argument → usage error.
  - e2e: `/model` shows four mock providers; a `cursor-auth` pause shows "Skip"; `/handoff` prints the changed files.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** `pnpm check` PASS. **Step 5:** Commit `feat(cli): provider commands, Gemini key, Cursor opt-in, handoff view`.

### Task 9: Desktop settings and phone display

**Files:**
- Modify: `apps/desktop/src/components/Settings.tsx` (Providers section: status rows, enable toggles, order up/down, primary model select, auto-fallback, "Notify me when the model switches" (`notifyOnSwitch`: a desktop system notification on `provider.switched` when the window is not focused), API billing, Cursor apply-edits per project, Antigravity status and "Open in Terminal", diagnostics refresh), `apps/desktop/src/api.ts`, `apps/desktop/src/labels.ts`, `apps/desktop/electron/*` (RPC allowlist additions)
- Modify: `apps/desktop/src/components/Conversation.tsx`: the handoff banner gets "View handoff" (renders `HandoffView`)
- Modify: `apps/mobile/src/screens/SessionsScreen.tsx` (provider status rows replace the two hard-coded usage rows; unreported usage says so), `apps/mobile/src/screens/SessionScreen.tsx` (handoff banner → summary sheet via `handoff.get`)
- Test: `tests/unit/desktop-labels.test.ts` (provider labels/lanes), Electron capture (`WOTS_CAPTURE=… pnpm --filter @wots/desktop start`), `pnpm mobile:typecheck` + simulator screenshot

**Interfaces:**
- Consumes: `providers.status`, `handoff.get`, `antigravity.status|open`, `fallback.get|set`.
- The phone gets read-only views. **No new phone method can change providers, keys or permissions** (they stay out of `MOBILE_METHODS`; the gateway test asserts it).
- [ ] **Step 1: Failing tests:**
  - The labels test.
  - The gateway allowlist test extended with `gemini.setKey`, `gemini.clearKey`, `antigravity.open`, `cursor.setApplyEdits` and `fallback.set` → `unknown_method` from a phone; `providers.status` and `handoff.get` succeed.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. Keep the existing tokens; check keyboard order and contrast.
- [ ] **Step 4:** `pnpm check`, desktop build + capture (light and dark) and a mobile simulator screenshot all succeed; review each image.
- [ ] **Step 5:** Commit `feat(ui): provider settings and handoff summary on desktop and phone`.

### Task 10: Documentation, security review, live verification

**Files:**
- Create: `docs/decisions/0006-additional-providers.md` (D1–D6 as decided, the contract mapping, the Antigravity terms citation with date)
- Modify: `docs/compatibility.md` (per-provider evidence levels), `README.md` (setup for Cursor, the Gemini key, Antigravity launch, troubleshooting, limitations), `CLAUDE.md` (D2 clarification; Cursor `--force` rule), `BUILD_STATUS.md`, `docs/security/` (threat model for agent-tools)
- [ ] **Step 1:** Run `/code-review` (high) and `/security-review` on the branch; fix findings with tests.
- [ ] **Step 2:** `pnpm check`, `pnpm mobile:typecheck`, desktop build, and the iOS simulator build all pass.
- [ ] **Step 3 (needs the owner's go-ahead; may incur charges):**
  - Cursor: `agent status`, one tiny chat, and one interrupt with capture on. Replace the docs fixtures, then add the status parser and model-list parser from the real output.
  - Gemini: `models.list`, one tiny chat, one tool round trip, and an invalid-key 401 (free).
  - Record the results in `docs/compatibility.md`.
- [ ] **Step 4:** Commit `docs: providers, setup, security model; live evidence`.

## Migration and rollback

- **Storage:** additive only. No SQL migration is needed: the new fields live in existing JSON columns and settings, with zod defaults (Task 1 pins old-row parsing).
  - New settings keys: `cursor.applyEdits:<projectId>`, `usage:gemini`.
  - New Keychain item: `WotsRelay Gemini API key`.
- **Existing users:** their saved fallback order is respected. Cursor and Gemini appear in settings as "not set up" and join routing only when the user enables them (Review Focus 3). New installs get the four-step default order.
- **Rollback:** revert the branch. Older code strips unknown JSON fields on parse (zod object default). Sessions that used `cursor`/`gemini` routes show those attempts as from an unknown connection, and new runs fall back to Claude/Codex. The Keychain item can be removed with `wots gemini key clear`, or `security delete-generic-password -s "WotsRelay Gemini API key"`.

## Out of scope (explicit)

- Any automated use of `agy` or the `gemini` CLI, account rotation, quota evasion, or reading provider credential stores.
- Installing provider CLIs from WotsRelay.
- Running commands from the phone.
- Usage percentages for Cursor or Gemini; neither reports them.
