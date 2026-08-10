/**
 * Compact TUI-style stream for multi-agent channel chatter.
 * Intermediates fold to mono lines; expand a line for full body + harness.
 *
 * Intentionally avoids importing runtime values from ChatView (circular).
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Reply } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import {
  workTraceAuthorKey,
  workTraceDecals,
  isSteeringContinuationMessage,
  workTraceStatusLabel,
  workTraceSummary,
} from '../chat/workTrace';
import { hasRunActivity } from '../chat/harnessActivity';
import { CascadeRunPanel } from './CascadeRunPanel';
import { ChatQuoteRefs } from './ChatQuoteRefs';
import type { ChatMessage } from './ChatView';

const MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];

function formatTime(value: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  } catch {
    return '';
  }
}

function statusMark(message: ChatMessage): { mark: string; className: string } {
  if (message.status === 'failed') return { mark: '✗', className: 'err' };
  if (isSteeringContinuationMessage(message)) return { mark: '↪', className: 'steer' };
  if (message.status === 'canceled') return { mark: '✗', className: 'err' };
  if (message.status === 'running' || message.status === 'sending') return { mark: '…', className: 'run' };
  if (message.missionTaskId) return { mark: '›', className: 'task' };
  if (String(message.id || '').startsWith('sys-mission-') || message.author === 'Cascade') {
    return { mark: '#', className: 'sys' };
  }
  return { mark: '·', className: 'ok' };
}

function shouldRenderRunPanel(
  message: ChatMessage,
  selected: boolean,
  isLatestRunningMessage: boolean,
): boolean {
  if (selected) return true;
  if (message.status === 'failed' || message.status === 'canceled') return true;
  return message.status === 'running' && isLatestRunningMessage;
}

function WorkTraceBody({ body }: { body: string }) {
  const text = body.replace(/\\+`/g, '`');
  return (
    <div className="chat-work-line-md">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{text}</ReactMarkdown>
    </div>
  );
}

const WorkTraceLine = memo(function WorkTraceLine({
  message,
  open,
  onToggle,
  onCancelRun,
  onContextMenu,
  onReply,
  selected,
  vaultId,
  onHydrateMessage,
  latestRunningMessageId,
}: {
  message: ChatMessage;
  open: boolean;
  onToggle: () => void;
  onCancelRun: (runId: number) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  selected: boolean;
  vaultId?: string;
  onHydrateMessage?: (message: ChatMessage) => void;
  latestRunningMessageId?: string;
}) {
  const { mark, className } = statusMark(message);
  const author = workTraceAuthorKey(message);
  const preview = workTraceStatusLabel(message);
  const isLatestRunning = message.status !== 'running' || latestRunningMessageId === message.id;
  const showHarness = shouldRenderRunPanel(message, open || selected, isLatestRunning)
    && (message.status === 'running' || hasRunActivity(message) || open || selected);

  return (
    <div
      className={`chat-work-line ${open ? 'is-open' : ''} ${selected ? 'is-selected' : ''} status-${message.status || 'done'}`}
      data-message-id={message.id}
    >
      <button
        type="button"
        className="chat-work-line-fold"
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        onContextMenu={(event) => onContextMenu(event, message)}
        title={preview}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${author} work step: ${preview}`}
      >
        <span className={`chat-work-mark ${className}`} aria-hidden="true">{mark}</span>
        <span className="chat-work-author">{author}</span>
        <span className="chat-work-preview">{preview}</span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        <ChevronRight size={12} className={`chat-work-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <div className="chat-work-line-body">
          <ChatQuoteRefs message={message} />
          {message.body
            && !isSteeringContinuationMessage(message)
            && !(message.status === 'running' && /^Thinking(?:\.{3}|…)$/.test(message.body.trim()))
            && <WorkTraceBody body={message.body} />}
          {showHarness && (
            <CascadeRunPanel
              message={message}
              onCancelRun={onCancelRun}
              forceOpen={selected || message.status === 'running'}
              vaultId={vaultId}
              onHydrateMessage={onHydrateMessage}
            />
          )}
          <div className="chat-work-line-actions">
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onReply(message);
              }}
            >
              <Reply size={12} />
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export const ChatWorkTrace = memo(function ChatWorkTrace({
  trace,
  selectedMessageId,
  onCancelRun,
  onContextMenu,
  onReply,
  vaultId,
  onHydrateMessage,
  runningMessageState,
  artifactContent,
}: {
  trace: ChatMessage[];
  selectedMessageId: string | null;
  onCancelRun: (runId: number) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  vaultId?: string;
  onHydrateMessage?: (message: ChatMessage) => void;
  runningMessageState: ReadonlyMap<string, { latestId: string; count: number }>;
  artifactContent?: ReactNode;
}) {
  const live = trace.some((m) => m.status === 'running' || m.status === 'sending');
  const [open, setOpen] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const pinBottomRef = useRef(true);
  const summary = useMemo(() => workTraceSummary(trace), [trace]);
  const decals = useMemo(() => workTraceDecals(trace), [trace]);
  const currentPhase = decals[decals.length - 1]?.phase || 'working';

  useEffect(() => {
    if (!selectedMessageId) return;
    if (!trace.some((m) => m.id === selectedMessageId)) return;
    setOpen(true);
    setExpandedIds((prev) => {
      if (prev.has(selectedMessageId)) return prev;
      const next = new Set(prev);
      next.add(selectedMessageId);
      return next;
    });
  }, [selectedMessageId, trace]);

  useLayoutEffect(() => {
    if (!open || !live || !pinBottomRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [open, live, trace]);

  const toggleLine = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (trace.length === 0) return null;

  return (
    <div className={`chat-work-trace phase-${currentPhase} ${open ? 'is-open' : ''} ${live ? 'is-live' : ''}${artifactContent ? ' has-artifact' : ''}`}>
      <button
        type="button"
        className="chat-work-trace-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="chat-work-trace-kicker">flow</span>
        <span className="chat-work-decals" aria-label={`Workflow: ${decals.map((decal) => decal.label).join(', ')}`}>
          {decals.map((decal, index) => {
            const current = index === decals.length - 1;
            return (
              <span
                key={`${decal.phase}-${index}`}
                className={`chat-work-decal phase-${decal.phase}${current ? ' is-current' : ''}${current && live ? ' is-live' : ''}`}
                title={decal.label}
              >
                <span className="chat-work-decal-mark" aria-hidden="true">{decal.mark}</span>
                <span className="chat-work-decal-label">{decal.label}</span>
              </span>
            );
          })}
        </span>
        <span className="chat-work-trace-summary">{summary}</span>
        {live && <span className="ai-spinner chat-work-trace-spinner" aria-hidden="true" />}
        <ChevronRight size={13} className={`chat-work-trace-chevron${open ? ' open' : ''}`} />
      </button>
      {open && (
        <div
          ref={bodyRef}
          className="chat-work-trace-body"
          role="log"
          aria-label="Agent work trace"
          onScroll={(event) => {
            const el = event.currentTarget;
            pinBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
          }}
        >
          {trace.map((message) => {
            const runKey = message.registrationId || message.agentId || '';
            const runState = runKey ? runningMessageState.get(runKey) : undefined;
            return (
              <WorkTraceLine
                key={message.id}
                message={message}
                open={expandedIds.has(message.id) || message.status === 'running'}
                onToggle={() => toggleLine(message.id)}
                onCancelRun={onCancelRun}
                onContextMenu={onContextMenu}
                onReply={onReply}
                selected={selectedMessageId === message.id}
                vaultId={vaultId}
                onHydrateMessage={onHydrateMessage}
                latestRunningMessageId={runState?.latestId}
              />
            );
          })}
          {live && (
            <div className="chat-work-cursor" aria-hidden="true">
              <span>█</span>
            </div>
          )}
          {artifactContent && <div className="chat-work-trace-artifact">{artifactContent}</div>}
        </div>
      )}
    </div>
  );
});
