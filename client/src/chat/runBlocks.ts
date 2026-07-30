/**
 * Pure helpers for turning agent run events into chat message blocks/patches.
 */

import type { ChatBlock, ChatMessage } from '../components/ChatView';

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
  const isGeneric = /^(done\.?|completed note operations successfully\.?|agent failed\.?)$/i.test(summaryText);

  if (terminal === 'failed' || terminal === 'canceled') {
    const reason = summaryText
      || (terminal === 'canceled' ? 'Run canceled by user.' : 'Agent failed.');
    // Prefer a short failure reason; don't dump the whole mid-run monologue.
    if (trimmed && trimmed.length <= 800) return `${trimmed}\n\n> ⚠️ ${reason}`;
    return reason;
  }
  // Agent already posted via cascade-chat send — leave the run bubble empty.
  if (opts?.suppressChatBody) return '';
  if (summaryText && !isGeneric) return summaryText;
  if (trimmed) return trimmed;
  return summaryText || 'Done.';
}

/** Prefer the richer of local streaming vs remote socket/DB copy of the same message. */
export function mergeRemoteChatMessage(local: ChatMessage, remote: ChatMessage): ChatMessage {
  const localScore = chatMessageStreamScore(local);
  const remoteScore = chatMessageStreamScore(remote);
  const harnessLog = (local.harnessLog?.length ?? 0) >= (remote.harnessLog?.length ?? 0)
    ? local.harnessLog
    : remote.harnessLog;
  // Always keep server seq when either side has it — sort depends on it.
  const seq = remote.seq ?? local.seq;
  if (remoteScore >= localScore) {
    const next = harnessLog && harnessLog !== remote.harnessLog
      ? { ...remote, harnessLog }
      : remote;
    return seq != null && next.seq !== seq ? { ...next, seq } : next;
  }
  if (local.status === 'running' && !remote.status && remote.body.length >= local.body.length) {
    return {
      ...remote,
      blocks: remote.blocks?.length ? remote.blocks : local.blocks,
      harnessLog: harnessLog || remote.harnessLog || local.harnessLog,
      ...(seq != null ? { seq } : {}),
    };
  }
  const next = harnessLog && harnessLog !== local.harnessLog
    ? { ...local, harnessLog }
    : local;
  return seq != null && next.seq !== seq ? { ...next, seq } : next;
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
