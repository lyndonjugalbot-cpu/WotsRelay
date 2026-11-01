# WotsRelay

A personal workspace for chat and coding on your Mac. It prefers **Claude Opus 5.5** through the official Claude Code CLI and, when Claude reaches a confirmed usage limit, continues the same task with **GPT-6 Astra** through Codex — from a saved checkpoint, with every reply labelled by the model that wrote it.

WotsRelay never asks for provider passwords or tokens. You sign in with `claude auth login` and `codex login`; WotsRelay only launches those official tools.

## Requirements

- Apple Silicon Mac, Node.js 26+, pnpm 11
- Claude Code (≥ 2.1.302) and Codex CLI (0.166.x), each signed in

## Set up

```bash
pnpm install
pnpm wots doctor     # versions, sign-in, billing route, runner state
pnpm wots setup      # consent for chat fallback; starts the runner
```

To put `wots` on your PATH, run this **from the project folder** (it records the absolute path):

```bash
mkdir -p ~/.local/bin && ln -sfn "$(pwd)/apps/cli/bin/wots" ~/.local/bin/wots
```

## Use

Open a terminal in a project folder and run:

```bash
wots
```

It works like `claude` or `codex`: type a request and press Enter. The first time in a folder it asks whether you trust it (edits allowed) or want chat only. **Claude Opus 5.5** is the default model.

| In the session | Does |
|---|---|
| `/model` | pick any Claude or Codex model (↑/↓, Enter); the other provider stays as fallback; saved as your default. `/model gpt-6-astra` picks directly |
| `/new` | new conversation (`/clear` works too) |
| `/resume` | pick an earlier conversation in this folder |
| `/status` | model, fallback, folder access, sign-in |
| `/help`, `/exit` | list commands, quit (also Ctrl-D, or Ctrl-C twice) |
| Ctrl-C | stop the reply in progress |

**Usage-aware switching:** when a provider reports 95% of a usage window (5-hour or weekly) used, your next message goes to the fallback model with the conversation so far, and it switches back after the window resets. A reply already in progress is never cut off. See it with `/status` or `wots usage`; change it with `wots fallback threshold 90`.

If a reply pauses (for example Claude reaches its limit), a menu offers **Continue with GPT-6 Astra**, retry, or leave it paused. The first time, it asks before sending the conversation to the other provider.

`wots "fix the failing test"` starts the session with that message. Piped input runs once and exits: `echo "summarize README.md" | wots`.

Scripting commands are still available:

```bash
wots chat "Explain closures in JavaScript"
wots code --project /absolute/path/to/repo --consent "Build the settings page"
wots sessions
wots resume <session-id> [--fallback] [--note "the migration finished"]
wots export <session-id> > session.md
wots runner status | stop
wots usage                             # usage per provider and window
wots fallback threshold 95             # switch point, percent of a window
wots gateway enable | pair | status     # phone access (see docs/decisions/0004)
wots devices list | revoke <id>
```

Try the handoff without using any quota (clearly labelled as simulated):

```bash
wots code --project /tmp/some-repo --consent --mock quota-after-edit "Build the settings page."
```

Exit codes: 0 completed, 10 paused, 1 failed, 130 cancelled, 3 runner unavailable.

## Desktop app (development build)

```bash
pnpm desktop:build
pnpm --filter @wots/desktop start
```

Closing the window does not stop work — the runner is a separate process. When launching from a VS Code terminal, unset `ELECTRON_RUN_AS_NODE` first.

## iPhone app (development build)

The companion lives in `apps/mobile` (Expo SDK 58, its own npm install, not part of the pnpm workspace).

```bash
cd apps/mobile && npm install
npx expo run:ios            # builds and opens it in the iOS Simulator (Xcode required)
```

On the Mac: `wots gateway enable`, then `wots gateway pair`, and open the printed link on the phone (AirDrop, Messages or Notes), or paste it into the app. The phone trusts only your Mac's certificate (pinned from the link). Revoke it with `wots devices list` / `wots devices revoke <id>`.

The app shows your sessions with usage bars, follows replies live, answers approvals, stops runs and continues paused work. A physical iPhone build needs your Apple signing setup; notifications are not built yet.

## How fallback works

1. Claude runs in your project. Every event is saved to a local SQLite journal before it is shown.
2. On a confirmed usage limit, the runner stops Claude, proves its processes have exited, and records a checkpoint (objective, your latest instructions, completed steps, changed files and diff, unresolved actions).
3. If an action's outcome is unknown (for example a deploy that may have run), work pauses for you instead of continuing.
4. Otherwise GPT-6 Astra starts with that checkpoint, verifies the workspace and continues. It never reuses Claude's session.

Claude Code currently has no documented structured signal for "subscription limit reached", so a Claude limit pauses with a **Continue with GPT-6 Astra** button rather than switching on its own. See `docs/compatibility.md`.

## Data

Everything lives in `~/Library/Application Support/WotsRelay` (override with `WOTS_HOME`), user-only permissions. The database is not encrypted at rest. `.env`, keys and similar files are never sent between providers.

## Layout

See `docs/decisions/` for architecture decisions and `BUILD_STATUS.md` for what is done and what is still open.
