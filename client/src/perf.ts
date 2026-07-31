/**
 * Lightweight freeze / hot-path profiler for Cascade.
 *
 * Always-on (cheap):
 *   - PerformanceObserver for long tasks ≥ LONG_TASK_MS
 *   - `perfSpan` / `perfNow` that only log when a span exceeds warnMs
 *
 * Verbose (opt-in): localStorage.cascade_perf = "1"  or  ?perf=1
 *   - Logs every measured span + a 1s event tally
 *   - `window.__cascadePerf` exposes recent events for the console
 *
 * Intentionally zero deps and safe in SSR / non-browser tests.
 */

const LONG_TASK_MS = 80;
const DEFAULT_WARN_MS = 16;
const RECENT_CAP = 80;

export type PerfEvent = {
  t: number;
  name: string;
  ms: number;
  detail?: Record<string, unknown>;
  kind: 'span' | 'long-task' | 'mark';
};

const recent: PerfEvent[] = [];
let verboseCached: boolean | null = null;
let observerInstalled = false;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function isPerfVerbose(): boolean {
  if (verboseCached != null) return verboseCached;
  try {
    if (typeof window === 'undefined') {
      verboseCached = false;
      return false;
    }
    if (localStorage.getItem('cascade_perf') === '1') {
      verboseCached = true;
      return true;
    }
    if (new URLSearchParams(window.location.search).has('perf')) {
      verboseCached = true;
      return true;
    }
  } catch {
    // localStorage / location may be blocked
  }
  verboseCached = false;
  return false;
}

/** Force re-read of verbose flags (after toggling localStorage in console). */
export function refreshPerfFlags(): void {
  verboseCached = null;
}

function pushEvent(event: PerfEvent): void {
  recent.push(event);
  if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP);
  try {
    const w = window as unknown as { __cascadePerf?: { recent: PerfEvent[]; verbose: () => boolean } };
    if (!w.__cascadePerf) {
      w.__cascadePerf = {
        recent,
        verbose: isPerfVerbose,
      };
    }
  } catch {
    // ignore
  }
}

function logLine(kind: string, name: string, ms: number, detail?: Record<string, unknown>): void {
  const payload = detail && Object.keys(detail).length > 0 ? detail : undefined;
  const msg = `[cascade-perf] ${kind} ${name} ${ms.toFixed(1)}ms`;
  if (ms >= 200) {
    console.warn(msg, payload ?? '');
  } else if (ms >= LONG_TASK_MS || isPerfVerbose()) {
    // eslint-disable-next-line no-console
    console.info(msg, payload ?? '');
  }
}

/** Record a completed span; only prints when slow or verbose. */
export function perfReport(
  name: string,
  ms: number,
  detail?: Record<string, unknown>,
  warnMs: number = DEFAULT_WARN_MS,
): void {
  const event: PerfEvent = { t: Date.now(), name, ms, detail, kind: 'span' };
  if (ms >= warnMs || isPerfVerbose()) {
    pushEvent(event);
    logLine('span', name, ms, detail);
  } else if (ms >= warnMs / 2 && isPerfVerbose()) {
    pushEvent(event);
  }
}

/** Time a synchronous block. Returns the block's result. */
export function perfSpan<T>(
  name: string,
  fn: () => T,
  detail?: Record<string, unknown>,
  warnMs: number = DEFAULT_WARN_MS,
): T {
  const start = now();
  try {
    return fn();
  } finally {
    perfReport(name, now() - start, detail, warnMs);
  }
}

/** Async variant. */
export async function perfSpanAsync<T>(
  name: string,
  fn: () => Promise<T>,
  detail?: Record<string, unknown>,
  warnMs: number = DEFAULT_WARN_MS,
): Promise<T> {
  const start = now();
  try {
    return await fn();
  } finally {
    perfReport(name, now() - start, detail, warnMs);
  }
}

/** One-shot mark (no duration). Verbose only, unless force. */
export function perfMark(name: string, detail?: Record<string, unknown>, force = false): void {
  if (!force && !isPerfVerbose()) return;
  const event: PerfEvent = { t: Date.now(), name, ms: 0, detail, kind: 'mark' };
  pushEvent(event);
  // eslint-disable-next-line no-console
  console.info(`[cascade-perf] mark ${name}`, detail ?? '');
}

/**
 * Install Long Task observer. Safe to call multiple times.
 * Always-on: freezes ≥ LONG_TASK_MS land in the console so intermittent
 * 1–2s hangs leave a trail without needing to turn anything on.
 */
export function installPerfObservers(): void {
  if (observerInstalled || typeof window === 'undefined') return;
  observerInstalled = true;

  try {
    if (typeof PerformanceObserver === 'undefined') return;
    // longtask is not in every TS lib DOM version
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    if (types && !types.includes('longtask')) return;

    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = entry.duration;
        if (ms < LONG_TASK_MS) continue;
        const detail = {
          name: entry.name,
          startTime: Math.round(entry.startTime),
          // attribution is Chromium-specific
          attribution: (entry as PerformanceEntry & { attribution?: unknown[] }).attribution,
        };
        pushEvent({ t: Date.now(), name: 'longtask', ms, detail, kind: 'long-task' });
        console.warn(
          `[cascade-perf] long-task ${ms.toFixed(1)}ms (main thread blocked)`,
          detail,
        );
      }
    });
    obs.observe({ entryTypes: ['longtask'] as unknown as string[] });
  } catch {
    // Safari / older engines: ignore
  }

  if (isPerfVerbose()) {
    // eslint-disable-next-line no-console
    console.info(
      '[cascade-perf] verbose on — set localStorage.cascade_perf="" or drop ?perf to quiet. Recent: window.__cascadePerf.recent',
    );
  }
}
