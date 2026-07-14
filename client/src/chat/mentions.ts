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

type BatchableChatMessage = {
  author: string;
  body: string;
  registrationId?: string;
  agentId?: string;
};

/** Text from the contiguous message batch immediately before `nextMessage`.
 * Uses the same author/agent identity boundary as the chat's visual grouping. */
export function precedingMessageBatchText(
  messages: BatchableChatMessage[],
  nextMessage: BatchableChatMessage,
) {
  const bodies: string[] = [];
  const nextKey = nextMessage.registrationId ?? nextMessage.agentId ?? null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageKey = message.registrationId ?? message.agentId ?? null;
    if (message.author.trim() !== nextMessage.author.trim() || messageKey !== nextKey) break;
    const body = message.body.trim();
    if (body) bodies.unshift(body);
  }
  return bodies.join('\n').trim();
}
