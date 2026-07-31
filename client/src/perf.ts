/**
 * Lightweight freeze / hot-path profiler for Cascade.
 *
 * Always-on (cheap):
 *   - PerformanceObserver for long tasks ≥ LONG_TASK_MS
 *   - `perfSpan` that only logs when a span exceeds warnMs
 *   - Slow events are appended to disk via Electron IPC so desktop agents
 *     can read them after the fact (not only DevTools console)
 *
 * Verbose (opt-in): localStorage.cascade_perf = "1"  or  ?perf=1
 *   - Logs every measured span
 *   - `window.__cascadePerf` exposes recent events + log paths
 *
 * Log files (desktop):
 *   - ~/.config/Cascade/logs/cascade-perf.jsonl  (or userData equivalent)
 *   - /tmp/cascade-perf.jsonl  (Linux mirror for easy agent access)
 */

const LONG_TASK_MS = 80;
const DEFAULT_WARN_MS = 16;
const RECENT_CAP = 80;
const FILE_FLUSH_MS = 400;

export type PerfEvent = {
  t: number;
  name: string;
  ms: number;
  detail?: Record<string, unknown>;
  kind: 'span' | 'long-task' | 'mark';
};

type PerfElectronAPI = {
  appendPerfLog?: (lines: string | string[]) => Promise<{
    success: boolean;
    primary?: string;
    mirror?: string;
    paths?: string[];
    error?: string;
  }>;
  getPerfLogPath?: () => Promise<{
    success: boolean;
    primary?: string;
    mirror?: string;
    paths?: string[];
    error?: string;
  }>;
};

const recent: PerfEvent[] = [];
let verboseCached: boolean | null = null;
let observerInstalled = false;
let fileQueue: string[] = [];
let fileFlushTimer: number | null = null;
let logPaths: { primary?: string; mirror?: string; paths?: string[] } | null = null;
let fileSinkAvailable: boolean | null = null;

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function electronAPI(): PerfElectronAPI | undefined {
  try {
    return (window as unknown as { electronAPI?: PerfElectronAPI }).electronAPI;
  } catch {
    return undefined;
  }
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

function ensurePerfGlobal(): void {
  try {
    const w = window as unknown as {
      __cascadePerf?: {
        recent: PerfEvent[];
        verbose: () => boolean;
        logPath: string | null;
        logPaths: { primary?: string; mirror?: string; paths?: string[] } | null;
        flush: () => Promise<void>;
      };
    };
    w.__cascadePerf = {
      recent,
      verbose: isPerfVerbose,
      logPath: logPaths?.primary ?? logPaths?.mirror ?? null,
      logPaths,
      flush: flushPerfLog,
    };
  } catch {
    // ignore
  }
}

function pushEvent(event: PerfEvent, opts?: { toFile?: boolean }): void {
  recent.push(event);
  if (recent.length > RECENT_CAP) recent.splice(0, recent.length - RECENT_CAP);
  ensurePerfGlobal();
  if (opts?.toFile !== false) enqueueFileEvent(event);
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

function enqueueFileEvent(event: PerfEvent): void {
  if (typeof window === 'undefined') return;
  if (fileSinkAvailable === false) return;

  const row = {
    iso: new Date(event.t).toISOString(),
    t: event.t,
    kind: event.kind,
    name: event.name,
    ms: Math.round(event.ms * 10) / 10,
    detail: event.detail,
  };
  fileQueue.push(JSON.stringify(row));
  if (fileFlushTimer != null) return;
  fileFlushTimer = window.setTimeout(() => {
    fileFlushTimer = null;
    void flushPerfLog();
  }, FILE_FLUSH_MS);
}

/** Flush queued lines to disk (no-op outside Electron). */
export async function flushPerfLog(): Promise<void> {
  if (fileQueue.length === 0) return;
  const api = electronAPI();
  if (!api?.appendPerfLog) {
    fileSinkAvailable = false;
    fileQueue = [];
    return;
  }
  const batch = fileQueue;
  fileQueue = [];
  try {
    const res = await api.appendPerfLog(batch);
    if (res?.success === false) {
      fileSinkAvailable = false;
      return;
    }
    fileSinkAvailable = true;
    if (res?.primary || res?.mirror || res?.paths) {
      logPaths = {
        primary: res.primary,
        mirror: res.mirror,
        paths: res.paths,
      };
      ensurePerfGlobal();
    }
  } catch {
    fileSinkAvailable = false;
  }
}

async function resolveLogPaths(): Promise<void> {
  const api = electronAPI();
  if (!api?.getPerfLogPath) {
    fileSinkAvailable = false;
    return;
  }
  try {
    const res = await api.getPerfLogPath();
    if (res?.success) {
      logPaths = { primary: res.primary, mirror: res.mirror, paths: res.paths };
      fileSinkAvailable = true;
      ensurePerfGlobal();
    } else {
      fileSinkAvailable = false;
    }
  } catch {
    fileSinkAvailable = false;
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
 * Install Long Task observer + resolve disk log path. Safe to call multiple times.
 * Always-on: freezes ≥ LONG_TASK_MS land in console and cascade-perf.jsonl.
 */
export function installPerfObservers(): void {
  if (observerInstalled || typeof window === 'undefined') return;
  observerInstalled = true;
  ensurePerfGlobal();
  void resolveLogPaths();

  // Flush on hide / unload so a freeze right before quit still lands on disk.
  try {
    window.addEventListener('pagehide', () => {
      void flushPerfLog();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void flushPerfLog();
    });
  } catch {
    // ignore
  }

  try {
    if (typeof PerformanceObserver === 'undefined') return;
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    if (types && !types.includes('longtask')) return;

    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const ms = entry.duration;
        if (ms < LONG_TASK_MS) continue;
        const detail = {
          name: entry.name,
          startTime: Math.round(entry.startTime),
          attribution: (entry as PerformanceEntry & { attribution?: unknown[] }).attribution,
        };
        const event: PerfEvent = { t: Date.now(), name: 'longtask', ms, detail, kind: 'long-task' };
        pushEvent(event);
        console.warn(
          `[cascade-perf] long-task ${ms.toFixed(1)}ms (main thread blocked)`,
          detail,
        );
        // Long freezes: flush ASAP so agents can read without waiting for batch.
        if (ms >= 250) void flushPerfLog();
      }
    });
    obs.observe({ entryTypes: ['longtask'] as unknown as string[] });
  } catch {
    // Safari / older engines: ignore
  }

  if (isPerfVerbose()) {
    // eslint-disable-next-line no-console
    console.info(
      '[cascade-perf] verbose on — set localStorage.cascade_perf="" or drop ?perf to quiet. Recent: window.__cascadePerf.recent; file: window.__cascadePerf.logPath',
    );
  }
}
