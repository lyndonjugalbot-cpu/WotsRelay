# Captured provider streams

Real Claude Code / Codex process streams, replayed through the real adapters by `tests/unit/stream-replay.test.ts`.
Folder names carry the provider tool version the stream came from.

`cursor-docs/` is the exception: Cursor is not installed yet, so these streams are **synthesised from the documented
stream-json schema** (cursor.com/docs/cli/reference/output-format, read 2026-11-02) and their `meta` line says
`"source": "docs"`. Replace them with real captures once Cursor is installed.

## Capturing new ones (uses real provider quota — needs the owner's go-ahead)

1. `wots capture on`. Each provider process now writes `<WOTS_HOME>/captures/*.jsonl` (redacted, mode 0600).
2. Run the scenario (`wots chat …`, `wots code …`, interrupt, approval…).
3. `wots capture off`, then `wots capture status` to list the files.
4. `node tests/fixtures/sanitize-capture.ts <capture.jsonl> tests/fixtures/streams/<tool>-<version>/<name>.jsonl [--forbid word]`.
   It replaces home/temp paths, hostname and UUIDs, empties plugin/skill/MCP lists and hook output, and refuses to write if
   the home path, hostname, user name, git email or any `--forbid` word survives.
5. Read the result before committing it. It still contains the prompt and the model's reply.

## Format (one JSON object per line)

`meta` (format, connectionId, version) · `start` (args) · `in` (each stdin write) · `out` / `err` (each line) ·
`signal` (sent by the adapter) · `exit` (code, signal). `t` is milliseconds since start.

`replay-provider.ts` releases `out`/`err` in captured order. Each `in` and `signal` is a gate that the live adapter must
reach first, and it exits 99 if a JSON-RPC request method differs from the capture.
