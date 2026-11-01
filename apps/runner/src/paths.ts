import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RunnerPaths {
  home: string;
  db: string;
  socket: string;
  pidFile: string;
  leases: string;
  chatSandbox: string;
  logs: string;
  gateway: string;
  captures: string;
}

export function wotsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.WOTS_HOME ?? join(homedir(), 'Library', 'Application Support', 'WotsRelay');
}

export function runnerPaths(home = wotsHome()): RunnerPaths {
  return {
    home,
    db: join(home, 'wots.db'),
    // Unix socket paths are limited to ~104 bytes on macOS; keep it short.
    socket: join(home, 'r.sock'),
    pidFile: join(home, 'runner.pid'),
    leases: join(home, 'leases'),
    chatSandbox: join(home, 'chat-sandbox'),
    logs: join(home, 'logs'),
    gateway: join(home, 'gateway'),
    captures: join(home, 'captures'),
  };
}

export function ensureHome(p: RunnerPaths): void {
  for (const d of [p.home, p.leases, p.chatSandbox, p.logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
  chmodSync(p.home, 0o700);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readRunnerPid(p: RunnerPaths): number | null {
  if (!existsSync(p.pidFile)) return null;
  const pid = parseInt(readFileSync(p.pidFile, 'utf8'), 10);
  return Number.isFinite(pid) && alive(pid) ? pid : null;
}

// One daemon per OS user: exclusive pid file, stale owners reclaimed, live owners respected.
export function acquireDaemonLock(p: RunnerPaths): () => void {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(p.pidFile, 'wx', 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        if (readFileSync(p.pidFile, 'utf8') === String(process.pid)) rmSync(p.pidFile, { force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = readRunnerPid(p);
      if (pid) throw new Error(`WotsRelay runner already running (pid ${pid})`);
      rmSync(p.pidFile, { force: true });
    }
  }
  throw new Error('Could not acquire runner lock');
}
