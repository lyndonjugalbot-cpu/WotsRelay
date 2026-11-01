#!/usr/bin/env node
// Turns a stream capture from `wots capture on` into a committable fixture.
// Usage: sanitize-capture.ts <capture.jsonl> <fixture.jsonl> [--forbid word]...
// Captures are already secret-redacted; this removes what identifies the machine and its owner:
// home and temp paths, hostname, user name, installed plugins/skills/MCP servers, hook output,
// and real UUIDs (mapped consistently so thread/session correlation still replays). It refuses
// to write if any identifying string survives.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';

const [src, dst, ...rest] = process.argv.slice(2);
if (!src || !dst) {
  process.stderr.write('usage: sanitize-capture.ts <capture.jsonl> <fixture.jsonl> [--forbid word]...\n');
  process.exit(2);
}
const forbid = [homedir(), hostname(), hostname().replace(/\.local$/, ''), `/${userInfo().username}/`];
for (let i = 0; i < rest.length; i++) if (rest[i] === '--forbid' && rest[i + 1]) forbid.push(rest[++i]!);
try {
  const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim();
  if (email) forbid.push(email);
} catch {
  /* no git identity */
}

const uuids = new Map<string, string>();
const placeholderUuid = (u: string) => {
  if (!uuids.has(u.toLowerCase())) uuids.set(u.toLowerCase(), `00000000-0000-4000-8000-${String(uuids.size + 1).padStart(12, '0')}`);
  return uuids.get(u.toLowerCase())!;
};

function scrubText(s: string): string {
  return s
    .replaceAll(homedir(), '/Users/user')
    .replace(/\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\/([A-Za-z0-9._-]+)/g, '/tmp/$1')
    .replaceAll(hostname(), 'host.local')
    .replaceAll(hostname().replace(/\.local$/, ''), 'host')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, placeholderUuid);
}

function scrub(v: unknown): unknown {
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

// Provider-specific fields that describe the owner's setup rather than the protocol.
function trimProviderLine(msg: Record<string, unknown>): Record<string, unknown> {
  if (msg.type === 'system' && msg.subtype === 'init') {
    const m = { ...msg };
    for (const k of ['plugins', 'skills', 'slash_commands', 'mcp_servers', 'agents']) if (Array.isArray(m[k])) m[k] = [];
    if (Array.isArray(m.tools)) m.tools = (m.tools as unknown[]).filter((t) => typeof t === 'string' && !t.startsWith('mcp__'));
    return m;
  }
  if (msg.type === 'system' && typeof msg.subtype === 'string' && msg.subtype.startsWith('hook_')) {
    const m = { ...msg };
    for (const k of ['output', 'stdout', 'stderr']) if (k in m) m[k] = '';
    return m;
  }
  return msg;
}

const out: string[] = [];
for (const raw of readFileSync(src, 'utf8').split('\n').filter(Boolean)) {
  const e = JSON.parse(raw) as Record<string, unknown>;
  const line = e.line;
  if ((e.d === 'out' || e.d === 'in') && typeof line === 'string') {
    try {
      e.line = JSON.stringify(scrub(trimProviderLine(JSON.parse(line) as Record<string, unknown>)));
    } catch {
      e.line = scrubText(line);
    }
  }
  out.push(JSON.stringify(scrub(e)));
}
const text = `${out.join('\n')}\n`;
const leaks = forbid.filter((w) => w && text.toLowerCase().includes(w.toLowerCase()));
if (leaks.length) {
  process.stderr.write(`refusing to write ${dst}: still contains ${leaks.length} identifying string(s)\n`);
  process.exit(1);
}
writeFileSync(dst, text);
process.stdout.write(`${dst}: ${out.length} entries, ${uuids.size} ids mapped\n`);
