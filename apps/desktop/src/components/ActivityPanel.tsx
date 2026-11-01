import type { SessionView } from '../api.ts';
import type { Timeline } from '@wots/timeline';
import { modelLabel, routeLabel } from '../labels.ts';

export function ActivityPanel({ timeline, view, onClose }: { timeline: Timeline; view: SessionView | null; onClose: () => void; sessionId: string }) {
  const tools = timeline.items.filter((i) => i.kind === 'tool');
  const cp = view?.checkpoint ?? null;
  return (
    <aside className="activity" aria-label="Activity">
      <header className="activity-head">
        <h2>Activity</h2>
        <button className="icon-btn" aria-label="Close activity" onClick={onClose}>
          ×
        </button>
      </header>

      <section>
        <h3>Attempts</h3>
        {view?.attempts.length ? (
          <ol className="attempts">
            {view.attempts.map((a) => (
              <li key={a.id} className={`lane-${a.connectionId.includes('codex') ? 'b' : 'a'}`}>
                <span className="attempt-model">{modelLabel(a.effectiveModel ?? a.requestedModel)}</span>
                <span className="attempt-meta">
                  {routeLabel(a.connectionId)}, effort {a.effectiveEffort ?? a.requestedEffort}
                  {a.effectiveModel && a.effectiveModel !== a.requestedModel ? `, requested ${modelLabel(a.requestedModel)}` : ''}
                </span>
                <span className="attempt-end">{a.endedAt ? endText(a.termination) : 'Running'}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">No attempts yet.</p>
        )}
      </section>

      <section>
        <h3>Tools</h3>
        {tools.length ? (
          <ul className="activity-tools">
            {tools.map((t) =>
              t.kind === 'tool' ? (
                <li key={t.id} className={t.status}>
                  <span className={`tool-dot ${t.status}`} aria-hidden="true" />
                  <code>{t.preview}</code>
                </li>
              ) : null,
            )}
          </ul>
        ) : (
          <p className="muted">No tools used in this session.</p>
        )}
      </section>

      <section>
        <h3>Latest checkpoint</h3>
        {cp ? (
          <>
            <p className="muted">
              Saved {new Date(cp.createdAt).toLocaleTimeString()}, {cp.changedFiles.length} changed file{cp.changedFiles.length === 1 ? '' : 's'}.
            </p>
            {cp.changedFiles.length ? (
              <ul className="files">
                {cp.changedFiles.map((f) => (
                  <li key={f.path}>
                    <span className={`file-change ${f.change}`}>{f.change}</span> <code>{f.path}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {cp.diff ? (
              <details className="diff">
                <summary>Diff</summary>
                <pre>{cp.diff}</pre>
              </details>
            ) : null}
            {cp.unresolvedActions.length ? <p className="warn-text">{cp.unresolvedActions.length} action(s) with unknown outcome. They will not be repeated automatically.</p> : null}
          </>
        ) : (
          <p className="muted">Checkpoints are saved before any provider switch or pause.</p>
        )}
      </section>
    </aside>
  );
}

function endText(t: string | null): string {
  if (!t) return 'Ended';
  if (t === 'completed') return 'Completed';
  if (t.startsWith('failed:usage_limit')) return 'Usage limit';
  if (t.startsWith('failed:')) return t.slice(7).replace(/_/g, ' ');
  if (t === 'interrupted') return 'Stopped';
  return t.replace(/_/g, ' ');
}
