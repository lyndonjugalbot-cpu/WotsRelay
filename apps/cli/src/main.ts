#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import { ExitCodes, type Session } from '@wots/protocol';
import { ensureRunner, lanAddress, readRunnerPid, runnerPaths, RpcError, RunnerUnavailableError, type RunnerClient } from '@wots/runner';
import { ClaudeCodeAdapter } from '@wots/adapter-claude-code';
import { CodexAdapter } from '@wots/adapter-codex';
import { detectBillingEnv } from '@wots/security';
import { exitFor, followRun, sendAndFollow } from './follow.ts';
import { interactive, oneShot } from './interactive.ts';
import { amber, bold, dim, green, red } from './ui.ts';

const program = new Command()
  .name('wots')
  .description('WotsRelay — one workspace across Claude Code and Codex.\nRun `wots` with no command for an interactive session in the current folder.')
  .version('0.1.0')
  .option('--json', 'machine-readable JSON output')
  // Program options must come before a subcommand, so `wots code --mock …` keeps its own --mock.
  .enablePositionalOptions()
  .argument('[prompt...]', 'optional first message for the interactive session')
  .addOption(new Option('--mock <scenario>', 'use deterministic mock providers (clearly labelled)').hideHelp())
  .action(async (words: string[], opts: { mock?: string }) => {
    const text = words.join(' ');
    if (process.stdin.isTTY && process.stdout.isTTY) return interactive({ prompt: text || undefined, mock: opts.mock });
    const piped = text || (await readStdin());
    if (!piped) program.help();
    process.exitCode = await oneShot(piped, { mock: opts.mock });
  });
const json = () => program.opts<{ json?: boolean }>().json === true;

async function client(start = true): Promise<RunnerClient> {
  return ensureRunner({ start });
}

