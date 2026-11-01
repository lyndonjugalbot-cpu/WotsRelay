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

To put `wots` on your PATH: `ln -s "$PWD/apps/cli/bin/wots" ~/.local/bin/wots`.

## Use

```bash
wots chat "Explain closures in JavaScript"
wots code --project /absolute/path/to/repo --consent "Build the settings page"
wots sessions
wots resume <session-id> [--fallback] [--note "the migration finished"]
wots export <session-id> > session.md
wots runner status | stop
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
