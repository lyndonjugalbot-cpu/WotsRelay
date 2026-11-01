import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventEnvelope } from '@wots/protocol';
import { Store } from '@wots/storage';
import { WorkspaceLeases } from '@wots/workspace';
import { mockPair, type MockAdapter } from '@wots/adapter-mock';
import type { Clock, ProviderAdapter } from '@wots/core';
import { RelayController } from '../apps/runner/src/sessions/controller.ts';

export const fakeClock: Clock & { slept: number[] } = {
  slept: [],
  now: () => Date.now(),
  sleep(ms: number) {
    this.slept.push(ms);
    return Promise.resolve();
  },
};

export function tempDir(prefix = 'wots-test-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function tempRepo(files: Record<string, string> = { 'README.md': '# demo\n' }): string {
  const dir = tempDir('wots-repo-');
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return dir;
}

export interface Harness {
  relay: RelayController;
  store: Store;
  events: EventEnvelope[];
  primary: MockAdapter;
  secondary: MockAdapter;
  repo: string;
  projectId: string;
  home: string;
}

export function harness(
  scenario: string,
  opts: { consent?: boolean; adapters?: ProviderAdapter[]; failsToQuiesce?: boolean; dbPath?: string; home?: string; repo?: string; onEvent?: (e: EventEnvelope, relay: RelayController) => void } = {},
): Harness {
  const home = opts.home ?? tempDir('wots-home-');
  const store = new Store(opts.dbPath ?? join(home, 'wots.db'));
  const events: EventEnvelope[] = [];
  const [primary, secondary] = mockPair(scenario, { failsToQuiesce: opts.failsToQuiesce });
  const relay = new RelayController({
    store,
    leases: new WorkspaceLeases(join(home, 'leases')),
    adapters: opts.adapters ?? [primary, secondary],
    publish: (e) => {
      events.push(e);
      opts.onEvent?.(e, relay);
    },
    clock: fakeClock,
    random: () => 0.5,
  });
  const repo = opts.repo ?? tempRepo();
  const project = relay.registerProject({ root: repo, trusted: true, permissionProfile: 'edit', crossProviderConsent: opts.consent ?? true });
  return { relay, store, events, primary, secondary, repo, projectId: project.id, home };
}

export function types(events: EventEnvelope[]): string[] {
  return events.map((e) => e.type);
}

export function states(events: EventEnvelope[]): string[] {
  return events.filter((e) => e.type === 'run.stateChanged').map((e) => (e.payload as { to: string }).to);
}

export async function runOnce(h: Harness, text = 'Build the settings page.') {
  const s = h.relay.createSession({ projectId: h.projectId, mode: 'mock' });
  const { runId } = h.relay.sendMessage({ sessionId: s.id, text, idempotencyKey: `key-${Math.random()}` });
  const run = await h.relay.waitForRun(runId);
  return { session: s, run };
}
