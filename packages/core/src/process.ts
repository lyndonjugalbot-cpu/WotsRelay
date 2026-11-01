import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// Resolve the genuine executable on PATH (no shell), following symlinks to the real binary.
export function resolveExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return realpathSync(p);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function execVersion(path: string, args: string[] = ['--version']): string | null {
  try {
    return execFileSync(path, args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pgid, sig);
  } catch {
    /* already gone */
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitGone(pgid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!groupAlive(pgid)) return true;
    await wait(50);
  }
  return !groupAlive(pgid);
}

// Opt-in record of one provider process: its arguments, every stdin write, every stdout/stderr
// line and how it exited. The implementation decides where it goes and must redact.
export interface StreamCapture {
  record(entry: CaptureEntry): void;
}

export type CaptureEntry =
  | { d: 'start'; args: string[] }
  | { d: 'in' | 'out' | 'err'; line: string }
  | { d: 'signal'; signal: NodeJS.Signals }
  | { d: 'exit'; code: number | null; signal: NodeJS.Signals | null };

export type CaptureFactory = (meta: { connectionId: string; version: string | null }) => StreamCapture | null;

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  // Adapters call this for what they write to stdin so captures keep request/response order.
  recordInput(text: string): void;
  pgid: number;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  // Escalates gracefully and resolves true only when the whole group is provably gone.
  stop(opts?: { graceSignal?: NodeJS.Signals; graceMs?: number }): Promise<boolean>;
  ensureGroupGone(): Promise<boolean>;
}

// Spawn in its own process group (argument array, no shell) so the full tree can be stopped.
export function spawnManaged(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; capture?: StreamCapture | null }): ManagedProcess {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  const pgid = child.pid!;
  const cap = opts.capture ?? null;
  if (cap) {
    cap.record({ d: 'start', args });
    child.stdout.on('data', lineReader((line) => cap.record({ d: 'out', line })));
    child.stderr.on('data', lineReader((line) => cap.record({ d: 'err', line })));
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => {
      cap?.record({ d: 'exit', code, signal });
      resolve({ code, signal });
    });
    child.once('error', () => resolve({ code: null, signal: null }));
  });
  const ensureGroupGone = async () => {
    if (await waitGone(pgid, 500)) return true;
    signalGroup(pgid, 'SIGTERM');
    if (await waitGone(pgid, 5_000)) return true;
    signalGroup(pgid, 'SIGKILL');
    return waitGone(pgid, 2_000);
  };
  return {
    child,
    recordInput: (text) => cap?.record({ d: 'in', line: text }),
    pgid,
    exited,
    ensureGroupGone,
    async stop({ graceSignal = 'SIGINT', graceMs = 5_000 } = {}) {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          cap?.record({ d: 'signal', signal: graceSignal });
          child.kill(graceSignal);
        } catch {
          /* ignore */
        }
        await Promise.race([exited, wait(graceMs)]);
      }
      return ensureGroupGone();
    },
  };
}

// Split a byte stream into complete lines; caps line length to bound memory.
export function lineReader(onLine: (line: string) => void, maxLine = 4_000_000): (chunk: Buffer) => void {
  let buf = '';
  return (chunk) => {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
    if (buf.length > maxLine) buf = '';
  };
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
