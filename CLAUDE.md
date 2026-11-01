# WotsRelay — working notes for agents

- Product contract: `docs/research/` (blueprint), `docs/decisions/`, `docs/compatibility.md`. Keep `BUILD_STATUS.md` accurate after every milestone.
- Node 26 runs `.ts` directly via type stripping. Use only erasable syntax: no enums, no namespaces, no constructor parameter properties. Relative imports keep the `.ts` extension.
- Checks: `pnpm typecheck`, `pnpm test`. Desktop: `cd apps/desktop && npx tsc -p tsconfig.json --noEmit && pnpm build`.
- Never read provider credential files or keychains, never add `--dangerously-skip-permissions`, `--bare` or base-URL overrides to the Claude adapter, never treat model prose as a control signal.
- Add a provider error mapping only with structured evidence (pinned schema or captured fixture). Unknown → pause.
- Mock adapters must stay visibly labelled and are never eligible in real sessions.
- Don't run real provider requests in tests; live smoke tests need the owner's explicit go-ahead.
- Run Electron with `env -u ELECTRON_RUN_AS_NODE` when launched from VS Code; `WOTS_CAPTURE=/path.png` captures the window and quits.
