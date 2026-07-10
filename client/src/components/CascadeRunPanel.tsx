/**
 * Agent harness panel — structured transcript in a terminal-like stream.
 *
 * Renders parsed thinking / tools / meta as sequential harness lines
 * (not raw JSONL, not a product "timeline" UI). Optional Raw tab shows
 * the true process/SDK buffer in xterm when needed.
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  const lines = text.trim() ? indentBlock(text.trim()) : [];
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
  }, [text, open, live, lines.length]);

  return (
    <div className="crp-term-block crp-term-thinking">
      <button type="button" className="crp-term-fold" onClick={() => setOpen((v) => !v)}>
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

  return (
    <div className={`crp-term-block crp-term-tool status-${tool.status}`}>
      <button
        type="button"
        className="crp-term-fold"
        onClick={() => hasBody && setOpen((v) => !v)}
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
}: {
  message: ChatMessage;
  onCancelRun: (runId: number) => void;
  forceOpen?: boolean;
}) {
  const isRunning = message.status === 'running';
  const activity = useMemo(() => buildHarnessActivity(message), [message]);
  const canExpand = hasRunActivity(message) || activity.items.length > 0 || activity.stats.hasRaw;
  const [open, setOpen] = useState(isRunning);
  const [showRaw, setShowRaw] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** User is following the tail of the outer harness scroller. */
  const pinBottomRef = useRef(true);
  const summary = summarizeActivity(activity, isRunning);
  const statChips = useMemo(() => buildHeaderStatChips(activity.stats), [activity.stats]);
  const showUsage = hasUsageStats(activity.stats) || statChips.length > 0;
  const effectiveOpen = open || forceOpen;

  // Fingerprint content growth (length alone misses same-length edits; items
  // grow thinking in-place without changing items.length).
  const scrollEpoch = useMemo(() => {
    let n = activity.thinkingText.length;
    for (const item of activity.items) {
      n += (item.text?.length || 0) + (item.tool?.result?.length || 0) + 1;
    }
    n += activity.stats.toolCount * 17 + (activity.stats.numTurns || 0);
    n += activity.rawLog.length;
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

  if (!isRunning && !canExpand) return null;

  const hasStructured = activity.items.length > 0 || activity.stats.hasThinking;
  const useRaw = showRaw || (!hasStructured && activity.stats.hasRaw);

  return (
    <div
      className={`cascade-run-panel ${effectiveOpen ? 'open' : ''} ${isRunning ? 'is-running' : ''}`}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="crp-header">
        <button
          type="button"
          className="crp-toggle"
          onClick={() => canExpand && setOpen((v) => !v)}
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
