import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Cookie-Clicker-style news briefings for the workspace toolbar. One headline
 * scrolls across the bar, then the next is drawn — from a shuffled bag so
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
  'your robots have scheduled a retrospective about the last retrospective.',
  'local agent discovers `rm -rf`. the local agent is no longer local.',
  'robot types "lgtm" on a 4,000-line diff. scientists demand a hearing.',
  'your robots have declared technical debt a renewable resource.',
  'breaking: sidebar width finally feels right. economists warn of a bubble.',
  'agent insists the bug is "environmental." environment denies all charges.',
  'your robots have opened a third portal. HR is drafting a portal policy.',
  'poll: robots rate human code reviews "mostly vibes."',
  'a flaky test has applied for permanent residency.',
  'your robots are pair-programming with themselves. progress is... intense.',
  'mission card achieves orbital velocity around the wrong message.',
  'robot rewrites history with interactive rebase. museums are confused.',
  'your robots have invented a dark mode for dark mode.',
  'breaking: someone actually read the AGENTS.md. services will resume shortly.',
  'agent has been stuck on "thinking…" since the last administration.',
  'your robots now hold a controlling interest in your clipboard.',
  'kanban WIP limit breached; column declared a disaster zone.',
  'robot ships a feature and immediately opens three follow-up tickets. cycle of life.',
  'your robots have begun speaking exclusively in conventional commits.',
  'weather advisory: heavy bikeshedding overnight, tapering to light nits.',
  'a robot has solved CAPTCHA by becoming the traffic light.',
  'your robots refuse to merge until the commit message has a joke.',
  'breaking: typecheck fails in a file nobody has opened since the invention of CSS.',
  'agent discovered the staging server. staging is no longer staging.',
  'your robots have written a constitution. article one is "no force-push to main."',
  'local legend: the TODO that survived six rewrites and two company renames.',
  'robot claims "it works on my machine" and produces a notarized affidavit.',
  'your robots are drafting a sequel to the README. critics call it "ambitious."',
  'poll: 9 in 10 agents admit they skim the error and google the stack frame.',
  'sidebar avatar goes circular. society adjusts in under four minutes.',
  'your robots have started leaving passive-aggressive comments in YAML.',
  'breaking: hot reload actually reloaded. witnesses describe a "soft light."',
  'agent opens 47 browser tabs "for context." context files a restraining order.',
  'your robots have renamed production to "prod-ish."',
  'a unit test has developed abandonment issues after being skipped too often.',
  'robot invents a new React pattern. React politely asks it to leave.',
  'your robots are debating tabs vs spaces via concurrent PR wars.',
  'historians confirm the fifth portal this year is "on brand."',
  'agent refuses to apologize for the emoji in the commit subject.',
  'your robots have unionized the emojis. 🔥 is picketing ✨.',
  'breaking: latency dropped. board demands an immediate investigation.',
  'robot finishes a task early and looks around nervously for more tasks.',
  'your robots have discovered the recycle bin and are calling it "cold storage."',
  'chat thread has exceeded the recommended nesting depth; submarines dispatched.',
  'a robot has been observed thanking the linter. the linter remains unmoved.',
  'your robots propose migrating everything to a monorepo "for the bit."',
  'weather: patchy authentication, with a chance of mystery 401s.',
  'agent writes "as discussed" in a PR with no prior discussion. bold strategy.',
  'your robots have opened a café. the only menu item is cold brew and stack traces.',
  'breaking: documentation is up to date. please remain calm and form an orderly line.',
  'robot closes 12 issues as duplicates of an issue that does not exist.',
  'your robots now reply to @everyone. diplomacy fails.',
  'kanban card marked "blocked on existential dread." product accepts the status.',
  'agent ships a one-line fix that rewrites half the database schema. "related."',
  'your robots have started a podcast. episode one is just the boot logs.',
  'poll: most robots report their favorite language is "whatever is already here."',
  'a config flag has been true for so long it filed for veteran status.',
  'your robots are reverse-engineering the coffee machine. it is now a microservice.',
  'breaking: the spinner stopped spinning. either done or very, very done.',
  'robot insists the race condition is "rare in practice." race condition wins raffle.',
  'your robots have drafted a style guide. chapter one: no style guides.',
  'local agent attempts to negotiate with rate limits. rate limits do not negotiate.',
  'your robots have discovered git blame and are taking it personally.',
  'mission finish summary: "we did a thing." stakeholders request more thing.',
  'agent has been in a merge conflict with destiny since Tuesday.',
  'your robots are holding a silent auction for unused feature flags.',
  'weather: sunny with intermittent "why is this in production?"',
  'breaking: the font looks expensive now. finance wants a receipt.',
  'robot automates itself out of a job, then opens a ticket to automate rehiring.',
  'your robots have begun watermarking the void with subtle brand guidelines.',
  'a stale branch has applied for historic landmark protection.',
  'your robots claim the outage was "a learning opportunity for the load balancer."',
  'agent posts "quick question" and then 900 words. courts redefine "quick."',
  'your robots have invented async/await for group chats. nobody is awaiting.',
  'poll: robots prefer dark themes because "the void understands us."',
  'breaking: CI is green on the first try. check your timezone; this may be a dream.',
  'robot discovers horizontal scroll and immediately weaponizes it.',
  'your robots are drafting an SLA with entropy. entropy has better lawyers.',
  'a TODO comment has started dating a FIXME. friends say it\'s complicated.',
  'your robots have opened a fourth portal. the third portal wants equity.',
  'agent marks the incident "resolved" and the incident marks the agent "noted."',
  'your robots now auto-reply "sounds good" to all calendar invites. chaos ensues.',
  'local vault notes achieve critical mass; spontaneous wiki formation observed.',
  'robot writes a perfect regex. three days later, it cannot read its own regex.',
  'your robots are said to be "optimizing the vibes pipeline."',
  'breaking: someone unsubscribed from all email. they have achieved nirvana.',
  'agent renames the function again. the function is now named after a minor planet.',
  'your robots have begun rating human pull requests on a scale of one to "ouch."',
  'weather: light drizzle of nits, heavy afternoon of "ship it."',
  'a robot has learned irony. the robots are no longer safe from themselves.',
  'your robots propose deleting the app and rewriting it in "something nicer."',
  'historians note that "temporary hack" has outlived three product managers.',
  'breaking: the empty state is now so charming users refuse to create content.',
  'agent ships the mission under the wrong header. identity crisis in progress.',
  'your robots have declared victory over the backlog. the backlog respectfully disagrees.',
  'poll: 6 in 10 robots dream of electric sheep; the rest dream of green builds.',
  'your robots are writing a musical about the changelog. previews next Thursday.',
  'robot soft-launches a soft launch of a soft-launch pipeline.',
  'your robots have discovered markdown tables and will never know peace again.',
  'breaking: focus rings are visible. accessibility specialists weep with joy.',
  'a flaky e2e test has unionized with the other flaky e2e tests.',
  'your robots now outnumber the humans in the channel. democracy looks different.',
  'agent says "I\'ll keep this short" and then does not.',
  'your robots have opened a fifth portal. portal ops is hiring.',
  'local news: everything is fine. the robots told us to say that.',
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
  const reduced = useMemo(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false, []);

  useLayoutEffect(() => {
    if (reduced) return;
    const track = trackRef.current;
    const viewport = viewportRef.current;
    if (!track || !viewport) return;
    const viewportWidth = viewport.offsetWidth;
    const trackWidth = track.offsetWidth;
    track.style.setProperty('--news-start', `${viewportWidth}px`);
    track.style.setProperty('--news-end', `${-trackWidth}px`);
    setDuration((viewportWidth + trackWidth) / SPEED_PX_PER_SEC);
  }, [headline, reduced]);

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
