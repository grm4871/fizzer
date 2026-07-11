/**
 * Agent harness panel — structured transcript in a terminal-like stream.
 *
 * Renders parsed thinking / tools / meta as sequential harness lines
 * (not raw JSONL, not a product "timeline" UI). Optional Raw tab shows
 * the true process/SDK buffer in xterm when needed.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronRight, Square, TerminalSquare } from 'lucide-react';
import {
  buildHarnessActivity,
  buildHeaderStatChips,
  formatContextLine,
  formatCostUsd,
  formatDurationMs,
  formatRateLimitLine,
  formatRateLimitWindowLines,
  formatTokenCount,
  formatTurnsLine,
  hasRunActivity,
  hasUsageStats,
  summarizeActivity,
  toolResultPreview,
  type ActivityItem,
  type HarnessActivity,
  type RunStats,
} from '../chat/harnessActivity';
import { HarnessTerminal } from './HarnessTerminal';
import type { ChatMessage } from './ChatView';

const SCROLL_PIN_PX = 48;
const EDGE_PX = 2;

function isPinnedToBottom(el: HTMLElement, slack = SCROLL_PIN_PX): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

function scrollToBottom(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

/** Scroll once after layout; repeated updates naturally coalesce before paint. */
function scrollToBottomSoon(el: HTMLElement | null | undefined) {
  if (!el) return;
  requestAnimationFrame(() => scrollToBottom(el));
}

function isScrollableY(el: HTMLElement): boolean {
  if (el.scrollHeight <= el.clientHeight + 1) return false;
  const oy = getComputedStyle(el).overflowY;
  return oy === 'auto' || oy === 'scroll' || oy === 'overlay' || el.classList.contains('chat-messages');
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p) {
    if (isScrollableY(p)) return p;
    p = p.parentElement;
  }
  return null;
}

function atScrollEdge(el: HTMLElement, deltaY: number): boolean {
  if (deltaY > 0) return el.scrollTop + el.clientHeight >= el.scrollHeight - EDGE_PX;
  if (deltaY < 0) return el.scrollTop <= EDGE_PX;
  return false;
}

/** Push leftover scroll into the nearest parent scroller (harness → chat). */
function chainScrollDelta(el: HTMLElement, deltaY: number): boolean {
  if (!deltaY || !atScrollEdge(el, deltaY)) return false;
  let parent = findScrollParent(el);
  let remaining = deltaY;
  while (parent && remaining !== 0) {
    if (!atScrollEdge(parent, remaining)) {
      parent.scrollTop += remaining;
      return true;
    }
    // Parent also at edge — walk up (thinking → harness → chat).
    const next = findScrollParent(parent);
    if (!next) {
      parent.scrollTop += remaining;
      return true;
    }
    parent = next;
  }
  return false;
}

/**
 * When a nested harness/thinking scroller is already at its edge, keep
 * scrolling the outer chat instead of trapping the thumb/gesture.
 * `active` rebinds after folds mount their `<pre>` (ref is null while closed).
 */
function useScrollChain(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // pinch-zoom
      if (!atScrollEdge(el, event.deltaY)) return;
      if (chainScrollDelta(el, event.deltaY)) {
        event.preventDefault();
      }
    };

    let lastY = 0;
    let tracking = false;
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      lastY = event.touches[0].clientY;
      tracking = true;
    };
    const onTouchMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;
      const y = event.touches[0].clientY;
      const deltaY = lastY - y; // finger up → content down
      lastY = y;
      if (!deltaY) return;
      if (!atScrollEdge(el, deltaY)) return;
      if (chainScrollDelta(el, deltaY)) {
        // Prevent the nested scroller from rubber-banding / eating the gesture.
        event.preventDefault();
      }
    };
    const onTouchEnd = () => {
      tracking = false;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [ref, active]);
}

function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.trim();
  if (typeof input !== 'object') return String(input);
  const rec = input as Record<string, unknown>;
  if (typeof rec.command === 'string') return rec.command;
  if (typeof rec.file_path === 'string') return rec.file_path;
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.pattern === 'string') return rec.pattern;
  if (typeof rec.query === 'string') return rec.query;
  if (typeof rec.message === 'string') return rec.message;
  try {
    const s = JSON.stringify(input);
    return s.length > 240 ? `${s.slice(0, 239)}…` : s;
  } catch {
    return String(input);
  }
}

function indentBlock(text: string, prefix = '  '): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.length ? `${prefix}${line}` : prefix.trimEnd()));
}

