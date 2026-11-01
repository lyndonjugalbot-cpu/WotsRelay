import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { promoteRoute } from '@wots/core';
import { PAUSED_STATES, type FallbackConfig, type Project, type RouteRef, type RunState, type Session } from '@wots/protocol';
import { ensureRunner, RpcError, type RunnerClient } from '@wots/runner';
import { followRun, sendAndFollow, exitFor, type FollowOptions } from './follow.ts';
import { select, type Choice } from './select.ts';
import { amber, bold, cyan, dim, green, magenta, red } from './ui.ts';

type ModelRow = { connectionId: string; modelId: string; displayName: string };
type SessionView = { session: Session; attempts: Array<{ connectionId: string; requestedModel: string }> };
type UsageWindowView = { scope: string; percent: number; resetAt: string | null };
type UsageInfo = { switchAtPercent: number; connections: Record<string, UsageWindowView[]> };
const NOTE_AT_PERCENT = 80;


const HELP: Array<[string, string]> = [
  ['/model', 'choose the model (Claude or Codex); the other provider stays as fallback'],
  ['/new', 'start a new conversation (alias /clear)'],
  ['/resume', 'pick an earlier conversation in this folder'],
  ['/status', 'model, fallback, folder access and sign-in status'],
  ['/help', 'this list'],
  ['/exit', 'quit (or Ctrl-D, or Ctrl-C twice)'],
];

export async function interactive(opts: { prompt?: string; mock?: string }): Promise<void> {
  const cl = await ensureRunner({ start: true });
  const mode = opts.mock ? 'mock' : 'real';
  const root = realpathSync(process.cwd());
  const project = await chooseFolderAccess(cl, root);
  if (project === undefined) return void cl.close();
  const repl = new Repl(cl, project, mode, opts.mock);
  await repl.run(opts.prompt);
}

// Non-interactive `wots "prompt"` (stdin not a terminal): same folder rules, no questions.
export async function oneShot(text: string, opts: { mock?: string }): Promise<number> {
  const cl = await ensureRunner({ start: true });
  const root = realpathSync(process.cwd());
  const project = (await cl.call<Project[]>('projects.list')).find((p) => p.root === root && p.trusted) ?? null;
  const session = await cl.call<Session>('sessions.create', { projectId: project?.id ?? null, mode: opts.mock ? 'mock' : 'real', mockScenario: opts.mock });
  const state = await sendAndFollow(cl, session, text, { json: false, sigint: 'cli', resumeHints: true, showIds: false });
  cl.close();
  return exitFor(state);
}

// Like `claude`/`codex`: work happens in the current folder once it is trusted.
// Returns the project (edits allowed), null (chat only), or undefined (user cancelled).
async function chooseFolderAccess(cl: RunnerClient, root: string): Promise<Project | null | undefined> {
  const known = (await cl.call<Project[]>('projects.list')).find((p) => p.root === root);
  if (known?.trusted) return known;
  if (root === homedir() || root === '/') {
    process.stderr.write(dim(`Chat only in ${root === '/' ? 'the root folder' : 'your home folder'}. Run wots inside a project folder to let it read and edit files.\n`));
    return null;
  }
  const choice = await select(`Do you trust the files in this folder?\n  ${tilde(root)}\n  ${dim('Claude and Codex will be able to read and edit files and run commands here.')}`, [
    { label: 'Yes, trust this folder', value: 'trust' as const },
    { label: 'No, chat only (no file access)', value: 'chat' as const },
  ]);
  if (choice === null) return undefined;
  if (choice === 'chat') return null;
  const { project } = await cl.call<{ project: Project }>('projects.register', { root, trusted: true, permissionProfile: 'edit', crossProviderConsent: known?.crossProviderConsent ?? false });
  return project;
}

class Repl {
  private readonly cl: RunnerClient;
  private project: Project | null;
  private readonly mode: 'real' | 'mock';
  private readonly mock: string | undefined;
  private session: Session | null = null;
  private models: ModelRow[] = [];
  private readonly history: string[] = [];
  private lastEmptySigint = 0;
  private lastUsageNote = '';
  private declinedEarlySwitch = false;
  private readonly follow: FollowOptions & { showIds: boolean } = {
    json: false,
    sigint: 'repl',
    resumeHints: false,
    showIds: false,
    name: (connectionId, model) => (connectionId && model ? `${this.name({ connectionId, modelId: model })} ${dim(`· ${providerName(connectionId)}`)}` : 'assistant'),
  };

