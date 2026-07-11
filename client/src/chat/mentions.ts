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
