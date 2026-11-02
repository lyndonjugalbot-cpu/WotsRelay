// Bundles the Electron main and preload scripts (the renderer is built by Vite).
// Development build: the runner is launched from this checkout with the system Node.
import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const runnerMain = fileURLToPath(new URL('../../runner/src/main.ts', import.meta.url));
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], sourcemap: false, logLevel: 'info' };
await build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'out/main.cjs', define: { __RUNNER_MAIN__: JSON.stringify(runnerMain) } });
await build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'out/preload.cjs' });
copyFileSync(fileURLToPath(new URL('../assets/icon.png', import.meta.url)), fileURLToPath(new URL('../out/icon.png', import.meta.url)));
