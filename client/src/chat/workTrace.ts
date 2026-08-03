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
  if (message.status === 'canceled') return 'canceled';
  const preview = workTracePreview(message.body || '');
  return preview || '(empty)';
}

/**
 * Within a consecutive agent/system run, decide which messages collapse.
 * Mission/media artifacts and the last settled non-worker answer stay full.
 * Live shells remain in the trace so operator-visible work does not recreate
 * the verbose stack this component exists to collapse.
 */
export function partitionWorkRun(
  messages: ChatMessage[],
  options?: { coordinatorRegistrationIds?: ReadonlySet<string> },
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
    if (shouldRenderFullInWorkRun(message, isLast, options?.coordinatorRegistrationIds)) {
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
  coordinatorRegistrationIds?: ReadonlySet<string>,
): boolean {
  if (message.mission || message.changeRequest) return true;
  if (message.hasImages || message.images?.length || message.attachments?.length) return true;
  // Coordinator prose addresses the operator. Keep it conversational even if
  // a later worker wake or placeholder is appended to the same agent streak.
  if (
    message.registrationId
    && coordinatorRegistrationIds?.has(message.registrationId)
    && !isForcedWorkTraceLine(message)
  ) return true;
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
    coordinatorRegistrationIds?: ReadonlySet<string>;
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

    const { trace, full } = partitionWorkRun(work, {
      coordinatorRegistrationIds: options?.coordinatorRegistrationIds,
    });
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
