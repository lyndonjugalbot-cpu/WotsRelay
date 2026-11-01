import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, tempRepo } from '../helpers.ts';

// Drives the real `wots` interactive session in a pseudo-terminal with mock providers.
const EXPECT = ['/usr/bin/expect', '/opt/homebrew/bin/expect'].find(existsSync);
const WOTS = resolve('apps/cli/bin/wots');
const SCRIPTS = resolve('tests/e2e/repl');

function drive(script: string, scenario: string, cwd: string): { status: number | null; output: string } {
  const home = tempDir('wre-');
  const env = { ...process.env, WOTS_HOME: home };
  try {
    const r = spawnSync(EXPECT!, [join(SCRIPTS, script), WOTS, scenario], { cwd, env, encoding: 'utf8', timeout: 90_000 });
    return { status: r.status, output: (r.stdout + r.stderr).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
  } finally {
    spawnSync(WOTS, ['runner', 'stop'], { env, stdio: 'ignore' });
  }
}

describe.skipIf(!EXPECT)('interactive `wots` (pseudo-terminal, mock providers)', () => {
  it('trust prompt, /model picker and direct pick, /status, pause → consent → Codex finishes, /new, /resume, /exit', () => {
    const repo = tempRepo();
    const { status, output } = drive('fallback.exp', 'quota-after-edit', repo);
    expect(status, output).toBe(0);
    expect(output).toContain('Continue with gpt-6-astra');
    expect(readdirSync(join(repo, 'src', 'settings')).sort()).toEqual(['SettingsPage.tsx', 'index.ts', 'settings.css']);
    // The trusted folder and its consent persist for the next session.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })).toContain('src/');
  });

  it('at 96% of a usage window: heads-up note, asks before moving the conversation, then the fallback answers', () => {
    const { status, output } = drive('near-limit.exp', 'near-limit', tempDir('wchat-'));
    expect(status, output).toBe(0);
    expect(output).toMatch(/5-hour\s+\S+\s+96%/);
  });

  it('approval: risk in plain words, arrow-key choice, approved write lands', () => {
    const repo = tempRepo();
    const { status, output } = drive('approval.exp', 'approval', repo);
    expect(status, output).toBe(0);
    expect(readFileSync(join(repo, 'src', 'approved.txt'), 'utf8')).toBe('approved\n');
  });

  it('Ctrl-C stops a reply without leaving; twice on an empty prompt exits', () => {
    const { status, output } = drive('ctrlc.exp', 'slow-quota', tempDir('wchat-'));
    expect(status, output).toBe(0);
    expect(output).toContain('cancelled');
  });
});