function print(obj: unknown, human: () => void): void {
  if (json()) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else human();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

const followOpts = () => ({ json: json(), sigint: 'cli' as const, resumeHints: true, showIds: true });

// ---- commands ------------------------------------------------------------------------------

program
  .command('doctor')
  .description('Report tool versions, auth status, billing route and runner state (no secrets)')
  .action(async () => {
    const paths = runnerPaths();
    const sb = paths.chatSandbox;
    const report = await Promise.all(
      [new ClaudeCodeAdapter({ chatSandboxDir: sb }), new CodexAdapter({ chatSandboxDir: sb })].map(async (a) => {
        const probe = await a.probe();
        const conn = await a.getConnectionStatus();
        return { connectionId: a.connectionId, installed: probe.installed, executable: probe.executablePath, version: probe.version, supportedVersion: probe.supportedVersion, auth: conn.authStatus, billing: conn.billingMode, notes: [...probe.notes, ...conn.limitations] };
      }),
    );
    const env = { anthropic: detectBillingEnv(process.env, 'anthropic'), openai: detectBillingEnv(process.env, 'openai') };
    const runnerPid = readRunnerPid(paths);
    print({ connections: report, billingEnvironmentVariablesPresent: env, runner: { pid: runnerPid, home: paths.home } }, () => {
      for (const r of report) {
        const ok = r.installed && r.supportedVersion && r.auth === 'authenticated';
        console.log(`${ok ? green('●') : amber('●')} ${bold(r.connectionId)}  ${r.version ?? 'not installed'}  auth=${r.auth}  billing=${r.billing}`);
        console.log(dim(`    ${r.executable ?? ''}`));
        for (const n of r.notes) console.log(dim(`    · ${n}`));
      }
      const envs = [...env.anthropic, ...env.openai];
      console.log(envs.length ? amber(`● billing env vars present (values not shown): ${envs.join(', ')}`) : green('● no billing-changing environment variables detected'));
      console.log(`${runnerPid ? green('●') : dim('○')} runner ${runnerPid ? `running (pid ${runnerPid})` : 'not running'}  ${dim(paths.home)}`);
    });
  });

program
  .command('setup')
  .description('Guided setup: check providers and set cross-provider consent for chat')
  .addOption(new Option('--chat-consent <answer>', 'allow chat context to be sent to the fallback provider').choices(['yes', 'no']))
  .action(async (opts: { chatConsent?: 'yes' | 'no' }) => {
    console.log(bold('WotsRelay setup'));
    console.log('Work runs on this Mac. The phone companion only works while this Mac is awake and the runner is running.\n');
    const sb = runnerPaths().chatSandbox;
    const claude = await new ClaudeCodeAdapter({ chatSandboxDir: sb }).getConnectionStatus();
    const codex = await new CodexAdapter({ chatSandboxDir: sb }).getConnectionStatus();
    const line = (name: string, c: typeof claude, login: string) =>
      console.log(c.authStatus === 'authenticated' ? `${green('✓')} ${name}: signed in (${c.billingMode})` : `${amber('!')} ${name}: ${c.authStatus}. Sign in with the provider's own flow: ${bold(login)}`);
    line('Claude Code', claude, 'claude auth login');
    line('Codex / ChatGPT', codex, 'codex login');
    console.log(dim('\nWotsRelay never asks for provider passwords or tokens; sign-in happens in the official tools.\n'));
    const cl = await client();
    let consent = opts.chatConsent;
    if (!consent && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question('If Claude reaches its usage limit in a chat, may WotsRelay send that chat’s context to GPT-6 Astra to continue? [y/N] ');
      rl.close();
      consent = a.trim().toLowerCase().startsWith('y') ? 'yes' : 'no';
    }
    if (consent) await cl.call('settings.setChatConsent', { consent: consent === 'yes' });
    const conns = await cl.call('connections.list', { refresh: true });
    cl.close();
    print(conns, () => console.log(green('\nSetup saved. Run `wots doctor` any time; coding projects ask for consent separately (`wots code --consent`).')));
  });

program
  .command('chat')
  .description('Chat without file or shell access')
  .argument('[prompt...]', 'prompt; omit to read stdin or start an interactive chat')
  .option('--mock <scenario>', 'use deterministic mock providers (clearly labelled)')
  .action(async (words: string[], opts: { mock?: string }) => {
    const cl = await client();
    const session = await cl.call<Session>('sessions.create', { projectId: null, mode: opts.mock ? 'mock' : 'real', mockScenario: opts.mock });
    let text = words.join(' ') || (await readStdin());
    if (text) process.exitCode = exitFor(await sendAndFollow(cl, session, text, followOpts()));
    else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      for (;;) {
        text = (await rl.question(bold('\nyou › '))).trim();
        if (!text || text === '/exit') break;
        rl.pause();
        process.exitCode = exitFor(await sendAndFollow(cl, session, text, followOpts()));
        rl.resume();
      }
      rl.close();
    }
    cl.close();
  });

program
  .command('code')
  .description('Run a coding task in a trusted project folder')
  .requiredOption('--project <path>', 'absolute project path')
  .argument('[prompt...]')
  .option('--consent', 'allow this project’s task context to be sent to the fallback provider')
  .option('--read-only', 'use the read-only permission profile')
  .option('--mock <scenario>', 'use deterministic mock providers (clearly labelled)')
  .action(async (words: string[], opts: { project: string; consent?: boolean; readOnly?: boolean; mock?: string }) => {
    const text = words.join(' ') || (await readStdin());
    if (!text) {
      console.error('Provide a prompt as arguments or on stdin.');
      process.exit(ExitCodes.usage);
    }
    const cl = await client();
    const { project, git } = await cl.call<{ project: { id: string; crossProviderConsent: boolean }; git: { isRepo: boolean; dirtyPaths: string[] } }>('projects.register', {
      root: resolve(opts.project),
      trusted: true,
      permissionProfile: opts.readOnly ? 'read-only' : 'edit',
      crossProviderConsent: !!opts.consent,
    });
    if (!json() && git.dirtyPaths.length) process.stderr.write(amber(`Note: ${git.dirtyPaths.length} uncommitted change(s) exist. They will be preserved, not reset or stashed.\n`));
    if (!json() && !project.crossProviderConsent) process.stderr.write(dim('Cross-provider fallback is off for this project (add --consent to allow it).\n'));
    const session = await cl.call<Session>('sessions.create', { projectId: project.id, mode: opts.mock ? 'mock' : 'real', mockScenario: opts.mock });
    process.exitCode = exitFor(await sendAndFollow(cl, session, text, followOpts()));
    cl.close();
  });

