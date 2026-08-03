/**
 * Durable chat -> agent dispatch outbox.
 *
 * A chat message and its intended agent runs must be persisted together. The
 * renderer may disappear after the message POST, or it may have a stale/empty
 * member cache after reconnecting. Keeping dispatch intent on the server lets
 * any live renderer retry it without guessing from old transcript history.
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  assertChatChannel,
  getChatMessage,
  listChatAgentMembers,
  type ChatAgentRegistration,
  type ChatMessage,
} from './chat.js';

type Db = Database.Database;

type DispatchRow = {
  id: string;
  message_id: string;
  channel_id: string;
  registration_id: string;
  run_id: number | null;
  reasoning_effort: string;
  created_at: string;
};

export type ChatAgentDispatch = {
  id: string;
  messageId: string;
  channelId: string;
  registration: ChatAgentRegistration;
  message: ChatMessage;
  runId: number | null;
  reasoningEffort: string;
  createdAt: string;
};

export function ensureChatDispatchSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_agent_dispatches (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      registration_id TEXT NOT NULL,
      run_id INTEGER,
      reasoning_effort TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id, registration_id)
    );
    CREATE INDEX IF NOT EXISTS chat_agent_dispatches_pending_idx
      ON chat_agent_dispatches(channel_id, run_id, created_at);
  `);
  const columns = db.prepare('PRAGMA table_info(chat_agent_dispatches)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'reasoning_effort')) {
    db.exec("ALTER TABLE chat_agent_dispatches ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''");
  }
}

function normalizeMention(value: string): string {
  return value
    .replace(/^@+/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, registration: ChatAgentRegistration): boolean {
  const mention = normalizeMention(registration.mention || registration.agentId);
  if (!mention) return false;
  const escaped = mention.split(/\s+/).map(escapeRegExp).join('[\\s-]*');
  return new RegExp(`@\\s*${escaped}(?=$|[\\s.,:;!?\\])}])`, 'i').test(text);
}

/** Resolve targets from canonical server membership, never renderer cache. */
export function resolveChatAgentTargets(
  db: Db,
  userId: number,
  channelId: string,
  message: ChatMessage,
): ChatAgentRegistration[] {
  const { route } = assertChatChannel(db, channelId, userId);
  const registrations = listChatAgentMembers(db, channelId, userId);
  const fromAgent = Boolean(message.registrationId || message.agentId);
  const repliedMessage = message.replyTo?.messageId
    ? getChatMessage(db, channelId, userId, message.replyTo.messageId)
    : undefined;
  // Reply refs derive a mention from every author, including humans. Only an
  // agent-authored quote is an implicit agent call.
  const implicitReply = !fromAgent && repliedMessage?.registrationId && message.replyTo?.mention
    ? `@${message.replyTo.mention}`
    : '';
  const attachmentNames = (message.attachments ?? []).map((item) => item.name).join(' ');
  const source = [implicitReply, message.body, attachmentNames].filter(Boolean).join(' ');
  const explicitlyMentioned = new Set(
    registrations.filter((registration) => mentions(source, registration)).map((registration) => registration.id),
  );
  const explicitlyCallsSpecialist = registrations.some((registration) => (
    !registration.orchestrator && explicitlyMentioned.has(registration.id)
  ));
  const sourceOwner = db.prepare('SELECT created_by FROM vaults WHERE id = ?')
    .get(route.sourceVaultId) as { created_by: number } | undefined;
  const requesterIsOwner = sourceOwner?.created_by === userId;
  const selected: ChatAgentRegistration[] = [];
  const seen = new Set<string>();

  for (const registration of registrations) {
    if (registration.id === message.registrationId) continue;
    // A shared-channel guest cannot create an outbox item they are forbidden
    // to launch. This avoids a permanently pending dispatch and a failed ghost
    // bubble on every connected renderer.
    if (!fromAgent && !requesterIsOwner && !registration.pingableByOthers) continue;
    // Ordinary agent prose never overrides the target's opt-in. Coordinator
    // authority crosses this boundary only through the explicit mission API,
    // which prevents a synthesis that names @worker from launching it again.
    if (fromAgent && !registration.taggableByAgents) continue;
    const explicit = explicitlyMentioned.has(registration.id);
    // An explicit specialist call is already the zero-hop route. Do not also
    // pay for the default coordinator unless the human named it too.
    const always = !fromAgent
      && registration.replyToEveryMessage
      && !(registration.orchestrator && explicitlyCallsSpecialist);
    if (!explicit && !always) continue;
    const key = registration.vaultAgentId || registration.id;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(registration);
  }
  return selected;
}

