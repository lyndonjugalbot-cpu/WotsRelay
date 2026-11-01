import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { CaptureEntry, CaptureFactory } from '@wots/core';
import { redact } from '@wots/security';

export const CAPTURE_FORMAT = 1;
const MAX_CAPTURE_BYTES = 20_000_000;

// One JSONL file per provider process when stream capture is switched on. Every line passes
// through redact() before it touches disk; files are user-only. Captures hold prompts and
// model output, so they are reviewed by hand before any becomes a committed fixture.
export function fileCapture(dir: string, enabled: () => boolean): CaptureFactory {
  return ({ connectionId, version }) => {
    if (!enabled()) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const started = Date.now();
    const name = `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${connectionId}-${process.pid}-${Math.random().toString(36).slice(2, 6)}.jsonl`;
    const fd = openSync(join(dir, name), 'wx', 0o600);
    let bytes = 0;
    let open = true;
    const write = (obj: unknown) => {
      if (!open) return;
      const line = `${JSON.stringify(obj)}\n`;
      bytes += Buffer.byteLength(line);
      writeSync(fd, line);
    };
    write({ d: 'meta', format: CAPTURE_FORMAT, connectionId, version, startedAt: new Date(started).toISOString() });
    return {
      record(e: CaptureEntry) {
        if (!open) return;
        const t = Date.now() - started;
        if (e.d === 'exit') {
          write({ t, ...e });
          open = false;
          closeSync(fd);
          return;
        }
        if (bytes > MAX_CAPTURE_BYTES) return;
        if (e.d === 'start') write({ t, d: 'start', args: e.args.map(redact) });
        else if (e.d === 'signal') write({ t, ...e });
        else write({ t, d: e.d, line: redact(e.line) });
        if (bytes > MAX_CAPTURE_BYTES) write({ t, d: 'truncated' });
      },
    };
  };
}

export function listCaptures(dir: string): Array<{ file: string; bytes: number }> {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => ({ file: join(dir, f), bytes: statSync(join(dir, f)).size }));
  } catch {
    return [];
  }
}