program
  .command('sessions')
  .description('List sessions')
  .action(async () => {
    const cl = await client();
    const list = await cl.call<Session[]>('sessions.list');
    cl.close();
    print(list, () => {
      for (const s of list) console.log(`${s.id}  ${s.state.padEnd(16)} ${s.mode === 'mock' ? amber('[mock] ') : ''}${s.title}  ${dim(s.updatedAt)}`);
    });
  });

program
  .command('resume')
  .description('Resume a paused session')
  .argument('<session-id>')
  .option('--fallback', 'continue on the next provider in the fallback order')
  .option('--note <text>', 'add a note for the agent, e.g. the outcome of an uncertain command')
  .action(async (sessionId: string, opts: { fallback?: boolean; note?: string }) => {
    const cl = await client();
    const before = (await cl.call<{ session: Session }>('sessions.get', { sessionId })).session.latestSeq;
    const { runId } = await cl.call<{ runId: string }>('runs.resume', { sessionId, fallback: !!opts.fallback, note: opts.note });
    process.exitCode = exitFor(await followRun(cl, sessionId, runId, before, followOpts()));
    cl.close();
  });

for (const [name, decision] of [['approve', 'approve'], ['reject', 'reject']] as const) {
  program
    .command(name)
    .description(`${name[0]!.toUpperCase()}${name.slice(1)} a pending action`)
    .argument('<approval-id>')
    .requiredOption('--version <n>', 'expected approval version', (v) => parseInt(v, 10))
    .option('--session', 'approve, and let similar requests run without asking for the rest of the session (Codex commands)')
    .action(async (approvalId: string, opts: { version: number; session?: boolean }) => {
      const cl = await client(false);
      const res = await cl.call('approvals.decide', { approvalId, decision: decision === 'approve' && opts.session ? 'approve_session' : decision, expectedVersion: opts.version, deviceId: 'cli' });
      cl.close();
      print(res, () => console.log(res));
    });
}

program
  .command('connections')
  .description('Show provider connections (sanitized)')
  .option('--refresh', 're-check status now')
  .action(async (opts: { refresh?: boolean }) => {
    const cl = await client();
    const list = await cl.call<Array<{ connectionId: string; isMock: boolean; connection: { authStatus: string; billingMode: string; toolVersion: string | null; lastChecked: string } | null }>>('connections.list', { refresh: !!opts.refresh });
    cl.close();
    print(list, () => {
      for (const c of list) {
        const x = c.connection;
        console.log(`${bold(c.connectionId.padEnd(12))} ${c.isMock ? amber('MOCK ') : ''}${x ? `auth=${x.authStatus} billing=${x.billingMode} version=${x.toolVersion ?? '-'} ${dim(`checked ${x.lastChecked}`)}` : dim('not checked yet (use --refresh)')}`);
      }
    });
  });

program
  .command('models')
  .description('List known models and their verification status')
  .action(async () => {
    const cl = await client();
    await cl.call('connections.list', { refresh: true });
    const models = await cl.call<Record<string, Array<{ modelId: string; verification: string; supportedEfforts: string[] }>>>('models.list');
    cl.close();
    print(models, () => {
      for (const [conn, list] of Object.entries(models)) {
        console.log(bold(conn));
        for (const m of list) console.log(`  ${m.modelId.padEnd(22)} ${m.verification.padEnd(18)} ${dim(m.supportedEfforts.join('/'))}`);
      }
    });
  });

