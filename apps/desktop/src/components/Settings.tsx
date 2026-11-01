import { useEffect, useRef, useState } from 'react';
import type { Project } from '@wots/protocol';
import { api, type ConnectionRow } from '../api.ts';
import { modelLabel, relativeTime, routeLabel } from '../labels.ts';

type Theme = 'system' | 'light' | 'dark';

export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export function savedTheme(): Theme {
  try {
    return (localStorage.getItem('wots.theme') as Theme | null) ?? 'system';
  } catch {
    return 'system';
  }
}

const DEMOS: Array<[string, string]> = [
  ['quota-after-edit', 'Claude edits a file, hits its limit, Astra finishes'],
  ['quota-before-answer', 'Claude hits its limit before answering'],
  ['both-limited', 'Both providers are limited'],
  ['uncertain-action', 'A command’s outcome is unknown'],
  ['approval', 'An action needs your approval'],
];

export function Settings({ projects, onClose, onDemo }: { projects: Project[]; onClose: () => void; onDemo: (scenario: string, projectId: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [conns, setConns] = useState<ConnectionRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [fallback, setFallback] = useState<Awaited<ReturnType<typeof api.fallback>> | null>(null);
  const [theme, setTheme] = useState<Theme>(savedTheme());
  const [demoProject, setDemoProject] = useState<string>('');

  useEffect(() => {
    ref.current?.showModal();
    void api.connections(false).then(setConns);
    void api.fallback().then(setFallback);
  }, []);

  const check = async () => {
    setChecking(true);
    try {
      setConns(await api.connections(true));
    } finally {
      setChecking(false);
    }
  };

  const real = conns?.filter((c) => !c.isMock) ?? [];

  return (
    <dialog ref={ref} className="sheet settings" onCancel={onClose} aria-labelledby="settings-title">
      <header className="sheet-head">
        <h2 id="settings-title">Settings</h2>
        <button className="icon-btn" aria-label="Close settings" onClick={onClose}>
          ×
        </button>
      </header>

      <section>
        <div className="section-head">
          <h3>Connections</h3>
          <button className="btn small" onClick={() => void check()} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
        <p className="muted">Sign-in happens in the official tools. WotsRelay never sees your passwords or tokens.</p>
        {real.map((c) => (
          <div key={c.connectionId} className="conn">
            <div className="conn-row">
              <span className={`conn-dot ${c.connection?.authStatus === 'authenticated' ? 'ok' : 'warn'}`} aria-hidden="true" />
              <strong>{routeLabel(c.connectionId)}</strong>
              <span className="muted">{c.connection ? `${c.connection.authStatus}, billing ${c.connection.billingMode}, version ${c.connection.toolVersion ?? 'unknown'}` : 'Not checked yet'}</span>
              {c.connection ? <span className="muted small">checked {relativeTime(c.connection.lastChecked)}</span> : null}
            </div>
            {c.connection?.limitations.length ? (
              <ul className="limits">
                {c.connection.limitations.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : null}
            {c.connection && c.connection.authStatus !== 'authenticated' ? <p className="hint">Sign in from Terminal: {c.connectionId === 'codex' ? 'codex login' : 'claude auth login'}</p> : null}
          </div>
        ))}
      </section>

      <section>
        <h3>Fallback order</h3>
        {fallback ? (
          <>
            <ol className="order">
              {fallback.real.routes.map((r, i) => (
                <li key={`${r.connectionId}:${r.modelId}`} className={i === 0 ? 'lane-a' : 'lane-b'}>
                  {modelLabel(r.modelId)} <span className="muted">via {routeLabel(r.connectionId)}</span>
                </li>
              ))}
            </ol>
            <p className="muted">
              Switches only on a confirmed usage limit. Effort {fallback.real.effort}, standard speed. API billing and paid fallbacks stay off. Change the order with <code>wots fallback set</code>.
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={fallback.chatConsent}
                onChange={(e) => {
                  const v = e.target.checked;
                  void api.setChatConsent(v).then(() => setFallback({ ...fallback, chatConsent: v }));
                }}
              />
              <span>Allow chats to continue on the fallback provider (sends that chat’s context to it)</span>
            </label>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>

      <section>
        <h3>Appearance</h3>
        <div className="segmented" role="radiogroup" aria-label="Theme">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              role="radio"
              aria-checked={theme === t}
              className={theme === t ? 'on' : ''}
              onClick={() => {
                setTheme(t);
                applyTheme(t);
                try {
                  localStorage.setItem('wots.theme', t);
                } catch {
                  /* preference is optional */
                }
              }}
            >
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3>Practice runs</h3>
        <p className="muted">Try the handoff with simulated providers. Nothing is sent to Claude or OpenAI, and these sessions are labelled simulated.</p>
        <label className="field">
          <span>Project for coding demos</span>
          <select value={demoProject} onChange={(e) => setDemoProject(e.target.value)}>
            <option value="">None (chat)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="demo-list">
          {DEMOS.map(([id, text]) => (
            <button key={id} className="btn demo" onClick={() => onDemo(id, demoProject || null)}>
              {text}
            </button>
          ))}
        </div>
      </section>
    </dialog>
  );
}
