import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@wots/protocol';
import type { SessionView } from '../api.ts';
import type { Timeline, TimelineItem } from '@wots/timeline';
import { renderMarkdown } from '../markdown.ts';
import { STATE_TEXT, isMockRoute, lane, modelLabel, routeLabel } from '../labels.ts';

interface Props {
  timeline: Timeline;
  session: Session;
  view: SessionView | null;
  onResume: (fallback: boolean, note?: string) => void;
  onDecide: (approvalId: string, decision: 'approve' | 'reject', version: number) => void;
}

export function Conversation({ timeline, session, view, onResume, onDecide }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  const lastStateId = useMemo(() => [...timeline.items].reverse().find((i) => i.kind === 'state')?.id ?? null, [timeline.items]);
  const nextRoute = session.fallback.routes[1];

  return (
    <div
      className="conversation"
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      <div className="column" role="log" aria-live="polite" aria-relevant="additions">
        {timeline.items.length === 0 ? <EmptySession session={session} /> : null}
        {timeline.items.map((item) => (
          <Item key={`${item.kind}:${item.id}`} item={item} live={item.id === lastStateId && session.state === (item.kind === 'state' ? item.state : null)} nextRoute={nextRoute ? `${modelLabel(nextRoute.modelId)}` : null} onResume={onResume} onDecide={onDecide} pendingIds={view?.pendingApprovals.map((p) => p.id) ?? []} />
        ))}
        {timeline.state === 'switching' || timeline.state === 'checkpointing' ? <p className="inline-status">{STATE_TEXT[timeline.state]}…</p> : null}
      </div>
    </div>
  );
}

function EmptySession({ session }: { session: Session }) {
  const [a, b] = session.fallback.routes;
  return (
    <div className="empty-session">
      <p>
        {session.projectId ? 'Describe the change you want in this project.' : 'Ask anything. Chats have no access to your files or shell.'}
      </p>
      <p className="route-line">
        <span className="lane-chip a">{modelLabel(a?.modelId ?? null)}</span>
        <span aria-hidden="true">then</span>
        <span className="lane-chip b">{modelLabel(b?.modelId ?? null)}</span>
        {session.mode === 'mock' ? <span className="mock-tag">Simulated providers</span> : null}
      </p>
    </div>
  );
}

function Item({ item, live, nextRoute, onResume, onDecide, pendingIds }: { item: TimelineItem; live: boolean; nextRoute: string | null; onResume: Props['onResume']; onDecide: Props['onDecide']; pendingIds: string[] }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="msg user">
          <div className="bubble">{item.text}</div>
        </div>
      );
    case 'assistant':
      return <AssistantMessage item={item} />;
    case 'handoff':
      return (
        <div className={`exchange lane-${lane(item.from)}-to-${lane(item.to)}`} role="note">
          <span className="exchange-from" aria-hidden="true" />
          <p>
            <strong>{routeLabel(item.from)} stopped.</strong> {friendlyReason(item.reason)} Continuing with {modelLabel(item.toModel)}
            {item.simulated ? ' (simulated limit)' : ''}.
          </p>
          <span className="exchange-to" aria-hidden="true" />
        </div>
      );
    case 'tool':
      return <ToolCard item={item} />;
    case 'approval': {
      const pending = item.status === 'pending' && pendingIds.includes(item.id);
      return (
        <div className={`approval ${item.status}`} role="group" aria-label="Approval request">
          <p className="approval-action">{item.action}</p>
          <p className="approval-meta">
            Risk: {riskText(item.risk)}. Scope: <span className="path">{item.scope}</span>
          </p>
          {pending ? (
            <div className="approval-buttons">
              <button className="btn primary" onClick={() => onDecide(item.id, 'approve', item.version)}>
                Approve
              </button>
              <button className="btn" onClick={() => onDecide(item.id, 'reject', item.version)}>
                Reject
              </button>
            </div>
          ) : (
            <p className="approval-result">{item.status === 'approve' ? 'Approved' : item.status === 'reject' ? 'Rejected' : item.status === 'expired' ? 'No longer needed' : 'Waiting…'}</p>
          )}
        </div>
      );
    }
    case 'state':
      return <StateNotice item={item} live={live} nextRoute={nextRoute} onResume={onResume} />;
    case 'notice':
      return <p className={`notice ${item.level}`}>{item.text}</p>;
  }
}

function friendlyReason(reason: string): string {
  if (/usage limit/i.test(reason)) return 'It reached its usage limit.';
  return reason.endsWith('.') ? reason : `${reason}.`;
}

function riskText(r: string): string {
  return r === 'read-only' ? 'reads only' : r === 'reversible-local-write' ? 'changes files in this project' : r === 'external-side-effect' ? 'affects something outside this Mac' : 'not classified, review carefully';
}

function AssistantMessage({ item }: { item: Extract<TimelineItem, { kind: 'assistant' }> }) {
  const html = useMemo(() => renderMarkdown(item.text), [item.text]);
  const [copied, setCopied] = useState(false);
  return (
    <article className={`msg assistant lane-${lane(item.connectionId)}`} aria-label={`${modelLabel(item.model)} reply`}>
      <header className="msg-head">
        <span className="msg-model">{modelLabel(item.model)}</span>
        <span className="msg-route">via {routeLabel(item.connectionId)}</span>
        {isMockRoute(item.connectionId) ? <span className="mock-tag">Simulated</span> : null}
        {item.interrupted ? <span className="interrupted-tag">Interrupted</span> : null}
        <time className="msg-time" dateTime={item.ts} title={new Date(item.ts).toLocaleString()}>
          {new Date(item.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </time>
        <button
          className="icon-btn small copy"
          aria-label="Copy reply"
          onClick={() => {
            void navigator.clipboard.writeText(item.text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </header>
      <div className={`prose ${item.done ? '' : 'streaming'}`} dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}

function ToolCard({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const statusText = { started: 'Running', completed: 'Done', failed: 'Failed', unknown: 'Outcome unknown', denied: 'Not allowed' }[item.status];
  return (
    <div className={`tool ${item.status}`}>
      <button className="tool-row" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`tool-dot ${item.status}`} aria-hidden="true" />
        <span className="tool-name">{item.name}</span>
        <code className="tool-preview">{item.preview}</code>
        <span className="tool-status">{statusText}</span>
      </button>
      {open ? (
        <div className="tool-detail">
          <p>Risk: {riskText(item.risk)}.</p>
          {item.note ? <p>{item.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function StateNotice({ item, live, nextRoute, onResume }: { item: Extract<TimelineItem, { kind: 'state' }>; live: boolean; nextRoute: string | null; onResume: Props['onResume'] }) {
  const [note, setNote] = useState('');
  const paused = item.state.startsWith('paused');
  return (
    <div className={`state-notice ${item.state}`} role="status">
      <p className="state-title">{STATE_TEXT[item.state]}</p>
      {item.reason ? <p className="state-reason">{item.reason}</p> : null}
      {paused && live ? (
        <div className="state-actions">
          {item.state === 'paused_uncertain' ? (
            <label className="note-field">
              <span>Tell the agent what happened (optional)</span>
              <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: the migration finished successfully." />
            </label>
          ) : null}
          {item.state === 'paused_auth' ? <p className="hint">Sign in again in Terminal with the provider’s own tool, then resume.</p> : null}
          <div className="state-buttons">
            <button className="btn primary" onClick={() => onResume(false, note || undefined)}>
              Resume
            </button>
            {item.state !== 'paused_auth' && nextRoute ? (
              <button className="btn" onClick={() => onResume(true, note || undefined)}>
                Continue with {nextRoute}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
