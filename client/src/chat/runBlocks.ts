/**
 * Pure helpers for turning agent run events into chat message blocks/patches.
 */

import type { ChatBlock, ChatMessage } from './types';

export function newId(prefix: string) {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

/** ISO timestamp strictly after `iso` (and not before now). Used so agent shells
 * never share a millisecond with the prompt they reply to — that race was
 * flipping transcript order when the agent row got a lower seq first. */
export function afterChatTimestamp(iso: string | undefined | null): string {
  const now = Date.now();
  const base = iso ? Date.parse(iso) : NaN;
  const ms = Number.isFinite(base) ? Math.max(now, base + 1) : now;
  return new Date(ms).toISOString();
}

export function textFromRunContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: unknown) => {
      if (!block || typeof block !== 'object') return '';
      const rec = block as Record<string, unknown>;
      if (rec.type === 'text' && typeof rec.text === 'string') return rec.text;
      return '';
    })
    .join('');
}

export function normalizeChatRunBlocks(content: unknown): ChatBlock[] {
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ChatBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', text: String(block.thinking || block.text || '') });
    } else if (block.type === 'redacted_thinking') {
      blocks.push({ type: 'thinking', text: '', redacted: true });
    } else if (block.type === 'tool_use') {
      blocks.push({
        type: 'tool_use',
        id: typeof block.id === 'string' ? block.id : undefined,
        name: typeof block.name === 'string' ? block.name : 'tool',
        input: block.input,
      });
    } else if (block.type === 'tool_result') {
      const rawContent = block.content;
      let contentText = '';
      if (typeof rawContent === 'string') {
        contentText = rawContent;
      } else if (Array.isArray(rawContent)) {
        contentText = rawContent
          .map((part) => {
            if (!part || typeof part !== 'object') return '';
            const rec = part as Record<string, unknown>;
            if (typeof rec.text === 'string') return rec.text;
            return '';
          })
          .filter(Boolean)
          .join('\n');
      } else if (rawContent != null) {
        try {
          contentText = JSON.stringify(rawContent);
        } catch {
          contentText = String(rawContent);
        }
      }
      blocks.push({
        type: 'tool_result',
        toolUseId: typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : typeof block.toolUseId === 'string'
            ? block.toolUseId
            : undefined,
        content: contentText,
        text: contentText,
        isError: block.is_error === true || block.isError === true,
      });
    }
  }
  return blocks;
}

export function hasChatRunToolBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const type = (item as Record<string, unknown>).type;
    return type === 'tool_use' || type === 'tool_result';
  });
}

export function appendChatRunBlocks(existing: ChatBlock[] | undefined, blocks: ChatBlock[]) {
  const next = [...(existing ?? [])];
  for (const block of blocks) {
    const last = next[next.length - 1];
    if (last && last.type === block.type && (block.type === 'text' || block.type === 'thinking')) {
      next[next.length - 1] = {
        ...last,
        text: `${last.text || ''}${block.text || ''}`,
      };
      continue;
    }
    // Merge tool_use updates for the same id (partial → final input).
    if (block.type === 'tool_use' && block.id) {
      const existingIdx = next.findIndex((b) => b.type === 'tool_use' && b.id === block.id);
      if (existingIdx >= 0) {
        next[existingIdx] = {
          ...next[existingIdx],
          name: block.name || next[existingIdx].name,
          input: block.input !== undefined ? block.input : next[existingIdx].input,
        };
        continue;
      }
    }
    next.push({ ...block });
  }
  return next;
}

/** Cap in-memory harness logs (matches server HARNESS_LOG_MAX_CHARS). */
export const HARNESS_LOG_MAX_CHARS = 512_000;

