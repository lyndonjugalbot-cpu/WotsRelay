import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildHandoff } from '@wots/context';
import { containsSecret, matchesAny, redact, DEFAULT_SECRET_PATH_PATTERNS } from '@wots/security';
import { WorkspaceLeases, buildManifest, canonicalRoot, diffManifests, resolveInside } from '@wots/workspace';
import { Store } from '@wots/storage';
import type { Checkpoint } from '@wots/protocol';
import { tempDir } from '../helpers.ts';

const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  id: 'cp1',
  sessionId: 's',
  runId: 'r',
  objective: 'Build the settings page',
  latestUserConstraints: ['Use CSS grid'],
  completedSteps: ['Write: src/a.ts'],
  pendingSteps: ['Finish'],
  decisionNotes: [],
  recentMessages: [{ role: 'assistant', provider: 'claude-code', model: 'claude-opus-5-5', text: 'partial', interrupted: true }],
  baselineCommit: 'abc',
  fileManifest: [],
  changedFiles: [{ path: 'src/a.ts', change: 'added', sha256: 'f'.repeat(64) }],
  diff: 'x'.repeat(500),
  testEvidence: [],
  providerBindings: {},
  unresolvedActions: [{ operationId: 'op', name: 'Bash', argsPreview: 'npm run migrate', risk: 'external-side-effect', status: 'unknown' }],
  permissionVersion: 1,
  switchReason: 'Usage limit',
  previousProvider: { connectionId: 'claude-code', model: 'claude-opus-5-5' },
  nextRoute: null,
  handoffCategory: null,
  gitStatus: [],
  knownErrors: [],
  permissionProfile: null,
  createdAtSeq: 10,
  contentHash: 'h',
  createdAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('handoff assembly', () => {
  it('is deterministic and contains critical sections in priority order', () => {
    const a = buildHandoff(cp());
    expect(buildHandoff(cp()).prompt).toBe(a.prompt);
    const order = ['Original objective', 'Latest user instructions', 'Safety and permission', 'DO NOT REPEAT', 'Progress', 'Files changed'].map((s) => a.prompt.indexOf(s));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]!))).toBe(true);
    expect(a.prompt).toContain('INTERRUPTED');
    expect(a.blockedBy).toBeNull();
  });
  it('drops non-critical sections first and records omissions', () => {
    const r = buildHandoff(cp({ diff: 'y'.repeat(200_000) }), { contextLimit: 20_000, reserveForOutput: 4_000, fallbackCap: 0 });
    expect(r.omitted.join()).toMatch(/diff/);
    expect(r.prompt).toContain('Original objective');
    expect(r.blockedBy).toBeNull();
  });
  it('blocks instead of silently dropping a critical constraint', () => {
    const r = buildHandoff(cp({ latestUserConstraints: ['z'.repeat(100_000)] }), { contextLimit: 10_000, reserveForOutput: 2_000, fallbackCap: 0 });
    expect(r.blockedBy).not.toBeNull();
  });
  it('A13 redacts secrets from handoff content', () => {
    const r = buildHandoff(cp({ objective: 'deploy with key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX and AKIAABCDEFGHIJKLMNOP' }));
    expect(r.prompt).not.toContain('sk-ant-api03');
    expect(r.prompt).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });
});

describe('redaction and secret paths', () => {
  it('redacts common credential formats', () => {
    for (const s of ['sk-proj-abcdefghijklmnopqrstuvwxyz123', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'password = "hunter22hunter"', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----']) {
      expect(containsSecret(s)).toBe(true);
      expect(redact(s)).toContain('[REDACTED');
    }
    expect(containsSecret('just a normal sentence about tokens')).toBe(false);
  });
  it('excludes secret files by default', () => {
    for (const p of ['.env', '.env.local', 'config/server.pem', 'home/.ssh/id_rsa', '.aws/credentials']) expect(matchesAny(p, DEFAULT_SECRET_PATH_PATTERNS)).toBe(true);
    expect(matchesAny('src/environment.ts', DEFAULT_SECRET_PATH_PATTERNS)).toBe(false);
  });
});

describe('workspace boundaries', () => {
  it('rejects symlink escapes and relative roots', () => {
    const root = tempDir();
    const outside = tempDir();
    symlinkSync(outside, join(root, 'link'));
    expect(() => resolveInside(root, 'link/x.txt')).toThrow(/escapes/);
    expect(() => resolveInside(root, '../x')).toThrow(/escapes/);
    expect(resolveInside(root, 'src/new.ts')).toBe(join(root, 'src/new.ts'));
    expect(() => canonicalRoot('relative/path')).toThrow(/absolute/);
  });
  it('manifest skips secrets, ignored dirs and symlinks; diff detects changes', () => {
    const root = tempDir();
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules/x.js'), '1');
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'a.ts'), 'a');
    const before = buildManifest(root);
    expect(before.map((f) => f.path)).toEqual(['a.ts']);
    writeFileSync(join(root, 'a.ts'), 'b');
    writeFileSync(join(root, 'c.ts'), 'c');
    expect(diffManifests(before, buildManifest(root)).map((c) => `${c.change}:${c.path}`)).toEqual(['modified:a.ts', 'added:c.ts']);
  });
  it('single writer: a live lease cannot be taken by another run', () => {
    const leases = new WorkspaceLeases(tempDir());
    leases.acquire('/p', 'run:a');
    expect(() => leases.acquire('/p', 'run:b')).toThrow(/in use/);
    leases.release('/p', 'run:a');
    expect(leases.acquire('/p', 'run:b').ownerId).toBe('run:b');
  });
  it('reclaims a stale lease from a dead process', () => {
    const dir = tempDir();
    writeFileSync(join(dir, `${'x'}.lease`), JSON.stringify({ pid: 999_999, ownerId: 'old', root: '/q', acquiredAt: '' }));
    expect(new WorkspaceLeases(dir).reapStale()).toEqual(['/q']);
  });
});

describe('storage', () => {
  it('migrates from scratch and is idempotent on reopen', () => {
    const path = join(tempDir(), 'db.sqlite');
    const s1 = new Store(path);
    expect(s1.schemaVersion()).toBe(2);
    s1.close();
    const s2 = new Store(path);
    expect(s2.schemaVersion()).toBe(2);
    s2.close();
  });
  it('upgrades a v1 database to the current schema', () => {
    const path = join(tempDir(), 'db.sqlite');
    const s = new Store(path);
    s.db.exec('DROP TABLE devices; DROP TABLE pairing_challenges; DROP TABLE usage_observations; DELETE FROM schema_migrations WHERE version = 2;');
    s.close();
    const s2 = new Store(path);
    expect(s2.schemaVersion()).toBe(2);
    expect(s2.all('SELECT name FROM sqlite_master WHERE name = ?', 'devices')).toHaveLength(1);
    s2.close();
  });
  it('approval resolution is compare-and-set', () => {
    const s = new Store(':memory:');
    s.db.exec('PRAGMA foreign_keys = OFF');
    s.insertApproval({ id: 'a1', sessionId: 's', runId: 'r', attemptId: 't', operationId: null, providerRequestId: 'p', action: 'x', scope: 'y', risk: 'unknown', permissionVersion: 0, status: 'pending', version: 0, resolvedBy: null });
    expect(s.resolveApproval('a1', 'approve', 0, 'desktop')).toBe(true);
    expect(s.resolveApproval('a1', 'reject', 0, 'phone')).toBe(false);
    expect(s.getApproval('a1')!.status).toBe('approved');
  });
});
