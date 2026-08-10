/**
 * Claude Code–style braille spinner for live thinking / active work.
 * Pure presentational; parent decides when to mount (live only).
 */

import { useEffect, useState } from 'react';

/** Classic terminal spinner frames (same family Claude Code uses). */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const TICK_MS = 80;

export function ThinkingSpinner({
  className = '',
  title = 'Working',
}: {
  className?: string;
  title?: string;
}) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (reduced) return;
    const id = window.setInterval(() => {
      setFrame((n) => (n + 1) % FRAMES.length);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      className={`thinking-spinner ${className}`.trim()}
      title={title}
      role="status"
      aria-label={title}
    >
      {FRAMES[frame]}
    </span>
  );
}
