/**
 * @file chat.ts — Server-side chat message persistence
 *
 * Chat channels are notes with content `cascade://chat-channel`. Messages are
 * stored in SQLite and broadcast to vault room subscribers via Socket.IO.
 *
 * @module server/chat
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { getNote, getVault, type Vault } from './vault.js';

type Db = Database.Database;

export const CHAT_NOTE_MARKER = 'cascade://chat-channel';

export type ChatReplyRef = {
  messageId: string;
  author: string;
  mention: string;
  preview: string;
};

export type ChatBlock = {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  redacted?: boolean;
};

/** Cap persisted harness terminal logs so a long run cannot bloat the DB. */
export const HARNESS_LOG_MAX_CHARS = 512_000;

export type ChatMessage = {
  id: string;
  channelId: string;
  author: string;
  body: string;
  createdAt: string;
  /** Monotonic persistence order (DB rowid). Tiebreaks messages that share a
   * millisecond `createdAt` so clients order them exactly as the server does
   * (see listChatMessages' `ORDER BY created_at ASC, rowid ASC`). Absent on
   * optimistic messages not yet persisted; those sort last among a tie (newest). */
  seq?: number;
  status?: 'sending' | 'running' | 'failed' | 'canceled';
  agentId?: string;
  registrationId?: string;
  runId?: number;
  blocks?: ChatBlock[];
  /** Full harness terminal transcript (raw process I/O / SDK stream). */
  harnessLog?: string;
  images?: string[];
  attachments?: Array<{ name: string; media_type: string; url: string }>;
  replyTo?: ChatReplyRef;
};

/** Append a harness chunk, keeping only the tail when over the size cap. */
export function appendHarnessLog(existing: string | undefined, chunk: string, max = HARNESS_LOG_MAX_CHARS): string {
  if (!chunk) return existing || '';
  const next = (existing || '') + chunk;
  if (next.length <= max) return next;
  return next.slice(next.length - max);
}

/** A registered agent member in a chat channel (shown in the member list, @mentionable). */
export type ChatAgentRegistration = {
  id: string;
  agentId: string;
  displayName: string;
  mention: string;
  model: string;
  cwd: string;
  contextPrompt: string;
  taggableByAgents: boolean;
  replyToEveryMessage: boolean;
  /** Allow users other than the agent owner to @mention/trigger it in a shared
   * (linked) channel. Opt-in; the run still executes on the owner's runner. */
  pingableByOthers: boolean;
  /** Run this agent with permission prompts bypassed ("yolo"). Scoped to this
   * registration; applied on the machine that executes the run. */
  yolo: boolean;
  /** Conversation id linking this member's runs into one resumable session. A
   * `/clear` command rotates this to start a fresh session. */
  conversationId: string;
};

type ChatMessageRow = {
  rowid?: number;
  id: string;
  channel_id: string;
  vault_id: string;
  author: string;
  body: string;
  created_at: string;
  status: string | null;
  agent_id: string | null;
  registration_id: string | null;
  run_id: number | null;
  blocks_json: string | null;
  harness_log: string | null;
  images_json: string | null;
  attachments_json: string | null;
  reply_to_json: string | null;
};

type RunStatusRow = {
  id: number;
  status: string;
  summary: string | null;
};

export type ChatChannelRoute = {
  localVaultId: string;
  localChannelId: string;
  sourceVaultId: string;
  sourceChannelId: string;
};