/** Append a harness chunk, keeping only the tail when over the size cap. */
export function appendHarnessLog(existing: string | undefined, chunk: string, max = HARNESS_LOG_MAX_CHARS): string {
  if (!chunk) return existing || '';
  const next = (existing || '') + chunk;
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

function chatMessageStreamScore(message: ChatMessage): number {
  const bodyLen = message.body?.length ?? 0;
  const blockScore = (message.blocks ?? []).reduce((sum, block) => {
    if (block.type === 'tool_use') return sum + 200 + (block.name?.length ?? 0);
    if (block.type === 'tool_result') return sum + Math.min(block.content?.length ?? block.text?.length ?? 0, 4000);
    // Prefer structured thinking in blocks over stuffing it into body length.
    if (block.type === 'thinking') return sum + Math.min(block.text?.length ?? 0, 2000);
    return sum + Math.min(block.text?.length ?? 0, 4000);
  }, 0);
  const harnessScore = Math.min(message.harnessLog?.length ?? 0, 50_000);
  // Terminal statuses outrank running; canceled is a real terminal state.
  const statusScore = message.status === 'running'
    ? 1
    : message.status === 'failed' || message.status === 'canceled'
      ? 2
      : 10;
  // Dual-post suppress: completed run shell with empty body must beat a local
  // copy that still holds streamed monologue (otherwise thinking reappears).
  const suppressShell = statusScore === 10
    && message.runId != null
    && !(message.body?.trim())
    ? 900_000
    : 0;
  // Cap body influence so monologue length can't overturn terminal status/suppress.
  const bodyScore = Math.min(bodyLen, 8_000);
  return statusScore * 1_000_000 + suppressShell + bodyScore + blockScore + harnessScore;
}

/** Prefer the runner's latest final answer over accumulated progress text. */
export function honestAgentChatBody(
  streamedText: string,
  summary: string | undefined,
  terminal: 'completed' | 'failed' | 'canceled',
  opts?: { suppressChatBody?: boolean },
): string {
  const trimmed = streamedText.trim();
  const summaryText = typeof summary === 'string' ? summary.trim() : '';
  const isGenericSummary = isGenericAgentRunSummary(summaryText);
  const usefulStream = trimmed && !isGenericAgentRunSummary(trimmed) ? trimmed : '';

  // Automatic lifecycle cleanup (for example an obsolete mission review wake)
  // is terminal but is not a user-visible agent reply.
  if (opts?.suppressChatBody) return '';
  if (terminal === 'failed' || terminal === 'canceled') {
    const reason = summaryText
      || (terminal === 'canceled' ? 'Run canceled by user.' : 'Agent failed.');
    // Prefer a short failure reason; don't dump the whole mid-run monologue.
    if (usefulStream && usefulStream.length <= 800) return `${usefulStream}\n\n> ⚠️ ${reason}`;
    return reason;
  }
  if (summaryText && !isGenericSummary) return summaryText;
  if (usefulStream) return usefulStream;
  // No invented placeholder: empty completed bodies drop the run shell
  // (same path as dual-post suppress after cascade-chat send).
  return '';
}

/** Runner/SDK placeholders — not a real assistant answer. Never surface these. */
export function isGenericAgentRunSummary(summary: string): boolean {
  return /^(done\.?|completed note operations successfully\.?|agent failed\.?)$/i.test(summary.trim());
}

/** Optimistic agent shells the originating desktop paints before the fold catches up. */
export function isLiveAgentPlaceholder(body: string | undefined): boolean {
  const trimmed = String(body || '').trim();
  return trimmed === '' || /^(Thinking(?:\.{3}|…)|Queued\.{3})$/i.test(trimmed);
}

function isLiveAgentStatus(status: ChatMessage['status']): boolean {
  return status === 'running' || status === 'sending';
}

function isRemoteTerminalStatus(status: ChatMessage['status']): boolean {
  return status === 'failed' || status === 'canceled';
}

/** Prefer the richer of local streaming vs remote socket/DB copy of the same message. */
export function mergeRemoteChatMessage(local: ChatMessage, remote: ChatMessage): ChatMessage {
  const localScore = chatMessageStreamScore(local);
  const remoteScore = chatMessageStreamScore(remote);
  const harnessLog = (local.harnessLog?.length ?? 0) >= (remote.harnessLog?.length ?? 0)
    ? local.harnessLog
    : remote.harnessLog;
  // A slim transcript response deliberately replaces data-URL images with the
  // `hasImages` marker. Reconnect/soft-refresh reconciliation must not let that
  // marker overwrite media this renderer already hydrated, or an attachment
  // visibly disappears until the whole ChatView is remounted.
  const retainHydratedImages = (next: ChatMessage): ChatMessage => {
    const images = next.images?.length
      ? next.images
      : next.hasImages
        ? local.images
        : undefined;
    if (!images?.length) return next;
    const { hasImages: _strippedFromList, ...rest } = next;
    return { ...rest, images };
  };
  // Always keep server seq when either side has it — sort depends on it.
  const seq = remote.seq ?? local.seq;
  const withSeq = (next: ChatMessage): ChatMessage => (
    retainHydratedImages(seq != null && next.seq !== seq ? { ...next, seq } : next)
  );

  const localLive = isLiveAgentStatus(local.status);
  const remoteLive = isLiveAgentStatus(remote.status);
  const localIsHuman = !local.agentId && !local.registrationId;
  const remoteIsAgent = Boolean(remote.agentId || remote.registrationId);
  // A fold/update for an agent shell must never rewrite a human prompt that
  // happens to share the id, or the user's message vanishes when the agent
  // starts (work-trace treats agentId rows as agent traffic).
  if (localIsHuman && remoteIsAgent) {
    return withSeq(local);
  }
  // Owner desktop paints /runs immediately. A lagging fold must not rewind
  // that row to "Thinking..." or a shorter body. Cancel/fail from another
  // client is terminal and still wins below.
  if (localLive && (remoteLive || (isLiveAgentPlaceholder(remote.body) && !isRemoteTerminalStatus(remote.status)))) {
    const remotePlaceholder = isLiveAgentPlaceholder(remote.body);
    const localPlaceholder = isLiveAgentPlaceholder(local.body);
    const localLonger = (local.body?.length ?? 0) > (remote.body?.length ?? 0);
    const keepLocalBody = !localPlaceholder && (remotePlaceholder || localLonger);
    if (keepLocalBody || remotePlaceholder) {
      return withSeq({
        ...local,
        runId: remote.runId ?? local.runId,
        harnessLog: harnessLog || local.harnessLog,
        blocks: (local.blocks?.length ?? 0) >= (remote.blocks?.length ?? 0) ? local.blocks : remote.blocks,
      });
    }
  }

  if (remoteScore >= localScore) {
    const next = harnessLog && harnessLog !== remote.harnessLog
      ? { ...remote, harnessLog }
      : remote;
    return withSeq(next);
  }
  if (local.status === 'running' && !remote.status && remote.body.length >= local.body.length) {
    return withSeq({
      ...remote,
      blocks: remote.blocks?.length ? remote.blocks : local.blocks,
      harnessLog: harnessLog || remote.harnessLog || local.harnessLog,
    });
  }
  const next = harnessLog && harnessLog !== local.harnessLog
    ? { ...local, harnessLog }
    : local;
  return withSeq(next);
}

/** Apply a vault broadcast or list-API row onto a channel transcript. */
export function applyRemoteChatMessage(existing: ChatMessage[], remote: ChatMessage): ChatMessage[] {
  const index = existing.findIndex((message) => message.id === remote.id);
  const local = index === -1 ? undefined : existing[index];
  const emptyAgentShell = Boolean(
    remote.agentId
    && remote.status !== 'running'
    && isLiveAgentPlaceholder(remote.body),
  );
  if (emptyAgentShell) {
    const localIsHuman = Boolean(local && !local.agentId && !local.registrationId);
    // Never drop a human prompt. Dual-post suppress only applies to agent shells.
    if (localIsHuman) return existing;
    // Dual-post suppress: drop a settled empty shell unless this renderer is
    // still streaming a real answer for that id.
    if (local && isLiveAgentStatus(local.status) && !isLiveAgentPlaceholder(local.body)) {
      const merged = mergeRemoteChatMessage(local, remote);
      if (merged === local) return existing;
      const next = [...existing];
      next[index] = merged;
      return next;
    }
    if (index === -1) return existing;
    const next = existing.filter((message) => message.id !== remote.id);
    return next.length === existing.length ? existing : next;
  }
  if (!local) return [...existing, remote];
  const merged = mergeRemoteChatMessage(local, remote);
  if (merged === local) return existing;
  const next = [...existing];
  next[index] = merged;
  return next;
}

/** JSON patch body with explicit nulls so the server can clear status/blocks. */
export function toChatMessagePatch(message: ChatMessage): Record<string, unknown> {
  return {
    author: message.author,
    body: message.body,
    createdAt: message.createdAt,
    status: message.status ?? null,
    agentId: message.agentId ?? null,
    registrationId: message.registrationId ?? null,
    runId: message.runId ?? null,
    blocks: message.blocks ?? null,
    harnessLog: message.harnessLog ?? null,
    images: message.images ?? null,
    attachments: message.attachments ?? null,
    replyTo: message.replyTo ?? null,
  };
}
