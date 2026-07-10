/**
 * Cascade harness run panel — structured activity view for agent runs.
 *
 * Parses thinking / tools / usage into a custom Cascade UI instead of dumping
 * raw JSONL into a terminal. Raw xterm remains available as an advanced tab.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  Brain,
  Check,
  ChevronRight,
  CircleDot,
  Cpu,
  Folder,
  Loader2,
  Square,
  TerminalSquare,
  Wrench,
  X,
} from 'lucide-react';
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
import { highlightJSON } from './jsonHighlighter';
import { HarnessTerminal } from './HarnessTerminal';
import type { ChatMessage } from './ChatView';

type PanelTab = 'timeline' | 'thinking' | 'raw';

function formatInputForDisplay(input: unknown): { kind: 'json' | 'text'; value: string } {
  if (input == null) return { kind: 'text', value: '' };
  if (typeof input === 'string') {
    const t = input.trim();
    if ((t.startsWith('{') || t.startsWith('[')) && t.length > 1) {
      try {
        return { kind: 'json', value: JSON.stringify(JSON.parse(t), null, 2) };
      } catch {
        return { kind: 'text', value: t };
      }
    }
    return { kind: 'text', value: t };
  }
  try {
    return { kind: 'json', value: JSON.stringify(input, null, 2) };
  } catch {
    return { kind: 'text', value: String(input) };
  }
}

function ToolStatusIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') return <Loader2 size={12} className="crp-spin" />;
  if (status === 'error') return <X size={12} />;
  return <Check size={12} />;
}

function TimelineItem({
  item,
  defaultOpen,
}: {
  item: ActivityItem;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const isTool = item.kind === 'tool' && item.tool;
  const isThinking = item.kind === 'thinking';
  const expandable = isTool || (isThinking && (item.text?.length || 0) > 160);

  const status = item.tool?.status || 'done';
  const inputDisp = isTool ? formatInputForDisplay(item.tool?.input) : null;
  const resultText = isTool ? toolResultPreview(item.tool?.result) : '';

  return (
    <div className={`crp-item crp-item-${item.kind} status-${status}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="crp-item-head"
        onClick={() => expandable && setOpen((v) => !v)}
        disabled={!expandable}
      >
        <span className="crp-item-icon" aria-hidden="true">
          {isThinking && <Brain size={13} />}
          {isTool && <Wrench size={13} />}
          {item.kind === 'system' && <CircleDot size={13} />}
          {item.kind === 'text' && <Activity size={13} />}
          {item.kind === 'meta' && <Folder size={13} />}
        </span>
        <span className="crp-item-title">{item.title}</span>
        {!open && item.text && (
          <span className="crp-item-preview">{item.text}</span>
        )}
        {isTool && (
          <span className={`crp-item-status status-${status}`}>
            <ToolStatusIcon status={status} />
          </span>
        )}
        {expandable && <ChevronRight size={13} className="crp-chevron" />}
      </button>
      {open && (
        <div className="crp-item-body">
          {isThinking && (
            <div className="crp-thinking-prose">{item.text}</div>
          )}
          {isTool && inputDisp && inputDisp.value && (
            <div className="crp-code-block">
              <div className="crp-code-label">Input</div>
              <pre className="crp-code">
                {inputDisp.kind === 'json'
                  ? highlightJSON(inputDisp.value)
                  : inputDisp.value}
              </pre>
            </div>
          )}
          {isTool && resultText && (
            <div className={`crp-code-block ${item.tool?.isError ? 'is-error' : ''}`}>
              <div className="crp-code-label">{item.tool?.isError ? 'Error' : 'Result'}</div>
              <pre className="crp-code">{resultText}</pre>
            </div>
          )}
          {isTool && !resultText && status === 'running' && (
            <div className="crp-item-muted">Running…</div>
          )}
        </div>
      )}
    </div>
  );
}

function StatsPills({ activity }: { activity: HarnessActivity }) {
  const pills: ReactNode[] = [];
  const { stats } = activity;
  if (stats.toolCount > 0) {
    pills.push(
      <span key="tools" className="crp-pill" title="Tool calls">
        <Wrench size={11} />
        {stats.toolCount}
      </span>,
    );
  }
  if (stats.hasThinking) {
    pills.push(
      <span key="think" className="crp-pill" title="Thinking length">
        <Brain size={11} />
        {formatTokenCount(stats.thinkingChars) || '·'}
      </span>,
    );
  }
  const tokIn = formatTokenCount(stats.inputTokens);
  const tokOut = formatTokenCount(stats.outputTokens);
  if (tokIn || tokOut) {
    pills.push(
      <span key="tok" className="crp-pill" title="Input → output tokens">
        <Cpu size={11} />
        {[tokIn || '?', tokOut || '?'].join('→')}
      </span>,
    );
  }
  const cost = formatCostUsd(stats.totalCostUsd);
  if (cost) {
    pills.push(
      <span key="cost" className="crp-pill" title="Estimated cost">
        {cost}
      </span>,
    );
  }
  const dur = formatDurationMs(stats.durationMs);
  if (dur) {
    pills.push(
      <span key="dur" className="crp-pill" title="Duration">
        {dur}
      </span>,
    );
  }
  if (stats.model) {
    pills.push(
      <span key="model" className="crp-pill crp-pill-model" title="Model">
        {stats.model}
      </span>,
    );
  }
  if (stats.cwd) {
    const short = stats.cwd.replace(/^\/home\/[^/]+/, '~').replace(/\/$/, '');
    const base = short.split('/').filter(Boolean).slice(-2).join('/') || short;
    pills.push(
      <span key="cwd" className="crp-pill" title={stats.cwd}>
        <Folder size={11} />
        {base}
      </span>,
    );
  }
  if (pills.length === 0) return null;
  return <div className="crp-pills">{pills}</div>;
}

export function CascadeRunPanel({
  message,
  onCancelRun,
  forceOpen = false,
}: {
  message: ChatMessage;
  onCancelRun: (runId: number) => void;
  /** When parent selects the message, keep the panel expanded. */
  forceOpen?: boolean;
}) {
  const isRunning = message.status === 'running';
  const activity = useMemo(() => buildHarnessActivity(message), [message]);
  const canExpand = hasRunActivity(message) || activity.items.length > 0 || activity.stats.hasRaw;
  const [open, setOpen] = useState(isRunning);
  const [tab, setTab] = useState<PanelTab>('timeline');
  const bodyRef = useRef<HTMLDivElement>(null);
  const summary = summarizeActivity(activity, isRunning);
  const repliedViaChat = !isRunning
    && !(message.body || '').trim()
    && (message.agentId || message.registrationId || message.runId != null);

  // Auto-open while running; stay open if user expanded or parent selected.
  useEffect(() => {
    if (isRunning) setOpen(true);
  }, [isRunning]);

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  // Follow timeline tail while running.
  useEffect(() => {
    if (!isRunning || !open || tab !== 'timeline') return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [activity.items.length, activity.thinkingText.length, isRunning, open, tab]);

  // Prefer thinking tab content when only thinking exists
  useEffect(() => {
    if (tab === 'timeline' && activity.items.length === 0 && activity.stats.hasThinking) {
      setTab('thinking');
    }
  }, [activity.items.length, activity.stats.hasThinking, tab]);

  if (!isRunning && !canExpand) return null;

  const showThinkingTab = activity.stats.hasThinking;
  const showRawTab = activity.stats.hasRaw;
  const effectiveOpen = open || forceOpen;

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
          <span className="crp-toggle-icon" aria-hidden="true">
            {isRunning ? <Activity size={13} /> : <TerminalSquare size={13} />}
          </span>
          <span className="crp-toggle-label">
            {isRunning ? 'Live run' : repliedViaChat ? 'Run activity' : 'Run'}
          </span>
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
          <StatsPills activity={activity} />

          {(showThinkingTab || showRawTab || activity.items.length > 0) && (
            <div className="crp-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'timeline'}
                className={tab === 'timeline' ? 'active' : ''}
                onClick={() => setTab('timeline')}
              >
                Timeline
              </button>
              {showThinkingTab && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'thinking'}
                  className={tab === 'thinking' ? 'active' : ''}
                  onClick={() => setTab('thinking')}
                >
                  Thinking
                </button>
              )}
              {showRawTab && (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'raw'}
                  className={tab === 'raw' ? 'active' : ''}
                  onClick={() => setTab('raw')}
                >
                  Raw
                </button>
              )}
            </div>
          )}

          <div className="crp-body" ref={bodyRef}>
            {tab === 'timeline' && (
              <div className="crp-timeline">
                {activity.items.length === 0 && !activity.stats.hasThinking && (
                  <div className="crp-empty">
                    {isRunning
                      ? 'Waiting for the harness to stream activity…'
                      : 'No structured activity recorded for this run.'}
                  </div>
                )}
                {activity.items.map((item, index) => (
                  <TimelineItem
                    key={item.id}
                    item={item}
                    defaultOpen={
                      isRunning
                      && index === activity.items.length - 1
                      && (item.kind === 'thinking' || item.tool?.status === 'running')
                    }
                  />
                ))}
                {activity.items.length === 0 && activity.stats.hasThinking && (
                  <TimelineItem
                    item={{
                      id: 'thinking-only',
                      kind: 'thinking',
                      title: 'Thinking',
                      text: activity.thinkingText,
                    }}
                    defaultOpen
                  />
                )}
              </div>
            )}

            {tab === 'thinking' && (
              <div className="crp-thinking-full">
                {activity.thinkingText
                  ? <div className="crp-thinking-prose">{activity.thinkingText}</div>
                  : <div className="crp-empty">No thinking trace.</div>}
              </div>
            )}

            {tab === 'raw' && (
              <div className="crp-raw-wrap">
                <HarnessTerminal content={activity.rawLog} active={isRunning} />
              </div>
            )}
          </div>

          {repliedViaChat && (
            <div className="crp-footnote">
              Reply was posted via chat send — this panel is the run record.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
