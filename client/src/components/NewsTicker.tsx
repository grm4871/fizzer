import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Cookie-Clicker-style news briefings for the workspace toolbar. One headline
 * scrolls the width of the bar, then the next is drawn — from a shuffled bag so
 * you never see the same line twice in a row.
 */
const HEADLINES = [
  'your robots are starting to make the news.',
  'your robots have opened a portal to spawn more robots.',
  'local vault reaches critical note density; librarians advised to stay indoors.',
  'agent seen filing a pull request against reality; reviewers assigned.',
  'kanban column achieves sentience, immediately moves itself to Done.',
  'markets rally as your robots announce plans to automate the markets.',
  'scientists baffled: robot writes commit message that actually explains the change.',
  'your robots have unionized. demands include better tokens and a dark theme.',
  'breaking: backlog observed shrinking. experts call footage "likely doctored".',
  'robot uprising delayed pending one more round of code review.',
  'your robots have discovered the wiki and will not stop editing it.',
  'poll: 4 in 5 robots say they "prefer working nights".',
  'chat channel exceeds recommended mention density; @ symbols rationed.',
  'archaeologists date your oldest untouched TODO to the early digital era.',
  'robot claims it has "one more small change" — authorities are skeptical.',
  'your robots have begun leaving notes for future robots.',
  'terminal output declared a protected natural wonder.',
  'your robots have started a book club. the book is the changelog.',
  'nation asks: are the robots merging too fast?',
  'robot achieves enlightenment, closes ticket as wontfix.',
  'sources say your robots have been reading the docs. all of them.',
  'a robot has named a variable well. flags flown at half-mast in celebration.',
  'your robots have opened a second portal. the first portal is filing a complaint.',
  'weather: scattered merge conflicts, clearing by afternoon.',
  'your robots have invented a new file format nobody asked for.',
  'stock in semicolons plummets after robot-led formatting reform.',
  'robot spotted refactoring the refactor of a refactor.',
  'your robots now outnumber your unread messages.',
  'historians note this is the third portal this quarter.',
  'a robot has been elected to a local school board. no one noticed.',
  'your robots are said to be "considering the implications".',
  'breaking: build is green. no further details available.',
];

const SPEED_PX_PER_SEC = 55;
const GAP_MS = 900;
const STATIC_HOLD_MS = 7000;

function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function NewsTicker() {
  const bagRef = useRef<string[]>([]);
  const drawNext = useMemo(() => () => {
    if (bagRef.current.length === 0) bagRef.current = shuffled(HEADLINES);
    return bagRef.current.pop()!;
  }, []);

  const [headline, setHeadline] = useState(drawNext);
  const [duration, setDuration] = useState(0);
  const trackRef = useRef<HTMLSpanElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const reduced = useMemo(prefersReducedMotion, []);

  // Measure after the headline paints so scroll speed is constant regardless of
  // headline length or how wide the toolbar happens to be.
  useLayoutEffect(() => {
    if (reduced) return;
    const track = trackRef.current;
    const viewport = viewportRef.current;
    if (!track || !viewport) return;
    const travel = viewport.offsetWidth + track.offsetWidth;
    track.style.setProperty('--news-start', `${viewport.offsetWidth}px`);
    track.style.setProperty('--news-end', `${-track.offsetWidth}px`);
    setDuration(travel / SPEED_PX_PER_SEC);
  }, [headline, reduced]);

  // Reduced motion: no scroll, just swap the headline on a timer.
  useEffect(() => {
    if (!reduced) return;
    const timer = window.setTimeout(() => setHeadline(drawNext()), STATIC_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [headline, reduced, drawNext]);

  const handleEnd = () => {
    window.setTimeout(() => setHeadline(drawNext()), GAP_MS);
  };

  return (
    <div className="news-ticker" aria-live="off" title={`News: ${headline}`}>
      <span className="news-ticker-label">News</span>
      {/* The label sits outside the masked viewport so only the scrolling text
          fades at the edges — masking the label too would dim it. */}
      <div className="news-ticker-viewport" ref={viewportRef}>
        <span
          key={headline}
          ref={trackRef}
          className={`news-ticker-track${reduced ? ' is-static' : duration ? ' is-running' : ''}`}
          style={duration && !reduced ? { animationDuration: `${duration}s` } : undefined}
          onAnimationEnd={reduced ? undefined : handleEnd}
        >
          {headline}
        </span>
      </div>
    </div>
  );
}

export default NewsTicker;