  constructor(cl: RunnerClient, project: Project | null, mode: 'real' | 'mock', mock: string | undefined) {
    this.cl = cl;
    this.project = project;
    this.mode = mode;
    this.mock = mock;
  }

  async run(initialPrompt?: string): Promise<void> {
    // Ctrl-C must never kill the REPL outright; followRun adds its own handler during a reply.
    process.on('SIGINT', () => {});
    await this.loadModels();
    await this.newSession();
    this.banner();
    if (initialPrompt) await this.send(initialPrompt);
    for (;;) {
      const line = await this.ask();
      if (line === null) break;
      const text = line.trim();
      if (!text) continue;
      if (text.startsWith('/')) {
        if ((await this.command(text)) === 'exit') break;
      } else await this.send(text);
    }
    this.cl.close();
    process.stderr.write(dim('bye\n'));
    process.exit(0);
  }

  // ---- input -------------------------------------------------------------------------------

  // A fresh readline per prompt leaves stdin free for the picker and approval questions.
  // readline updates the `history` array it is given in place, so ↑ recalls earlier prompts.
  private ask(): Promise<string | null> {
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout, history: this.history, historySize: 500, removeHistoryDuplicates: true, terminal: true });
      let settled = false;
      const finish = (v: string | null) => {
        if (settled) return;
        settled = true;
        rl.close();
        resolve(v);
      };
      rl.on('SIGINT', () => {
        if (rl.line) {
          rl.write(null, { ctrl: true, name: 'u' });
          return;
        }
        if (Date.now() - this.lastEmptySigint < 2000) {
          process.stdout.write('\n');
          return finish(null);
        }
        this.lastEmptySigint = Date.now();
        process.stdout.write(dim('\n(press Ctrl-C again to exit)'));
        rl.prompt();
      });
      rl.on('close', () => finish(null));
      rl.question(`\n${bold(magenta('❯'))} `, (answer) => {
        // Submitting anything disarms "press Ctrl-C again to exit".
        this.lastEmptySigint = 0;
        finish(answer);
      });
    });
  }

  // ---- slash commands ------------------------------------------------------------------------

  private async command(text: string): Promise<'exit' | void> {
    const [cmd, ...args] = text.split(/\s+/);
    switch (cmd) {
      case '/exit':
      case '/quit':
        return 'exit';
      case '/help':
      case '/?':
        for (const [c, d] of HELP) process.stderr.write(`  ${cyan(c.padEnd(9))} ${d}\n`);
        process.stderr.write(dim('  Ctrl-C stops a reply in progress.\n'));
        return;
      case '/model':
        return this.chooseModel(args[0]);
      case '/new':
      case '/clear':
        await this.newSession();
        process.stderr.write(dim('New conversation.\n'));
        return;
      case '/resume':
        return this.resumeSession();
      case '/status':
        return this.status();
      default:
        process.stderr.write(amber(`Unknown command ${cmd}. Type /help for the list.\n`));
    }
  }

  private async chooseModel(direct?: string): Promise<void> {
    await this.loadModels();
    const current = this.session!.fallback.routes[0]!;
    let route: RouteRef | null;
    if (direct) {
      const hit = this.models.find((m) => m.modelId === direct || m.displayName.toLowerCase() === direct.toLowerCase());
      if (!hit) {
        process.stderr.write(amber(`No model named ${direct}. Type /model to pick from the list.\n`));
        return;
      }
      route = { connectionId: hit.connectionId, modelId: hit.modelId };
    } else {
      if (!this.models.length) {
        process.stderr.write(amber('No models available yet. Check sign-in with /status.\n'));
        return;
      }
      const choices: Choice<RouteRef>[] = this.models.map((m) => ({
        label: m.displayName,
        hint: `${providerName(m.connectionId)}${m.connectionId === current.connectionId && m.modelId === current.modelId ? ' · current' : ''}`,
        value: { connectionId: m.connectionId, modelId: m.modelId },
      }));
      const at = choices.findIndex((c) => c.value.connectionId === current.connectionId && c.value.modelId === current.modelId);
      route = await select('Select a model', choices, Math.max(0, at));
    }
    if (!route) return;
    this.session = await this.cl.call<Session>('sessions.setRoute', { sessionId: this.session!.id, route });
    if (this.mode === 'real') {
      const saved = await this.cl.call<{ real: FallbackConfig }>('fallback.get');
      await this.cl.call('fallback.set', { ...saved.real, routes: promoteRoute(saved.real.routes, route) });
    }
    process.stderr.write(`${green('✓')} Using ${bold(this.name(route))}${this.fallbackNote()}${this.mode === 'real' ? dim(' · saved as your default') : ''}\n`);
  }

  private async resumeSession(): Promise<void> {
    const projectId = this.project?.id ?? null;
    const list = (await this.cl.call<Session[]>('sessions.list')).filter((s) => s.projectId === projectId && s.mode === this.mode && s.latestSeq > 0);
    if (!list.length) {
      process.stderr.write(dim('No earlier conversations in this folder.\n'));
      return;
    }
    const picked = await select(
      'Resume a conversation',
      list.slice(0, 20).map((s) => ({ label: s.title, hint: `${ago(s.updatedAt)}${PAUSED_STATES.has(s.state) ? ' · paused' : ''}`, value: s })),
    );
    if (!picked) return;
    this.session = picked;
    process.stderr.write(dim(`Resumed "${picked.title}". New messages continue this conversation.\n`));
    if (PAUSED_STATES.has(picked.state)) await this.afterRun(picked.state);
  }

  private async status(): Promise<void> {
    const conns = await this.cl.call<Array<{ connectionId: string; isMock: boolean; connection: { authStatus: string; toolVersion: string | null } | null }>>('connections.list', { refresh: false });
    const s = this.session!;
    process.stderr.write(`  ${bold('Model')}     ${this.name(s.fallback.routes[0]!)}${this.fallbackNote()}\n`);
    process.stderr.write(`  ${bold('Folder')}    ${this.project ? `${tilde(this.project.root)} ${green('(edits allowed)')}` : dim('chat only, no file access')}\n`);
    process.stderr.write(`  ${bold('Fallback')}  ${(await this.consent()) ? 'allowed' : dim('asks first')}\n`);
    const usage = await this.usage();
    for (const c of conns.filter((c) => c.isMock === (this.mode === 'mock'))) {
      const auth = c.connection?.authStatus ?? 'unknown';
      process.stderr.write(`  ${bold(providerName(c.connectionId).padEnd(9))} ${auth === 'authenticated' ? green('signed in') : amber(auth)} ${dim(c.connection?.toolVersion ?? '')}\n`);
      const windows = activeWindows(usage, c.connectionId);
      for (const w of windows) process.stderr.write(`            ${windowName(w.scope).padEnd(7)} ${bar(w.percent, usage.switchAtPercent)} ${String(w.percent).padStart(3)}%${w.resetAt ? dim(`  resets ${clock(w.resetAt)}`) : ''}\n`);
      if (!windows.length) process.stderr.write(dim('            usage not reported yet\n'));
    }
    process.stderr.write(dim(`  Switches to the fallback at ${usage.switchAtPercent}% of any usage window.\n`));
    process.stderr.write(dim(`  session ${s.id}\n`));
  }

  // ---- running -----------------------------------------------------------------------------

  private async send(text: string): Promise<void> {
    try {
      await this.confirmEarlySwitch();
      const state = await sendAndFollow(this.cl, this.session!, text, this.follow);
      await this.afterRun(state);
      this.session = (await this.cl.call<SessionView>('sessions.get', { sessionId: this.session!.id })).session;
      await this.usageNote();
    } catch (e) {
      this.reportError(e);
    }
  }

  // The runner moves a conversation off a nearly full provider only with consent to share it.
  // Ask now, with the reason, instead of letting the next reply run into the limit.
  private async confirmEarlySwitch(): Promise<void> {
    if (this.declinedEarlySwitch || !this.session!.latestSeq || (await this.consent())) return;
    const usage = await this.usage();
    const [preferred, ...rest] = this.session!.fallback.routes;
    const full = worstWindow(usage, preferred!.connectionId, usage.switchAtPercent);
    const next = rest.find((r) => r.connectionId !== preferred!.connectionId && !worstWindow(usage, r.connectionId, usage.switchAtPercent));
    if (!full || !next) return;
    process.stderr.write(amber(`${this.name(preferred!)} is at ${full.percent}% of its ${windowName(full.scope)} limit${full.resetAt ? ` (resets ${clock(full.resetAt)})` : ''}.\n`));
    if (!(await this.askConsent(next))) {
      this.declinedEarlySwitch = true;
      process.stderr.write(dim(`Staying on ${this.name(preferred!)} for this conversation.\n`));
    }
  }

  // A short heads-up once a window passes 80%, repeated only when the number changes.
  private async usageNote(): Promise<void> {
    const usage = await this.usage();
    const [preferred, ...rest] = this.session!.fallback.routes;
    const w = worstWindow(usage, preferred!.connectionId, NOTE_AT_PERCENT);
    if (!w) return;
    const fb = rest.find((r) => r.connectionId !== preferred!.connectionId);
    const resets = w.resetAt ? ` (resets ${clock(w.resetAt)})` : '';
    const note =
      w.percent >= usage.switchAtPercent
        ? `${this.name(preferred!)}: ${w.percent}% of the ${windowName(w.scope)} limit used${resets}.${fb ? ((await this.consent()) || !this.session!.latestSeq ? ` New messages go to ${this.name(fb)} until it resets.` : ` Your next message asks before moving to ${this.name(fb)}.`) : ''}`
        : `${this.name(preferred!)}: ${w.percent}% of the ${windowName(w.scope)} limit used${resets}.${fb ? ` Switches to ${this.name(fb)} at ${usage.switchAtPercent}%.` : ''}`;
    if (note === this.lastUsageNote) return;
    this.lastUsageNote = note;
    process.stderr.write(`${w.percent >= usage.switchAtPercent ? amber('◔') : dim('◔')} ${dim(note)}\n`);
  }

  private usage(): Promise<UsageInfo> {
    return this.cl.call<UsageInfo>('usage.get');
  }

  // A pause becomes a question instead of a command to copy.
  private async afterRun(state: RunState): Promise<void> {
    if (!PAUSED_STATES.has(state)) return;
    const view = await this.cl.call<SessionView>('sessions.get', { sessionId: this.session!.id });
    this.session = view.session;
    const last = view.attempts.at(-1);
    const current = last ? { connectionId: last.connectionId, modelId: last.requestedModel } : view.session.fallback.routes[0]!;
    const next = view.session.fallback.routes.find((r) => r.connectionId !== current.connectionId);
    if (state === 'paused_auth') process.stderr.write(amber(`Sign in again in another terminal (${current.connectionId.startsWith('claude') ? 'claude auth login' : 'codex login'}), then choose Retry.\n`));
    const choices: Choice<'next' | 'retry' | 'leave'>[] = [
      ...(next && state !== 'paused_auth' ? [{ label: `Continue with ${this.name(next)}`, hint: 'picks up from the saved checkpoint', value: 'next' as const }] : []),
      { label: `Retry with ${this.name(current)}`, value: 'retry' },
      { label: 'Leave it paused', hint: 'type a new message or /resume later', value: 'leave' },
    ];
    const pick = await select('The reply is paused. What next?', choices);
    if (!pick || pick === 'leave') return;
    if (pick === 'next' && !(await this.consent()) && !(await this.askConsent(next!))) return;
    try {
      const before = view.session.latestSeq;
      const { runId } = await this.cl.call<{ runId: string }>('runs.resume', { sessionId: view.session.id, fallback: pick === 'next' });
      await this.afterRun(await followRun(this.cl, view.session.id, runId, before, this.follow));
    } catch (e) {
      this.reportError(e);
    }
  }

  private async consent(): Promise<boolean> {
    if (this.project) return this.project.crossProviderConsent;
    return (await this.cl.call<{ chatConsent: boolean }>('fallback.get')).chatConsent;
  }

  // Asked at the moment it matters, naming exactly what will be shared and with whom.
  private async askConsent(next: RouteRef): Promise<boolean> {
    const what = this.project ? `this conversation and the changes in ${tilde(this.project.root)}` : 'this conversation';
    const ok = await select(`Send ${what} to ${this.name(next)} (${providerName(next.connectionId)}) to continue?`, [
      { label: this.project ? 'Yes, and allow it for this folder from now on' : 'Yes, and allow it for chats from now on', value: true },
      { label: 'No', value: false },
    ]);
    if (!ok) return false;
    if (this.project) {
      const { project } = await this.cl.call<{ project: Project }>('projects.register', { root: this.project.root, trusted: true, permissionProfile: this.project.permissionProfile, crossProviderConsent: true });
      this.project = project;
    } else await this.cl.call('settings.setChatConsent', { consent: true });
    return true;
  }

  // ---- helpers -----------------------------------------------------------------------------

  private async newSession(): Promise<void> {
    this.session = await this.cl.call<Session>('sessions.create', { projectId: this.project?.id ?? null, mode: this.mode, mockScenario: this.mock });
  }

  private async loadModels(): Promise<void> {
    const order = this.mode === 'mock' ? ['mock-claude', 'mock-codex'] : ['claude-code', 'codex'];
    let catalog = await this.cl.call<Record<string, Array<{ modelId: string; displayName: string }>>>('models.list');
    // Catalogs fill in after the runner's first provider check; ask for one if ours are missing.
    if (order.some((c) => !catalog[c]?.length)) {
      await this.cl.call('connections.list', { refresh: true });
      catalog = await this.cl.call('models.list');
    }
    this.models = order.flatMap((connectionId) => (catalog[connectionId] ?? []).map((m) => ({ connectionId, modelId: m.modelId, displayName: m.displayName })));
  }

  private banner(): void {
    const s = this.session!;
    const where = this.project ? `${tilde(this.project.root)}  ${green('edits allowed')}` : dim('chat only, no file access');
    process.stderr.write(`\n${bold(magenta('✻ WotsRelay'))}  ${this.name(s.fallback.routes[0]!)}${this.fallbackNote()}${this.mode === 'mock' ? amber('  [MOCK]') : ''}\n`);
    process.stderr.write(`  ${where}\n`);
    process.stderr.write(dim('  /model to switch models · /help for commands · Ctrl-C stops a reply\n'));
  }

  private fallbackNote(): string {
    const [first, ...rest] = this.session!.fallback.routes;
    const fb = rest.find((r) => r.connectionId !== first!.connectionId);
    return fb ? dim(`  → fallback ${this.name(fb)}`) : '';
  }

  private name(r: RouteRef): string {
    return this.models.find((m) => m.connectionId === r.connectionId && m.modelId === r.modelId)?.displayName ?? r.modelId;
  }

  private reportError(e: unknown): void {
    process.stderr.write(red(`${e instanceof RpcError ? e.message : e instanceof Error ? e.message : String(e)}\n`));
  }
}

function providerName(connectionId: string): string {
  if (connectionId.includes('claude')) return connectionId.startsWith('mock') ? 'Claude (mock)' : 'Claude';
  return connectionId.startsWith('mock') ? 'Codex (mock)' : 'Codex';
}

function activeWindows(u: UsageInfo, connectionId: string): UsageWindowView[] {
  return (u.connections[connectionId] ?? []).filter((w) => !w.resetAt || Date.parse(w.resetAt) > Date.now());
}

function worstWindow(u: UsageInfo, connectionId: string, atLeast: number): UsageWindowView | null {
  return activeWindows(u, connectionId)
    .filter((w) => w.percent >= atLeast)
    .sort((a, b) => b.percent - a.percent)[0] ?? null;
}

function windowName(scope: string): string {
  return ({ five_hour: '5-hour', seven_day: 'weekly' } as Record<string, string>)[scope] ?? scope;
}

function bar(percent: number, switchAt: number): string {
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  const s = `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  return percent >= switchAt ? red(s) : percent >= NOTE_AT_PERCENT ? amber(s) : green(s);
}

function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function tilde(path: string): string {
  return path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path;
}

function ago(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
