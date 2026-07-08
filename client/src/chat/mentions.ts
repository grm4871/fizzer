/**
 * Shared @mention parsing helpers used by chat send logic and the ChatView UI.
 */

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeMention(value: string) {
  return value.replace(/^@+/, '').trim();
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

export function getMentionedRegistrations<T extends MentionableAgent>(
  text: string,
  registrations: T[],
  fromAgent: boolean,
): T[] {
  const mentioned: T[] = [];
  for (const registration of registrations) {
    if (fromAgent && !registration.taggableByAgents) continue;
    const mention = normalizeMention(registration.mention || registration.agentId);
    if (mention && mentionPattern(mention).test(text)) mentioned.push(registration);
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