export function ensureChatSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT,
      agent_id TEXT,
      registration_id TEXT,
      run_id INTEGER,
      blocks_json TEXT,
      harness_log TEXT,
      images_json TEXT,
      attachments_json TEXT,
      reply_to_json TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages(channel_id, created_at);
    CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(author, body, content='chat_messages', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(rowid, author, body) VALUES (NEW.rowid, NEW.author, NEW.body);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, author, body) VALUES('delete', OLD.rowid, OLD.author, OLD.body);
    END;
    CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
      INSERT INTO chat_messages_fts(chat_messages_fts, rowid, author, body) VALUES('delete', OLD.rowid, OLD.author, OLD.body);
      INSERT INTO chat_messages_fts(rowid, author, body) VALUES (NEW.rowid, NEW.author, NEW.body);
    END;

    CREATE TABLE IF NOT EXISTS chat_agent_members (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      mention TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      context_prompt TEXT NOT NULL DEFAULT '',
      taggable_by_agents INTEGER NOT NULL DEFAULT 1,
      reply_to_every_message INTEGER NOT NULL DEFAULT 0,
      pingable_by_others INTEGER NOT NULL DEFAULT 0,
      yolo INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS chat_agent_members_channel_idx ON chat_agent_members(channel_id);

    CREATE TABLE IF NOT EXISTS chat_channel_links (
      local_channel_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      local_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      source_channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      source_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(local_vault_id, source_channel_id)
    );
    CREATE INDEX IF NOT EXISTS chat_channel_links_source_idx ON chat_channel_links(source_channel_id);
  `);

  // Migrations: add columns to pre-existing tables.
  const messageCols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
  if (!messageCols.some((col) => col.name === 'harness_log')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN harness_log TEXT');
  }
  const memberCols = db.prepare("PRAGMA table_info(chat_agent_members)").all() as Array<{ name: string }>;
  if (!memberCols.some((col) => col.name === 'yolo')) {
    db.exec('ALTER TABLE chat_agent_members ADD COLUMN yolo INTEGER NOT NULL DEFAULT 0');
  }
  if (!memberCols.some((col) => col.name === 'conversation_id')) {
    db.exec("ALTER TABLE chat_agent_members ADD COLUMN conversation_id TEXT NOT NULL DEFAULT ''");
  }
  if (!memberCols.some((col) => col.name === 'reply_to_every_message')) {
    db.exec('ALTER TABLE chat_agent_members ADD COLUMN reply_to_every_message INTEGER NOT NULL DEFAULT 0');
  }
  if (!memberCols.some((col) => col.name === 'pingable_by_others')) {
    db.exec('ALTER TABLE chat_agent_members ADD COLUMN pingable_by_others INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    INSERT INTO chat_messages_fts(rowid, author, body)
    SELECT cm.rowid, cm.author, cm.body
    FROM chat_messages cm
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_messages_fts fts WHERE fts.rowid = cm.rowid
    );
  `);
}

type ChatAgentMemberRow = {
  id: string;
  channel_id: string;
  vault_id: string;
  agent_id: string;
  display_name: string;
  mention: string;
  model: string;
  cwd: string;
  context_prompt: string;
  taggable_by_agents: number;
  reply_to_every_message: number;
  pingable_by_others: number;
  yolo: number;
  conversation_id: string;
};

function rowToAgentMember(row: ChatAgentMemberRow): ChatAgentRegistration {
  return {
    id: row.id,
    agentId: row.agent_id,
    displayName: row.display_name,
    mention: row.mention,
    model: row.model,
    cwd: row.cwd,
    contextPrompt: row.context_prompt,
    taggableByAgents: row.taggable_by_agents !== 0,
    replyToEveryMessage: row.reply_to_every_message !== 0,
    pingableByOthers: row.pingable_by_others !== 0,
    yolo: row.yolo !== 0,
    conversationId: row.conversation_id,
  };
}

function normalizeMention(value: string, fallback: string): string {
  const mention = String(value || fallback).replace(/^@+/, '').trim();
  return mention || fallback;
}

