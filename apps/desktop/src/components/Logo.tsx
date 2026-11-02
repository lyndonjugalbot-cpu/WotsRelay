import { logo } from '@wots/design-tokens';
import type { CSSProperties } from 'react';

// The relay moment: the mark settles, the arrow sweeps across it, then the wordmark follows letter
// by letter (styles.css, `.logo`). `replayKey` re-runs only the arrow sweep, so a provider handoff
// replays the relay in the logo itself. Reduced motion shows the finished logo.
export function Logo({ variant, replayKey = null }: { variant: 'lockup' | 'full'; replayKey?: string | null }) {
  const arrow = <path key={replayKey ?? 'first'} className="lg-arrow" d={logo.arrow} />;
  const letters = logo.letters.map((d, i) => <path key={i} className="lg-letter" d={d} style={{ '--i': i } as CSSProperties} />);
  if (variant === 'full') {
    return (
      <svg className="logo logo-full" viewBox={logo.viewBox.full} role="img" aria-label="WotsRelay">
        <g fillRule="evenodd">
          <path className="lg-mark" d={logo.mark} />
          {arrow}
          {letters}
        </g>
      </svg>
    );
  }
  return (
    <span className="logo logo-lockup" role="img" aria-label="WotsRelay">
      <svg className="lg-lockup-mark" viewBox={logo.viewBox.mark} aria-hidden="true">
        <g fillRule="evenodd">
          <path className="lg-mark" d={logo.mark} />
          {arrow}
        </g>
      </svg>
      <svg className="lg-lockup-word" viewBox={logo.viewBox.word} aria-hidden="true">
        <g fillRule="evenodd">{letters}</g>
      </svg>
    </span>
  );
}