/** Insert one explicit target intent, including coordinator wakeups. */
export function createChatAgentDispatchForRegistration(
  db: Db,
  userId: number,
  channelId: string,
  message: ChatMessage,
  registrationId: string,
  options: { reasoningEffort?: string } = {},
): ChatAgentDispatch {
  const { route } = assertChatChannel(db, channelId, userId);
  const registration = listChatAgentMembers(db, channelId, userId)
    .find((item) => item.id === registrationId);
  if (!registration) throw new Error('Agent not found');
  db.prepare(`
    INSERT OR IGNORE INTO chat_agent_dispatches
      (id, message_id, channel_id, registration_id, reasoning_effort)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    message.id,
    route.sourceChannelId,
    registration.id,
    String(options.reasoningEffort || '').trim().toLowerCase(),
  );
  const row = db.prepare(`
    SELECT * FROM chat_agent_dispatches
    WHERE message_id = ? AND registration_id = ?
  `).get(message.id, registration.id) as DispatchRow;
  const dispatch = hydrateDispatch(db, userId, channelId, row);
  if (!dispatch) throw new Error('Could not create chat agent dispatch');
  return dispatch;
}

function hydrateDispatch(
  db: Db,
  userId: number,
  localChannelId: string,
  row: DispatchRow,
): ChatAgentDispatch | null {
  const registration = listChatAgentMembers(db, localChannelId, userId)
    .find((item) => item.id === row.registration_id);
  const message = getChatMessage(db, localChannelId, userId, row.message_id);
  if (!registration || !message) return null;
  return {
    id: row.id,
    messageId: row.message_id,
    channelId: localChannelId,
    registration,
    message,
    runId: row.run_id,
    reasoningEffort: row.reasoning_effort || '',
    createdAt: row.created_at,
  };
}

/** Insert target intents idempotently after the message itself is durable. */
export function createChatAgentDispatches(
  db: Db,
  userId: number,
  channelId: string,
  message: ChatMessage,
): ChatAgentDispatch[] {
  // Client-authored Cascade notices (for example `/clear`) are UI state, not a
  // new human turn, even when a channel has an always-reply agent.
  if (message.id.startsWith('sys-')) return [];
  const { route } = assertChatChannel(db, channelId, userId);
  const targets = resolveChatAgentTargets(db, userId, channelId, message);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO chat_agent_dispatches
      (id, message_id, channel_id, registration_id)
    VALUES (?, ?, ?, ?)
  `);
  const select = db.prepare(`
    SELECT * FROM chat_agent_dispatches
    WHERE message_id = ? AND registration_id = ?
  `);
  const dispatches: ChatAgentDispatch[] = [];
  for (const registration of targets) {
    insert.run(crypto.randomUUID(), message.id, route.sourceChannelId, registration.id);
    const row = select.get(message.id, registration.id) as DispatchRow;
    const dispatch = hydrateDispatch(db, userId, channelId, row);
    if (dispatch) dispatches.push(dispatch);
  }
  return dispatches;
}

export function listPendingChatAgentDispatches(
  db: Db,
  userId: number,
  channelId: string,
): ChatAgentDispatch[] {
  const { route } = assertChatChannel(db, channelId, userId);
  const sourceOwner = db.prepare('SELECT created_by FROM vaults WHERE id = ?')
    .get(route.sourceVaultId) as { created_by: number } | undefined;
  const requesterIsOwner = sourceOwner?.created_by === userId;
  const rows = db.prepare(`
    SELECT * FROM chat_agent_dispatches
    WHERE channel_id = ? AND run_id IS NULL
    ORDER BY created_at ASC, id ASC
  `).all(route.sourceChannelId) as DispatchRow[];
  return rows
    .map((row) => hydrateDispatch(db, userId, channelId, row))
    .filter((item): item is ChatAgentDispatch => Boolean(
      item && (requesterIsOwner || item.registration.pingableByOthers),
    ));
}

export function getChatAgentDispatch(
  db: Db,
  userId: number,
  channelId: string,
  dispatchId: string,
): ChatAgentDispatch | null {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db.prepare(`
    SELECT * FROM chat_agent_dispatches WHERE id = ? AND channel_id = ?
  `).get(dispatchId, route.sourceChannelId) as DispatchRow | undefined;
  return row ? hydrateDispatch(db, userId, channelId, row) : null;
}

export function attachRunToChatAgentDispatch(db: Db, dispatchId: string, runId: number): void {
  db.prepare(`
    UPDATE chat_agent_dispatches SET run_id = COALESCE(run_id, ?) WHERE id = ?
  `).run(runId, dispatchId);
}
