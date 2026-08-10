/** Chat-native, single-target agent collaboration over durable message links. */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  CHAT_RELATIONSHIPS,
  assertChatChannel,
  createChatMessage,
  getChatMessage,
  listChatAgentMembers,
  type ChatMessage,
  type ChatRelationship,
} from './chat.js';
import {
  createChatAgentDispatchForRegistration,
  type ChatAgentDispatch,
} from './chat-dispatch.js';

type Db = Database.Database;

export const MAX_CHAT_COLLABORATION_HOPS = 4;

export type ChatCollaborationInput = {
  sourceMessageId: string;
  target: string;
  relationship: ChatRelationship;
  instruction: string;
  requestId?: string;
  /** Required for restricted agent-helper calls; ignored for browser users. */
  callerRegistrationId?: string;
  author?: string;
};

function normalizeMention(value: string): string {
  return String(value || '')
    .replace(/^@+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function messagePreview(message: ChatMessage): string {
  const body = message.body.replace(/\s+/g, ' ').trim();
  if (body) return body.length > 120 ? `${body.slice(0, 119)}…` : body;
  if (message.images?.length || message.hasImages) {
    const count = message.images?.length || 1;
    return `[${count} image${count === 1 ? '' : 's'}]`;
  }
  if (message.attachments?.length) return message.attachments[0]?.name || '[attachment]';
  return '(message)';
}

function collaborationDepth(db: Db, userId: number, channelId: string, source: ChatMessage): number {
  const seen = new Set<string>();
  let depth = 0;
  let current: ChatMessage | undefined = source;
  while (current?.replyTo?.relationship && current.replyTo.messageId && depth <= MAX_CHAT_COLLABORATION_HOPS) {
    if (seen.has(current.id)) return MAX_CHAT_COLLABORATION_HOPS;
    seen.add(current.id);
    depth += 1;
    current = getChatMessage(db, channelId, userId, current.replyTo.messageId);
  }
  return depth;
}

/**
 * Create exactly one typed handoff and exactly one durable dispatch. Permissions
 * are checked here because the direct dispatch primitive intentionally assumes
 * its caller has already established authority.
 */
export function createChatCollaboration(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  input: ChatCollaborationInput,
  fromAgent: boolean,
): { message: ChatMessage; dispatch: ChatAgentDispatch } {
  assertChatChannel(db, channelId, userId);
  const sourceMessageId = String(input.sourceMessageId || '').trim();
  const source = sourceMessageId ? getChatMessage(db, channelId, userId, sourceMessageId) : undefined;
  if (!source) throw new Error('Linked message not found in this channel');

  const relationship = String(input.relationship || '') as ChatRelationship;
  if (!CHAT_RELATIONSHIPS.includes(relationship)) throw new Error('Invalid collaboration relationship');
  const instruction = String(input.instruction || '').trim();
  if (!instruction) throw new Error('Collaboration instruction is required');
  if (instruction.length > 8_000) throw new Error('Collaboration instruction is too long');

  const members = listChatAgentMembers(db, channelId, userId);
  const targetRef = String(input.target || '').trim();
  const targetMention = normalizeMention(targetRef);
  const target = members.find((member) => (
    member.id === targetRef
    || normalizeMention(member.mention || member.agentId) === targetMention
  ));
  if (!target) throw new Error('Agent not found');

  const callerRegistrationId = String(input.callerRegistrationId || '').trim();
  if (fromAgent) {
    const caller = members.find((member) => member.id === callerRegistrationId);
    if (!caller || caller.ownerUserId !== userId) throw new Error('Agent helper identity is invalid');
    if (caller.id === target.id) throw new Error('An agent cannot hand work to itself');
    if (!target.taggableByAgents) throw new Error(`@${target.mention} is not accepting agent handoffs`);
    if (target.ownerUserId !== userId && !target.pingableByOthers) {
      throw new Error(`@${target.mention} is not accepting pings from other users`);
    }
    if (collaborationDepth(db, userId, channelId, source) >= MAX_CHAT_COLLABORATION_HOPS) {
      throw new Error(`Collaboration hop limit (${MAX_CHAT_COLLABORATION_HOPS}) reached`);
    }
  } else if (target.ownerUserId !== userId && !target.pingableByOthers) {
    throw new Error(`@${target.mention} is not accepting pings from other users`);
  }

  const requestId = String(input.requestId || '').trim().slice(0, 180)
    || `collab-${crypto.randomUUID()}`;
  const body = `@${target.mention} ${instruction}`;
  const replyTo = {
    messageId: source.id,
    author: source.author,
    mention: source.registrationId
      ? (members.find((member) => member.id === source.registrationId)?.mention || '')
      : normalizeMention(source.author),
    preview: messagePreview(source),
    relationship,
  } as const;

  return db.transaction(() => {
    const existing = getChatMessage(db, channelId, userId, requestId);
    let message: ChatMessage;
    if (existing) {
      if (
        existing.body !== body
        || existing.replyTo?.messageId !== source.id
        || existing.replyTo?.relationship !== relationship
        || (fromAgent && existing.registrationId !== callerRegistrationId)
      ) {
        throw new Error('Collaboration request id is already in use');
      }
      message = existing;
    } else {
      message = createChatMessage(db, userId, vaultId, channelId, {
        id: requestId,
        channelId,
        author: fromAgent ? '' : String(input.author || '').trim(),
        body,
        createdAt: new Date().toISOString(),
        ...(fromAgent ? { registrationId: callerRegistrationId } : {}),
        replyTo,
      });
    }

    const priorTargets = db.prepare(
      'SELECT registration_id FROM chat_agent_dispatches WHERE message_id = ?',
    ).all(message.id) as Array<{ registration_id: string }>;
    if (priorTargets.some((row) => row.registration_id !== target.id)) {
      throw new Error('Collaboration request is already assigned to another agent');
    }
    const dispatch = createChatAgentDispatchForRegistration(db, userId, channelId, message, target.id);
    return { message, dispatch };
  })();
}
