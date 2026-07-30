/**
 * Shared @mention parsing helpers used by chat send logic and the ChatView UI.
 */

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Canonical handle: strip @, trim, lowercase (matches server vault uniqueness). */
export function normalizeMention(value: string) {
  return value
    .replace(/^@+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function mentionPattern(alias: string) {
  const escaped = alias.trim().split(/\s+/).map(escapeRegExp).join('[\\s-]*');
  return new RegExp(`@\\s*${escaped}(?=$|[\\s.,:;!?\\])}])`, 'gi');
}

export type MentionableAgent = {
  agentId: string;
  mention: string;
  taggableByAgents: boolean;
};

/** Resolve the channel member behind an agent-authored message. Older desktop
 * helpers did not attach registrationId, so fall back to one unambiguous
 * agentId + display-name match instead of silently dropping agent handoffs. */
export function resolveAgentMessageRegistration<T extends MentionableAgent & { id: string; displayName: string }>(
  message: { registrationId?: string; agentId?: string; author?: string },
  registrations: T[],
): T | undefined {
  if (message.registrationId) {
    const exact = registrations.find((item) => item.id === message.registrationId);
    if (exact) return exact;
  }
  if (!message.agentId || !message.author) return undefined;
  const author = message.author.trim().toLowerCase();
  const matches = registrations.filter((item) =>
    item.agentId === message.agentId && item.displayName.trim().toLowerCase() === author
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function getMentionedRegistrations<T extends MentionableAgent & { id?: string; vaultAgentId?: string }>(
  text: string,
  registrations: T[],
  fromAgent: boolean,
): T[] {
  const mentioned: T[] = [];
  const seen = new Set<string>();
  for (const registration of registrations) {
    if (fromAgent && !registration.taggableByAgents) continue;
    const mention = normalizeMention(registration.mention || registration.agentId);
    if (!mention || !mentionPattern(mention).test(text)) continue;
    // One trigger per vault identity (or registration id) even if denormalized copies exist.
    const key = registration.vaultAgentId || registration.id || mention;
    if (seen.has(key)) continue;
    seen.add(key);
    mentioned.push(registration);
  }
  return mentioned;
}

export function stripRegisteredAgentMentions(
  text: string,
  registrations: Array<{ agentId: string; mention: string }>,
) {
  let next = text;
  for (const registration of registrations) {
    const mention = normalizeMention(registration.mention || registration.agentId);
    if (mention) next = next.replace(mentionPattern(mention), ' ');
  }
  return next.replace(/\s+/g, ' ').trim();
}

type QuotableReplyRef = {
  messageId: string;
  author?: string;
  mention?: string;
  preview?: string;
};

type QuotableMessage = {
  id: string;
  body: string;
  author?: string;
  replyTo?: QuotableReplyRef;
};

/** Render the message a reply points at, so the quote reaches the agent as the ask.
 * The stored preview is clipped for the UI, so prefer the full body when the
 * quoted message is still in the loaded history.
 *
 * Replies chain: "that's not the failure I'm replying to" happens when the
 * quoted message is itself an answer, and the thing actually at issue is one
 * link further up. So walk the reply parents too — the agent needs the thread,
 * not just the last hop. */
export function buildQuotedReplyPrompt(
  replyTo: QuotableReplyRef,
  messages: QuotableMessage[],
  maxChars = 1_200,
  maxAncestors = 2,
) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const quote = (text: string, limit: number) => {
    const clipped = text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
    return clipped.split('\n').map((line) => `> ${line}`).join('\n');
  };

  const sections: string[] = [];
  const seen = new Set<string>();
  let ref: QuotableReplyRef | undefined = replyTo;
  for (let depth = 0; ref && depth <= maxAncestors; depth += 1) {
    if (seen.has(ref.messageId)) break;
    seen.add(ref.messageId);
    const message = byId.get(ref.messageId);
    const text = (message?.body.trim() || ref.preview?.trim() || '').trim();
    if (text) {
      const who = (ref.author || ref.mention || message?.author || '').trim() || 'a message';
      const header = depth === 0 ? `Replying to ${who}:` : `…which was itself replying to ${who}:`;
      sections.push(`${header}\n${quote(text, depth === 0 ? maxChars : Math.ceil(maxChars / 3))}`);
    }
    ref = message?.replyTo;
  }
  return sections.join('\n\n');
}

type BatchableChatMessage = {
  author: string;
  body: string;
  registrationId?: string;
  agentId?: string;
};

/** The contiguous message batch immediately before `nextMessage`, using the same
 * author/agent identity boundary as the chat's visual grouping. */
export function precedingMessageBatch<T extends BatchableChatMessage>(
  messages: T[],
  nextMessage: BatchableChatMessage,
) {
  const batch: T[] = [];
  const nextKey = nextMessage.registrationId ?? nextMessage.agentId ?? null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageKey = message.registrationId ?? message.agentId ?? null;
    if (message.author.trim() !== nextMessage.author.trim() || messageKey !== nextKey) break;
    batch.unshift(message);
  }
  return batch;
}

/** Text from the contiguous message batch immediately before `nextMessage`. */
export function precedingMessageBatchText(
  messages: BatchableChatMessage[],
  nextMessage: BatchableChatMessage,
) {
  return precedingMessageBatch(messages, nextMessage)
    .map((message) => message.body.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
