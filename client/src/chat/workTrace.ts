/**
 * Collapse multi-agent / mission channel chatter into a work-trace partition.
 *
 * Humans and single agent answers stay full chat bubbles. Consecutive agent
 * (and Cascade system) messages form a work run: intermediates become compact
 * TUI-style lines; the last settled non-worker answer stays a full bubble.
 */

import type { ChatMessage } from '../components/ChatView';

export interface ChatMessageGroup {
  messages: ChatMessage[];
}

function canGroup(a: ChatMessage, b: ChatMessage): boolean {
  if (a.author.trim() !== b.author.trim()) return false;
  const aKey = a.registrationId ?? a.agentId ?? null;
  const bKey = b.registrationId ?? b.agentId ?? null;
  return aKey === bKey;
}

export type TranscriptSegment =
  | { kind: 'group'; group: ChatMessageGroup }
  | {
      kind: 'work';
      /** Stable key for React (first message id in the raw run). */
      id: string;
      /** Compact TUI lines. */
      trace: ChatMessage[];
      /** Full-weight bubbles after the trace (final answer, live run, mission). */
      fullGroups: ChatMessageGroup[];
    };

export function isSystemCascadeMessage(message: Pick<ChatMessage, 'id' | 'author'>): boolean {
  return message.author === 'Cascade' || String(message.id || '').startsWith('sys-mission-');
}

/** Message belongs in the agent work stream rather than human conversation. */
export function isWorkTraceMessage(
  message: Pick<ChatMessage, 'id' | 'author' | 'agentId' | 'registrationId'>,
  agentAuthors?: ReadonlySet<string>,
): boolean {
  if (message.agentId || message.registrationId) return true;
  if (isSystemCascadeMessage(message)) return true;
  if (agentAuthors && message.author && agentAuthors.has(message.author)) return true;
  return false;
}

/** Always a compact line — never the user-facing final answer. */
export function isForcedWorkTraceLine(
  message: Pick<ChatMessage, 'id' | 'author' | 'missionTaskId'>,
): boolean {
  if (message.missionTaskId) return true;
  return isSystemCascadeMessage(message);
}

export function workTracePreview(body: string, max = 110): string {
  const line = String(body || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0) || '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(1, max - 1))}…`;
}

export function workTraceStatusLabel(message: Pick<ChatMessage, 'status' | 'body'>): string {
  if (message.status === 'running') return 'working…';
  if (message.status === 'sending') return 'queued…';
  if (message.status === 'failed') return 'failed';
  if (isSteeringContinuationMessage(message)) return 'steered';
  if (message.status === 'canceled') return 'canceled';
  const preview = workTracePreview(message.body || '');
  return preview || '(empty)';
}

/** Durable steering sentinel: useful for presentation state, never user-facing prose. */
export function isSteeringContinuationMessage(
  message: Pick<ChatMessage, 'status' | 'body'>,
): boolean {
  return message.status === 'canceled'
    && /steered into the continuation below/i.test(message.body || '');
}

export type WorkTracePhase =
  | 'routing'
  | 'working'
  | 'waiting'
  | 'steering'
  | 'reviewing'
  | 'testing'
  | 'deploying'
  | 'blocked'
  | 'complete';

export interface WorkTraceDecal {
  phase: WorkTracePhase;
  label: string;
  mark: string;
}

const WORK_TRACE_DECALS: Record<WorkTracePhase, WorkTraceDecal> = {
  routing: { phase: 'routing', label: 'route', mark: '↗' },
  working: { phase: 'working', label: 'work', mark: '◌' },
  waiting: { phase: 'waiting', label: 'wait', mark: '⋯' },
  steering: { phase: 'steering', label: 'steer', mark: '↪' },
  reviewing: { phase: 'reviewing', label: 'review', mark: '◇' },
  testing: { phase: 'testing', label: 'test', mark: '✓' },
  deploying: { phase: 'deploying', label: 'deploy', mark: '↑' },
  blocked: { phase: 'blocked', label: 'blocked', mark: '!' },
  complete: { phase: 'complete', label: 'complete', mark: '✓' },
};

/** Best available workflow phase from durable status plus a conservative live-text overlay. */
export function workTracePhase(
  message: Pick<ChatMessage, 'id' | 'author' | 'body' | 'status' | 'missionTaskId' | 'harnessLog'>,
): WorkTracePhase {
  const text = `${message.body || ''}\n${message.harnessLog || ''}`.toLowerCase();
  // Steering cancel is intentional flow, not a hard block.
  if (isSteeringContinuationMessage(message)) return 'steering';
  if (message.status === 'failed') return 'blocked';
  if (/\b(steer|redirect|change direction|supersed)/.test(text)) return 'steering';
  if (message.status === 'canceled') return 'blocked';
  if (isSystemCascadeMessage(message) || /\b(review|reconcil|ready for review)/.test(text)) return 'reviewing';
  if (message.status === 'running' || message.status === 'sending') {
    if (/\b(deploy|ship|release|production|prod\b)/.test(text)) return 'deploying';
    if (/\b(test|verify|verification|lint|runtime|regression|check)/.test(text)) return 'testing';
    if (/\b(wait|waiting|blocked on|dependency|agent busy)/.test(text)) return 'waiting';
    if (message.status === 'sending' || message.missionTaskId) return 'routing';
    return 'working';
  }
  if (message.missionTaskId) return 'complete';
  return 'complete';
}

