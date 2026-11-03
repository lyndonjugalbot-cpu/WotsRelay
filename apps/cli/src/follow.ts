import { randomUUID } from 'node:crypto';
import { ExitCodes, PAUSED_STATES, TERMINAL_STATES, type EventEnvelope, type EventPayload, type RunState, type Session } from '@wots/protocol';
import { describeRisk } from '@wots/core';
import type { ApprovalDecision } from '@wots/protocol';
import type { RunnerClient } from '@wots/runner';
import { select } from './select.ts';
import { amber, bold, cyan, dim, green, red } from './ui.ts';

export interface FollowOptions {
  json: boolean;
  // 'cli': first Ctrl-C stops the run, second exits. 'repl': Ctrl-C only ever stops the run.
  sigint: 'cli' | 'repl';
  // Print the `wots resume …` hint on pause (the interactive mode offers a menu instead).
  resumeHints: boolean;
  // Display name for a speaker; defaults to `connection · model`.
  name?: (connectionId: string | null, model: string | null) => string;
}


export async function followRun(cl: RunnerClient, sessionId: string, runId: string, after: number, opts: FollowOptions): Promise<RunState> {
  const json = opts.json;
  const label = (p: { connectionId: string | null; model: string | null }) => opts.name?.(p.connectionId, p.model) ?? `${p.connectionId ?? 'assistant'} · ${p.model ?? '?'}`;
  let lastSeq = after;
  let speaker: string | null = null;
  let finalState: RunState | null = null;
  let resolveDone: (s: RunState) => void = () => {};
  const done = new Promise<RunState>((r) => (resolveDone = r));

  const handle = async (e: EventEnvelope) => {
    if (e.seq <= lastSeq) return; // dedupe replay/live overlap
    lastSeq = e.seq;
    if (e.runId !== runId && e.type !== 'user.message') return;
    if (json) {
      process.stdout.write(`${JSON.stringify(e)}\n`);
    }
    switch (e.type) {
      case 'attempt.started': {
        const p = e.payload as EventPayload<'attempt.started'>;
        if (!json) process.stderr.write(dim(`\n▸ ${label(p)}${p.isMock ? amber(' [MOCK]') : ''}\n`));
        break;
      }
      case 'message.delta': {
        const p = e.payload as EventPayload<'message.delta'>;
        if (json) break;
        const who = label(p);
        if (speaker !== who) {
          process.stdout.write(`\n${cyan(bold(who))}\n`);
          speaker = who;
        }
        process.stdout.write(p.text);
        break;
      }
      case 'message.completed':
        if (!json) process.stdout.write('\n');
        speaker = null;
        break;
      case 'message.interrupted':
        if (!json) process.stdout.write(amber('\n[interrupted]\n'));
        speaker = null;
        break;
      case 'tool.started': {
        const p = e.payload as EventPayload<'tool.started'>;
        if (!json) process.stderr.write(dim(`  ⚙ ${p.name} ${p.argsPreview} (${p.risk})\n`));
        break;
      }
      case 'tool.denied':
      case 'tool.unknown':
      case 'tool.failed':
        if (!json) process.stderr.write(amber(`  ! ${e.type.split('.')[1]}: ${(e.payload as { message: string }).message}\n`));
        break;
      case 'model.effective': {
        const p = e.payload as EventPayload<'model.effective'>;
        if (!json && p.effective !== p.requested) process.stderr.write(amber(`  ! effective model ${p.effective} (requested ${p.requested})${p.note ? ` — ${p.note}` : ''}\n`));
        break;
      }
      case 'provider.switched': {
        const p = e.payload as EventPayload<'provider.switched'>;
        if (!json) process.stderr.write(bold(amber(`\n⇄ ${p.reason}. Continuing with ${p.to.modelId} on ${p.to.connectionId}${p.simulated ? ' (simulated limit)' : ''}.\n`)));
        break;
      }
      case 'approval.requested': {
        const p = e.payload as EventPayload<'approval.requested'>;
        if (json) break;
        const riskText = p.risk === 'external-side-effect' ? red(describeRisk(p.risk)) : p.risk === 'read-only' ? green(describeRisk(p.risk)) : amber(describeRisk(p.risk));
        process.stderr.write(`\n${bold('? Approval needed')}  ${riskText}\n  ${p.action}\n  ${dim(`in ${p.scope}`)}\n`);
        if (process.stdin.isTTY) {
          const decision =
            (await select<ApprovalDecision>('Allow this?', [
              { label: 'Approve once', value: 'approve' },
              ...(p.canApproveForSession ? [{ label: 'Approve for this session', hint: 'similar requests run without asking until the session ends', value: 'approve_session' as const }] : []),
              { label: 'Reject', hint: 'Esc also rejects', value: 'reject' },
            ])) ?? 'reject';
          const res = await cl.call<{ applied: boolean; status: string }>('approvals.decide', { approvalId: p.approvalId, decision, expectedVersion: p.version, deviceId: 'cli' });
          if (!res.applied) process.stderr.write(dim(`  (already ${res.status} elsewhere)\n`));
        } else process.stderr.write(`  Decide with: wots approve ${p.approvalId} --version ${p.version}  (or wots reject …)\n`);
        break;
      }
      case 'run.stateChanged': {
        const p = e.payload as EventPayload<'run.stateChanged'>;
        if (TERMINAL_STATES.has(p.to) || PAUSED_STATES.has(p.to)) {
          finalState = p.to;
          if (!json) {
            const msg = p.to === 'completed' ? green('✓ completed') : p.to === 'cancelled' ? amber('■ cancelled') : PAUSED_STATES.has(p.to) ? amber(`❚❚ ${p.to.replace('_', ' ')}`) : red('✗ failed');
            process.stderr.write(`\n${msg}${p.reason ? dim(` — ${p.reason}`) : ''}\n`);
            if (PAUSED_STATES.has(p.to) && opts.resumeHints) process.stderr.write(dim(`  Resume: wots resume ${sessionId}   ·   Continue on next provider: wots resume ${sessionId} --fallback\n`));
          }
          resolveDone(p.to);
        }
        break;
      }
      case 'diagnostic': {
        const p = e.payload as EventPayload<'diagnostic'>;
        if (!json && p.level !== 'info') process.stderr.write(dim(`  ${p.level}: ${p.message}\n`));
        break;
      }
    }
  };

  let queue = Promise.resolve();
  const unsubscribe = cl.onEvent((e) => {
    if (e.sessionId === sessionId) queue = queue.then(() => handle(e));
  });
  cl.onClose(() => resolveDone(finalState ?? ('paused_uncertain' as RunState)));
  const { replay } = await cl.call<{ replay: EventEnvelope[] }>('events.subscribe', { sessionId, after });
  for (const e of replay) queue = queue.then(() => handle(e));

  let sigints = 0;
  const onSigint = () => {
    sigints++;
    if (opts.sigint === 'cli' && sigints > 1) process.exit(ExitCodes.cancelled);
    if (sigints === 1) process.stderr.write(amber(opts.sigint === 'cli' ? '\nStopping run… (Ctrl-C again to detach; the run is then stopped by the runner)\n' : '\nStopping…\n'));
    void cl.call('runs.interrupt', { runId });
  };
  process.on('SIGINT', onSigint);

  try {
    const state = await done;
    await queue;
    return state;
  } finally {
    process.off('SIGINT', onSigint);
    unsubscribe();
    await cl.call('events.unsubscribe', { sessionId }).catch(() => {});
  }
}

export function exitFor(state: RunState): number {
  if (state === 'completed') return ExitCodes.completed;
  if (state === 'cancelled') return ExitCodes.cancelled;
  if (PAUSED_STATES.has(state)) return ExitCodes.paused;
  return ExitCodes.failed;
}

export async function sendAndFollow(cl: RunnerClient, session: Session, text: string, opts: FollowOptions & { showIds: boolean }): Promise<RunState> {
  const before = (await cl.call<{ session: Session }>('sessions.get', { sessionId: session.id })).session.latestSeq;
  const { runId } = await cl.call<{ runId: string }>('messages.send', { sessionId: session.id, text, idempotencyKey: randomUUID() });
  if (!opts.json && opts.showIds) process.stderr.write(dim(`session ${session.id} · run ${runId}\n`));
  return followRun(cl, session.id, runId, before, opts);
}