function normalizeAgentRegistration(input: Partial<ChatAgentRegistration>, fallbackAgentId?: string): ChatAgentRegistration {
  const agentId = String(input.agentId || fallbackAgentId || '').trim();
  if (!agentId) throw new Error('agentId is required');

  const id = String(input.id || '').trim() || crypto.randomUUID();
  const mention = normalizeMention(input.mention || '', agentId);

  return {
    id,
    agentId,
    displayName: String(input.displayName || '').trim() || agentId,
    mention,
    model: String(input.model || ''),
    cwd: String(input.cwd || ''),
    contextPrompt: String(input.contextPrompt || ''),
    taggableByAgents: input.taggableByAgents !== false,
    replyToEveryMessage: input.replyToEveryMessage === true,
    pingableByOthers: input.pingableByOthers === true,
    yolo: input.yolo === true,
    // May be empty here; upsert preserves the existing session or mints a new one.
    conversationId: String(input.conversationId || '').trim(),
  };
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function rowToMessage(row: ChatMessageRow): ChatMessage {
  const status = row.status as ChatMessage['status'] | null;
  return {
    id: row.id,
    channelId: row.channel_id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    ...(typeof row.rowid === 'number' ? { seq: row.rowid } : {}),
    ...(status ? { status } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.registration_id ? { registrationId: row.registration_id } : {}),
    ...(row.run_id != null ? { runId: row.run_id } : {}),
    ...(() => {
      const blocks = parseJson<ChatBlock[]>(row.blocks_json);
      return blocks?.length ? { blocks } : {};
    })(),
    ...(row.harness_log ? { harnessLog: row.harness_log } : {}),
    ...(() => {
      const images = parseJson<string[]>(row.images_json);
      return images?.length ? { images } : {};
    })(),
    ...(() => {
      const attachments = parseJson<Array<{ name: string; media_type: string; url: string }>>(row.attachments_json);
      return attachments?.length ? { attachments } : {};
    })(),
    ...(() => {
      const replyTo = parseJson<ChatReplyRef>(row.reply_to_json);
      return replyTo ? { replyTo } : {};
    })(),
  };
}

function messageToRow(vaultId: string, channelId: string, message: ChatMessage): ChatMessageRow {
  return {
    id: message.id,
    channel_id: channelId,
    vault_id: vaultId,
    author: message.author,
    body: message.body,
    created_at: message.createdAt,
    status: message.status ?? null,
    agent_id: message.agentId ?? null,
    registration_id: message.registrationId ?? null,
    run_id: message.runId ?? null,
    blocks_json: serializeJson(message.blocks),
    harness_log: message.harnessLog ?? null,
    images_json: serializeJson(message.images),
    attachments_json: serializeJson(message.attachments),
    reply_to_json: serializeJson(message.replyTo),
  };
}

export function isChatChannelNote(note: { content: string; content_preview: string }): boolean {
  const preview = note.content_preview.trim();
  if (preview.startsWith(CHAT_NOTE_MARKER)) return true;
  return note.content.trim().startsWith(CHAT_NOTE_MARKER);
}

export function assertChatChannel(db: Db, channelId: string, userId: number) {
  const note = getNote(db, channelId);
  if (!note || !isChatChannelNote(note)) {
    throw new Error('Chat channel not found');
  }
  const vault = getVault(db, note.vault_id, userId);
  if (!vault) {
    throw new Error('Chat channel not found');
  }

  const link = db.prepare(`
    SELECT local_channel_id AS localChannelId,
           local_vault_id AS localVaultId,
           source_channel_id AS sourceChannelId,
           source_vault_id AS sourceVaultId
    FROM chat_channel_links
    WHERE local_channel_id = ?
  `).get(channelId) as ChatChannelRoute | undefined;
  if (!link) {
    return {
      note,
      vault,
      route: {
        localVaultId: vault.id,
        localChannelId: note.id,
        sourceVaultId: vault.id,
        sourceChannelId: note.id,
      },
    };
  }

  const sourceNote = getNote(db, link.sourceChannelId);
  if (!sourceNote || sourceNote.vault_id !== link.sourceVaultId || !isChatChannelNote(sourceNote)) {
    throw new Error('Chat channel not found');
  }
  const sourceVault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(link.sourceVaultId);
  if (!sourceVault) throw new Error('Chat channel not found');
  return { note: sourceNote, vault: sourceVault, route: link };
}

export function linkChatChannel(
  db: Db,
  input: {
    localVaultId: string;
    localChannelId: string;
    sourceVaultId: string;
    sourceChannelId: string;
    createdBy: number;
  },
): void {
  db.prepare(`
    INSERT OR IGNORE INTO chat_channel_links (
      local_channel_id, local_vault_id, source_channel_id, source_vault_id, created_by
    ) VALUES (?, ?, ?, ?, ?)
  `).run(input.localChannelId, input.localVaultId, input.sourceChannelId, input.sourceVaultId, input.createdBy);
}

export function listChatChannelRoutes(db: Db, sourceVaultId: string, sourceChannelId: string): ChatChannelRoute[] {
  const linked = db.prepare(`
    SELECT local_vault_id AS localVaultId,
           local_channel_id AS localChannelId,
           source_vault_id AS sourceVaultId,
           source_channel_id AS sourceChannelId
    FROM chat_channel_links
    WHERE source_vault_id = ? AND source_channel_id = ?
  `).all(sourceVaultId, sourceChannelId) as ChatChannelRoute[];
  return [
    { localVaultId: sourceVaultId, localChannelId: sourceChannelId, sourceVaultId, sourceChannelId },
    ...linked,
  ];
}

/** Usernames of everyone with access to a shared chat (source owner + linked vault owners). */
export function listChatChannelParticipantUsernames(db: Db, sourceVaultId: string, sourceChannelId: string): string[] {
  const usernames = new Set<string>();
  const sourceOwner = db.prepare(`
    SELECT u.username
    FROM users u
    JOIN vaults v ON v.created_by = u.id
    WHERE v.id = ?
  `).get(sourceVaultId) as { username: string } | undefined;
  if (sourceOwner?.username) usernames.add(sourceOwner.username);

  const linkedOwners = db.prepare(`
    SELECT DISTINCT u.username
    FROM chat_channel_links l
    JOIN vaults v ON v.id = l.local_vault_id
    JOIN users u ON u.id = v.created_by
    WHERE l.source_channel_id = ?
  `).all(sourceChannelId) as Array<{ username: string }>;
  for (const row of linkedOwners) {
    if (row.username) usernames.add(row.username);
  }
  return Array.from(usernames).sort((a, b) => a.localeCompare(b));
}

export function listChatChannelParticipants(db: Db, channelId: string, userId: number): string[] {
  const { route } = assertChatChannel(db, channelId, userId);
  return listChatChannelParticipantUsernames(db, route.sourceVaultId, route.sourceChannelId);
}

export function listChatMessages(db: Db, channelId: string, userId: number): ChatMessage[] {
  const { route } = assertChatChannel(db, channelId, userId);
  const rows = db.prepare(`
    SELECT *, rowid
    FROM chat_messages
    WHERE channel_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(route.sourceChannelId) as ChatMessageRow[];
  return rows.map((row) => ({
    ...reconcileChatMessageRunStatus(db, row),
    channelId: route.localChannelId,
  }));
}

function hasRunOutput(message: ChatMessage): boolean {
  const body = message.body.trim();
  return body.length > 0 && body !== 'Thinking...';
}

/** Prefer the visible assistant text already on the message over a CLI summary. */
function honestChatBody(message: ChatMessage | undefined, fallbackSummary: string, emptyFallback: string): string {
  if (message && hasRunOutput(message)) return message.body.trim();
  const summary = fallbackSummary.trim();
  // Generic CLI/SDK summaries are not chat answers — only use them if we have nothing else.
  if (summary && !isGenericRunSummary(summary)) return summary;
  if (message && hasRunOutput(message)) return message.body.trim();
  return summary || emptyFallback;
}

function isGenericRunSummary(summary: string): boolean {
  return /^(done\.?|completed note operations successfully\.?|agent failed\.?)$/i.test(summary.trim());
}

function terminalRunPatch(run: RunStatusRow, message?: ChatMessage): Pick<ChatMessage, 'body' | 'status'> | null {
  if (run.status === 'completed') {
    return {
      body: honestChatBody(message, run.summary || '', 'Done.'),
      status: undefined,
    };
  }
  if (run.status === 'failed' || run.status === 'canceled') {
    const reason = run.summary?.trim()
      || (run.status === 'canceled' ? 'Run canceled by user.' : 'Agent failed.');
    const status = run.status === 'canceled' ? 'canceled' as const : 'failed' as const;
    // Preserve any accumulated output so a failed run (usage limits, cancel, …)
    // keeps its scratchpad for a resuming agent; annotate with the reason rather
    // than erasing the work. Guard against re-appending if the streaming path
    // already annotated this body.
    if (message && hasRunOutput(message)) {
      const annotation = `> ⚠️ ${reason}`;
      const body = message.body.includes(annotation) ? message.body : `${message.body}\n\n${annotation}`;
      return { body, status };
    }
    return { body: reason, status };
  }
  return null;
}

function persistChatMessageRow(db: Db, vaultId: string, channelId: string, message: ChatMessage): ChatMessage {
  const row = messageToRow(vaultId, channelId, message);
  db.prepare(`
    UPDATE chat_messages SET
      author = ?,
      body = ?,
      created_at = ?,
      status = ?,
      agent_id = ?,
      registration_id = ?,
      run_id = ?,
      blocks_json = ?,
      harness_log = ?,
      images_json = ?,
      attachments_json = ?,
      reply_to_json = ?
    WHERE id = ? AND channel_id = ?
  `).run(
    row.author,
    row.body,
    row.created_at,
    row.status,
    row.agent_id,
    row.registration_id,
    row.run_id,
    row.blocks_json,
    row.harness_log,
    row.images_json,
    row.attachments_json,
    row.reply_to_json,
    message.id,
    channelId,
  );
  return message;
}

function reconcileChatMessageRunStatus(db: Db, row: ChatMessageRow): ChatMessage {
  const message = rowToMessage(row);
  if (message.status !== 'running' || row.run_id == null) return message;

  const run = db.prepare('SELECT id, status, summary FROM runs WHERE id = ?').get(row.run_id) as RunStatusRow | undefined;
  if (!run) return message;
  const patch = terminalRunPatch(run, message);
  if (!patch) return message;

  return persistChatMessageRow(db, row.vault_id, row.channel_id, {
    ...message,
    body: patch.body,
    status: patch.status,
  });
}

export function settleChatMessagesForRun(db: Db, runId: number): Array<{ vaultId: string; channelId: string; message: ChatMessage }> {
  const run = db.prepare('SELECT id, status, summary FROM runs WHERE id = ?').get(runId) as RunStatusRow | undefined;
  if (!run) return [];
  const rows = db.prepare('SELECT *, rowid FROM chat_messages WHERE run_id = ?').all(runId) as ChatMessageRow[];
  return rows.map((row) => {
    const current = rowToMessage(row);
    const patch = terminalRunPatch(run, current);
    if (!patch) {
      return { vaultId: row.vault_id, channelId: row.channel_id, message: current };
    }
    const message = persistChatMessageRow(db, row.vault_id, row.channel_id, {
      ...current,
      body: patch.body,
      status: patch.status,
    });
    return { vaultId: row.vault_id, channelId: row.channel_id, message };
  });
}

export function createChatMessage(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  input: ChatMessage,
): ChatMessage {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');

  const id = String(input.id || '').trim() || crypto.randomUUID();
  const registrationId = String(input.registrationId || '').trim();
  let author = String(input.author || '').trim();
  let agentId = input.agentId;

  // Agent helper sends include registrationId; treat it as authoritative so
  // concurrent runs can't mis-attribute messages when helper context races.
  if (registrationId) {
    const row = db
      .prepare('SELECT display_name, agent_id FROM chat_agent_members WHERE id = ? AND channel_id = ?')
      .get(registrationId, route.sourceChannelId) as { display_name: string; agent_id: string } | undefined;
    if (row) {
      author = row.display_name?.trim() || row.agent_id;
      agentId = row.agent_id;
    }
  }
  if (!author) throw new Error('Author is required');

  const message: ChatMessage = {
    ...input,
    id,
    channelId: route.sourceChannelId,
    author,
    ...(agentId ? { agentId } : {}),
    ...(registrationId ? { registrationId } : {}),
    body: String(input.body ?? ''),
    createdAt: input.createdAt || new Date().toISOString(),
  };

  const row = messageToRow(route.sourceVaultId, route.sourceChannelId, message);

  // Idempotent create: client + server may both insert the agent placeholder
  // (eager client create races with ensureAgentChatMessage). On conflict, keep
  // the existing row and return it (optionally merging run_id/status).
  const existing = db.prepare(
    'SELECT *, rowid FROM chat_messages WHERE id = ? AND channel_id = ?',
  ).get(row.id, row.channel_id) as ChatMessageRow | undefined;
  if (existing) {
    const current = rowToMessage(existing);
    // Prefer non-empty agent fields from the newer write when filling blanks.
    const merged: ChatMessage = {
      ...current,
      author: message.author || current.author,
      body: current.body && current.body !== 'Thinking...' ? current.body : (message.body || current.body),
      status: message.status || current.status,
      agentId: message.agentId || current.agentId,
      registrationId: message.registrationId || current.registrationId,
      runId: message.runId ?? current.runId,
      blocks: message.blocks?.length ? message.blocks : current.blocks,
      harnessLog: (message.harnessLog?.length ?? 0) > (current.harnessLog?.length ?? 0)
        ? message.harnessLog
        : current.harnessLog,
    };
    return {
      ...persistChatMessageRow(db, route.sourceVaultId, route.sourceChannelId, merged),
      channelId: route.localChannelId,
    };
  }

  const info = db.prepare(`
    INSERT INTO chat_messages (
      id, channel_id, vault_id, author, body, created_at,
      status, agent_id, registration_id, run_id,
      blocks_json, harness_log, images_json, attachments_json, reply_to_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.channel_id,
    row.vault_id,
    row.author,
    row.body,
    row.created_at,
    row.status,
    row.agent_id,
    row.registration_id,
    row.run_id,
    row.blocks_json,
    row.harness_log,
    row.images_json,
    row.attachments_json,
    row.reply_to_json,
  );

  // Carry the persistence order so the create broadcast orders identically to a
  // later reload (which reads rowid) even for same-millisecond messages.
  message.seq = Number(info.lastInsertRowid);
  // Chat→note backlinks are indexed by the route layer (see indexChatMessageBacklinks)
  // to avoid a circular import with evolution.ts.
  return { ...message, channelId: route.localChannelId };
}

export function updateChatMessage(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  messageId: string,
  patch: Partial<ChatMessage>,
): ChatMessage | undefined {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');

  const existing = db.prepare('SELECT *, rowid FROM chat_messages WHERE id = ? AND channel_id = ?').get(messageId, route.sourceChannelId) as ChatMessageRow | undefined;
  if (!existing) return undefined;

  const current = rowToMessage(existing);
  const patchRecord = patch as Partial<ChatMessage> & Record<string, unknown>;
  const next: ChatMessage = {
    ...current,
    id: current.id,
    channelId: current.channelId,
    author: typeof patch.author === 'string' ? patch.author : current.author,
    body: typeof patch.body === 'string' ? patch.body : current.body,
    createdAt: typeof patch.createdAt === 'string' ? patch.createdAt : current.createdAt,
  };

  if ('status' in patchRecord) {
    next.status = patch.status === null || patch.status === undefined
      ? undefined
      : patch.status;
  }
  if ('agentId' in patchRecord) {
    next.agentId = patch.agentId === null || patch.agentId === undefined ? undefined : patch.agentId;
  }
  if ('registrationId' in patchRecord) {
    next.registrationId = patch.registrationId === null || patch.registrationId === undefined
      ? undefined
      : patch.registrationId;
  }
  if ('runId' in patchRecord) {
    next.runId = patch.runId === null || patch.runId === undefined ? undefined : patch.runId;
  }
  if ('blocks' in patchRecord) {
    next.blocks = patch.blocks === null || patch.blocks === undefined ? undefined : patch.blocks;
  }
  if ('harnessLog' in patchRecord) {
    next.harnessLog = patch.harnessLog === null || patch.harnessLog === undefined
      ? undefined
      : patch.harnessLog;
  }
  if ('images' in patchRecord) {
    next.images = patch.images === null || patch.images === undefined ? undefined : patch.images;
  }
  if ('attachments' in patchRecord) {
    next.attachments = patch.attachments === null || patch.attachments === undefined ? undefined : patch.attachments;
  }
  if ('replyTo' in patchRecord) {
    next.replyTo = patch.replyTo === null || patch.replyTo === undefined ? undefined : patch.replyTo;
  }

  return {
    ...persistChatMessageRow(db, route.sourceVaultId, route.sourceChannelId, next),
    channelId: route.localChannelId,
  };
}

/**
 * Extract the visible assistant text from an agent run event's `message.content`
 * (Anthropic-style content blocks, or a plain string).
 */
function textFromRunContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') return b.text;
      return '';
    })
    .join('');
}