/** Ordered, de-duplicated workflow trail for the collapsed header. */
export function workTraceDecals(trace: ChatMessage[]): WorkTraceDecal[] {
  const phases: WorkTracePhase[] = [];
  for (const message of trace) {
    const phase = workTracePhase(message);
    if (phases[phases.length - 1] !== phase) phases.push(phase);
  }
  return phases.slice(-6).map((phase) => WORK_TRACE_DECALS[phase]);
}

/**
 * Within a consecutive agent/system run, decide which messages collapse.
 * Mission/media artifacts and the last settled non-worker answer stay full.
 * Live shells remain in the trace so operator-visible work does not recreate
 * the verbose stack this component exists to collapse.
 */
export function partitionWorkRun(
  messages: ChatMessage[],
): { trace: ChatMessage[]; full: ChatMessage[] } {
  if (messages.length === 0) return { trace: [], full: [] };

  // Lone ordinary reply → normal chat bubble (no work chrome).
  if (messages.length === 1 && !isForcedWorkTraceLine(messages[0])) {
    return { trace: [], full: messages };
  }

  const trace: ChatMessage[] = [];
  const full: ChatMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const isLast = index === messages.length - 1;
    if (shouldRenderFullInWorkRun(message, isLast)) {
      full.push(message);
    } else {
      trace.push(message);
    }
  }

  return { trace, full };
}

function shouldRenderFullInWorkRun(
  message: ChatMessage,
  isLast: boolean,
): boolean {
  if (message.mission || message.changeRequest || message.clarification) return true;
  if (message.hasImages || message.images?.length || message.attachments?.length) return true;
  // Final user-facing answer of a multi-message run.
  if (
    isLast
    && message.status !== 'running'
    && message.status !== 'sending'
    && !isForcedWorkTraceLine(message)
  ) return true;
  return false;
}

function groupMessages(messages: ChatMessage[]): ChatMessageGroup[] {
  const groups: ChatMessageGroup[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && canGroup(last.messages[last.messages.length - 1], message)) {
      last.messages.push(message);
    } else {
      groups.push({ messages: [message] });
    }
  }
  return groups;
}

/**
 * Split a sorted transcript into human groups and agent work runs.
 * Work runs with no compact lines fall back to ordinary groups.
 */
export function segmentTranscript(
  messages: ChatMessage[],
  options?: {
    agentAuthors?: ReadonlySet<string>;
  },
): TranscriptSegment[] {
  const agentAuthors = options?.agentAuthors;
  const segments: TranscriptSegment[] = [];
  let index = 0;

  while (index < messages.length) {
    const head = messages[index];
    if (!isWorkTraceMessage(head, agentAuthors)) {
      const human: ChatMessage[] = [];
      while (index < messages.length && !isWorkTraceMessage(messages[index], agentAuthors)) {
        human.push(messages[index]);
        index += 1;
      }
      for (const group of groupMessages(human)) {
        segments.push({ kind: 'group', group });
      }
      continue;
    }

    const work: ChatMessage[] = [];
    while (index < messages.length && isWorkTraceMessage(messages[index], agentAuthors)) {
      work.push(messages[index]);
      index += 1;
    }

    const { trace, full } = partitionWorkRun(work);
    if (trace.length === 0) {
      for (const group of groupMessages(full.length ? full : work)) {
        segments.push({ kind: 'group', group });
      }
      continue;
    }

    // Preserve exact chronology when a full-weight artifact appears inside a
    // work run. A single trace + trailing fullGroups would move later compact
    // messages ahead of that artifact.
    const traceIds = new Set(trace.map((message) => message.id));
    let compact: ChatMessage[] = [];
    let fullWeight: ChatMessage[] = [];
    const flushCompact = () => {
      if (compact.length === 0) return;
      segments.push({
        kind: 'work',
        id: compact[0].id,
        trace: compact,
        fullGroups: [],
      });
      compact = [];
    };
    const flushFull = () => {
      if (fullWeight.length === 0) return;
      for (const group of groupMessages(fullWeight)) segments.push({ kind: 'group', group });
      fullWeight = [];
    };
    for (const message of work) {
      if (traceIds.has(message.id)) {
        flushFull();
        compact.push(message);
      } else {
        flushCompact();
        fullWeight.push(message);
      }
    }
    flushCompact();
    flushFull();
  }

  return segments;
}

export function workTraceAuthorKey(message: Pick<ChatMessage, 'author'>): string {
  return String(message.author || 'agent').trim() || 'agent';
}

export function workTraceSummary(trace: ChatMessage[]): string {
  if (trace.length === 0) return 'work';
  const authors: string[] = [];
  const seen = new Set<string>();
  for (const message of trace) {
    const key = workTraceAuthorKey(message).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(workTraceAuthorKey(message));
    if (authors.length >= 3) break;
  }
  const more = new Set(trace.map((m) => workTraceAuthorKey(m).toLowerCase())).size - authors.length;
  const who = more > 0 ? `${authors.join(' · ')} +${more}` : authors.join(' · ');
  const live = trace.some((m) => m.status === 'running' || m.status === 'sending');
  const n = trace.length;
  return live
    ? `${n} step${n === 1 ? '' : 's'} · ${who} · live`
    : `${n} step${n === 1 ? '' : 's'} · ${who}`;
}
