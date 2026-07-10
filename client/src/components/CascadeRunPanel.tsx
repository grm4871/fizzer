/**
 * Agent harness panel — structured transcript in a terminal-like stream.
 *
 * Renders parsed thinking / tools / meta as sequential harness lines
 * (not raw JSONL, not a product "timeline" UI). Optional Raw tab shows
 * the true process/SDK buffer in xterm when needed.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Square, TerminalSquare } from 'lucide-react';
import {
  buildHarnessActivity,
  formatCostUsd,
  formatDurationMs,
  formatTokenCount,
  hasRunActivity,
  summarizeActivity,
  toolResultPreview,
  type ActivityItem,
  type HarnessActivity,
} from '../chat/harnessActivity';
import { HarnessTerminal } from './HarnessTerminal';
import type { ChatMessage } from './ChatView';

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
  const lines = text.trim() ? indentBlock(text.trim()) : [];
  const collapsedPreview = lines[0]?.replace(/^\s+/, '') || '';
  const more = lines.length > 1 ? ` (+${lines.length - 1} lines)` : '';

  useEffect(() => {
    if (live) setOpen(true);
  }, [live]);

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
        <pre className="crp-term-pre dim">
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
  const inputLine = previewInput(tool.input);
  const result = toolResultPreview(tool.result, 3000);
  const hasBody = Boolean(result || (tool.status === 'running' && !result));
  const mark = tool.status === 'error' ? '✗' : tool.status === 'running' ? '…' : '✓';
  const markClass = tool.status === 'error' ? 'err' : tool.status === 'running' ? 'run' : 'ok';

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
        <pre className={`crp-term-pre ${tool.isError ? 'err' : 'muted'}`}>
          {result
            ? indentBlock(result).join('\n')
            : '  …'}
        </pre>
      )}
    </div>
  );
}

function buildStatusLine(activity: HarnessActivity, isRunning: boolean): string | null {
  const parts: string[] = [];
  if (activity.stats.model) parts.push(activity.stats.model);
  const tokIn = formatTokenCount(activity.stats.inputTokens);
  const tokOut = formatTokenCount(activity.stats.outputTokens);
  if (tokIn || tokOut) parts.push(`${tokIn || '?'}→${tokOut || '?'} tok`);
  const cost = formatCostUsd(activity.stats.totalCostUsd);
  if (cost) parts.push(cost);
  const dur = formatDurationMs(activity.stats.durationMs);
  if (dur) parts.push(dur);
  if (activity.stats.toolCount > 0) {
    parts.push(`${activity.stats.toolCount} tool${activity.stats.toolCount === 1 ? '' : 's'}`);
  }
  if (isRunning && parts.length === 0) return 'running';
  if (parts.length === 0) return null;
  return parts.join(' · ');
}

function StructuredTranscript({
  activity,
  isRunning,
}: {
  activity: HarnessActivity;
  isRunning: boolean;
}) {
  const { stats, items } = activity;
  const statusLine = buildStatusLine(activity, isRunning);
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
      {statusLine && !isRunning && (
        <div className="crp-term-line meta dim"># {statusLine}</div>
      )}
      {isRunning && (
        <div className="crp-term-line run-cursor" aria-hidden="true">
          <span className="crp-term-cursor">█</span>
        </div>
      )}
    </div>
  );
}

export function CascadeRunPanel({
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
  const summary = summarizeActivity(activity, isRunning);

  useEffect(() => {
    if (isRunning) setOpen(true);
  }, [isRunning]);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  useEffect(() => {
    if (!isRunning || !open || showRaw) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activity.items.length, activity.thinkingText.length, isRunning, open, showRaw]);

  if (!isRunning && !canExpand) return null;

  const effectiveOpen = open || forceOpen;
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
        >
          <TerminalSquare size={13} className="crp-toggle-icon" />
          <span className="crp-toggle-label">Harness</span>
          <span className="crp-toggle-summary">{summary}</span>
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
          <div className="crp-term" ref={bodyRef}>
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
}