/** Convert run-event content into the chat block list (text + thinking only). */
function normalizeChatRunBlocks(content: unknown): ChatBlock[] {
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
    }
  }
  return blocks;
}

/** Append blocks, coalescing consecutive text/thinking blocks (mirrors the client). */
function appendChatRunBlocks(existing: ChatBlock[], blocks: ChatBlock[]): ChatBlock[] {
  const next = [...existing];
  for (const block of blocks) {
    const last = next[next.length - 1];
    if (last && last.type === block.type && (block.type === 'text' || block.type === 'thinking')) {
      next[next.length - 1] = { ...last, text: `${last.text || ''}${block.text || ''}` };
    } else {
      next.push({ ...block });
    }
  }
  return next;
}

export type AgentChatContent = {
  body: string;
  blocks: ChatBlock[];
  harnessLog: string;
  status: ChatMessage['status'];
  done: boolean;
};

/**
 * Fold an agent run's event log into the chat message shape (body + blocks +
 * harness log + status). This is the server-authoritative equivalent of the
 * client's stream accumulation, so the agent reply is persisted and broadcast
 * even if the client that started the run disconnects mid-stream.
 *
 * Chat body prefers the streamed assistant **text**, not the CLI/SDK summary
 * (which is often a generic "Done." / tool result string).
 */
