import { useEffect, useRef, useState } from 'react';

export function TrustDialog({ path, onCancel, onTrust }: { path: string; onCancel: () => void; onTrust: (consent: boolean) => void }) {
  const [consent, setConsent] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="sheet" onCancel={onCancel} aria-labelledby="trust-title">
      <h2 id="trust-title">Trust this folder for coding?</h2>
      <p className="path">{path}</p>
      <ul className="plain-list">
        <li>Agents can read and edit files in this folder. Shell commands outside the permission profile are blocked and reported.</li>
        <li>Uncommitted changes are kept. WotsRelay never resets, stashes or commits for you.</li>
        <li>Project hooks and MCP servers in this folder are not loaded by Claude Code runs.</li>
      </ul>
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>If Claude reaches its usage limit, send this task’s context (objective, recent messages, changed files and diffs) to GPT-6 Astra so it can continue. Secret files such as .env are excluded.</span>
      </label>
      <div className="sheet-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => onTrust(consent)}>
          Trust folder
        </button>
      </div>
    </dialog>
  );
}
