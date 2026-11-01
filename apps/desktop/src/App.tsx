import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventEnvelope, Project, Session } from '@wots/protocol';
import { api, bridge, type SessionView } from './api.ts';
import { applyEvents, emptyTimeline, type Timeline } from '@wots/timeline';
import { RelayCore } from './components/RelayCore.tsx';
import { Conversation } from './components/Conversation.tsx';
import { Composer } from './components/Composer.tsx';
import { ActivityPanel } from './components/ActivityPanel.tsx';
import { Settings } from './components/Settings.tsx';
import { TrustDialog } from './components/TrustDialog.tsx';
import { STATE_TEXT, lane, modelLabel, relativeTime, routeLabel } from './labels.ts';

const LIVE = new Set(['preparing', 'running', 'checkpointing', 'switching', 'awaiting_approval']);

export function App() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [runnerError, setRunnerError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<Timeline>(emptyTimeline());
  const [view, setView] = useState<SessionView | null>(null);
  const [query, setQuery] = useState('');
  const [showActivity, setShowActivity] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [trustPath, setTrustPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const refreshLists = useCallback(async () => {
    const [s, p] = await Promise.all([api.sessions(), api.projects()]);
    setSessions(s);
    setProjects(p);
  }, []);

  const refreshView = useCallback(async (id: string) => {
    try {
      setView(await api.session(id));
    } catch {
      /* session may have been removed */
    }
  }, []);

  // Runner connection + live events.
  useEffect(() => {
    const offRunner = bridge().onRunner((s) => {
      setOnline(s.online);
      setRunnerError(s.error ?? null);
      if (s.online) void refreshLists();
    });
    const offEvent = bridge().onEvent((e: EventEnvelope) => {
      if (e.sessionId === selectedRef.current) {
        setTimeline((t) => applyEvents(t, [e]));
        if (e.type === 'run.stateChanged' || e.type === 'attempt.started' || e.type === 'approval.requested' || e.type === 'checkpoint.created') void refreshView(e.sessionId);
      }
      if (e.type === 'run.stateChanged' || e.type === 'user.message') void refreshLists();
    });
    api
      .sessions()
      .then((s) => {
        setOnline(true);
        setSessions(s);
        // Reopen the most recent session.
        if (s[0]) setSelected((cur) => cur ?? s[0]!.id);
        return api.projects().then(setProjects);
      })
      .catch((e: Error) => {
        setOnline(false);
        setRunnerError(e.message);
      });
    return () => {
      offRunner();
      offEvent();
    };
  }, [refreshLists, refreshView]);

  // Switch session: replay durable events from the start, then follow live.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setTimeline(emptyTimeline());
    setView(null);
    void api.subscribe(selected, 0).then(({ replay }) => {
      if (!cancelled) setTimeline((t) => applyEvents(t, replay));
    });
    void refreshView(selected);
    return () => {
      cancelled = true;
      void api.unsubscribe(selected).catch(() => {});
    };
  }, [selected, refreshView]);

  const newChat = useCallback(async () => {
    setError(null);
    try {
      const s = await api.createSession(null, 'real');
      await refreshLists();
      setSelected(s.id);
      setTimeout(() => composerRef.current?.focus(), 50);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [refreshLists]);

  const newCodingTask = useCallback(async () => {
    const path = await bridge().pickProject();
    if (path) setTrustPath(path);
  }, []);

  const startProject = useCallback(
    async (root: string, consent: boolean) => {
      setTrustPath(null);
      try {
        const { project } = await api.registerProject(root, consent);
        const s = await api.createSession(project.id, 'real');
        await refreshLists();
        setSelected(s.id);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshLists],
  );

  const startDemo = useCallback(
    async (scenario: string, projectId: string | null) => {
      setShowSettings(false);
      try {
        const s = await api.createSession(projectId, 'mock', scenario);
        await refreshLists();
        setSelected(s.id);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [refreshLists],
  );

  const send = useCallback(
    async (text: string) => {
      if (!selected) return;
      setError(null);
      try {
        await api.send(selected, text);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [selected],
  );

  const stop = useCallback(() => {
    const runId = timeline.activeRunId;
    if (runId && timeline.state && LIVE.has(timeline.state)) void api.interrupt(runId);
  }, [timeline.activeRunId, timeline.state]);

  // Keyboard shortcuts: ⌘N new chat, ⌘K search, ⌘L composer, ⌘. stop.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        void newChat();
      } else if (e.key === 'k') {
        e.preventDefault();
        setSidebarOpen(true);
        setTimeout(() => searchRef.current?.focus(), 0);
      } else if (e.key === 'l') {
        e.preventDefault();
        composerRef.current?.focus();
      } else if (e.key === '.') {
        e.preventDefault();
        stop();
      } else if (e.key === ',') {
        e.preventDefault();
        setShowSettings(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newChat, stop]);

  const session = sessions.find((s) => s.id === selected) ?? view?.session ?? null;
  const project = session?.projectId ? (projects.find((p) => p.id === session.projectId) ?? null) : null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((s) => s.title.toLowerCase().includes(q) || s.objective.toLowerCase().includes(q)) : sessions;
  }, [sessions, query]);

  const live = !!timeline.state && LIVE.has(timeline.state);
  const lastHandoff = [...timeline.items].reverse().find((i) => i.kind === 'handoff');
  const activeLane = timeline.activeConnection ? (lane(timeline.activeConnection) === 'a' ? 'A' : 'B') : null;
  const statusTitle = !session ? 'No session open' : timeline.state ? (STATE_TEXT[timeline.state] ?? timeline.state) : 'Ready';
  const statusModel = session && timeline.activeConnection ? `${modelLabel(timeline.activeModel)} via ${routeLabel(timeline.activeConnection)}` : null;

  return (
    <div className={`shell ${sidebarOpen ? '' : 'sidebar-closed'} ${showActivity ? 'with-activity' : ''}`}>
      <aside className="sidebar" aria-label="Sessions">
        <div className="drag-region" />
        <div className="core-block">
          <RelayCore active={activeLane} running={live} handoffKey={lastHandoff?.id ?? null} handoffTo={lastHandoff && lastHandoff.kind === 'handoff' ? (lane(lastHandoff.to) === 'a' ? 'A' : 'B') : null} />
          <div className="core-status" aria-live="polite">
            <p className="core-state">
              {statusTitle}
              {timeline.isMock && session ? <span className="mock-tag">Simulated</span> : null}
            </p>
            {statusModel ? <p className="core-model">{statusModel}</p> : null}
          </div>
        </div>
        <div className="sidebar-actions">
          <button className="btn primary" onClick={() => void newChat()} disabled={!online}>
            New chat
          </button>
          <button className="btn" onClick={() => void newCodingTask()} disabled={!online}>
            New coding task
          </button>
        </div>
        <label className="search">
          <span className="visually-hidden">Search sessions</span>
          <input ref={searchRef} type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <nav className="session-list">
          {filtered.length === 0 ? <p className="empty-note">{query ? 'No sessions match.' : 'Your chats and coding tasks will appear here.'}</p> : null}
          {filtered.map((s) => {
            const p = s.projectId ? projects.find((x) => x.id === s.projectId) : null;
            return (
              <button key={s.id} className={`session-item ${s.id === selected ? 'selected' : ''}`} onClick={() => setSelected(s.id)} aria-current={s.id === selected}>
                <span className="session-title">{s.title}</span>
                <span className="session-meta">
                  <span className={`dot state-${s.state}`} aria-hidden="true" />
                  <span className="session-where">
                    {p ? p.name : 'Chat'}
                    {s.mode === 'mock' ? ', simulated' : ''}
                  </span>
                  <span className="session-time">{relativeTime(s.updatedAt)}</span>
                </span>
              </button>
            );
          })}
        </nav>
        <footer className="sidebar-footer">
          <button className="btn ghost" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <span className={`runner-pill ${online ? 'on' : 'off'}`} title={runnerError ?? undefined}>
            {online === null ? 'Connecting…' : online ? 'Runner on this Mac' : 'Runner offline'}
          </span>
        </footer>
      </aside>

      <main className="main">
        <header className="topbar">
          <button className="icon-btn" aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'} onClick={() => setSidebarOpen((v) => !v)}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <rect x="2" y="3" width="14" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="7" y1="3" x2="7" y2="15" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
          <div className="topbar-title">
            <h1>{session?.title ?? 'WotsRelay'}</h1>
            {project ? (
              <span className="project-path" title={project.root}>
                {shortPath(project.root)}
              </span>
            ) : session ? (
              <span className="project-path">Chat, no file access</span>
            ) : null}
          </div>
          {session ? (
            <button className={`btn ghost ${showActivity ? 'pressed' : ''}`} aria-pressed={showActivity} onClick={() => setShowActivity((v) => !v)}>
              Activity
            </button>
          ) : null}
        </header>

        {online === false ? (
          <div className="banner error" role="alert">
            <p>The runner on this Mac isn’t reachable{runnerError ? `: ${runnerError}` : '.'}</p>
            <button className="btn" onClick={() => void bridge().reconnect()}>
              Try again
            </button>
          </div>
        ) : null}
        {error ? (
          <div className="banner error" role="alert">
            <p>{error}</p>
            <button className="btn ghost" onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}

        {session ? (
          <>
            <Conversation timeline={timeline} session={session} view={view} onResume={(fallback, note) => void api.resume(session.id, fallback, note).catch((e: Error) => setError(e.message))} onDecide={(id, d, v) => void api.decide(id, d, v).catch((e: Error) => setError(e.message))} />
            <Composer ref={composerRef} session={session} live={live} timeline={timeline} onSend={send} onStop={stop} />
          </>
        ) : (
          <Welcome onChat={() => void newChat()} onCode={() => void newCodingTask()} disabled={!online} />
        )}
      </main>

      {showActivity && session ? <ActivityPanel timeline={timeline} view={view} onClose={() => setShowActivity(false)} sessionId={session.id} /> : null}
      {showSettings ? <Settings projects={projects} onClose={() => setShowSettings(false)} onDemo={startDemo} /> : null}
      {trustPath ? <TrustDialog path={trustPath} onCancel={() => setTrustPath(null)} onTrust={(consent) => void startProject(trustPath, consent)} /> : null}
    </div>
  );
}

function shortPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

function Welcome({ onChat, onCode, disabled }: { onChat: () => void; onCode: () => void; disabled: boolean }) {
  return (
    <section className="welcome">
      <h2>Start with Claude Opus 5.5. Keep going with GPT-6 Astra.</h2>
      <p>
        When Claude reaches a confirmed usage limit, WotsRelay saves a checkpoint and hands the task to GPT-6 Astra on {routeLabel('codex')}. Work stays on this Mac, and each reply shows which model wrote it.
      </p>
      <div className="welcome-actions">
        <button className="btn primary" onClick={onChat} disabled={disabled}>
          New chat
        </button>
        <button className="btn" onClick={onCode} disabled={disabled}>
          Choose a project folder
        </button>
      </div>
      <p className="welcome-keys">
        <kbd>⌘</kbd> <kbd>N</kbd> new chat, <kbd>⌘</kbd> <kbd>K</kbd> search, <kbd>⌘</kbd> <kbd>.</kbd> stop
      </p>
    </section>
  );
}