export function buildAgentChatContentFromRunEvents(
  events: Array<{ type: string; payload_json: string }>,
): AgentChatContent {
  let assistantText = '';
  let blocks: ChatBlock[] = [];
  let harnessLog = '';
  let status: ChatMessage['status'] = 'running';
  let terminalSummary = '';
  let suppressChatBody = false;

  for (const event of events) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload_json);
    } catch {
      continue;
    }
    if (event.type === 'text') {
      assistantText += textFromRunContent(payload?.message?.content);
      blocks = appendChatRunBlocks(blocks, normalizeChatRunBlocks(payload?.message?.content));
    } else if (event.type === 'user') {
      blocks = appendChatRunBlocks(blocks, normalizeChatRunBlocks(payload?.message?.content));
    } else if (event.type === 'harness') {
      const chunk = typeof payload?.data === 'string' ? payload.data : '';
      harnessLog = appendHarnessLog(harnessLog, chunk);
    } else if (event.type === 'status') {
      const s = payload?.status;
      if (payload?.suppressChatBody === true) suppressChatBody = true;
      if (s === 'completed') {
        status = undefined;
        terminalSummary = String(payload?.summary || 'Done.');
      } else if (s === 'failed') {
        status = 'failed';
        terminalSummary = String(payload?.summary || 'Agent failed.');
      } else if (s === 'canceled') {
        status = 'canceled';
        terminalSummary = String(payload?.summary || 'Run canceled by user.');
      }
    }
  }

  const trimmed = assistantText.trim();
  const done = status !== 'running';
  // Successful chat body = streamed assistant text. CLI/SDK summary is only a
  // fallback when nothing useful streamed (and even then, skip generic strings).
  // Full step narration lives in `blocks` / `harnessLog` for the terminal pane.
  // Failures keep the scratchpad and append the reason.
  // If the agent already posted via cascade-chat send, leave the run bubble
  // body empty so we don't double-post the same reply.
  let body: string;
  if (!done) {
    body = trimmed || 'Thinking...';
  } else if (status === 'failed' || status === 'canceled') {
    const reason = terminalSummary.trim()
      || (status === 'canceled' ? 'Run canceled by user.' : 'Agent failed.');
    body = trimmed ? `${trimmed}\n\n> ⚠️ ${reason}` : reason;
  } else if (suppressChatBody) {
    body = '';
  } else {
    if (trimmed) {
      body = trimmed;
    } else if (terminalSummary.trim() && !isGenericRunSummary(terminalSummary)) {
      body = terminalSummary.trim();
    } else {
      body = terminalSummary.trim() || 'Done.';
    }
  }

  return { body, blocks, harnessLog, status, done };
}

