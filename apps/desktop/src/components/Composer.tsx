import { forwardRef, useState } from 'react';
import type { Session } from '@wots/protocol';
import type { Timeline } from '@wots/timeline';
import { modelLabel } from '../labels.ts';

interface Props {
  session: Session;
  live: boolean;
  timeline: Timeline;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
}

export const Composer = forwardRef<HTMLTextAreaElement, Props>(function Composer({ session, live, timeline, onSend, onStop }, ref) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const paused = !!timeline.state?.startsWith('paused');
  const [a, b] = session.fallback.routes;

  const submit = async () => {
    const t = text.trim();
    if (!t || live || sending || paused) return;
    setSending(true);
    // The draft clears only after the runner acknowledges persistence.
    try {
      await onSend(t);
      setText('');
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="composer-box">
        <label className="visually-hidden" htmlFor="prompt">
          Message
        </label>
        <textarea
          id="prompt"
          ref={ref}
          rows={1}
          value={text}
          placeholder={paused ? 'This run is paused. Resume it above, or start a new chat.' : session.projectId ? 'Describe the change' : 'Message WotsRelay'}
          disabled={paused}
          onChange={(e) => {
            setText(e.target.value);
            e.currentTarget.style.height = 'auto';
            e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 280)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {live ? (
          <button type="button" className="send stop" onClick={onStop} aria-label="Stop run">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <button type="submit" className="send" disabled={!text.trim() || sending || paused} aria-label="Send message">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
      <div className="composer-meta" aria-label="Run settings">
        <span className="lane-chip a">{modelLabel(a?.modelId ?? null)}</span>
        <span className="arrow" aria-hidden="true">
          ›
        </span>
        <span className="lane-chip b">{modelLabel(b?.modelId ?? null)}</span>
        <span className="meta-item">{session.fallback.autoFallback ? 'Auto fallback on' : 'Auto fallback off'}</span>
        <span className="meta-item">Effort {session.fallback.effort}</span>
        <span className="meta-item">Standard speed</span>
        <span className="meta-hint">Enter to send, Shift Enter for a new line</span>
      </div>
    </form>
  );
});
