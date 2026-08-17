/**
 * Shared @mention parsing helpers used by chat send logic and the ChatView UI.
 */
import { relationshipPromptLabel, type ChatRelationship } from './relationships';

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

export function hasRegistrationForMention(
  mention: string,
  registrations: Array<Pick<MentionableAgent, 'agentId' | 'mention'>>,
): boolean {
  const target = normalizeMention(mention);
  return Boolean(target && registrations.some((registration) =>
    normalizeMention(registration.mention || registration.agentId) === target
  ));
}

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

/**
 * Does a reply quote point at an agent, i.e. is it supposed to start a run?
 *
 * A reply ref falls back to an author-derived @name, so replying to a person
 * carries a mention too — the mention alone cannot answer this, and treating it
 * as one made "could not route reply" fire on every human reply.
 */
export function replyQuoteTargetsAgent(
  replyTo: { messageId: string; mention?: string } | undefined,
  messages: Array<{ id: string; agentId?: string; registrationId?: string }>,
): boolean {
  if (!replyTo) return false;
  const quoted = messages.find((message) => message.id === replyTo.messageId);
  // A derived reply mention can belong to a person too. If the quoted row is
  // outside the loaded window, let the server inspect the authoritative parent
  // rather than showing a false agent-routing failure in the renderer.
  if (!quoted) return false;
  return Boolean(quoted.agentId || quoted.registrationId);
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

export function isCompactCommand(
  text: string,
  registrations: Array<{ agentId: string; mention: string }>,
) {
  return /^\/compact$/i.test(stripRegisteredAgentMentions(text, registrations).trim());
}

type QuotableReplyRef = {
  messageId: string;
  author?: string;
  mention?: string;
  preview?: string;
  relationship?: ChatRelationship;
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
/** Handles a message is addressed to, in the order they appear. */
export function addressedMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of String(body || '').matchAll(/(^|[\s(])@([A-Za-z0-9_-]{1,40})/g)) {
    const handle = normalizeMention(match[2]);
    if (handle) found.add(handle);
  }
  return [...found];
}

export function buildQuotedReplyPrompt(
  replyTo: QuotableReplyRef,
  messages: QuotableMessage[],
  maxChars = 1_200,
  maxAncestors = 4,
  /** Who this prompt is being built for, so an ancestor aimed at another agent
   * can be labelled as background instead of reading like a live instruction. */
  selfMention = '',
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
      // An ancestor addressed to a different agent is thread context, not this
      // agent's ask. Without this, whoever is prompted answers everyone's
      // questions in the chain.
      const addressed = addressedMentions(text);
      const me = normalizeMention(selfMention);
      const notMine = Boolean(me) && addressed.length > 0 && !addressed.includes(me);
      const aside = notMine
        ? ` (addressed to ${addressed.map((handle) => `@${handle}`).join(', ')}, not you — context only)`
        : '';
      const header = `${relationshipPromptLabel(ref.relationship, depth > 0)} ${who}${aside}:`;
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
  maxMessages = 8,
) {
  const batch: T[] = [];
  const nextKey = nextMessage.registrationId ?? nextMessage.agentId ?? null;
  const limit = Math.max(1, Math.floor(maxMessages));
  for (let index = messages.length - 1; index >= 0 && batch.length < limit; index -= 1) {
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
  maxChars = 4_000,
  maxMessages = 8,
) {
  const text = precedingMessageBatch(messages, nextMessage, maxMessages)
    .map((message) => message.body.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
  const limit = Math.max(80, Math.floor(maxChars));
  return text.length > limit ? `…${text.slice(-(limit - 1))}` : text;
}
