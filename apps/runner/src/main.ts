#!/usr/bin/env node
import { startRunner } from './runner.ts';

const runner = await startRunner().catch((e: Error) => {
  process.stderr.write(`wots-runner: ${e.message}\n`);
  process.exit(e.message.includes('already running') ? 0 : 1);
});

process.stdout.write(`wots-runner ${process.pid} listening on ${runner.paths.socket}\n`);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(sig, () => {
    void runner.stop().then(() => process.exit(0));
  });
}
