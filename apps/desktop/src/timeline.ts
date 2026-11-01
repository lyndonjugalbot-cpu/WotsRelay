import type { EventEnvelope, EventPayload, RiskCategory, RunState } from '@wots/protocol';

export type TimelineItem =
  | { kind: 'user'; id: string; text: string; ts: string }
  | { kind: 'assistant'; id: string; connectionId: string | null; model: string | null; text: string; done: boolean; interrupted: boolean; ts: string }
  | { kind: 'handoff'; id: string; from: string; to: string; toModel: string; reason: string; simulated: boolean; ts: string }
  | { kind: 'tool'; id: string; name: string; preview: string; risk: RiskCategory; status: 'started' | 'completed' | 'failed' | 'unknown' | 'denied'; note: string | null; ts: string }
  | { kind: 'approval'; id: string; action: string; scope: string; risk: RiskCategory; version: number; status: 'pending' | 'approve' | 'reject' | 'expired'; ts: string }
  | { kind: 'state'; id: string; state: RunState; reason: string | null; ts: string }
  | { kind: 'notice'; id: string; level: 'warn' | 'error' | 'info'; text: string; ts: string };

export interface Timeline {
  items: TimelineItem[];
  lastSeq: number;
  state: RunState | null;
  activeRunId: string | null;
  activeConnection: string | null;
  activeModel: string | null;
  isMock: boolean;
  checkpoints: number;
  changedFiles: number;
}

export const emptyTimeline = (): Timeline => ({ items: [], lastSeq: 0, state: null, activeRunId: null, activeConnection: null, activeModel: null, isMock: false, checkpoints: 0, changedFiles: 0 });

const SHOWN_STATES = new Set<RunState>(['paused_limits', 'paused_auth', 'paused_uncertain', 'failed', 'cancelled']);

// Pure fold of durable events into what the conversation shows. Replays are idempotent by seq.
export function applyEvents(t: Timeline, events: EventEnvelope[]): Timeline {
  const fresh = events.filter((e) => e.seq > t.lastSeq).sort((a, b) => a.seq - b.seq);
  if (!fresh.length) return t;
  const next: Timeline = { ...t, items: [...t.items] };
  const index = new Map(next.items.map((it, i) => [`${it.kind}:${it.id}`, i]));
  const upsert = (it: TimelineItem) => {
    const k = `${it.kind}:${it.id}`;
    const i = index.get(k);
    if (i === undefined) {
      index.set(k, next.items.length);
      next.items.push(it);
    } else next.items[i] = it;
  };
  const get = <K extends TimelineItem['kind']>(kind: K, id: string) => {
    const i = index.get(`${kind}:${id}`);
    return i === undefined ? undefined : (next.items[i] as Extract<TimelineItem, { kind: K }>);
  };

  for (const e of fresh) {
    next.lastSeq = e.seq;
    switch (e.type) {
      case 'user.message': {
        const p = e.payload as EventPayload<'user.message'>;
        upsert({ kind: 'user', id: p.messageId, text: p.text, ts: e.ts });
        if (e.runId) next.activeRunId = e.runId;
        break;
      }
      case 'attempt.started': {
        const p = e.payload as EventPayload<'attempt.started'>;
        next.activeConnection = p.connectionId;
        next.activeModel = p.model;
        next.isMock = p.isMock;
        break;
      }
      case 'model.effective': {
        const p = e.payload as EventPayload<'model.effective'>;
        next.activeModel = p.effective;
        if (p.effective !== p.requested) upsert({ kind: 'notice', id: e.eventId, level: 'warn', text: `Served by ${p.effective} instead of ${p.requested}${p.note ? ` (${p.note})` : ''}.`, ts: e.ts });
        break;
      }
      case 'message.delta': {
        const p = e.payload as EventPayload<'message.delta'>;
        const cur = get('assistant', p.messageId);
        upsert({ kind: 'assistant', id: p.messageId, connectionId: p.connectionId, model: p.model, text: (cur?.text ?? '') + p.text, done: false, interrupted: false, ts: cur?.ts ?? e.ts });
        break;
      }
      case 'message.completed':
      case 'message.interrupted': {
        const p = e.payload as EventPayload<'message.completed'>;
        const cur = get('assistant', p.messageId);
        upsert({ kind: 'assistant', id: p.messageId, connectionId: p.connectionId, model: p.model, text: p.text, done: true, interrupted: e.type === 'message.interrupted', ts: cur?.ts ?? e.ts });
        break;
      }
      case 'provider.switched': {
        const p = e.payload as EventPayload<'provider.switched'>;
        upsert({ kind: 'handoff', id: e.eventId, from: p.from.connectionId, to: p.to.connectionId, toModel: p.to.modelId, reason: p.reason, simulated: p.simulated, ts: e.ts });
        break;
      }
      case 'tool.started': {
        const p = e.payload as EventPayload<'tool.started'>;
        upsert({ kind: 'tool', id: p.operationId, name: p.name, preview: p.argsPreview, risk: p.risk, status: 'started', note: null, ts: e.ts });
        break;
      }
      case 'tool.completed':
      case 'tool.failed':
      case 'tool.unknown':
      case 'tool.denied': {
        const p = e.payload as { operationId: string; message?: string };
        const cur = get('tool', p.operationId);
        if (cur) upsert({ ...cur, status: e.type.split('.')[1] as 'completed', note: p.message ?? null });
        break;
      }
      case 'approval.requested': {
        const p = e.payload as EventPayload<'approval.requested'>;
        upsert({ kind: 'approval', id: p.approvalId, action: p.action, scope: p.scope, risk: p.risk, version: p.version, status: 'pending', ts: e.ts });
        break;
      }
      case 'approval.resolved': {
        const p = e.payload as EventPayload<'approval.resolved'>;
        const cur = get('approval', p.approvalId);
        if (cur) upsert({ ...cur, status: p.decision, version: p.version });
        break;
      }
      case 'checkpoint.created': {
        const p = e.payload as EventPayload<'checkpoint.created'>;
        next.checkpoints++;
        next.changedFiles = p.changedFiles;
        break;
      }
      case 'run.stateChanged': {
        const p = e.payload as EventPayload<'run.stateChanged'>;
        next.state = p.to;
        if (e.runId) next.activeRunId = e.runId;
        if (SHOWN_STATES.has(p.to)) upsert({ kind: 'state', id: e.eventId, state: p.to, reason: p.reason, ts: e.ts });
        if (p.to !== 'awaiting_approval') for (const it of next.items) if (it.kind === 'approval' && it.status === 'pending' && ['completed', 'cancelled', 'failed'].includes(p.to)) upsert({ ...it, status: 'expired' });
        break;
      }
      case 'diagnostic': {
        const p = e.payload as EventPayload<'diagnostic'>;
        if (p.level !== 'info') upsert({ kind: 'notice', id: e.eventId, level: p.level, text: p.message, ts: e.ts });
        break;
      }
    }
  }
  return next;
}