const fallback = program.command('fallback').description('Show or set the fallback order');
fallback.command('show').action(async () => {
  const cl = await client();
  const f = await cl.call<{ real: { routes: Array<{ connectionId: string; modelId: string }>; effort: string; speed: string; autoFallback: boolean }; chatConsent: boolean }>('fallback.get');
  cl.close();
  print(f, () => {
    f.real.routes.forEach((r, i) => console.log(`${i + 1}. ${r.modelId} via ${r.connectionId}`));
    console.log(dim(`effort=${f.real.effort} speed=${f.real.speed} auto=${f.real.autoFallback} chat-consent=${f.chatConsent}`));
  });
});
fallback
  .command('set')
  .argument('<models...>', 'model ids in order, e.g. claude-opus-5-5 gpt-6-astra')
  .action(async (models: string[]) => {
    const conn = (m: string) => (m.startsWith('claude') ? 'claude-code' : 'codex');
    const cl = await client();
    const cur = await cl.call<{ real: Record<string, unknown> }>('fallback.get');
    const res = await cl.call('fallback.set', { ...cur.real, routes: models.map((m) => ({ connectionId: conn(m), modelId: m })) });
    cl.close();
    print(res, () => console.log(green('Fallback order saved.')));
  });

fallback
  .command('threshold')
  .argument('<percent>', 'switch to the next model once a provider reports this share of a usage window as used (50–100; 100 = only on a real limit)', (v) => parseInt(v, 10))
  .action(async (percent: number) => {
    const cl = await client();
    const cur = await cl.call<{ real: Record<string, unknown> }>('fallback.get');
    const res = await cl.call('fallback.set', { ...cur.real, switchAtPercent: percent });
    cl.close();
    print(res, () => console.log(green(`New conversations switch at ${percent}% of a usage window.`)));
  });

program
  .command('usage')
  .description('Usage reported by Claude Code and Codex, per window')
  .action(async () => {
    const cl = await client();
    const u = await cl.call<{ switchAtPercent: number; connections: Record<string, Array<{ scope: string; percent: number; resetAt: string | null }>> }>('usage.get');
    cl.close();
    print(u, () => {
      for (const [conn, windows] of Object.entries(u.connections)) {
        if (conn.startsWith('mock')) continue;
        const live = windows.filter((w) => !w.resetAt || Date.parse(w.resetAt) > Date.now());
        console.log(bold(conn));
        if (!live.length) console.log(dim('  not reported yet (it appears after the next request)'));
        for (const w of live) console.log(`  ${w.scope.padEnd(10)} ${String(w.percent).padStart(3)}%${w.resetAt ? dim(`  resets ${new Date(w.resetAt).toLocaleString()}`) : ''}${w.percent >= u.switchAtPercent ? amber('  → switching') : ''}`);
      }
      console.log(dim(`Switches to the next model at ${u.switchAtPercent}% (change with: wots fallback threshold <percent>).`));
    });
  });

program
  .command('export')
  .argument('<session-id>')
  .addOption(new Option('--format <format>').choices(['markdown', 'json']).default('markdown'))
  .action(async (sessionId: string, opts: { format: string }) => {
    const cl = await client();
    const out = await cl.call('export', { sessionId, format: opts.format });
    cl.close();
    process.stdout.write(typeof out === 'string' ? out : `${JSON.stringify(out, null, 2)}\n`);
  });

type GatewayStatus = { enabled: boolean; host: string; port: number; listening: { host: string; port: number } | null; fingerprint: string | null; connectedDevices: string[] };
const showGateway = (s: GatewayStatus) => {
  if (!s.enabled) return console.log(dim('gateway disabled'));
  console.log(s.listening ? green(`gateway listening on https://${s.listening.host}:${s.listening.port}`) : red(`gateway enabled but not listening on ${s.host}:${s.port} (see runner log)`));
  if (s.fingerprint) console.log(dim(`certificate sha256 ${s.fingerprint}`));
  console.log(dim(`${s.connectedDevices.length} device(s) connected`));
};

const gateway = program.command('gateway').description('Phone access over an authenticated HTTPS/WebSocket gateway (off by default)');
gateway
  .command('enable')
  .description('Listen for paired phones. Defaults to this Mac\'s LAN address')
  .option('--host <address>', 'address to bind, e.g. a LAN or Tailscale IP')
  .option('--port <port>', 'TCP port', (v) => parseInt(v, 10), 7443)
  .action(async (opts: { host?: string; port: number }) => {
    const host = opts.host ?? lanAddress();
    if (!host) throw new Error('No LAN address found; pass --host');
    if (host === '0.0.0.0' || host === '::') console.error(amber('Binding to every interface. Prefer a specific LAN or Tailscale address.'));
    const cl = await client();
    const s = await cl.call<GatewayStatus>('gateway.configure', { enabled: true, host, port: opts.port });
    cl.close();
    print(s, () => showGateway(s));
  });
