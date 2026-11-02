import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { FileEntry } from '@wots/protocol';
import { DEFAULT_IGNORED_DIRS, DEFAULT_SECRET_PATH_PATTERNS, matchesAny, sha256 } from '@wots/security';

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export function canonicalRoot(path: string): string {
  if (!path.startsWith('/')) throw new WorkspaceError('Project path must be absolute');
  if (!existsSync(path)) throw new WorkspaceError(`Project path does not exist: ${path}`);
  const real = realpathSync(path);
  if (!statSync(real).isDirectory()) throw new WorkspaceError('Project path is not a directory');
  if (real === '/' || real === realpathSync(process.env.HOME ?? '/')) throw new WorkspaceError('Refusing to use / or the home directory as a project root');
  return real;
}

// Resolve a path relative to a root and reject anything that escapes it, including via symlinks.
export function resolveInside(root: string, candidate: string): string {
  const abs = resolve(root, candidate);
  let real = abs;
  if (existsSync(abs)) real = realpathSync(abs);
  else {
    // For not-yet-existing files, check the nearest existing parent.
    let parent = abs;
    while (!existsSync(parent)) parent = resolve(parent, '..');
    real = join(realpathSync(parent), relative(parent, abs));
  }
  if (real !== root && !real.startsWith(root + sep)) throw new WorkspaceError(`Path escapes project root: ${candidate}`);
  return real;
}

export interface ManifestOptions {
  exclusions?: readonly string[];
  maxFiles?: number;
  maxFileBytes?: number;
}

export function buildManifest(root: string, opts: ManifestOptions = {}): FileEntry[] {
  const exclusions = [...DEFAULT_SECRET_PATH_PATTERNS, ...(opts.exclusions ?? [])];
  const maxFiles = opts.maxFiles ?? 20_000;
  const maxBytes = opts.maxFileBytes ?? 5_000_000;
  const out: FileEntry[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (out.length >= maxFiles) return;
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) continue; // never follow symlinks out of the workspace
      if (st.isDirectory()) {
        if (DEFAULT_IGNORED_DIRS.includes(name)) continue;
        walk(abs);
      } else if (st.isFile()) {
        if (matchesAny(rel, exclusions)) continue;
        const hash = st.size <= maxBytes ? sha256(readFileSync(abs)) : `size:${st.size}:mtime:${st.mtimeMs}`;
        out.push({ path: rel, sha256: hash, size: st.size });
      }
    }
  };
  walk(root);
  return out;
}

export type FileChange = { path: string; change: 'added' | 'modified' | 'deleted'; sha256: string | null };

export function diffManifests(before: FileEntry[], after: FileEntry[]): FileChange[] {
  const b = new Map(before.map((f) => [f.path, f]));
  const a = new Map(after.map((f) => [f.path, f]));
  const changes: FileChange[] = [];
  for (const [p, f] of a) {
    const prev = b.get(p);
    if (!prev) changes.push({ path: p, change: 'added', sha256: f.sha256 });
    else if (prev.sha256 !== f.sha256) changes.push({ path: p, change: 'modified', sha256: f.sha256 });
  }
  for (const p of b.keys()) if (!a.has(p)) changes.push({ path: p, change: 'deleted', sha256: null });
  return changes.sort((x, y) => x.path.localeCompare(y.path));
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}

export interface GitBaseline {
  isRepo: boolean;
  head: string | null;
  dirtyPaths: string[];
}

export function gitBaseline(root: string): GitBaseline {
  const inside = git(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { isRepo: false, head: null, dirtyPaths: [] };
  const head = git(root, ['rev-parse', 'HEAD']);
  const status = git(root, ['status', '--porcelain']) ?? '';
  return { isRepo: true, head, dirtyPaths: status ? status.split('\n').map((l) => l.slice(3)) : [] };
}

// `git status --porcelain=v1` lines (path only, never contents), capped. [] outside a repo.
export function gitStatusLines(root: string, max = 200): string[] {
  try {
    // Not git(): its trim() would eat the leading space of the first " M path" line.
    const out = execFileSync('git', ['status', '--porcelain=v1'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
    return out.split('\n').filter(Boolean).slice(0, max);
  } catch {
    return [];
  }
}

// Text diff of changed files against the git baseline when available; otherwise a manifest summary.
export function workspaceDiff(root: string, changes: FileChange[], maxBytes = 60_000): string {
  const base = gitBaseline(root);
  if (base.isRepo && base.head) {
    const d = git(root, ['diff', '--no-color', base.head, '--', ...changes.map((c) => c.path)]) ?? '';
    const untracked = changes.filter((c) => c.change === 'added').map((c) => `+++ ${c.path} (new file, ${c.sha256?.slice(0, 12)})`);
    return truncate([d, ...untracked].filter(Boolean).join('\n'), maxBytes);
  }
  return truncate(changes.map((c) => `${c.change.toUpperCase()} ${c.path}${c.sha256 ? ` sha256:${c.sha256.slice(0, 12)}` : ''}`).join('\n'), maxBytes);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n… [diff truncated at ${max} bytes]`;
}

// ---- single-writer workspace lease ------------------------------------------------------

export interface LeaseInfo {
  pid: number;
  ownerId: string;
  root: string;
  acquiredAt: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class WorkspaceLeases {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  private file(root: string): string {
    return join(this.dir, `${sha256(root).slice(0, 24)}.lease`);
  }

  read(root: string): LeaseInfo | null {
    const f = this.file(root);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as LeaseInfo;
    } catch {
      return null;
    }
  }

  // Acquire exclusively (O_EXCL). A stale lease from a dead process is reclaimed;
  // a live owner's lease is never stolen.
  acquire(root: string, ownerId: string): LeaseInfo {
    const f = this.file(root);
    for (let i = 0; i < 2; i++) {
      try {
        const fd = openSync(f, 'wx', 0o600);
        const info: LeaseInfo = { pid: process.pid, ownerId, root, acquiredAt: new Date().toISOString() };
        writeSync(fd, JSON.stringify(info));
        closeSync(fd);
        return info;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const cur = this.read(root);
        if (cur && cur.ownerId === ownerId && cur.pid === process.pid) return cur;
        if (cur && pidAlive(cur.pid) && cur.pid !== process.pid) throw new WorkspaceError(`Workspace is in use by process ${cur.pid}`);
        if (cur && cur.pid === process.pid && cur.ownerId !== ownerId) throw new WorkspaceError(`Workspace is in use by run ${cur.ownerId}`);
        rmSync(f, { force: true }); // stale
      }
    }
    throw new WorkspaceError('Could not acquire workspace lease');
  }

  release(root: string, ownerId: string): void {
    const cur = this.read(root);
    if (cur && cur.ownerId === ownerId && cur.pid === process.pid) rmSync(this.file(root), { force: true });
  }

  // Called at runner startup: drop leases whose owning process is gone.
  reapStale(): string[] {
    const reaped: string[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.lease')) continue;
      const f = join(this.dir, name);
      try {
        const info = JSON.parse(readFileSync(f, 'utf8')) as LeaseInfo;
        if (!pidAlive(info.pid) || info.pid === process.pid) {
          rmSync(f, { force: true });
          reaped.push(info.root);
        }
      } catch {
        rmSync(f, { force: true });
      }
    }
    return reaped;
  }
}
