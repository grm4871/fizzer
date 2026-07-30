/**
 * @file chat.ts — Server-side chat message persistence
 *
 * Chat channels are notes with content `cascade://chat-channel`. Messages are
 * stored in SQLite and broadcast to vault room subscribers via Socket.IO.
 *
 * @module server/chat
 */

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getNote, getVault, type Vault } from './vault.js';

type Db = Database.Database;

export const CHAT_NOTE_MARKER = 'cascade://chat-channel';
export const CASCADE_AGENT_APP_CONTEXT =
  'Cascade is a user-facing, Obsidian-style workspace for AI-native project management. '
  + 'Its notes, folders, project docs, and chats are live app data, not files under the agent process cwd. '
  + 'Use `cascade-note` by command name to read or write Cascade notes; it is on PATH and pre-authorized. '
  + 'Do not replace it with an absolute path or inspect a local docs.db. '
  + 'Use normal filesystem tools only for local repository/workspace work the user actually requested.';

export type ChatReplyRef = {
  messageId: string;
  author: string;
  mention: string;
  preview: string;
};

export type ChatFileChange = { path: string; additions: number; deletions: number };
export type ChatChangeRequest = {
  files: ChatFileChange[];
  commit?: string;
  ref?: string;
  approvals: Array<{ userId: number; username: string }>;
  mergedAt?: string;
  mergedBy?: string;
};

export type ChatBlock = {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  redacted?: boolean;
  /** tool_use */
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result */
  toolUseId?: string;
  content?: string;
  isError?: boolean;
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
  /** List payloads omit harnessLog; true when a full log exists server-side. */
  hasHarness?: boolean;
  /** List payloads strip heavy data-URL images; true when the full message has
   * images the client should hydrate on demand. */
  hasImages?: boolean;
  images?: string[];
  attachments?: Array<{ name: string; media_type: string; url: string }>;
  replyTo?: ChatReplyRef;
  changeRequest?: ChatChangeRequest;
};

/** Max messages returned by the default channel list (newest first window). */
export const CHAT_LIST_DEFAULT_LIMIT = 120;
/** Cap thinking/tool bodies in list payloads — full text loads on expand. */
const LIST_BLOCK_TEXT_MAX = 280;

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
  /** Persistent vault-level agent this membership belongs to (vault_agents.id).
   * Empty only transiently for legacy rows before the backfill migration runs. */
  vaultAgentId: string;
  agentId: string;
  displayName: string;
  /** Optional http(s) image URL, shared with the agent's vault identity. */
  avatarUrl: string;
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

/** A persistent, vault-level chat agent. Identity fields (agent backend, name,
 * mention, model, cwd, context prompt) live canonically here; channel
 * memberships in `chat_agent_members` keep a synced copy for back-compat plus
 * their own per-channel state (conversation, flags). */
export type VaultAgent = {
  id: string;
  vaultId: string;
  agentId: string;
  displayName: string;
  avatarUrl: string;
  mention: string;
  model: string;
  cwd: string;
  contextPrompt: string;
  ownerUserId: number;
  ownerUsername: string;
  createdAt: string;
  updatedAt: string;
};

export type VaultAgentWithChannels = VaultAgent & {
  /** Channels this agent is currently a member of (source channel ids). */
  channelIds: string[];
};