gateway.command('disable').action(async () => {
  const cl = await client();
  const s = await cl.call<GatewayStatus>('gateway.configure', { enabled: false });
  cl.close();
  print(s, () => showGateway(s));
});
gateway.command('status').action(async () => {
  const cl = await client();
  const s = await cl.call<GatewayStatus>('gateway.status');
  cl.close();
  print(s, () => showGateway(s));
});
gateway
  .command('pair')
  .description('Issue a single-use pairing link (expires in 2 minutes)')
  .action(async () => {
    const cl = await client();
    const p = await cl.call<{ uri: string; expiresAt: string; fingerprint: string }>('gateway.pair');
    cl.close();
    print(p, () => {
      console.log('Open this link on the phone (or scan it once the desktop shows a QR code):');
      console.log(bold(p.uri));
      console.log(dim(`expires ${p.expiresAt} · single use · certificate sha256 ${p.fingerprint}`));
    });
  });

const devices = program.command('devices').description('Paired phones');
devices.command('list').action(async () => {
  const cl = await client();
  const list = await cl.call<Array<{ id: string; name: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null }>>('devices.list');
  cl.close();
  print(list, () => {
    if (!list.length) console.log(dim('no paired devices'));
    for (const d of list) console.log(`${bold(d.id)} ${d.name} ${d.revokedAt ? red(`revoked ${d.revokedAt}`) : green('active')} ${dim(`paired ${d.createdAt} · last seen ${d.lastSeenAt ?? 'never'}`)}`);
  });
});
devices
  .command('revoke')
  .argument('<device-id>')
  .description('Revoke a device and disconnect it now')
  .action(async (deviceId: string) => {
    const cl = await client();
    const r = await cl.call<{ revoked: boolean }>('devices.revoke', { deviceId });
    cl.close();
    print(r, () => console.log(r.revoked ? green('Device revoked and disconnected.') : dim('No active device with that id.')));
  });

const capture = program.command('capture').description('Record provider streams (redacted, user-only files) for building test fixtures');
const showCapture = (r: { enabled: boolean; dir: string }) => console.log(`${r.enabled ? amber('capture ON') : dim('capture off')} ${dim(r.dir)}`);
for (const [name, enabled] of [['on', true], ['off', false]] as const) {
  capture.command(name).action(async () => {
    const cl = await client();
    const r = await cl.call<{ enabled: boolean; dir: string }>('capture.set', { enabled });
    cl.close();
    print(r, () => showCapture(r));
  });
}
capture.command('status').action(async () => {
  const cl = await client();
  const r = await cl.call<{ enabled: boolean; dir: string; captures: Array<{ file: string; bytes: number }> }>('capture.get');
  cl.close();
  print(r, () => {
    showCapture(r);
    for (const c of r.captures) console.log(`  ${c.file} ${dim(`${c.bytes} B`)}`);
  });
});

const runner = program.command('runner').description('Manage the local runner');
runner.command('start').action(async () => {
  const cl = await client(true);
  const s = await cl.call('runner.status');
  cl.close();
  print(s, () => console.log(green('runner running'), s));
});
runner.command('status').action(async () => {
  try {
    const cl = await client(false);
    const s = await cl.call('runner.status');
    cl.close();
    print(s, () => console.log(s));
  } catch {
    print({ running: false }, () => console.log(dim('runner not running')));
    process.exitCode = ExitCodes.runnerUnavailable;
  }
});
runner.command('stop').action(async () => {
  try {
    const cl = await client(false);
    await cl.call('runner.stop');
    cl.close();
    print({ stopping: true }, () => console.log('runner stopping (active runs are interrupted and checkpointed)'));
  } catch {
    print({ running: false }, () => console.log(dim('runner not running')));
  }
});

program.parseAsync().catch((e: unknown) => {
  if (e instanceof RunnerUnavailableError) {
    console.error(red(e.message));
    process.exit(ExitCodes.runnerUnavailable);
  }
  console.error(red(e instanceof RpcError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)));
  process.exit(ExitCodes.failed);
});
