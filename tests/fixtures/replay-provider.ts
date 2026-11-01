#!/usr/bin/env node
// Stands in for `claude` or `codex` and plays back a stream capture (apps/runner/src/capture.ts).
// Usage: replay-provider.ts <capture.jsonl> [provider args...]
// Output lines are released in captured order; each captured stdin write or signal is a gate the
// live adapter must reach first, so request/response interleaving matches the real run. A JSON-RPC
// request whose method differs from the capture aborts with exit 99 (adapter protocol drift).
import { readFileSync } from 'node:fs';

type Entry = { d: string; line?: string; signal?: NodeJS.Signals; code?: number | null; version?: string | null };

const [file, ...args] = process.argv.slice(2);
const entries = readFileSync(file!, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Entry);
const meta = entries.find((e) => e.d === 'meta');

if (args[0] === '--version') {
  process.stdout.write(`${meta?.version ?? '0.0.0'} (replay)\n`);
  process.exit(0);
}

const received: string[] = [];
let stdinEnded = false;
const signals: NodeJS.Signals[] = [];
let wake: (() => void) | null = null;
const notify = () => {
  wake?.();
  wake = null;
};
let buf = '';
process.stdin.on('data', (c: Buffer) => {
  buf += c.toString('utf8');
  let i: number;
  while ((i = buf.indexOf('\n')) >= 0) {
    if (buf.slice(0, i).trim()) received.push(buf.slice(0, i));
    buf = buf.slice(i + 1);
  }
  notify();
});
process.stdin.on('end', () => {
  if (buf.trim()) received.push(buf);
  stdinEnded = true;
  notify();
});
for (const s of ['SIGINT', 'SIGTERM'] as const)
  process.on(s, () => {
    signals.push(s);
    notify();
  });

// Signal listeners do not keep Node alive; without this the process would exit while waiting
// at a signal gate once stdin has ended.
setInterval(() => {}, 1 << 30);

const until = async (cond: () => boolean) => {
  while (!cond()) await new Promise<void>((r) => (wake = r));
};
const method = (l: string | undefined) => {
  try {
    return (JSON.parse(l ?? '') as { method?: string }).method;
  } catch {
    return undefined;
  }
};
const write = (stream: NodeJS.WriteStream, line: string) => new Promise<void>((r) => (stream.write(`${line}\n`) ? r() : stream.once('drain', () => r())));

let inputs = 0;
let signalsSeen = 0;
for (const e of entries) {
  if (e.d === 'in') {
    const n = inputs++;
    await until(() => received.length > n || stdinEnded);
    const want = method(e.line);
    if (want && received[n] !== undefined && method(received[n]) !== want) {
      process.stderr.write(`replay mismatch at input ${n}: expected ${want}, got ${method(received[n]) ?? 'non-RPC input'}\n`);
      process.exit(99);
    }
  } else if (e.d === 'signal') {
    const n = signalsSeen++;
    await until(() => signals.length > n);
  } else if (e.d === 'out') await write(process.stdout, e.line!);
  else if (e.d === 'err') await write(process.stderr, e.line!);
  else if (e.d === 'exit') {
    if (e.signal) {
      process.removeAllListeners(e.signal);
      process.kill(process.pid, e.signal);
    }
    process.exit(e.code ?? 0);
  }
}
await until(() => stdinEnded);
process.exit(0);