/** A channel membership of a persistent vault agent, with its (source) location. */
export type VaultAgentMembership = {
  registration: ChatAgentRegistration;
  vaultId: string;
  channelId: string;
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
  change_request_json: string | null;
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
      reply_to_json TEXT,
      change_request_json TEXT
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
      avatar_url TEXT NOT NULL DEFAULT '',
      mention TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      context_prompt TEXT NOT NULL DEFAULT '',
      taggable_by_agents INTEGER NOT NULL DEFAULT 0,
      reply_to_every_message INTEGER NOT NULL DEFAULT 0,
      pingable_by_others INTEGER NOT NULL DEFAULT 0,
      yolo INTEGER NOT NULL DEFAULT 0,
      conversation_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS chat_agent_members_channel_idx ON chat_agent_members(channel_id);

    CREATE TABLE IF NOT EXISTS vault_agents (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      mention TEXT NOT NULL,
      model TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      context_prompt TEXT NOT NULL DEFAULT '',
      owner_user_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vault_id, mention)
    );
    CREATE INDEX IF NOT EXISTS vault_agents_vault_idx ON vault_agents(vault_id);

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

    CREATE TABLE IF NOT EXISTS chat_channel_settings (
      channel_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
      cwd TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrations: add columns to pre-existing tables.
  const messageCols = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>;
  if (!messageCols.some((col) => col.name === 'harness_log')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN harness_log TEXT');
  }
  if (!messageCols.some((col) => col.name === 'change_request_json')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN change_request_json TEXT');
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
  if (!memberCols.some((col) => col.name === 'vault_agent_id')) {
    db.exec("ALTER TABLE chat_agent_members ADD COLUMN vault_agent_id TEXT NOT NULL DEFAULT ''");
  }
  if (!memberCols.some((col) => col.name === 'avatar_url')) {
    db.exec("ALTER TABLE chat_agent_members ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
  }
  const vaultAgentCols = db.prepare("PRAGMA table_info(vault_agents)").all() as Array<{ name: string }>;
  if (!vaultAgentCols.some((col) => col.name === 'avatar_url')) {
    db.exec("ALTER TABLE vault_agents ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
  }
  if (!vaultAgentCols.some((col) => col.name === 'owner_user_id')) {
    db.exec('ALTER TABLE vault_agents ADD COLUMN owner_user_id INTEGER REFERENCES users(id)');
  }
  db.exec(`UPDATE vault_agents SET owner_user_id = (
    SELECT created_by FROM vaults WHERE vaults.id = vault_agents.vault_id
  ) WHERE owner_user_id IS NULL`);
  db.exec(`
    INSERT INTO chat_messages_fts(rowid, author, body)
    SELECT cm.rowid, cm.author, cm.body
    FROM chat_messages cm
    WHERE NOT EXISTS (
      SELECT 1 FROM chat_messages_fts fts WHERE fts.rowid = cm.rowid
    );
  `);

  // Backfill vault_agents from existing channel memberships (idempotent).
  backfillVaultAgentsFromMembers(db);
  // Enforce unique handles (case-insensitive); resolve conflicts preferring #cascade-dev.
  reconcileVaultAgentIdentities(db);
}

type ChatAgentMemberRow = {
  id: string;
  channel_id: string;
  vault_id: string;
  vault_agent_id: string;
  agent_id: string;
  display_name: string;
  avatar_url: string;
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

type VaultAgentRow = {
  id: string;
  vault_id: string;
  agent_id: string;
  display_name: string;
  avatar_url: string;
  mention: string;
  model: string;
  cwd: string;
  context_prompt: string;
  owner_user_id: number;
  owner_username?: string;
  created_at: string;
  updated_at: string;
};

function rowToVaultAgent(row: VaultAgentRow): VaultAgent {
  return {
    id: row.id,
    vaultId: row.vault_id,
    agentId: row.agent_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || '',
    mention: row.mention,
    model: row.model,
    cwd: row.cwd,
    contextPrompt: row.context_prompt,
    ownerUserId: row.owner_user_id,
    ownerUsername: row.owner_username || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAgentMember(row: ChatAgentMemberRow): ChatAgentRegistration {
  return {
    id: row.id,
    vaultAgentId: row.vault_agent_id || '',
    agentId: row.agent_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url || '',
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

/**
 * One-time / idempotent: for each chat_agent_members row without vault_agent_id,
 * find-or-create a vault_agents row (keyed by vault+mention) and link it.
 */
function backfillVaultAgentsFromMembers(db: Db): void {
  const orphans = db.prepare(`
    SELECT * FROM chat_agent_members
    WHERE vault_agent_id IS NULL OR vault_agent_id = ''
  `).all() as ChatAgentMemberRow[];
  if (orphans.length === 0) return;

  const findVa = db.prepare(`
    SELECT id FROM vault_agents WHERE vault_id = ? AND mention = ? COLLATE NOCASE
  `);
  const insertVa = db.prepare(`
    INSERT INTO vault_agents (id, vault_id, agent_id, display_name, avatar_url, mention, model, cwd, context_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const link = db.prepare(`
    UPDATE chat_agent_members SET vault_agent_id = ? WHERE id = ? AND channel_id = ?
  `);

  for (const row of orphans) {
    const mention = normalizeMention(row.mention || '', row.agent_id || 'agent');
    let va = findVa.get(row.vault_id, mention) as { id: string } | undefined;
    if (!va) {
      const id = crypto.randomUUID();
      try {
        insertVa.run(
          id,
          row.vault_id,
          row.agent_id,
          row.display_name || row.agent_id,
          row.avatar_url || '',
          mention,
          row.model || '',
          row.cwd || '',
          row.context_prompt || '',
        );
        va = { id };
      } catch {
        va = findVa.get(row.vault_id, mention) as { id: string } | undefined;
      }
    }
    if (va) link.run(va.id, row.id, row.channel_id);
  }
}

/** Canonical @handle: strip @, trim, lowercase — vault-wide unique. */
function normalizeMention(value: string, fallback: string): string {
  const raw = String(value || fallback).replace(/^@+/, '').trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (cleaned) return cleaned;
  const fb = String(fallback || 'agent').replace(/^@+/, '').trim().toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return fb || 'agent';
}

function findCascadeDevChannelId(db: Db, vaultId: string): string | null {
  const row = db.prepare(`
    SELECT id FROM notes
    WHERE vault_id = ?
      AND lower(trim(title)) = 'cascade-dev'
      AND (
        trim(content_preview) LIKE 'cascade://chat-channel%'
        OR trim(content) LIKE 'cascade://chat-channel%'
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(vaultId) as { id: string } | undefined;
  return row?.id ?? null;
}

function agentInChannel(db: Db, vaultAgentId: string, channelId: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS ok FROM chat_agent_members
    WHERE vault_agent_id = ? AND channel_id = ?
    LIMIT 1
  `).get(vaultAgentId, channelId) as { ok: number } | undefined;
  return Boolean(row);
}

/** Mint a free mention in the vault (base, base-2, base-3, …). */
function allocateUniqueMention(db: Db, vaultId: string, base: string, excludeId: string): string {
  const root = normalizeMention(base, 'agent');
  let candidate = root;
  let n = 2;
  for (;;) {
    const clash = db.prepare(`
      SELECT id FROM vault_agents
      WHERE vault_id = ? AND mention = ? COLLATE NOCASE AND id != ?
      LIMIT 1
    `).get(vaultId, candidate, excludeId) as { id: string } | undefined;
    if (!clash) return candidate;
    candidate = `${root}-${n++}`;
    if (n > 500) return `${root}-${crypto.randomUUID().slice(0, 8)}`;
  }
}

/**
 * Repair handle collisions vault-wide.
 * Winner = agent present in #cascade-dev when possible, else random.
 * Losers get a unique @handle suffix; memberships are re-synced.
 */
export function reconcileVaultAgentIdentities(db: Db): { renamed: Array<{ id: string; from: string; to: string }> } {
  const renamed: Array<{ id: string; from: string; to: string }> = [];
  const vaultIds = (db.prepare('SELECT DISTINCT vault_id AS id FROM vault_agents').all() as Array<{ id: string }>)
    .map((r) => r.id);

  for (const vaultId of vaultIds) {
    // Normalize every mention to canonical form first.
    const all = db.prepare('SELECT * FROM vault_agents WHERE vault_id = ?').all(vaultId) as VaultAgentRow[];
    for (const row of all) {
      const next = normalizeMention(row.mention || row.agent_id, row.agent_id || 'agent');
      if (next !== row.mention) {
        // May still collide after lowercasing — handled in group pass below.
        try {
          db.prepare(`
            UPDATE vault_agents SET mention = ?, updated_at = datetime('now') WHERE id = ?
          `).run(next, row.id);
          db.prepare(`
            UPDATE chat_agent_members SET mention = ?, updated_at = datetime('now') WHERE vault_agent_id = ?
          `).run(next, row.id);
          if (row.mention !== next) renamed.push({ id: row.id, from: row.mention, to: next });
        } catch {
          // UNIQUE violation until group reconciliation renames losers.
        }
      }
    }

    const cascadeDevId = findCascadeDevChannelId(db, vaultId);
    const agents = db.prepare('SELECT * FROM vault_agents WHERE vault_id = ?').all(vaultId) as VaultAgentRow[];
    const groups = new Map<string, VaultAgentRow[]>();
    for (const agent of agents) {
      const key = normalizeMention(agent.mention || agent.agent_id, agent.agent_id || 'agent');
      const list = groups.get(key) ?? [];
      list.push(agent);
      groups.set(key, list);
    }

    for (const [handle, group] of groups) {
      if (group.length <= 1) {
        // Ensure single agent has canonical handle stored.
        const only = group[0];
        if (only && only.mention !== handle) {
          db.prepare(`UPDATE vault_agents SET mention = ?, updated_at = datetime('now') WHERE id = ?`).run(handle, only.id);
          db.prepare(`UPDATE chat_agent_members SET mention = ?, updated_at = datetime('now') WHERE vault_agent_id = ?`).run(handle, only.id);
        }
        continue;
      }

      let winners = cascadeDevId
        ? group.filter((a) => agentInChannel(db, a.id, cascadeDevId))
        : [];
      if (winners.length === 0) winners = group;
      const winner = winners[Math.floor(Math.random() * winners.length)];

      // Winner keeps the base handle.
      if (winner.mention !== handle) {
        try {
          db.prepare(`UPDATE vault_agents SET mention = ?, updated_at = datetime('now') WHERE id = ?`).run(handle, winner.id);
          db.prepare(`UPDATE chat_agent_members SET mention = ?, updated_at = datetime('now') WHERE vault_agent_id = ?`).run(handle, winner.id);
          renamed.push({ id: winner.id, from: winner.mention, to: handle });
        } catch { /* rare */ }
      }

      for (const loser of group) {
        if (loser.id === winner.id) continue;
        const next = allocateUniqueMention(db, vaultId, handle, loser.id);
        const from = loser.mention;
        db.prepare(`UPDATE vault_agents SET mention = ?, updated_at = datetime('now') WHERE id = ?`).run(next, loser.id);
        db.prepare(`UPDATE chat_agent_members SET mention = ?, updated_at = datetime('now') WHERE vault_agent_id = ?`).run(next, loser.id);
        renamed.push({ id: loser.id, from, to: next });
      }
    }

    // Drop duplicate memberships of the same vault agent in one channel (keep oldest).
    const dups = db.prepare(`
      SELECT channel_id, vault_agent_id, MIN(rowid) AS keep_rowid, COUNT(*) AS c
      FROM chat_agent_members
      WHERE vault_id = ? AND vault_agent_id IS NOT NULL AND vault_agent_id != ''
      GROUP BY channel_id, vault_agent_id
      HAVING c > 1
    `).all(vaultId) as Array<{ channel_id: string; vault_agent_id: string; keep_rowid: number }>;
    for (const dup of dups) {
      db.prepare(`
        DELETE FROM chat_agent_members
        WHERE channel_id = ? AND vault_agent_id = ? AND rowid != ?
      `).run(dup.channel_id, dup.vault_agent_id, dup.keep_rowid);
    }
  }

  return { renamed };
}

function normalizeAgentRegistration(input: Partial<ChatAgentRegistration>, fallbackAgentId?: string): ChatAgentRegistration {
  const agentId = String(input.agentId || fallbackAgentId || '').trim();
  if (!agentId) throw new Error('agentId is required');

  const id = String(input.id || '').trim() || crypto.randomUUID();
  const mention = normalizeMention(input.mention || '', agentId);

  return {
    id,
    vaultAgentId: String(input.vaultAgentId || '').trim(),
    agentId,
    displayName: String(input.displayName || '').trim() || agentId,
    avatarUrl: String(input.avatarUrl || '').trim(),
    mention,
    model: String(input.model || ''),
    cwd: String(input.cwd || ''),
    contextPrompt: String(input.contextPrompt || ''),
    taggableByAgents: input.taggableByAgents === true,
    replyToEveryMessage: input.replyToEveryMessage === true,
    pingableByOthers: input.pingableByOthers === true,
    yolo: input.yolo === true,
    // May be empty here; upsert preserves the existing session or mints a new one.
    conversationId: String(input.conversationId || '').trim(),
  };
}

/**
 * Find or create the vault-level agent identity for a membership.
 * Never silently steals another agent's handle or overwrites its settings.
 */
function ensureVaultAgentForMember(
  db: Db,
  vaultId: string,
  member: ChatAgentRegistration,
): VaultAgent {
  const mention = normalizeMention(member.mention || '', member.agentId);

  if (member.vaultAgentId) {
    const existing = db.prepare('SELECT * FROM vault_agents WHERE id = ? AND vault_id = ?')
      .get(member.vaultAgentId, vaultId) as VaultAgentRow | undefined;
    if (existing) {
      // Handle must stay unique if the membership is renaming identity.
      const clash = db.prepare(`
        SELECT id, mention FROM vault_agents
        WHERE vault_id = ? AND mention = ? COLLATE NOCASE AND id != ?
        LIMIT 1
      `).get(vaultId, mention, existing.id) as { id: string; mention: string } | undefined;
      if (clash) {
        throw new Error(`Mention @${mention} is already used by another vault agent`);
      }
      db.prepare(`
        UPDATE vault_agents SET
          agent_id = ?, display_name = ?, avatar_url = ?, mention = ?, model = ?, cwd = ?, context_prompt = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        member.agentId,
        member.displayName,
        member.avatarUrl,
        mention,
        member.model,
        member.cwd,
        member.contextPrompt,
        existing.id,
      );
      db.prepare(`
        UPDATE chat_agent_members SET
          agent_id = ?, display_name = ?, avatar_url = ?, mention = ?, model = ?, cwd = ?, context_prompt = ?,
          updated_at = datetime('now')
        WHERE vault_agent_id = ?
      `).run(
        member.agentId,
        member.displayName,
        member.avatarUrl,
        mention,
        member.model,
        member.cwd,
        member.contextPrompt,
        existing.id,
      );
      return rowToVaultAgent(db.prepare('SELECT * FROM vault_agents WHERE id = ?').get(existing.id) as VaultAgentRow);
    }
  }

  // Existing identity with this handle — link only; do not clobber its settings.
  const byMention = db.prepare(`
    SELECT * FROM vault_agents WHERE vault_id = ? AND mention = ? COLLATE NOCASE
  `).get(vaultId, mention) as VaultAgentRow | undefined;
  if (byMention) {
    return rowToVaultAgent(byMention);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO vault_agents (id, vault_id, agent_id, display_name, avatar_url, mention, model, cwd, context_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    vaultId,
    member.agentId,
    member.displayName,
    member.avatarUrl,
    mention,
    member.model,
    member.cwd,
    member.contextPrompt,
  );
  return rowToVaultAgent(db.prepare('SELECT * FROM vault_agents WHERE id = ?').get(id) as VaultAgentRow);
}

export function listVaultAgents(db: Db, userId: number, vaultId: string): VaultAgentWithChannels[] {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const rows = db.prepare(`
    SELECT va.*, u.username AS owner_username
    FROM vault_agents va LEFT JOIN users u ON u.id = va.owner_user_id
    WHERE va.vault_id = ? ORDER BY va.display_name ASC, va.mention ASC
  `).all(vaultId) as VaultAgentRow[];
  return rows.map((row) => {
    const channelIds = (db.prepare(`
      SELECT DISTINCT channel_id FROM chat_agent_members WHERE vault_agent_id = ?
    `).all(row.id) as Array<{ channel_id: string }>).map((r) => r.channel_id);
    return { ...rowToVaultAgent(row), channelIds };
  });
}

export function getVaultAgent(db: Db, userId: number, vaultId: string, vaultAgentId: string): VaultAgentWithChannels | undefined {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const row = db.prepare('SELECT * FROM vault_agents WHERE id = ? AND vault_id = ?')
    .get(vaultAgentId, vaultId) as VaultAgentRow | undefined;
  if (!row) return undefined;
  const channelIds = (db.prepare(`
    SELECT DISTINCT channel_id FROM chat_agent_members WHERE vault_agent_id = ?
  `).all(row.id) as Array<{ channel_id: string }>).map((r) => r.channel_id);
  return { ...rowToVaultAgent(row), channelIds };
}

export function upsertVaultAgent(
  db: Db,
  userId: number,
  vaultId: string,
  input: Partial<VaultAgent> & { agentId?: string },
): VaultAgent {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const agentId = String(input.agentId || '').trim();
  if (!agentId) throw new Error('agentId is required');
  const mention = normalizeMention(String(input.mention || ''), agentId);
  const displayName = String(input.displayName || '').trim() || agentId;
  const model = String(input.model || '');
  const cwd = String(input.cwd || '');
  const contextPrompt = String(input.contextPrompt || '');
  const id = String(input.id || '').trim() || crypto.randomUUID();

  const existing = db.prepare('SELECT * FROM vault_agents WHERE id = ? AND vault_id = ?')
    .get(id, vaultId) as VaultAgentRow | undefined;
  const avatarUrl = String(input.avatarUrl || existing?.avatar_url || '').trim();

  // Unique handle on both create and update (case-insensitive).
  const clash = db.prepare(`
    SELECT id FROM vault_agents WHERE vault_id = ? AND mention = ? COLLATE NOCASE AND id != ?
  `).get(vaultId, mention, id) as { id: string } | undefined;
  if (clash) throw new Error(`Mention @${mention} is already used by another vault agent`);

  if (existing) {
    db.prepare(`
      UPDATE vault_agents SET
        agent_id = ?, display_name = ?, avatar_url = ?, mention = ?, model = ?, cwd = ?, context_prompt = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(agentId, displayName, avatarUrl, mention, model, cwd, contextPrompt, id);
    db.prepare(`
      UPDATE chat_agent_members SET
        agent_id = ?, display_name = ?, avatar_url = ?, mention = ?, model = ?, cwd = ?, context_prompt = ?,
        updated_at = datetime('now')
      WHERE vault_agent_id = ?
    `).run(agentId, displayName, avatarUrl, mention, model, cwd, contextPrompt, id);
  } else {
    db.prepare(`
      INSERT INTO vault_agents (id, vault_id, agent_id, display_name, avatar_url, mention, model, cwd, context_prompt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, vaultId, agentId, displayName, avatarUrl, mention, model, cwd, contextPrompt);
  }
  db.prepare('UPDATE vault_agents SET owner_user_id = COALESCE(owner_user_id, ?) WHERE id = ?').run(userId, id);
  return rowToVaultAgent(db.prepare(`
    SELECT va.*, u.username AS owner_username
    FROM vault_agents va LEFT JOIN users u ON u.id = va.owner_user_id
    WHERE va.id = ?
  `).get(id) as VaultAgentRow);
}

export function deleteVaultAgent(db: Db, userId: number, vaultId: string, vaultAgentId: string): boolean {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  // Drop all channel memberships first
  db.prepare('DELETE FROM chat_agent_members WHERE vault_agent_id = ?').run(vaultAgentId);
  const result = db.prepare('DELETE FROM vault_agents WHERE id = ? AND vault_id = ?').run(vaultAgentId, vaultId);
  return result.changes > 0;
}

/**
 * Add an existing vault agent to a channel (or refresh membership flags).
 * Identity always comes from vault_agents.
 */
export function addVaultAgentToChannel(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  vaultAgentId: string,
  flags: Partial<Pick<ChatAgentRegistration, 'taggableByAgents' | 'replyToEveryMessage' | 'pingableByOthers' | 'yolo' | 'conversationId'>> = {},
): ChatAgentRegistration {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');
  const va = db.prepare('SELECT * FROM vault_agents WHERE id = ? AND vault_id = ?')
    .get(vaultAgentId, route.sourceVaultId) as VaultAgentRow | undefined;
  if (!va) throw new Error('Vault agent not found');

  const existing = db.prepare(`
    SELECT * FROM chat_agent_members WHERE vault_agent_id = ? AND channel_id = ?
  `).get(vaultAgentId, route.sourceChannelId) as ChatAgentMemberRow | undefined;

  const conversationId = flags.conversationId
    || existing?.conversation_id
    || crypto.randomUUID();
  const taggable = flags.taggableByAgents !== undefined ? flags.taggableByAgents : (existing ? existing.taggable_by_agents !== 0 : false);
  const replyEvery = flags.replyToEveryMessage !== undefined ? flags.replyToEveryMessage : (existing ? existing.reply_to_every_message !== 0 : false);
  const pingable = flags.pingableByOthers !== undefined ? flags.pingableByOthers : (existing ? existing.pingable_by_others !== 0 : false);
  const yolo = flags.yolo !== undefined ? flags.yolo : (existing ? existing.yolo !== 0 : false);
  const memberId = existing?.id || crypto.randomUUID();

  if (existing) {
    db.prepare(`
      UPDATE chat_agent_members SET
        agent_id = ?, display_name = ?, avatar_url = ?, mention = ?, model = ?, cwd = ?, context_prompt = ?,
        taggable_by_agents = ?, reply_to_every_message = ?, pingable_by_others = ?, yolo = ?,
        conversation_id = ?, vault_agent_id = ?, updated_at = datetime('now')
      WHERE id = ? AND channel_id = ?
    `).run(
      va.agent_id, va.display_name, va.avatar_url, va.mention, va.model, va.cwd, va.context_prompt,
      taggable ? 1 : 0, replyEvery ? 1 : 0, pingable ? 1 : 0, yolo ? 1 : 0,
      conversationId, va.id, memberId, route.sourceChannelId,
    );
  } else {
    db.prepare(`
      INSERT INTO chat_agent_members (
        id, channel_id, vault_id, vault_agent_id, agent_id, display_name, avatar_url, mention,
        model, cwd, context_prompt, taggable_by_agents, reply_to_every_message, pingable_by_others, yolo, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memberId, route.sourceChannelId, route.sourceVaultId, va.id,
      va.agent_id, va.display_name, va.avatar_url, va.mention, va.model, va.cwd, va.context_prompt,
      taggable ? 1 : 0, replyEvery ? 1 : 0, pingable ? 1 : 0, yolo ? 1 : 0, conversationId,
    );
  }

  return rowToAgentMember(db.prepare('SELECT * FROM chat_agent_members WHERE id = ? AND channel_id = ?')
    .get(memberId, route.sourceChannelId) as ChatAgentMemberRow);
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

function slimBlocksForList(blocks: ChatBlock[]): ChatBlock[] {
  return blocks.map((block) => {
    if (block.type === 'thinking' && block.text && block.text.length > LIST_BLOCK_TEXT_MAX) {
      return { ...block, text: `${block.text.slice(0, LIST_BLOCK_TEXT_MAX)}…` };
    }
    if (block.type === 'tool_result') {
      const raw = block.content || block.text || '';
      if (raw.length > LIST_BLOCK_TEXT_MAX) {
        const clipped = `${raw.slice(0, LIST_BLOCK_TEXT_MAX)}…`;
        return { ...block, content: clipped, text: clipped };
      }
    }
    if (block.type === 'text' && block.text && block.text.length > LIST_BLOCK_TEXT_MAX * 4) {
      // Keep more of visible text blocks; still bound pathological rows.
      return { ...block, text: `${block.text.slice(0, LIST_BLOCK_TEXT_MAX * 4)}…` };
    }
    return block;
  });
}

function rowToMessage(row: ChatMessageRow & { has_harness?: number }, opts?: { detail?: 'list' | 'full' }): ChatMessage {
  const detail = opts?.detail ?? 'full';
  const status = row.status as ChatMessage['status'] | null;
  const hasHarnessCol = typeof row.has_harness === 'number'
    ? row.has_harness !== 0
    : Boolean(row.harness_log && row.harness_log.length > 0);
  const blocks = parseJson<ChatBlock[]>(row.blocks_json);
  const slimBlocks = detail === 'list' && blocks?.length ? slimBlocksForList(blocks) : blocks;
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
    ...(slimBlocks?.length ? { blocks: slimBlocks } : {}),
    // List: never ship multi-hundred-KB harness logs over the wire.
    ...(detail === 'full' && row.harness_log ? { harnessLog: row.harness_log } : {}),
    ...(hasHarnessCol ? { hasHarness: true } : {}),
    ...(() => {
      const images = parseJson<string[]>(row.images_json);
      if (!images?.length) return {};
      // List: drop giant data-URL payloads; keep short http(s) thumbs. Flag any
      // stripped images so the client can hydrate the full message on demand
      // (otherwise image-only messages render blank after a list load).
      if (detail === 'list') {
        const light = images.filter((src) => typeof src === 'string' && !src.startsWith('data:') && src.length < 2048);
        if (light.length === images.length) return { images: light };
        return light.length ? { images: light, hasImages: true } : { hasImages: true };
      }
      return { images };
    })(),
    ...(() => {
      const attachments = parseJson<Array<{ name: string; media_type: string; url: string }>>(row.attachments_json);
      return attachments?.length ? { attachments } : {};
    })(),
    ...(() => {
      const replyTo = parseJson<ChatReplyRef>(row.reply_to_json);
      return replyTo ? { replyTo } : {};
    })(),
    ...(() => {
      const changeRequest = parseJson<ChatChangeRequest>(row.change_request_json);
      return changeRequest ? { changeRequest } : {};
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
    change_request_json: serializeJson(message.changeRequest),
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

export function listChatMessages(
  db: Db,
  channelId: string,
  userId: number,
  opts?: { detail?: 'list' | 'full'; limit?: number },
): ChatMessage[] {
  const { route } = assertChatChannel(db, channelId, userId);
  const detail = opts?.detail ?? 'list';
  const limit = Math.max(1, Math.min(Number(opts?.limit) || CHAT_LIST_DEFAULT_LIMIT, 500));

  // List path: skip selecting harness_log body (can be hundreds of KB per row).
  // Newest window first, then reverse to chronological for the client.
  const rows = (detail === 'full'
    ? db.prepare(`
        SELECT *, rowid,
          CASE WHEN harness_log IS NOT NULL AND length(harness_log) > 0 THEN 1 ELSE 0 END AS has_harness
        FROM chat_messages
        WHERE channel_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `).all(route.sourceChannelId, limit)
    : db.prepare(`
        SELECT id, channel_id, vault_id, author, body, created_at,
          status, agent_id, registration_id, run_id,
          blocks_json, images_json, attachments_json, reply_to_json, change_request_json,
          rowid,
          CASE WHEN harness_log IS NOT NULL AND length(harness_log) > 0 THEN 1 ELSE 0 END AS has_harness
        FROM chat_messages
        WHERE channel_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `).all(route.sourceChannelId, limit)
  ) as Array<ChatMessageRow & { has_harness?: number }>;

  rows.reverse();
  return rows.map((row) => ({
    ...reconcileChatMessageRunStatus(db, row, detail),
    channelId: route.localChannelId,
  })).filter((message) => {
    // A helper-posted agent response leaves its original run row suppressed.
    // Keep active placeholders, but do not make every future client/agent pay
    // for terminal empty shells or stale Thinking rows.
    if (!message.agentId || message.status === 'running') return true;
    const body = message.body.trim();
    return body.length > 0 && body !== 'Thinking...';
  });
}

/** Small, text-only context for a cold agent run. Heavy media and run blocks stay out. */
export function buildAgentChatContext(
  messages: ChatMessage[],
  excludeMessageIds: string | string[] = '',
  limit = 8,
  maxBodyChars = 320,
): string {
  const excluded = new Set(Array.isArray(excludeMessageIds) ? excludeMessageIds : [excludeMessageIds]);
  const maxBody = Math.max(80, maxBodyChars);
  const rows = messages
    .filter((message) => !excluded.has(message.id))
    .filter((message) => {
      const body = message.body.trim();
      return body.length > 0 && body !== 'Thinking...';
    })
    .slice(-Math.max(1, limit));
  if (!rows.length) return '';
  return rows.map((message) => {
    const body = message.body.replace(/\s+/g, ' ').trim();
    const clipped = body.length > maxBody ? `${body.slice(0, maxBody - 1)}…` : body;
    const reply = message.replyTo?.preview
      ? ` (replying to ${message.replyTo.author || message.replyTo.mention || 'message'}: ${message.replyTo.preview.slice(0, 120)})`
      : '';
    return `${message.author}${reply}: ${clipped}`;
  }).join('\n');
}

/**
 * Give chat agents the note-tree context that a person can see in the sidebar.
 *
 * The process cwd is an execution detail and may be the home directory, so it
 * cannot tell an agent that (for example) #cubegen lives under projects / OC.
 * Project notes in the channel folder (or an ancestor) are inherited context,
 * just like an AGENTS.md file applies to descendants in a source tree.
 */
export function buildAgentChannelWorkspaceContext(
  db: Db,
  channelId: string,
  maxProjectDocChars = 4_000,
): string {
  const channel = db.prepare(`
    SELECT id, vault_id, folder_id, title
    FROM notes
    WHERE id = ?
  `).get(channelId) as {
    id: string;
    vault_id: string;
    folder_id: string | null;
    title: string;
  } | undefined;
  if (!channel) return '';

  type FolderRow = { id: string; parent_id: string | null; name: string };
  const nearestFolders: FolderRow[] = [];
  const seen = new Set<string>();
  let folderId = channel.folder_id;
  while (folderId && !seen.has(folderId) && nearestFolders.length < 32) {
    seen.add(folderId);
    const folder = db.prepare(`
      SELECT id, parent_id, name
      FROM folders
      WHERE id = ? AND vault_id = ?
    `).get(folderId, channel.vault_id) as FolderRow | undefined;
    if (!folder) break;
    nearestFolders.push(folder);
    folderId = folder.parent_id;
  }

  const location = [
    ...nearestFolders.slice().reverse().map((folder) => folder.name),
    `#${channel.title}`,
  ].join(' / ');
  const chunks = [
    'Cascade is the user-facing, Obsidian-style workspace for AI-native project management. '
      + 'Its vault folders, project docs, notes, and chats are live app data, not a mirror of the process cwd. '
      + 'Use the `cascade-note` CLI on PATH to list, read, create, or edit live notes '
      + '(`--listed` and `--folder` place new notes in the sidebar); do not conclude the notes are unavailable '
      + 'because they are absent from the local filesystem or named tool list.',
    `Cascade channel location: ${location}`,
  ];

  let remaining = Math.max(0, Math.floor(maxProjectDocChars));
  let documentCount = 0;
  for (const folder of nearestFolders) {
    if (remaining <= 0 || documentCount >= 3) break;
    const notes = db.prepare(`
      SELECT id, title, content
      FROM notes
      WHERE vault_id = ?
        AND folder_id = ?
        AND id != ?
        AND is_archived = 0
      ORDER BY is_pinned DESC, updated_at DESC, title ASC
    `).all(channel.vault_id, folder.id, channel.id) as Array<{
      id: string;
      title: string;
      content: string;
    }>;
    for (const note of notes) {
      if (remaining <= 0 || documentCount >= 3) break;
      if (!/^Project(?:\s*(?:[-—–:])|\s+|$)/i.test(note.title.trim())) continue;
      const body = String(note.content || '').trim();
      const clipped = body.length > remaining
        ? `${body.slice(0, Math.max(0, remaining - 1))}…`
        : body;
      chunks.push(
        `Relevant project doc from ${folder.name} — ${note.title}:`
        + (clipped ? `\n${clipped}` : ''),
      );
      remaining -= Math.min(body.length, remaining);
      documentCount += 1;
    }
  }

  return chunks.join('\n\n');
}

/** Full single message (includes harness log) — used when expanding a harness panel. */
export function getChatMessage(
  db: Db,
  channelId: string,
  userId: number,
  messageId: string,
): ChatMessage | undefined {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db.prepare(`
    SELECT *, rowid,
      CASE WHEN harness_log IS NOT NULL AND length(harness_log) > 0 THEN 1 ELSE 0 END AS has_harness
    FROM chat_messages
    WHERE id = ? AND channel_id = ?
  `).get(messageId, route.sourceChannelId) as (ChatMessageRow & { has_harness?: number }) | undefined;
  if (!row) return undefined;
  return {
    ...rowToMessage(row, { detail: 'full' }),
    channelId: route.localChannelId,
  };
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

function isAntigravityPlannerMonologue(summary: string): boolean {
  const t = summary.trim();
  if (!t) return false;
  if (/^I will\b/i.test(t)) return true;
  if (/^I(?:'ll| am going to)\b/i.test(t)) return true;
  if (/^Let me\b/i.test(t)) return true;
  return false;
}

function isGenericRunSummary(summary: string): boolean {
  const s = summary.trim();
  if (/^(done\.?|completed note operations successfully\.?|agent failed\.?)$/i.test(s)) return true;
  if (isAntigravityPlannerMonologue(s)) return true;
  return false;
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
      reply_to_json = ?,
      change_request_json = ?
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
    row.change_request_json,
    message.id,
    channelId,
  );
  return message;
}

function reconcileChatMessageRunStatus(
  db: Db,
  row: ChatMessageRow & { has_harness?: number },
  detail: 'list' | 'full' = 'full',
): ChatMessage {
  const message = rowToMessage(row, { detail });
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
    const row = db.prepare(`
      SELECT m.display_name, m.agent_id, va.owner_user_id
      FROM chat_agent_members m
      JOIN vault_agents va ON va.id = m.vault_agent_id
      WHERE m.id = ? AND m.channel_id = ?
    `).get(registrationId, route.sourceChannelId) as {
      display_name: string; agent_id: string; owner_user_id: number;
    } | undefined;
    if (row) {
      if (row.owner_user_id !== userId) throw new Error('Only an agent owner can post as that agent');
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
  if (input.changeRequest) {
    message.changeRequest = {
      files: input.changeRequest.files.slice(0, 100).map((file) => ({
        path: String(file.path || '').slice(0, 500),
        additions: Math.max(0, Math.floor(Number(file.additions) || 0)),
        deletions: Math.max(0, Math.floor(Number(file.deletions) || 0)),
      })).filter((file) => file.path.length > 0),
      ...(input.changeRequest.commit ? { commit: String(input.changeRequest.commit).slice(0, 80) } : {}),
      ...(input.changeRequest.ref ? { ref: String(input.changeRequest.ref).slice(0, 200) } : {}),
      approvals: [],
    };
  }

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
      blocks_json, harness_log, images_json, attachments_json, reply_to_json, change_request_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    row.change_request_json,
  );

  // Carry the persistence order so the create broadcast orders identically to a
  // later reload (which reads rowid) even for same-millisecond messages.
  message.seq = Number(info.lastInsertRowid);
  // Chat→note backlinks are indexed by the route layer (see indexChatMessageBacklinks)
  // to avoid a circular import with evolution.ts.
  return { ...message, channelId: route.localChannelId };
}

/**
 * Hard-delete a chat message (used to drop dual-post run shells after the agent
 * already posted via cascade-chat send). Returns true when a row was removed.
 */
export function deleteChatMessage(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  messageId: string,
): boolean {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');
  const result = db.prepare('DELETE FROM chat_messages WHERE id = ? AND channel_id = ?')
    .run(messageId, route.sourceChannelId);
  return Number(result.changes || 0) > 0;
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

export function approveChatChangeRequest(
  db: Db, userId: number, vaultId: string, channelId: string, messageId: string,
): ChatMessage {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db.prepare('SELECT *, rowid FROM chat_messages WHERE id = ? AND channel_id = ?')
    .get(messageId, route.sourceChannelId) as ChatMessageRow | undefined;
  if (!row) throw new Error('Change request not found');
  const message = rowToMessage(row);
  if (!message.changeRequest) throw new Error('Message is not a change request');
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
  const approvals = message.changeRequest.approvals.filter((approval) => approval.userId !== userId);
  approvals.push({ userId, username: user.username });
  return {
    ...persistChatMessageRow(db, route.sourceVaultId, route.sourceChannelId, {
      ...message,
      changeRequest: { ...message.changeRequest, approvals },
    }),
    channelId: route.localChannelId,
  };
}

export function mergeChatChangeRequest(
  db: Db, userId: number, vaultId: string, channelId: string, messageId: string,
): ChatMessage {
  const { route } = assertChatChannel(db, channelId, userId);
  const sourceVault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(route.sourceVaultId) as Vault | undefined;
  if (!sourceVault || sourceVault.created_by !== userId) throw new Error('Only the repository owner can merge');
  const row = db.prepare('SELECT *, rowid FROM chat_messages WHERE id = ? AND channel_id = ?')
    .get(messageId, route.sourceChannelId) as ChatMessageRow | undefined;
  if (!row) throw new Error('Change request not found');
  const message = rowToMessage(row);
  const request = message.changeRequest;
  if (!request || request.mergedAt) throw new Error('Change request is unavailable');
  if (!request.approvals.length) throw new Error('At least one approval is required');
  const ref = String(request.ref || request.commit || '').trim();
  if (!ref || ref.startsWith('-') || ref.includes('..') || !/^[A-Za-z0-9_./-]+$/.test(ref)) {
    throw new Error('Change request has an invalid git ref');
  }
  const configured = db.prepare('SELECT cwd FROM chat_channel_settings WHERE channel_id = ?')
    .get(route.sourceChannelId) as { cwd: string } | undefined;
  const cwd = configured?.cwd?.trim() || sourceVault.root_path;
  execFileSync('git', ['-C', cwd, 'merge', '--ff-only', ref], { timeout: 120_000, stdio: 'pipe' });
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
  return {
    ...persistChatMessageRow(db, route.sourceVaultId, route.sourceChannelId, {
      ...message,
      changeRequest: {
        ...request,
        mergedAt: new Date().toISOString(),
        mergedBy: user.username,
      },
    }),
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

/** Convert run-event content into the chat block list (text, thinking, tools). */
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

/** Append blocks, coalescing consecutive text/thinking blocks (mirrors the client). */
function appendChatRunBlocks(existing: ChatBlock[], blocks: ChatBlock[]): ChatBlock[] {
  const next = [...existing];
  for (const block of blocks) {
    const last = next[next.length - 1];
    if (last && last.type === block.type && (block.type === 'text' || block.type === 'thinking')) {
      next[next.length - 1] = { ...last, text: `${last.text || ''}${block.text || ''}` };
      continue;
    }
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
 * Chat body prefers the runner's latest non-generic final summary. The streamed
 * text can include earlier progress narration from tool turns.
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
  // Successful chat body = the runner's latest final answer when available.
  // Accumulated streamed text is a fallback because it may include progress.
  // Full step narration lives in `blocks` / `harnessLog` for the terminal pane.
  // Failures keep the scratchpad and append the reason.
  // If the agent already posted via cascade-chat send, leave the run bubble
  // body empty so we don't double-post the same reply.
  //
  // While still running, never put intermediate stream text in the chat body —
  // models often emit plan/monologue/"thinking out loud" as type:text tokens
  // (and real thinking blocks already stay in blocks). Showing that mid-run
  // leaked "thinking traces" into the transcript. Harness + blocks still update.
  let body: string;
  if (!done) {
    body = 'Thinking...';
  } else if (status === 'failed' || status === 'canceled') {
    const reason = terminalSummary.trim()
      || (status === 'canceled' ? 'Run canceled by user.' : 'Agent failed.');
    body = trimmed ? `${trimmed}\n\n> ⚠️ ${reason}` : reason;
  } else if (suppressChatBody) {
    body = '';
  } else {
    if (terminalSummary.trim() && !isGenericRunSummary(terminalSummary)) {
      body = terminalSummary.trim();
    } else if (trimmed) {
      body = trimmed;
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
    /** Optional; when omitted, stamp strictly after the channel's latest message
     * so agent shells never share a millisecond (and lower rowid) with the prompt. */
    createdAt?: string;
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

  const { route } = assertChatChannel(db, channelId, userId);
  let createdAt = input.createdAt || new Date().toISOString();
  const latest = db.prepare(`
    SELECT created_at FROM chat_messages
    WHERE channel_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(route.sourceChannelId) as { created_at: string } | undefined;
  if (latest?.created_at && createdAt <= latest.created_at) {
    const t = Date.parse(latest.created_at);
    createdAt = new Date((Number.isFinite(t) ? t : Date.now()) + 1).toISOString();
  }

  const message = createChatMessage(db, userId, vaultId, channelId, {
    id: input.messageId,
    channelId,
    author: input.author,
    body: input.body ?? 'Thinking...',
    createdAt,
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

/**
 * Channel-level working directory. When set, every agent run in the channel
 * uses it, overriding each agent's own cwd — a single "global cwd" for the
 * channel. Stored against the source channel so linked (guest) channels share
 * the owner's setting. Empty string means "unset — fall back to per-agent cwd".
 */
export function getChannelCwd(db: Db, sourceChannelId: string): string {
  const row = db.prepare('SELECT cwd FROM chat_channel_settings WHERE channel_id = ?')
    .get(sourceChannelId) as { cwd: string } | undefined;
  return (row?.cwd ?? '').trim();
}

/** Read a channel's settings (resolves links to the source channel). */
export function getChannelSettings(db: Db, channelId: string, userId: number): { cwd: string } {
  const { route } = assertChatChannel(db, channelId, userId);
  return { cwd: getChannelCwd(db, route.sourceChannelId) };
}

/** Set the channel-wide cwd. Applies to the source channel; returns the value. */
export function setChannelCwd(db: Db, channelId: string, userId: number, cwd: string): { cwd: string } {
  const { route } = assertChatChannel(db, channelId, userId);
  const value = String(cwd ?? '').trim();
  db.prepare(`
    INSERT INTO chat_channel_settings (channel_id, cwd, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at
  `).run(route.sourceChannelId, value);
  return { cwd: value };
}

/** Set one persistent agent identity's picture. Only its vault owner can do so. */
export function setChatAgentAvatar(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  registrationId: string,
  avatarUrl: string,
): ChatAgentRegistration {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId || route.sourceVaultId !== vaultId) throw new Error('Chat channel not found');
  const sourceVault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(route.sourceVaultId) as Vault | undefined;
  if (!sourceVault || sourceVault.created_by !== userId) throw new Error('Only the agent owner can update its profile picture');
  const url = String(avatarUrl || '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw new Error('Profile picture must be an http(s) URL');
  if (url.length > 2048) throw new Error('Profile picture URL is too long');
  const member = db.prepare('SELECT * FROM chat_agent_members WHERE id = ? AND channel_id = ?')
    .get(registrationId, route.sourceChannelId) as ChatAgentMemberRow | undefined;
  if (!member) throw new Error('Agent not found');
  const vaultAgentId = member.vault_agent_id;
  if (!vaultAgentId) throw new Error('Agent identity is not ready yet');
  db.prepare("UPDATE vault_agents SET avatar_url = ?, updated_at = datetime('now') WHERE id = ? AND vault_id = ?")
    .run(url, vaultAgentId, route.sourceVaultId);
  db.prepare("UPDATE chat_agent_members SET avatar_url = ?, updated_at = datetime('now') WHERE vault_agent_id = ?")
    .run(url, vaultAgentId);
  const updated = db.prepare('SELECT * FROM chat_agent_members WHERE id = ? AND channel_id = ?')
    .get(registrationId, route.sourceChannelId) as ChatAgentMemberRow;
  return rowToAgentMember(updated);
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

  // Prefer linking an existing vault agent when vaultAgentId is provided.
  if (input.vaultAgentId && String(input.vaultAgentId).trim()) {
    return addVaultAgentToChannel(db, userId, vaultId, channelId, String(input.vaultAgentId).trim(), {
      taggableByAgents: input.taggableByAgents,
      replyToEveryMessage: input.replyToEveryMessage,
      pingableByOthers: input.pingableByOthers,
      yolo: input.yolo,
      conversationId: input.conversationId,
    });
  }

  const member = normalizeAgentRegistration(input);
  const existing = db.prepare('SELECT id, conversation_id, vault_agent_id FROM chat_agent_members WHERE id = ? AND channel_id = ?').get(member.id, route.sourceChannelId) as { id: string; conversation_id: string; vault_agent_id: string } | undefined;

  // The session id is sticky: an explicit value (e.g. a `/clear` rotation) wins,
  // otherwise keep the member's existing session, otherwise mint a fresh one.
  member.conversationId = member.conversationId || existing?.conversation_id || crypto.randomUUID();
  if (existing?.vault_agent_id) member.vaultAgentId = existing.vault_agent_id;

  const vaultAgent = ensureVaultAgentForMember(db, route.sourceVaultId, member);
  member.vaultAgentId = vaultAgent.id;
  // Identity is canonical on vault_agents
  member.agentId = vaultAgent.agentId;
  member.displayName = vaultAgent.displayName;
  member.avatarUrl = vaultAgent.avatarUrl;
  member.mention = vaultAgent.mention;
  member.model = vaultAgent.model;
  member.cwd = vaultAgent.cwd;
  member.contextPrompt = vaultAgent.contextPrompt;

  if (existing) {
    db.prepare(`
      UPDATE chat_agent_members SET
        vault_agent_id = ?,
        agent_id = ?,
        display_name = ?,
        avatar_url = ?,
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
      member.vaultAgentId,
      member.agentId,
      member.displayName,
      member.avatarUrl,
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
        id, channel_id, vault_id, vault_agent_id, agent_id, display_name, avatar_url, mention,
        model, cwd, context_prompt, taggable_by_agents, reply_to_every_message, pingable_by_others, yolo, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      member.id,
      route.sourceChannelId,
      route.sourceVaultId,
      member.vaultAgentId,
      member.agentId,
      member.displayName,
      member.avatarUrl,
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
