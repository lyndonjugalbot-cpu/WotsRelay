import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, type EventEnvelope } from '@wots/protocol';
import { lineReader } from '@wots/core';
import { ensureHome, runnerPaths, type RunnerPaths } from './paths.ts';

export class RunnerUnavailableError extends Error {
  constructor(message = 'WotsRelay runner is not running') {
    super(message);
    this.name = 'RunnerUnavailableError';
  }
}

export class RpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'RpcError';
  }
}

export class RunnerClient {
  private socket: Socket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(e: EventEnvelope) => void>();
  private closeListeners = new Set<() => void>();
  readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  connect(): Promise<this> {
    return new Promise((resolve, reject) => {
      const s = connect(this.socketPath);
      s.once('connect', () => {
        this.socket = s;
        resolve(this);
      });
      s.once('error', (e) => reject(new RunnerUnavailableError(`Cannot reach runner: ${(e as NodeJS.ErrnoException).code ?? e.message}`)));
      s.on(
        'data',
        lineReader((line) => {
          const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { code: string; message: string }; method?: string; params?: EventEnvelope };
          if (msg.method === 'event' && msg.params) for (const l of this.listeners) l(msg.params);
          else if (typeof msg.id === 'number') {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) p?.reject(new RpcError(msg.error.code, msg.error.message));
            else p?.resolve(msg.result);
          }
        }),
      );
      s.on('close', () => {
        for (const p of this.pending.values()) p.reject(new RunnerUnavailableError('Runner connection closed'));
        this.pending.clear();
        for (const l of this.closeListeners) l();
      });
    });
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (!this.socket) return Promise.reject(new RunnerUnavailableError());
    const id = this.nextId++;
    this.socket.write(`${JSON.stringify({ v: PROTOCOL_VERSION, id, method, params })}\n`);
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
  }

  onEvent(fn: (e: EventEnvelope) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onClose(fn: () => void): void {
    this.closeListeners.add(fn);
  }

  close(): void {
    this.socket?.end();
    this.socket = null;
  }
}

const defaultRunnerMain = () => join(fileURLToPath(new URL('.', import.meta.url)), 'main.ts');

export interface EnsureRunnerOptions {
  paths?: RunnerPaths;
  start?: boolean;
  timeoutMs?: number;
  // Override how the runner is launched (e.g. from Electron, whose execPath is not Node).
  command?: { exec: string; args: string[]; env?: NodeJS.ProcessEnv };
}

// Attach to the user's runner, starting it detached if needed. The runner outlives clients.
export async function ensureRunner(opts: EnsureRunnerOptions = {}): Promise<RunnerClient> {
  const paths = opts.paths ?? runnerPaths();
  try {
    return await new RunnerClient(paths.socket).connect();
  } catch (e) {
    if (opts.start === false) throw e;
  }
  ensureHome(paths);
  const log = openSync(join(paths.logs, 'runner.log'), 'a', 0o600);
  const cmd = opts.command ?? { exec: process.execPath, args: [defaultRunnerMain()] };
  const child = spawn(cmd.exec, cmd.args, { detached: true, stdio: ['ignore', log, log], env: { ...(cmd.env ?? process.env), WOTS_HOME: paths.home } });
  child.unref();
  const until = Date.now() + (opts.timeoutMs ?? 10_000);
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(paths.socket)) continue;
    try {
      return await new RunnerClient(paths.socket).connect();
    } catch {
      /* not ready yet */
    }
  }
  throw new RunnerUnavailableError(`Runner did not start; see ${join(paths.logs, 'runner.log')}`);
}