/**
 * Ensure a running agent chat message exists for a run (server single-writer).
 * Creates the placeholder if missing; otherwise updates runId/status.
 */
export function ensureAgentChatMessage(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  input: {
    messageId: string;
    author: string;
    agentId?: string;
    registrationId?: string;
    runId: number;
    body?: string;
  },
): { message: ChatMessage; created: boolean } {
  const existing = updateChatMessage(db, userId, vaultId, channelId, input.messageId, {
    runId: input.runId,
    status: 'running',
    agentId: input.agentId,
    registrationId: input.registrationId,
    author: input.author,
  });
  if (existing) return { message: existing, created: false };

  const message = createChatMessage(db, userId, vaultId, channelId, {
    id: input.messageId,
    channelId,
    author: input.author,
    body: input.body ?? 'Thinking...',
    createdAt: new Date().toISOString(),
    status: 'running',
    agentId: input.agentId,
    registrationId: input.registrationId,
    runId: input.runId,
  });
  return { message, created: true };
}

export function listChatAgentMembers(db: Db, channelId: string, userId: number): ChatAgentRegistration[] {
  const { route } = assertChatChannel(db, channelId, userId);
  const rows = db.prepare(`
    SELECT *
    FROM chat_agent_members
    WHERE channel_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(route.sourceChannelId) as ChatAgentMemberRow[];
  return rows.map(rowToAgentMember);
}

export type ResolvedChatAgentRun = {
  registration: ChatAgentRegistration;
  /** The agent owner's vault (the machine that must execute the run). */
  sourceVault: Vault;
  route: ChatChannelRoute;
  /** User id of the agent owner — the desktop runner the run delegates to. */
  ownerId: number;
};

/**
 * Resolve a registered chat agent for a run request. `assertChatChannel`
 * authorizes that `userId` can reach this (possibly linked) channel; the member
 * and owner are then read from the canonical *source* channel/vault, so a
 * cross-user ping executes with the owner's registration on the owner's runner.
 */
export function resolveChatAgentRun(
  db: Db,
  userId: number,
  channelId: string,
  registrationId: string,
): ResolvedChatAgentRun {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db
    .prepare('SELECT * FROM chat_agent_members WHERE id = ? AND channel_id = ?')
    .get(registrationId, route.sourceChannelId) as ChatAgentMemberRow | undefined;
  if (!row) throw new Error('Agent not found');

  const sourceVault = db
    .prepare('SELECT * FROM vaults WHERE id = ?')
    .get(route.sourceVaultId) as Vault | undefined;
  if (!sourceVault) throw new Error('Agent not found');

  return {
    registration: rowToAgentMember(row),
    sourceVault,
    route,
    ownerId: sourceVault.created_by,
  };
}

export function upsertChatAgentMember(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  input: Partial<ChatAgentRegistration>,
): ChatAgentRegistration {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');

  const member = normalizeAgentRegistration(input);
  const existing = db.prepare('SELECT id, conversation_id FROM chat_agent_members WHERE id = ? AND channel_id = ?').get(member.id, route.sourceChannelId) as { id: string; conversation_id: string } | undefined;

  // The session id is sticky: an explicit value (e.g. a `/clear` rotation) wins,
  // otherwise keep the member's existing session, otherwise mint a fresh one.
  member.conversationId = member.conversationId || existing?.conversation_id || crypto.randomUUID();

  if (existing) {
    db.prepare(`
      UPDATE chat_agent_members SET
        agent_id = ?,
        display_name = ?,
        mention = ?,
        model = ?,
        cwd = ?,
        context_prompt = ?,
        taggable_by_agents = ?,
        reply_to_every_message = ?,
        pingable_by_others = ?,
        yolo = ?,
        conversation_id = ?,
        updated_at = datetime('now')
      WHERE id = ? AND channel_id = ?
    `).run(
      member.agentId,
      member.displayName,
      member.mention,
      member.model,
      member.cwd,
      member.contextPrompt,
      member.taggableByAgents ? 1 : 0,
      member.replyToEveryMessage ? 1 : 0,
      member.pingableByOthers ? 1 : 0,
      member.yolo ? 1 : 0,
      member.conversationId,
      member.id,
      route.sourceChannelId,
    );
  } else {
    db.prepare(`
      INSERT INTO chat_agent_members (
        id, channel_id, vault_id, agent_id, display_name, mention,
        model, cwd, context_prompt, taggable_by_agents, reply_to_every_message, pingable_by_others, yolo, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.id,
      route.sourceChannelId,
      route.sourceVaultId,
      member.agentId,
      member.displayName,
      member.mention,
      member.model,
      member.cwd,
      member.contextPrompt,
      member.taggableByAgents ? 1 : 0,
      member.replyToEveryMessage ? 1 : 0,
      member.pingableByOthers ? 1 : 0,
      member.yolo ? 1 : 0,
      member.conversationId,
    );
  }

  return member;
}

export function removeChatAgentMember(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  registrationId: string,
): boolean {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');

  const result = db.prepare('DELETE FROM chat_agent_members WHERE id = ? AND channel_id = ?').run(registrationId, route.sourceChannelId);
  return result.changes > 0;
}
