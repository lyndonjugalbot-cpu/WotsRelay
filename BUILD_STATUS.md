# Build status

Last updated: 2026-11-01

## Milestones

| Milestone | State | Notes |
|---|---|---|
| 0 — integration evidence | **Done (live)** | Real requests to both providers and a real cross-provider handoff succeeded (2026-11-01). Still unobserved: a natural usage limit and live approval flows. See `docs/compatibility.md`. |
| 1 — durable core | **Done** | Protocol schemas, transition table, failure policy, route selection, SQLite journal, leases, handoff, redaction, crash recovery. |
| 2 — terminal vertical slice | **Done (live)** | Runner daemon + `wots` CLI; real Claude → Codex handoff finished a two-step coding task without repeating the edit. |
| 2b — interactive terminal | **Done** | `wots` opens a Claude/Codex-style session in the current folder: trust prompt, `/model` picker (Opus 5.5 default, saved), pause menu with just-in-time fallback consent, `/new`, `/resume`, `/status`. Pseudo-terminal e2e tests with mock providers. |
| 2c — usage-aware switching | **Done (mock + fixtures)** | Switch at 95% of any usage window (configurable), automatic return after reset, conversation memory across turns (native resume / handoff), usage meter (`/status`, `wots usage`, 80% heads-up), approvals with plain-language risk and approve-for-session (ADR 0005). Conversation memory verified live on both providers (2026-11-01); `acceptForSession` not yet run live. |
| 3 — Mac desktop | **Development build working** | Electron app renders live runner sessions in light/dark; relay-core 3D element. Not packaged/signed. |
| 4 — iPhone companion | **First version running in the simulator** | Expo SDK 58 app (`apps/mobile`, own npm install): pairing by link with certificate pinning in a native Swift module, session list with usage bars and live updates, conversation timeline (shared `@wots/timeline`), approvals with risk words, pause menu, stop, send. Phone client tested against the real gateway (reconnect without gaps, revocation). Not yet: QR scanning, push notifications, a physical-device build (needs Apple signing). |

## Commands run and results

- `pnpm check` (runner/CLI typecheck, desktop typecheck, tests) → clean; 14 files, 121 tests passed (incl. 4 pseudo-terminal REPL tests), including 7 replays of real captured provider streams (mock-tested; see compatibility.md for evidence levels). Gateway tests were mutation-checked (removing the allowlist or the device-id override fails them).
- CLI gateway smoke test (temp `WOTS_HOME`, loopback): `gateway enable` → `gateway pair` → `curl --cacert` health + pair → `devices list` → `devices revoke` all behaved as specified.
- `wots code --project <tmp repo> --consent --mock quota-after-edit "Build the settings page."` → completed, exit 0, three files written once each, switch shown.
- Live probe (no model requests): Claude `auth status` and Codex `initialize/account/read/model/list` succeeded.
- `pnpm desktop:build` + Electron launch with page capture → renders correctly.
- **Live smoke tests (authorized 2026-11-01, isolated temp `WOTS_HOME`):** `wots chat` → `pong` from `claude-opus-5-5` (3.3 s) and `gpt-6-astra` (6.4 s), exit 0. Handoff: `wots code` two-step task on Claude; Claude process SIGTERMed after step 1 → `paused_uncertain` (exit 10) → `wots resume --fallback` → Codex finished step 2 only, exit 0. No quarantined provider lines.
- **Live capture session (2026-11-01, 7 small requests):** chat success ×2, coding turn ×2, interrupt ×2, Codex approval-reject. Sanitized into `tests/fixtures/streams/`. Found and fixed: a Claude interrupt was recorded as a completed message.
- **iPhone simulator run (2026-11-02, mock providers, isolated runner):** Release build installed on iPhone 17 Pro simulator; opening a `wots gateway pair` link paired over pinned TLS; the session list showed both MOCK sessions and updated live when an approval was decided on the Mac; the conversation screen showed the timeline, a live pending approval with Approve/Reject, and Stop while running. Pairing survived reinstall (Keychain). Taps could not be scripted (no accessibility permission), so phone-side Approve was exercised by the client integration test instead.
- **Live memory check (2026-11-01, 4 small requests):** two-turn chats on `claude-opus-5-5` and `gpt-6-astra` both recalled the first turn's codeword and reused the same provider session/thread. Live usage at the time: Claude 5-hour 90%, Codex 5-hour 17%.

## Remaining gates

1. ~~Live smoke tests~~ — done 2026-11-01 (see below).
2. ~~Stream capture + fixtures~~: done for success, coding, interrupt (both) and Codex approval-reject. Still missing: auth failure, a natural usage limit (add a Claude limit signature only then), Codex approve. ~~Classify shell command risk~~ (done). ~~`--resume` / `thread/resume` live~~ (done). Run `acceptForSession` live once.
3. Claude approval bridge via `--permission-prompt-tool` (ADR 0002).
4. iPhone companion follow-ups: QR scanning (expo-camera) and a QR on the desktop, push notifications for approvals and pauses (needs an Apple Developer account and a push service), physical-device build/TestFlight, gateway cert rotation.
5. Desktop packaging: bundle the runner, code signing/notarization (needs Lyndon's Apple credentials), optional login item.
6. Settings UI for fallback order editing (currently `wots fallback set`).

## Next action
iPhone follow-ups (QR pairing, notifications), or desktop settings UI.
