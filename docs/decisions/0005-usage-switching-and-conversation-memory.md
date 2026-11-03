# ADR 0005 — Switch at 95% of a usage window; keep conversations across turns

Status: accepted · 2026-11-01

## Context
The owner asked for the switch to the next model to happen at 95% of a provider's limit, not after it fails. Both CLIs report usage as structured data (captured in `tests/fixtures/streams/`):

- Claude Code 2.1.316 `rate_limit_event` → `rate_limit_info.unifiedWindows.{five_hour,seven_day}` with `utilization` (0–1) and `resetsAt` (epoch s). The real capture showed the 5-hour window at 0.99 (`allowed_warning`) while requests still succeeded.
- Codex 0.166.0 `account/rateLimits/updated` → `primary`/`secondary` with `usedPercent`, `windowDurationMins` (300 / 10080) and `resetsAt`.

While building this, we found that every new message started a fresh provider conversation (`resumeProviderSessionId` was always null). Multi-turn chats had no memory, and a switch between turns would have lost the thread.

## Decision
- Both adapters emit `usage.observed` for every window, normalised to `five_hour` / `seven_day` and a percentage. The runner keeps the latest provider-reported value per connection and window (setting `usage:<connectionId>`). Nothing is estimated.
- `FallbackConfig.switchAtPercent` (default 95, range 50–100; `wots fallback threshold <n>`). Route selection skips a route whose provider has a window at or over the threshold and not yet reset, provided another route is eligible. If every route is near its limit, it uses the one with the most room rather than stopping. Once the window's `resetsAt` passes, the preferred model is eligible again, so it returns on its own.
- The check runs when a new message starts a run. **A reply already in progress is never cut off.** If it then hits the hard limit, the existing limit handling applies (Codex: confirmed limit → automatic fallback; Claude: no captured hard-limit signal yet → pause with the one-step menu).
- Conversation memory: a new message continues the provider's own session when the same provider answered last (`claude --resume <session_id>`, Codex `thread/resume` from the pinned schema). When the provider changes, the runner builds the existing evidence-based handoff (checkpoint + recent conversation + the new message as a critical section) and records `provider.switched` with the reason (e.g. "claude-opus-5-5 is at 96% of its 5-hour limit, resets 18:56").
- Moving an ongoing conversation to another provider still needs cross-provider consent. The interactive CLI asks at that moment, naming the usage figure. A brand-new conversation has nothing to share, so it may start on the fallback without asking.

## Consequences
- Switches happen between turns, so a single long reply can still reach 100%.
- `thread/resume` and `claude --resume` are covered by mock-provider tests and the pinned schema, but have **not yet been run live**.
- Claude may only send `rate_limit_event` near a threshold (all captures were at 99%). If it never reports low usage, the stored reading simply expires at its reset time.
