/** Bounded shared-room context and natural typed chat relationships. */
import type Database from 'better-sqlite3';
import {
  getChatMessage,
  type ChatAgentRegistration,
  type ChatMessage,
  type ChatMission,
  type ChatRelationship,
} from './chat.js';

type Db = Database.Database;

export const MAX_CHAT_COLLABORATION_HOPS = 4;

function normalizeMention(value: string): string {
  return String(value || '')
    .replace(/^@+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionsAgent(text: string, registration: ChatAgentRegistration): boolean {
  const mention = normalizeMention(registration.mention || registration.agentId);
  if (!mention) return false;
  const escaped = mention.split(/\s+/).map(escapeRegExp).join('[\\s-]*');
  return new RegExp(`@\\s*${escaped}(?=$|[\\s.,:;!?\\])}])`, 'i').test(text);
}

function compactText(value: string, maxChars: number): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(1, maxChars - 1))}…`;
}

function messagePreview(message: ChatMessage, maxChars = 180): string {
  const body = compactText(message.body, maxChars);
  if (body && body !== 'Thinking...') return body;
  const images = message.images?.length || (message.hasImages ? 1 : 0);
  if (images) return `[${images} image${images === 1 ? '' : 's'}]`;
  if (message.attachments?.length) return `[attachment: ${message.attachments[0]?.name || 'file'}]`;
  return '(message)';
}

/** Infer durable semantics only for language that clearly refers to prior work. */
export function inferChatRelationship(text: string): ChatRelationship | undefined {
  const value = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!value) return undefined;
  if (/\b(?:contradict|disagree with|push back on|argue against|challenge (?:this|that|the)|find (?:the )?flaws? in|devil['’]s advocate)\b/.test(value)) {
    return 'contradiction';
  }
  if (/\b(?:make the call|settle (?:this|that)|decide (?:this|that|between|which)|choose between|which (?:one|option|approach).{0,30}\bchoose)\b/.test(value)) {
    return 'decision';
  }
  if (/\b(?:what do you think|thoughts on (?:this|that|the)|review (?:this|that|the|my)|critique (?:this|that|the|my)|audit (?:this|that|the)|check (?:this|that|the (?:proposal|result|answer|approach|plan|evidence|claim)))\b/.test(value)) {
    return 'review_request';
  }
  if (/\b(?:build on|build upon|extend (?:this|that|the)|continue from|take (?:this|that) further|carry (?:this|that) forward)\b/.test(value)) {
    return 'builds_on';
  }
  if (
    value.includes('?')
    && /\b(?:this|that|it|above|previous|proposal|result|answer|approach|plan|evidence|claim)\b/.test(value)
  ) return 'question';
  return undefined;
}

/**
 * Add an invisible typed edge to an ordinary reply or contextual @mention.
 * Standalone assignments remain unlinked, so nearby unrelated agent output is
 * never silently treated as evidence.
 */
export function inferNaturalChatLink(
  input: ChatMessage,
  priorMessages: ChatMessage[],
  registrations: ChatAgentRegistration[],
): ChatMessage {
  if (input.replyTo?.relationship) return input;
  const relationship = inferChatRelationship(input.body);
  if (!relationship) return input;

  if (input.replyTo) {
    return { ...input, replyTo: { ...input.replyTo, relationship } };
  }

  const sourceText = [
    input.body,
    ...(input.attachments || []).map((attachment) => attachment.name),
  ].filter(Boolean).join(' ');
  if (!registrations.some((registration) => mentionsAgent(sourceText, registration))) return input;

  const source = [...priorMessages].reverse().find((message) => {
    const preview = messagePreview(message);
    const hasMedia = Boolean(message.images?.length || message.hasImages || message.attachments?.length);
    const substantiveHumanTurn = !message.registrationId
      && !message.agentId
      && message.author !== 'Cascade'
      && compactText(message.body, 10_000).length >= 24;
    return message.status !== 'running'
      && preview !== '(message)'
      && (Boolean(message.registrationId || message.agentId) || substantiveHumanTurn || hasMedia);
  });
  if (!source) return input;
  const sourceRegistration = registrations.find((registration) => registration.id === source.registrationId);
  return {
    ...input,
    replyTo: {
      messageId: source.id,
      author: source.author,
      mention: sourceRegistration?.mention || normalizeMention(source.author),
      preview: messagePreview(source, 120),
      relationship,
    },
  };
}

/** Count typed parent edges, treating cycles as beyond the automatic hop limit. */
export function chatRelationshipDepth(
  db: Db,
  userId: number,
  channelId: string,
  source: ChatMessage,
): number {
  const seen = new Set<string>();
  let depth = 0;
  let current: ChatMessage | undefined = source;
  while (current?.replyTo?.relationship && current.replyTo.messageId && depth <= MAX_CHAT_COLLABORATION_HOPS) {
    if (seen.has(current.id)) return MAX_CHAT_COLLABORATION_HOPS + 1;
    seen.add(current.id);
    depth += 1;
    current = getChatMessage(db, channelId, userId, current.replyTo.messageId);
  }
  return depth;
}

function roomMessageLine(message: ChatMessage): string {
  const relation = message.replyTo?.relationship
    ? `; ${message.replyTo.relationship} → ${message.replyTo.author || message.replyTo.mention || 'linked message'}`
    : '';
  return `- ${message.author} [${message.id}${relation}]: ${messagePreview(message, 220)}`;
}

function missionLine(mission: ChatMission): string {
  const objective = compactText(mission.objective || mission.summary || '', 180);
  const tasks = mission.tasks
    .filter((task) => ['pending', 'running', 'blocked', 'failed'].includes(task.status))
    .slice(0, 3)
    .map((task) => `${task.assigneeMention ? `@${task.assigneeMention}` : task.assignee}: ${compactText(task.title, 70)} (${task.status})`)
    .join('; ');
  return `- ${compactText(mission.title, 100)} (${mission.status})${objective ? ` — ${objective}` : ''}${tasks ? `; work: ${tasks}` : ''}`;
}

export type AgentRoomContextOptions = {
  messages: ChatMessage[];
  registrations: ChatAgentRegistration[];
  missions?: ChatMission[];
  targetRegistrationId?: string;
  excludeMessageIds?: string[];
  includeOwnPrior?: boolean;
  maxChars?: number;
};

/**
 * A compact snapshot that lets every invocation rejoin the room. It carries
 * state and interleaved changes, while the renderer's focused reply/evidence
 * chain remains the authoritative task input.
 */
export function buildAgentRoomContext(options: AgentRoomContextOptions): string {
  const {
    messages,
    registrations,
    missions = [],
    targetRegistrationId = '',
    excludeMessageIds = [],
    includeOwnPrior = false,
    maxChars = 4_200,
  } = options;
  const excluded = new Set(excludeMessageIds.filter(Boolean));
  const roomMessages = messages.filter((message) => !excluded.has(message.id));
  const visibleMessages = roomMessages.filter((message) => (
    message.body.trim() !== 'Thinking...'
    && (message.body.trim() || message.images?.length || message.hasImages || message.attachments?.length)
  ));
  const target = registrations.find((registration) => registration.id === targetRegistrationId);

  const humanNames = new Set(visibleMessages
    .filter((message) => !message.registrationId && !message.agentId && message.author !== 'Cascade')
    .map((message) => message.author.trim())
    .filter(Boolean));
  const participantLabels = [
    ...Array.from(humanNames).slice(-8),
    ...registrations.slice(0, 10).map((registration) => (
      `${registration.displayName} (@${registration.mention || registration.agentId}${registration.orchestrator ? ', coordinator' : ''})`
    )),
  ];

  const activeMissions = missions
    .filter((mission) => ['active', 'reviewing', 'attention', 'blocked'].includes(mission.status))
    .slice(0, 3);
  const activeAgents = roomMessages
    .filter((message) => message.status === 'running' && message.registrationId)
    .slice(-4)
    .map((message) => {
      const registration = registrations.find((item) => item.id === message.registrationId);
      return `- @${registration?.mention || normalizeMention(message.author)} is running [${message.id}]`;
    });

  const typed = visibleMessages.filter((message) => Boolean(message.replyTo?.relationship));
  const childMessageIds = new Set(visibleMessages.map((message) => message.replyTo?.messageId).filter(Boolean));
  const decisions = typed.filter((message) => message.replyTo?.relationship === 'decision').slice(-3);
  const disagreements = typed.filter((message) => message.replyTo?.relationship === 'contradiction').slice(-3);
  const openQuestions = typed.filter((message) => (
    (message.replyTo?.relationship === 'question' || message.replyTo?.relationship === 'review_request')
    && !childMessageIds.has(message.id)
  )).slice(-3);

  let lastOwnIndex = -1;
  if (targetRegistrationId) {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      if (visibleMessages[index]?.registrationId === targetRegistrationId) {
        lastOwnIndex = index;
        break;
      }
    }
  }
  const roomChanges = (lastOwnIndex >= 0
    ? visibleMessages.slice(lastOwnIndex + 1)
    : visibleMessages.slice(-8))
    .filter((message) => message.registrationId !== targetRegistrationId)
    .slice(-10);
  const ownPrior = includeOwnPrior && targetRegistrationId
    ? visibleMessages.filter((message) => message.registrationId === targetRegistrationId).slice(-2)
    : [];

  const sections: string[] = [];
  if (participantLabels.length) sections.push(`Participants: ${participantLabels.join('; ')}`);
  if (activeMissions.length) sections.push(`Active goals:\n${activeMissions.map(missionLine).join('\n')}`);
  if (activeAgents.length) sections.push(`Active work:\n${activeAgents.join('\n')}`);
  if (decisions.length) sections.push(`Recent decisions:\n${decisions.map(roomMessageLine).join('\n')}`);
  if (disagreements.length) sections.push(`Recent disagreements:\n${disagreements.map(roomMessageLine).join('\n')}`);
  if (openQuestions.length) sections.push(`Open questions and reviews:\n${openQuestions.map(roomMessageLine).join('\n')}`);
  if (roomChanges.length) {
    sections.push(`${lastOwnIndex >= 0 && target ? `Since @${target.mention || target.agentId} last spoke` : 'Recent room conversation'}:\n${roomChanges.map(roomMessageLine).join('\n')}`);
  }
  if (ownPrior.length) sections.push(`Your recent contributions:\n${ownPrior.map(roomMessageLine).join('\n')}`);

  const footer = 'The focused request and quoted evidence in this turn take priority over this snapshot. '
    + 'For older raw chat, use `cascade-chat history --around-message-id <id> --include-reply-context`; '
    + 'use `cascade-chat search <query>` when you only know the topic.';
  const header = 'Shared room state (bounded current snapshot):';
  const budget = Math.max(1_200, maxChars) - footer.length - header.length - 4;
  let body = '';
  for (const section of sections) {
    const separator = body ? '\n\n' : '';
    const remaining = budget - body.length - separator.length;
    if (remaining <= 0) break;
    if (section.length <= remaining) {
      body += `${separator}${section}`;
      continue;
    }
    if (remaining >= 100) body += `${separator}${compactText(section, remaining)}`;
    break;
  }
  return `${header}${body ? `\n${body}` : ''}\n\n${footer}`;
}