/** Collapsible thinking block rendered as terminal-style dim lines. */
function ThinkingBlock({
  text,
  defaultOpen,
  live,
}: {
  text: string;
  defaultOpen?: boolean;
  live?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen || live));
  const preRef = useRef<HTMLPreElement>(null);
  const pinRef = useRef(true);
  // Live thinking can grow many times per second; paint a throttled snapshot
  // so we don't re-split multi-KB strings into lines on every chunk.
  const [paintText, setPaintText] = useState(text);
  useEffect(() => {
    if (!live) {
      setPaintText(text);
      return;
    }
    const timer = window.setTimeout(() => setPaintText(text), 90);
    return () => window.clearTimeout(timer);
  }, [text, live]);

  const lines = paintText.trim() ? indentBlock(paintText.trim()) : [];
  const collapsedPreview = lines[0]?.replace(/^\s+/, '') || '';
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : '';

  useEffect(() => {
    if (live) {
      setOpen(true);
      pinRef.current = true;
    }
  }, [live]);

  // Thinking body is its own scroll container (max-height). Follow the tail
  // while live / pinned — outer panel scroll alone never moves this.
  useLayoutEffect(() => {
    if (!open) return;
    const pre = preRef.current;
    if (!pre) return;
    if (live || pinRef.current) scrollToBottomSoon(pre);
  }, [paintText, open, live, lines.length]);

  // Bind after fold opens so the <pre> exists.
  useScrollChain(preRef, open);

  return (
    <div className="crp-term-block crp-term-thinking">
      <button
        type="button"
        className="crp-term-fold"
        // Keep fold expand local: don't bubble to message selection / panel chrome.
        onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span className="crp-term-mark dim">·</span>
        <span className="crp-term-tag dim">thinking</span>
        {!open && (
          <span className="crp-term-fold-preview dim">
            {collapsedPreview}
            {more}
          </span>
        )}
        {open && <span className="crp-term-fold-preview" />}
        <ChevronRight size={12} className={`crp-term-fold-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <pre
          ref={preRef}
          className="crp-term-pre dim"
          onScroll={(event) => {
            pinRef.current = isPinnedToBottom(event.currentTarget);
          }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

function ToolBlock({
  item,
  defaultOpen,
}: {
  item: ActivityItem;
  defaultOpen?: boolean;
}) {
  const tool = item.tool!;
  const [open, setOpen] = useState(Boolean(defaultOpen || tool.status === 'running'));
  const preRef = useRef<HTMLPreElement>(null);
  const pinRef = useRef(true);
  const inputLine = previewInput(tool.input);
  const result = toolResultPreview(tool.result, 3000);
  const hasBody = Boolean(result || (tool.status === 'running' && !result));
  const mark = tool.status === 'error' ? '✗' : tool.status === 'running' ? '…' : '✓';
  const markClass = tool.status === 'error' ? 'err' : tool.status === 'running' ? 'run' : 'ok';
  const live = tool.status === 'running';

  useEffect(() => {
    if (live) {
      setOpen(true);
      pinRef.current = true;
    }
  }, [live]);

  useLayoutEffect(() => {
    if (!open || !hasBody) return;
    if (live || pinRef.current) scrollToBottomSoon(preRef.current);
  }, [result, open, hasBody, live]);

  useScrollChain(preRef, open && hasBody);

  return (
    <div className={`crp-term-block crp-term-tool status-${tool.status}`}>
      <button
        type="button"
        className="crp-term-fold"
        onClick={(event) => {
          event.stopPropagation();
          if (hasBody) setOpen((v) => !v);
        }}
        onPointerDown={(event) => event.stopPropagation()}
        disabled={!hasBody}
      >
        <span className={`crp-term-mark ${markClass}`}>{mark}</span>
        <span className="crp-term-tag tool">{tool.name || item.title}</span>
        {inputLine && <span className="crp-term-fold-preview">{inputLine}</span>}
        {hasBody && (
          <ChevronRight size={12} className={`crp-term-fold-chevron${open ? ' open' : ''}`} />
        )}
      </button>
      {open && hasBody && (
        <pre
          ref={preRef}
          className={`crp-term-pre ${tool.isError ? 'err' : 'muted'}`}
          onScroll={(event) => {
            pinRef.current = isPinnedToBottom(event.currentTarget);
          }}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {result
            ? indentBlock(result).join('\n')
            : '  …'}
        </pre>
      )}
    </div>
  );
}

/** Trailing `# …` meta lines for usage / context / turns / limits. */
function buildMetaLines(stats: RunStats, isRunning: boolean): string[] {
  const lines: string[] = [];
  const primary: string[] = [];
  if (stats.model) primary.push(stats.model);

  const ctx = formatContextLine(stats);
  if (ctx) primary.push(ctx);

  const turns = formatTurnsLine(stats);
  if (turns) primary.push(turns);

  const tokIn = formatTokenCount(stats.inputTokens);
  const tokOut = formatTokenCount(stats.outputTokens);
  if (tokIn || tokOut) primary.push(`${tokIn || '?'}→${tokOut || '?'} tok`);

  if (stats.cacheReadTokens != null && stats.cacheReadTokens > 0) {
    const cr = formatTokenCount(stats.cacheReadTokens);
    if (cr) primary.push(`cache ${cr}`);
  }

  const cost = formatCostUsd(stats.totalCostUsd);
  if (cost) primary.push(cost);

  const dur = formatDurationMs(stats.durationMs);
  if (dur) primary.push(dur);

  if (stats.toolCount > 0) {
    primary.push(`${stats.toolCount} tool${stats.toolCount === 1 ? '' : 's'}`);
  }

  if (primary.length) lines.push(primary.join(' · '));
  else if (isRunning) lines.push('running');

  const limitLine = formatRateLimitLine(stats);
  if (limitLine) lines.push(limitLine);

  // Only dump multi-window detail when we have more than the primary summary.
  const windows = formatRateLimitWindowLines(stats);
  if (windows.length > 1) {
    for (const w of windows) {
      if (w !== limitLine) lines.push(w);
    }
  }

  return lines;
}

function StructuredTranscript({
  activity,
  isRunning,
}: {
  activity: HarnessActivity;
  isRunning: boolean;
}) {
  const { stats, items } = activity;
  const metaLines = buildMetaLines(stats, isRunning);
  const lastIdx = items.length - 1;

  // If we only have thinkingText and no items, synthesize one block.
  const renderItems = items.length > 0
    ? items
    : activity.thinkingText
      ? [{
          id: 'thinking-only',
          kind: 'thinking' as const,
          title: 'Thinking',
          text: activity.thinkingText,
        }]
      : [];

  return (
    <div className="crp-term-stream" role="log" aria-label="Agent harness output">
      {(stats.command || stats.model || stats.cwd) && (
        <div className="crp-term-line meta">
          {stats.command
            ? <span className="dim">$ {stats.command}</span>
            : (
              <span className="dim">
                # {stats.model || 'agent'}
                {stats.cwd ? ` · ${stats.cwd}` : ''}
              </span>
            )}
        </div>
      )}

      {renderItems.length === 0 && (
        <div className="crp-term-line dim">
          {isRunning ? 'waiting for harness stream…' : 'no structured output'}
        </div>
      )}

      {renderItems.map((item, index) => {
        if (item.kind === 'thinking') {
          return (
            <ThinkingBlock
              key={item.id}
              text={item.text || ''}
              defaultOpen={isRunning && index === lastIdx}
              live={isRunning && index === lastIdx}
            />
          );
        }
        if (item.kind === 'tool' && item.tool) {
          return (
            <ToolBlock
              key={item.id}
              item={item}
              defaultOpen={isRunning && (index === lastIdx || item.tool.status === 'running')}
            />
          );
        }
        if (item.text) {
          return (
            <div key={item.id} className="crp-term-line">
              {item.text}
            </div>
          );
        }
        return null;
      })}

      {stats.exitCode != null && stats.exitCode !== '' && (
        <div className="crp-term-line meta dim"># exit {stats.exitCode}</div>
      )}
      {/* Always show usage lines when we have them — mid-run (max turns /
          rate limits) and after completion (ctx, turns, cost). */}
      {metaLines.map((line, i) => (
        <div key={`meta-${i}`} className="crp-term-line meta dim"># {line}</div>
      ))}
      {isRunning && (
        <div className="crp-term-line run-cursor" aria-hidden="true">
          <span className="crp-term-cursor">█</span>
        </div>
      )}
    </div>
  );
}

export const CascadeRunPanel = memo(function CascadeRunPanel({
  message,
  onCancelRun,
  forceOpen = false,
  onContentGrow,
}: {
  message: ChatMessage;
  onCancelRun: (runId: number) => void;
  forceOpen?: boolean;
  /** Notify parent (main chat scroller) when harness content height grows. */
  onContentGrow?: () => void;
}) {
  const isRunning = message.status === 'running';
  const activity = useMemo(() => buildHarnessActivity(message), [message]);
  const canExpand = hasRunActivity(message) || activity.items.length > 0 || activity.stats.hasRaw;
  const [open, setOpen] = useState(isRunning);
  const [showRaw, setShowRaw] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** User is following the tail of the outer harness scroller. */
  const pinBottomRef = useRef(true);
  const onContentGrowRef = useRef(onContentGrow);
  onContentGrowRef.current = onContentGrow;
  const summary = useMemo(() => summarizeActivity(activity, isRunning), [activity, isRunning]);
  const statChips = useMemo(() => buildHeaderStatChips(activity.stats), [activity.stats]);
  const showUsage = hasUsageStats(activity.stats) || statChips.length > 0;
  const effectiveOpen = open || forceOpen;
  // Harness body → main chat when already at top/bottom.
  useScrollChain(bodyRef, effectiveOpen && canExpand);

  // Fingerprint content growth (length alone misses same-length edits; items
  // grow thinking in-place without changing items.length).
  const scrollEpoch = useMemo(() => {
    let n = activity.thinkingText.length;
    for (const item of activity.items) {
      n += (item.text?.length || 0) + (item.tool?.result?.length || 0) + 1;
    }
    n += activity.stats.toolCount * 17 + (activity.stats.numTurns || 0);
    // Coarse harness length — avoid re-scrolling on every stats byte.
    n += Math.floor((activity.rawLog.length || 0) / 256);
    return n;
  }, [activity]);

  useEffect(() => {
    if (isRunning) {
      setOpen(true);
      pinBottomRef.current = true;
    }
  }, [isRunning]);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useLayoutEffect(() => {
    if (!isRunning || !effectiveOpen || showRaw) return;
    if (!pinBottomRef.current) return;
    scrollToBottomSoon(bodyRef.current);
  }, [scrollEpoch, isRunning, effectiveOpen, showRaw]);

  // Keep the main chat panel pinned when harness/thinking expands.
  useLayoutEffect(() => {
    if (!effectiveOpen) return;
    onContentGrowRef.current?.();
  }, [scrollEpoch, effectiveOpen]);

  if (!isRunning && !canExpand) return null;

  const hasStructured = activity.items.length > 0 || activity.stats.hasThinking;
  const useRaw = showRaw || (!hasStructured && activity.stats.hasRaw);

  return (
    <div
      className={`cascade-run-panel ${effectiveOpen ? 'open' : ''} ${isRunning ? 'is-running' : ''}`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="crp-header">
        <button
          type="button"
          className="crp-toggle"
          onClick={(event) => {
            event.stopPropagation();
            if (canExpand) setOpen((v) => !v);
          }}
          disabled={!canExpand}
          title={showUsage
            ? statChips.map((c) => c.title || c.label).join('\n')
            : summary}
        >
          <TerminalSquare size={13} className="crp-toggle-icon" />
          <span className="crp-toggle-label">Harness</span>
          <span className="crp-toggle-summary">{summary}</span>
          {statChips.length > 0 && (
            <span className="crp-stat-chips" aria-label="Run usage stats">
              {statChips.map((chip) => (
                <span
                  key={chip.id}
                  className={`crp-stat-chip${chip.warn ? ' is-warn' : ''}`}
                  title={chip.title || chip.label}
                >
                  {chip.label}
                </span>
              ))}
            </span>
          )}
          {isRunning && <span className="ai-spinner crp-spinner" />}
          {canExpand && <ChevronRight size={13} className="crp-chevron" />}
        </button>
        {isRunning && message.runId != null && (
          <button
            type="button"
            className="crp-stop"
            onClick={(event) => {
              event.stopPropagation();
              onCancelRun(message.runId!);
            }}
            title="Stop run"
          >
            <Square size={11} fill="currentColor" />
            Stop
          </button>
        )}
      </div>

      {effectiveOpen && canExpand && (
        <div className="crp-shell">
          <div
            className="crp-term"
            ref={bodyRef}
            onScroll={(event) => {
              // While running, only keep following if the user is near the tail.
              pinBottomRef.current = isPinnedToBottom(event.currentTarget);
            }}
          >
            {useRaw ? (
              <div className="crp-raw-wrap">
                <HarnessTerminal content={activity.rawLog || activity.thinkingText} active={isRunning} />
              </div>
            ) : (
              <StructuredTranscript activity={activity} isRunning={isRunning} />
            )}
          </div>
          {activity.stats.hasRaw && hasStructured && (
            <div className="crp-term-footer">
              <button
                type="button"
                className="crp-raw-toggle"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? 'structured' : 'raw buffer'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
