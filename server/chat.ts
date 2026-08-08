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
import { createNote, getNote, getVault, type Vault } from './vault.js';
import { redactPrivateBlocks } from './privacy.js';
import { createWorkItem } from './workItems.js';

type Db = Database.Database;

export const CHAT_NOTE_MARKER = 'cascade://chat-channel';
export const CASCADE_AGENT_APP_CONTEXT =
  'Cascade is a user-facing, Obsidian-style workspace for AI-native project management. '
  + 'Its vault folders, project docs, notes, and chats are live app data, not a mirror of the agent process cwd. '
  + 'Use `cascade-note` by command name to list, read, create, edit, move live notes, and create/list folders; it is on PATH and pre-authorized. '
  + 'Use `cascade-note folder create <name>`, then `cascade-note move <note> --folder <folder>` to organize existing notes. Use `--listed` and `--folder` when placing a new note in the sidebar. '
  + 'Do not replace the helper with an absolute path, inspect a local docs.db, or conclude notes are unavailable '
  + 'because they are absent from the local filesystem or named tool list. '
  + 'Use normal filesystem tools only for local repository/workspace work the user actually requested. '
  + 'Chat messages can carry images and files; the text transcript only marks them. '
  + 'When a message has media, open it with `cascade-chat attachment --message-id <id>` (writes the file and prints its path) '
  + 'before answering about the image. Never claim you cannot see/receive an attachment, and never invent its contents. '
  + 'Shipping to this repo: run `npm run build` before push to master; after push watch Deploy Production with `gh run watch` until green. '
  + 'Push is not ship. Do not ignore a red deploy.';

export type ChatReplyRef = {
  messageId: string;
  author: string;
  mention: string;
  preview: string;
};

/** Provenance stamped on a message copied into another channel ("forward"). */
export type ChatForwardRef = {
  /** Origin message id. Kept for tracing; the copy is independent of it. */
  messageId: string;
  /** Origin channel as the forwarder sees it (their local channel id). */
  channelId: string;
  channelName: string;
  author: string;
  createdAt: string;
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

/**
 * Pre-contract clarification: agent asks (questionnaire); human answers; accept
 * compiles into a work-item contract + mission that drives agents until done,
 * token budget, or manual stop.
 */
export type ClarificationQuestionKind = 'text' | 'single' | 'multi';

export type ChatClarificationQuestion = {
  id: string;
  prompt: string;
  /** text = freeform; single = radio; multi = checkboxes. Default text. */
  kind?: ClarificationQuestionKind;
  /** Choice labels for single/multi. */
  options?: string[];
  /**
   * Prefill shown in the card (and counted as answered). Agents should always
   * set this so Accept is one click when the user agrees with the recommendation.
   */
  answer?: string;
};

export type ChatClarification = {
  title: string;
  questions: ChatClarificationQuestion[];
  status: 'pending' | 'accepted' | 'canceled';
  /** Soft token ceiling for the resulting contract (0 = unlimited). */
  tokenBudget?: number;
  assigneeRegistrationId?: string;
  workItemId?: string;
  /** Mission opened on accept so the orchestrator can plan/delegate. */
  missionId?: string;
  acceptedAt?: string;
  acceptedBy?: string;
};

function normalizeClarificationQuestionKind(raw: unknown): ClarificationQuestionKind {
  const kind = String(raw || 'text').toLowerCase();
  if (kind === 'single' || kind === 'choice' || kind === 'radio' || kind === 'select') return 'single';
  if (kind === 'multi' || kind === 'multiple' || kind === 'checkbox' || kind === 'checkboxes') return 'multi';
  return 'text';
}

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
/** Optimistic agent shells older than this never acquired a real run. */
export const AGENT_PLACEHOLDER_START_TIMEOUT_MS = 60_000;

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
  /** Set when this message was forwarded from another channel. */
  forwardedFrom?: ChatForwardRef;
  changeRequest?: ChatChangeRequest;
  /** Pre-work Q&A that becomes a work-item contract when accepted. */
  clarification?: ChatClarification;
  /** Durable chat-first orchestration state projected onto the root message. */
  mission?: ChatMission;
  /** Delegated worker messages point at the task they execute. */
  missionTaskId?: string;
};

export type ChatMissionTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'canceled';

export type ChatMissionTask = {
  id: string;
  title: string;
  assignee: string;
  assigneeMention: string;
  assigneeModel: string;
  status: ChatMissionTaskStatus;
  summary: string;
  dependsOn: string[];
  waitingFor: string[];
  priority: number;
  reasoningEffort: string;
  /** Parallel clone of a channel agent; not a second named member. */
  anonymous: boolean;
  queueReason: 'dependency' | 'agent-busy' | 'queued' | '';
  runId?: number;
  /** Durable work-item twin (workspace / lease / PR). */
  workItemId?: string;
  workItemStatus?: string;
  workspaceMode?: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  prState?: string;
  verification?: string;
  reviewState?: 'none' | 'requested' | 'in_review' | 'ready';
  gitState?: { changedFiles: number; dirty: boolean; behind: number; updatedAt: string };
  reviewReady?: boolean;
  reviewBlockers?: string[];
  updatedAt: string;
};

export type ChatMissionStatus = 'active' | 'reviewing' | 'blocked' | 'completed' | 'canceled';

export type ChatMission = {
  id: string;
  title: string;
  objective: string;
  status: ChatMissionStatus;
  coordinator: string;
  coordinatorMention: string;
  tasks: ChatMissionTask[];
  summary: string;
  createdAt: string;
  updatedAt: string;
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
  /** Optional per-channel Codex effort override. Empty inherits the local CLI config. */
  reasoningEffort: string;
  cwd: string;
  contextPrompt: string;
  taggableByAgents: boolean;
  replyToEveryMessage: boolean;
  /** Channel coordinator: receives every human turn and may dispatch members. */
  orchestrator: boolean;
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
  forwarded_from_json: string | null;
  change_request_json: string | null;
  clarification_json: string | null;
  mission_json: string | null;
  mission_task_id: string | null;
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
      forwarded_from_json TEXT,
      change_request_json TEXT,
      mission_json TEXT,
      mission_task_id TEXT
    );
    CREATE INDEX IF NOT EXISTS chat_messages_channel_idx ON chat_messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS chat_messages_run_idx ON chat_messages(run_id);
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
      reasoning_effort TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      context_prompt TEXT NOT NULL DEFAULT '',
      taggable_by_agents INTEGER NOT NULL DEFAULT 0,
      reply_to_every_message INTEGER NOT NULL DEFAULT 0,
      orchestrator INTEGER NOT NULL DEFAULT 0,
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
      kanban_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL,
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
  if (!messageCols.some((col) => col.name === 'clarification_json')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN clarification_json TEXT');
  }
  if (!messageCols.some((col) => col.name === 'forwarded_from_json')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN forwarded_from_json TEXT');
  }
  if (!messageCols.some((col) => col.name === 'mission_json')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN mission_json TEXT');
  }
  if (!messageCols.some((col) => col.name === 'mission_task_id')) {
    db.exec('ALTER TABLE chat_messages ADD COLUMN mission_task_id TEXT');
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
  if (!memberCols.some((col) => col.name === 'orchestrator')) {
    db.exec('ALTER TABLE chat_agent_members ADD COLUMN orchestrator INTEGER NOT NULL DEFAULT 0');
  }
  if (!memberCols.some((col) => col.name === 'pingable_by_others')) {
    db.exec('ALTER TABLE chat_agent_members ADD COLUMN pingable_by_others INTEGER NOT NULL DEFAULT 0');
  }
  const channelSettingsCols = db.prepare('PRAGMA table_info(chat_channel_settings)').all() as Array<{ name: string }>;
  if (!channelSettingsCols.some((col) => col.name === 'kanban_note_id')) {
    db.exec('ALTER TABLE chat_channel_settings ADD COLUMN kanban_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL');
  }
  if (!memberCols.some((col) => col.name === 'vault_agent_id')) {
    db.exec("ALTER TABLE chat_agent_members ADD COLUMN vault_agent_id TEXT NOT NULL DEFAULT ''");
  }
  if (!memberCols.some((col) => col.name === 'avatar_url')) {
    db.exec("ALTER TABLE chat_agent_members ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
  }
  if (!memberCols.some((col) => col.name === 'reasoning_effort')) {
    db.exec("ALTER TABLE chat_agent_members ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT ''");
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

  // Agents belong to the person who made them, not to a vault, so the same
  // roster follows you into every vault you are a member of.
  migrateVaultAgentsToOwnerScope(db);

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
  reasoning_effort: string;
  cwd: string;
  context_prompt: string;
  taggable_by_agents: number;
  reply_to_every_message: number;
  orchestrator: number;
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
    reasoningEffort: row.reasoning_effort || '',
    cwd: row.cwd,
    contextPrompt: row.context_prompt,
    taggableByAgents: row.taggable_by_agents !== 0,
    replyToEveryMessage: row.reply_to_every_message !== 0,
    orchestrator: row.orchestrator !== 0,
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
/**
 * Re-key vault_agents from UNIQUE(vault_id, mention) to UNIQUE(owner_user_id,
 * mention) so an agent roster belongs to a person rather than to one vault.
 *
 * Handles were only unique per vault, so one owner could end up with a separate
 * `@claude` row per vault. Those rows were always meant to be the same agent, so
 * they are *merged* — the oldest survives and inherits the others' channel
 * memberships — rather than renamed into `@claude-2`. Merging happens before the
 * rebuild: the old constraint tolerates the duplicates, the new one would not.
 */
function migrateVaultAgentsToOwnerScope(db: Db): void {
  const schema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vault_agents'",
  ).get() as { sql: string } | undefined;
  if (!schema || /UNIQUE\s*\(\s*owner_user_id\s*,\s*mention\s*\)/i.test(schema.sql)) return;

  const dupes = db.prepare(`
    SELECT owner_user_id AS owner, LOWER(mention) AS handle, COUNT(*) AS n
    FROM vault_agents WHERE owner_user_id IS NOT NULL
    GROUP BY owner, handle HAVING n > 1
  `).all() as Array<{ owner: number; handle: string; n: number }>;
  for (const dupe of dupes) {
    const rows = db.prepare(`
      SELECT id, vault_id, mention FROM vault_agents
      WHERE owner_user_id = ? AND mention = ? COLLATE NOCASE
      ORDER BY created_at ASC
    `).all(dupe.owner, dupe.handle) as Array<{ id: string; vault_id: string; mention: string }>;
    // Oldest survives and absorbs the rest: same handle, same person, so the
    // duplicates were only ever an artifact of per-vault storage.
    const winner = rows[0];
    if (!winner) continue;
    for (const loser of rows.slice(1)) {
      // A channel can only hold one membership per agent; drop any that would
      // duplicate the winner's before repointing the remainder.
      db.prepare(`
        DELETE FROM chat_agent_members
        WHERE vault_agent_id = ? AND channel_id IN (
          SELECT channel_id FROM chat_agent_members WHERE vault_agent_id = ?
        )
      `).run(loser.id, winner.id);
      db.prepare(`
        UPDATE chat_agent_members
        SET vault_agent_id = ?, mention = ?, updated_at = datetime('now')
        WHERE vault_agent_id = ?
      `).run(winner.id, winner.mention, loser.id);
      db.prepare('DELETE FROM vault_agents WHERE id = ?').run(loser.id);
    }
  }

  db.exec(`
    CREATE TABLE vault_agents_owner_scoped (
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
      UNIQUE(owner_user_id, mention)
    );
    INSERT INTO vault_agents_owner_scoped
      (id, vault_id, agent_id, display_name, avatar_url, mention, model, cwd, context_prompt, owner_user_id, created_at, updated_at)
      SELECT id, vault_id, agent_id, display_name, avatar_url, mention, model, cwd, context_prompt, owner_user_id, created_at, updated_at
      FROM vault_agents;
    DROP TABLE vault_agents;
    ALTER TABLE vault_agents_owner_scoped RENAME TO vault_agents;
    CREATE INDEX IF NOT EXISTS vault_agents_vault_idx ON vault_agents(vault_id);
    CREATE INDEX IF NOT EXISTS vault_agents_owner_idx ON vault_agents(owner_user_id);
  `);
}

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
    // Scoped per vault because that is where an @mention has to be unambiguous;
    // ownership uniqueness is enforced by UNIQUE(owner_user_id, mention).
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
  const requestedEffort = String(input.reasoningEffort || '').trim().toLowerCase();
  const supportedEfforts = agentId === 'codex'
    ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    : agentId === 'claude-code'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : [];
  const reasoningEffort = supportedEfforts.includes(requestedEffort)
    ? requestedEffort
    : '';

  return {
    id,
    vaultAgentId: String(input.vaultAgentId || '').trim(),
    agentId,
    displayName: String(input.displayName || '').trim() || agentId,
    avatarUrl: String(input.avatarUrl || '').trim(),
    mention,
    model: String(input.model || ''),
    reasoningEffort,
    cwd: String(input.cwd || ''),
    contextPrompt: String(input.contextPrompt || ''),
    taggableByAgents: input.taggableByAgents === true,
    replyToEveryMessage: input.replyToEveryMessage === true || input.orchestrator === true,
    orchestrator: input.orchestrator === true,
    pingableByOthers: input.pingableByOthers === true,
    yolo: input.yolo === true,
    // May be empty here; upsert preserves the existing session or mints a new one.
    conversationId: String(input.conversationId || '').trim(),
  };
}

function assertCoordinatorSlot(db: Db, channelId: string, memberId: string, requested: boolean): void {
  if (!requested) return;
  const existing = db.prepare(`
    SELECT display_name, mention FROM chat_agent_members
    WHERE channel_id = ? AND orchestrator != 0 AND id != ? LIMIT 1
  `).get(channelId, memberId) as { display_name: string; mention: string } | undefined;
  if (existing) {
    throw new Error(`${existing.display_name || `@${existing.mention}`} already coordinates this channel`);
  }
}

function assertAgentManagementOwner(db: Db, userId: number, sourceVaultId: string): void {
  const vault = db.prepare('SELECT created_by FROM vaults WHERE id = ?')
    .get(sourceVaultId) as { created_by: number } | undefined;
  if (!vault || vault.created_by !== userId) {
    throw new Error('Only the channel owner can manage its agents');
  }
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
    // Not scoped to this vault: the same agent identity is reused across every
    // vault it has been added to, so its row lives wherever it was created.
    const existing = db.prepare('SELECT * FROM vault_agents WHERE id = ?')
      .get(member.vaultAgentId) as VaultAgentRow | undefined;
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
  // Your own roster, wherever it was created, plus any agent already placed in
  // this vault's channels — so a shared vault still shows the owner's agents
  // to the people they invited.
  const rows = db.prepare(`
    SELECT va.*, u.username AS owner_username
    FROM vault_agents va LEFT JOIN users u ON u.id = va.owner_user_id
    WHERE va.owner_user_id = ? OR va.vault_id = ?
    ORDER BY va.display_name ASC, va.mention ASC
  `).all(userId, vaultId) as VaultAgentRow[];
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
  const row = db.prepare(
    'SELECT * FROM vault_agents WHERE id = ? AND (owner_user_id = ? OR vault_id = ?)',
  ).get(vaultAgentId, userId, vaultId) as VaultAgentRow | undefined;
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

  const existing = db.prepare(
    'SELECT * FROM vault_agents WHERE id = ? AND (owner_user_id = ? OR vault_id = ?)',
  ).get(id, userId, vaultId) as VaultAgentRow | undefined;
  if (existing && existing.owner_user_id != null && existing.owner_user_id !== userId) {
    throw new Error('Only the agent owner can edit it');
  }
  const avatarUrl = String(input.avatarUrl || existing?.avatar_url || '').trim();

  // Handles are unique per owner, and additionally must not collide with an
  // agent already living in this vault (both could be @-mentioned here).
  const clash = db.prepare(`
    SELECT id FROM vault_agents
    WHERE mention = ? COLLATE NOCASE AND id != ? AND (owner_user_id = ? OR vault_id = ?)
  `).get(mention, id, userId, vaultId) as { id: string } | undefined;
  if (clash) throw new Error(`Mention @${mention} is already used by another agent`);

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
    // Owned at creation: the roster is the person's, and UNIQUE(owner_user_id,
    // mention) only holds if the owner is set in the same statement.
    db.prepare(`
      INSERT INTO vault_agents (id, vault_id, agent_id, display_name, avatar_url, mention, model, cwd, context_prompt, owner_user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, vaultId, agentId, displayName, avatarUrl, mention, model, cwd, contextPrompt, userId);
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
  // Only the owner can retire an agent; a vault member removing it from their
  // view should be removing it from the channel, not deleting someone's agent.
  const target = db.prepare('SELECT owner_user_id FROM vault_agents WHERE id = ?')
    .get(vaultAgentId) as { owner_user_id: number | null } | undefined;
  if (!target) return false;
  if (target.owner_user_id != null && target.owner_user_id !== userId) {
    throw new Error('Only the agent owner can delete it');
  }
  // Drop all channel memberships first
  db.prepare('DELETE FROM chat_agent_members WHERE vault_agent_id = ?').run(vaultAgentId);
  const result = db.prepare('DELETE FROM vault_agents WHERE id = ?').run(vaultAgentId);
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
  flags: Partial<Pick<ChatAgentRegistration, 'reasoningEffort' | 'taggableByAgents' | 'replyToEveryMessage' | 'orchestrator' | 'pingableByOthers' | 'yolo' | 'conversationId'>> = {},
): ChatAgentRegistration {
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');
  assertAgentManagementOwner(db, userId, route.sourceVaultId);
  // One agent, many vaults: an agent you own can join a channel anywhere you
  // can manage agents, not only in the vault it happened to be created in.
  const va = db.prepare(
    'SELECT * FROM vault_agents WHERE id = ? AND (owner_user_id = ? OR vault_id = ?)',
  ).get(vaultAgentId, userId, route.sourceVaultId) as VaultAgentRow | undefined;
  if (!va) throw new Error('Vault agent not found');
  // The handle has to stay unambiguous inside the vault it is joining.
  const handleClash = db.prepare(`
    SELECT id FROM vault_agents
    WHERE vault_id = ? AND mention = ? COLLATE NOCASE AND id != ?
  `).get(route.sourceVaultId, va.mention, va.id) as { id: string } | undefined;
  if (handleClash) {
    throw new Error(`@${va.mention} is already used by another agent in this vault`);
  }

  const existing = db.prepare(`
    SELECT * FROM chat_agent_members WHERE vault_agent_id = ? AND channel_id = ?
  `).get(vaultAgentId, route.sourceChannelId) as ChatAgentMemberRow | undefined;

  const conversationId = flags.conversationId
    || existing?.conversation_id
    || crypto.randomUUID();
  const taggable = flags.taggableByAgents !== undefined ? flags.taggableByAgents : (existing ? existing.taggable_by_agents !== 0 : false);
  const orchestrator = flags.orchestrator !== undefined ? flags.orchestrator : (existing ? existing.orchestrator !== 0 : false);
  const replyEvery = orchestrator || (flags.replyToEveryMessage !== undefined ? flags.replyToEveryMessage : (existing ? existing.reply_to_every_message !== 0 : false));
  const pingable = flags.pingableByOthers !== undefined ? flags.pingableByOthers : (existing ? existing.pingable_by_others !== 0 : false);
  const yolo = flags.yolo !== undefined ? flags.yolo : (existing ? existing.yolo !== 0 : false);
  const requestedEffort = String(flags.reasoningEffort ?? existing?.reasoning_effort ?? '').trim().toLowerCase();
  const supportedEfforts = va.agent_id === 'codex'
    ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    : va.agent_id === 'claude-code'
      ? ['low', 'medium', 'high', 'xhigh', 'max']
      : [];
  const reasoningEffort = supportedEfforts.includes(requestedEffort)
    ? requestedEffort
    : '';
  const memberId = existing?.id || crypto.randomUUID();
  assertCoordinatorSlot(db, route.sourceChannelId, memberId, orchestrator);

  if (existing) {
    db.prepare(`
      UPDATE chat_agent_members SET
        agent_id = ?, display_name = ?, avatar_url = ?, mention = ?, model = ?, reasoning_effort = ?, cwd = ?, context_prompt = ?,
        taggable_by_agents = ?, reply_to_every_message = ?, orchestrator = ?, pingable_by_others = ?, yolo = ?,
        conversation_id = ?, vault_agent_id = ?, updated_at = datetime('now')
      WHERE id = ? AND channel_id = ?
    `).run(
      va.agent_id, va.display_name, va.avatar_url, va.mention, va.model, reasoningEffort, va.cwd, va.context_prompt,
      taggable ? 1 : 0, replyEvery ? 1 : 0, orchestrator ? 1 : 0, pingable ? 1 : 0, yolo ? 1 : 0,
      conversationId, va.id, memberId, route.sourceChannelId,
    );
  } else {
    db.prepare(`
      INSERT INTO chat_agent_members (
        id, channel_id, vault_id, vault_agent_id, agent_id, display_name, avatar_url, mention,
        model, reasoning_effort, cwd, context_prompt, taggable_by_agents, reply_to_every_message, orchestrator, pingable_by_others, yolo, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memberId, route.sourceChannelId, route.sourceVaultId, va.id,
      va.agent_id, va.display_name, va.avatar_url, va.mention, va.model, reasoningEffort, va.cwd, va.context_prompt,
      taggable ? 1 : 0, replyEvery ? 1 : 0, orchestrator ? 1 : 0, pingable ? 1 : 0, yolo ? 1 : 0, conversationId,
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
      const forwardedFrom = parseJson<ChatForwardRef>(row.forwarded_from_json);
      return forwardedFrom ? { forwardedFrom } : {};
    })(),
    ...(() => {
      const changeRequest = parseJson<ChatChangeRequest>(row.change_request_json);
      return changeRequest ? { changeRequest } : {};
    })(),
    ...(() => {
      const clarification = parseJson<ChatClarification>(row.clarification_json);
      return clarification ? { clarification } : {};
    })(),
    ...(() => {
      const mission = parseJson<ChatMission>(row.mission_json);
      return mission ? { mission } : {};
    })(),
    ...(row.mission_task_id ? { missionTaskId: row.mission_task_id } : {}),
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
    forwarded_from_json: serializeJson(message.forwardedFrom),
    change_request_json: serializeJson(message.changeRequest),
    clarification_json: serializeJson(message.clarification),
    mission_json: serializeJson(message.mission),
    mission_task_id: message.missionTaskId ?? null,
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

  // Also include human authors who posted in this channel so profiles populate
  // even when membership is only partially linked (or a guest spoke once).
  try {
    const authors = db.prepare(`
      SELECT DISTINCT author AS username
      FROM chat_messages
      WHERE channel_id = ?
        AND (agent_id IS NULL OR agent_id = '')
        AND author IS NOT NULL
        AND author != ''
        AND author != 'Cascade'
      LIMIT 200
    `).all(sourceChannelId) as Array<{ username: string }>;
    for (const row of authors) {
      if (row.username) usernames.add(row.username);
    }
  } catch {
    // Best-effort; core owner/link participants still return.
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
          blocks_json, images_json, attachments_json, reply_to_json,
          forwarded_from_json, change_request_json, clarification_json, mission_json, mission_task_id,
          rowid,
          CASE WHEN harness_log IS NOT NULL AND length(harness_log) > 0 THEN 1 ELSE 0 END AS has_harness
        FROM chat_messages
        WHERE channel_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?
      `).all(route.sourceChannelId, limit)
  ) as Array<ChatMessageRow & { has_harness?: number }>;

  rows.reverse();
  // List windows are pure reads; full fetches may still persist ghost repairs.
  const persist = detail === 'full';
  return rows.map((row) => ({
    ...reconcileChatMessageRunStatus(db, row, detail, { persist }),
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
  // A screenshot is often the whole message. Dropping media-only rows for having
  // an empty body left agents arguing about evidence they were never told exists.
  const mediaCount = (message: ChatMessage) =>
    (message.images?.length || (message.hasImages ? 1 : 0)) + (message.attachments?.length || 0);
  const rows = messages
    .filter((message) => !excluded.has(message.id))
    .filter((message) => {
      const body = message.body.trim();
      if (body === 'Thinking...') return false;
      return body.length > 0 || mediaCount(message) > 0;
    })
    .slice(-Math.max(1, limit));
  if (!rows.length) return '';
  const lines = rows.map((message) => {
    const body = message.body.replace(/\s+/g, ' ').trim();
    const clipped = body.length > maxBody ? `${body.slice(0, maxBody - 1)}…` : body;
    const reply = message.replyTo?.preview
      ? ` (replying to ${message.replyTo.author || message.replyTo.mention || 'message'}: ${message.replyTo.preview.slice(0, 120)})`
      : '';
    const images = message.images?.length || (message.hasImages ? 1 : 0);
    const named = (message.attachments || []).map((item) => item.name).filter(Boolean);
    const media = [
      images ? `${images} image${images === 1 ? '' : 's'}` : '',
      named.length ? named.join(', ') : '',
    ].filter(Boolean).join(', ');
    const marker = media ? ` [attached: ${media} — message ${message.id}]` : '';
    return `${message.author}${reply}: ${clipped}${marker}`;
  });
  const anyMedia = rows.some((message) => mediaCount(message) > 0);
  // The transcript is text-only, so name the way to actually open the file.
  const hint = anyMedia
    ? '\n(Attachments above are not inlined in this text window. Open one with '
      + '`cascade-chat attachment --message-id <id>` before answering about the image — '
      + 'it writes the file locally and prints its path. Do not claim you cannot see the attachment.)'
    : '';
  return `${lines.join('\n')}${hint}`;
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
  const chunks = [`Cascade channel location: ${location}`];

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
      const body = redactPrivateBlocks(String(note.content || '')).trim();
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

/**
 * Copy a message into another channel, Discord-style. The copy is a normal
 * message authored by the forwarder (so it is theirs to edit/delete) carrying a
 * `forwardedFrom` stamp for provenance. Body, images and attachments come
 * along; run state, harness logs and change requests deliberately do not —
 * those belong to the run in the origin channel.
 */
export function forwardChatMessage(
  db: Db,
  userId: number,
  username: string,
  input: {
    fromVaultId: string;
    fromChannelId: string;
    messageId: string;
    toVaultId: string;
    toChannelId: string;
    comment?: string;
  },
): ChatMessage {
  const source = getChatMessage(db, input.fromChannelId, userId, input.messageId);
  if (!source) throw new Error('Message not found');
  // assertChatChannel throws when the target is not a chat channel the user can see.
  const { route: target } = assertChatChannel(db, input.toChannelId, userId);
  if (target.localVaultId !== input.toVaultId) throw new Error('Chat channel not found');
  if (target.localChannelId === input.fromChannelId) {
    throw new Error('Cannot forward a message into the same channel');
  }

  const originNote = getNote(db, input.fromChannelId);
  const comment = String(input.comment ?? '').trim();
  const body = comment ? `${comment}\n\n${source.body}` : source.body;
  if (!body.trim() && !source.images?.length && !source.attachments?.length) {
    throw new Error('Nothing to forward');
  }

  return createChatMessage(db, userId, input.toVaultId, input.toChannelId, {
    id: crypto.randomUUID(),
    channelId: input.toChannelId,
    author: username,
    body,
    createdAt: new Date().toISOString(),
    ...(source.images?.length ? { images: source.images } : {}),
    ...(source.attachments?.length ? { attachments: source.attachments } : {}),
    forwardedFrom: {
      messageId: source.id,
      channelId: input.fromChannelId,
      channelName: originNote?.title || 'channel',
      author: source.author,
      createdAt: source.createdAt,
    },
  });
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
      forwarded_from_json = ?,
      change_request_json = ?,
      clarification_json = ?,
      mission_json = ?,
      mission_task_id = ?
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
    row.forwarded_from_json,
    row.change_request_json,
    row.clarification_json,
    row.mission_json,
    row.mission_task_id,
    message.id,
    channelId,
  );
  return message;
}

function reconcileChatMessageRunStatus(
  db: Db,
  row: ChatMessageRow & { has_harness?: number },
  detail: 'list' | 'full' = 'full',
  opts: { persist?: boolean } = {},
): ChatMessage {
  const message = rowToMessage(row, { detail });
  if (message.status !== 'running') return message;

  // List/history must stay a pure read under multi-client load. Persist repairs
  // only on explicit settle paths (or full single-message fetch).
  const persist = opts.persist === true;

  // Older clients persisted the optimistic shell before POST /runs. A renderer
  // reload in that gap leaves no run id and therefore no terminal event capable
  // of settling the row.
  const createdAt = Date.parse(message.createdAt);
  const staleUnlinked = row.run_id == null
    && Number.isFinite(createdAt)
    && Date.now() - createdAt >= AGENT_PLACEHOLDER_START_TIMEOUT_MS;
  if (staleUnlinked) {
    const next = {
      ...message,
      body: 'Agent run did not start. Please try again.',
      status: 'failed' as const,
    };
    return persist ? persistChatMessageRow(db, row.vault_id, row.channel_id, next) : next;
  }
  if (row.run_id == null) return message;

  const run = db.prepare('SELECT id, status, summary FROM runs WHERE id = ?').get(row.run_id) as RunStatusRow | undefined;
  if (!run) {
    if (!Number.isFinite(createdAt) || Date.now() - createdAt < AGENT_PLACEHOLDER_START_TIMEOUT_MS) return message;
    const next = {
      ...message,
      body: 'Agent run record is missing. Please try again.',
      status: 'failed' as const,
    };
    return persist ? persistChatMessageRow(db, row.vault_id, row.channel_id, next) : next;
  }
  const patch = terminalRunPatch(run, message);
  if (!patch) return message;

  const next = {
    ...message,
    body: patch.body,
    status: patch.status,
  };
  return persist ? persistChatMessageRow(db, row.vault_id, row.channel_id, next) : next;
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
  if (input.clarification) {
    // Keep cards tiny: max 3 questions. Agents must prefill answers so Accept is cheap.
    const questions = (Array.isArray(input.clarification.questions) ? input.clarification.questions : [])
      .slice(0, 3)
      .map((q, index) => {
        const kind = normalizeClarificationQuestionKind(q?.kind ?? (q as { type?: string })?.type);
        const options = Array.isArray(q?.options)
          ? q.options.map((opt: unknown) => String(opt || '').trim().slice(0, 200)).filter(Boolean).slice(0, 8)
          : [];
        const rawDefault = q?.answer ?? (q as { default?: string; defaultAnswer?: string })?.default
          ?? (q as { defaultAnswer?: string })?.defaultAnswer;
        let answer = rawDefault != null ? String(rawDefault).trim().slice(0, 4000) : '';
        // Auto-prefill discrete choices when the agent forgot: single → first option.
        if (!answer && kind === 'single' && options.length) answer = options[0];
        if (!answer && kind === 'multi' && options.length) answer = options[0];
        return {
          id: String(q?.id || `q${index + 1}`).slice(0, 40),
          prompt: String(q?.prompt || '').trim().slice(0, 2000),
          kind,
          ...(options.length && kind !== 'text' ? { options } : {}),
          ...(answer ? { answer } : {}),
        };
      })
      .filter((q) => q.prompt.length > 0);
    if (questions.length) {
      message.clarification = {
        title: String(input.clarification.title || 'Clarification').trim().slice(0, 240) || 'Clarification',
        questions,
        status: input.clarification.status === 'accepted' || input.clarification.status === 'canceled'
          ? input.clarification.status
          : 'pending',
        ...(input.clarification.tokenBudget != null
          ? { tokenBudget: Math.max(0, Math.floor(Number(input.clarification.tokenBudget) || 0)) }
          : {}),
        ...(input.clarification.assigneeRegistrationId
          ? { assigneeRegistrationId: String(input.clarification.assigneeRegistrationId).slice(0, 120) }
          : {}),
        ...(input.clarification.workItemId
          ? { workItemId: String(input.clarification.workItemId).slice(0, 80) }
          : {}),
        ...(input.clarification.missionId
          ? { missionId: String(input.clarification.missionId).slice(0, 80) }
          : {}),
      };
    }
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
      mission: message.mission || current.mission,
      missionTaskId: message.missionTaskId || current.missionTaskId,
      clarification: message.clarification || current.clarification,
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
      blocks_json, harness_log, images_json, attachments_json, reply_to_json,
      forwarded_from_json, change_request_json, clarification_json, mission_json, mission_task_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    row.forwarded_from_json,
    row.change_request_json,
    row.clarification_json,
    row.mission_json,
    row.mission_task_id,
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
  db: Db, userId: number, channelId: string, messageId: string,
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
  db: Db, userId: number, channelId: string, messageId: string,
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

export function answerChatClarification(
  db: Db,
  userId: number,
  channelId: string,
  messageId: string,
  answers: Array<{ id: string; answer: string }>,
): ChatMessage {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db.prepare('SELECT *, rowid FROM chat_messages WHERE id = ? AND channel_id = ?')
    .get(messageId, route.sourceChannelId) as ChatMessageRow | undefined;
  if (!row) throw new Error('Message not found');
  const message = rowToMessage(row);
  if (!message.clarification) throw new Error('Message is not a clarification');
  if (message.clarification.status !== 'pending') throw new Error('Clarification is already closed');
  const byId = new Map((answers || []).map((item) => [String(item.id), String(item.answer || '').trim().slice(0, 4000)]));
  const questions = message.clarification.questions.map((q) => ({
    ...q,
    ...(byId.has(q.id) ? { answer: byId.get(q.id) || '' } : {}),
  }));
  return {
    ...persistChatMessageRow(db, route.sourceVaultId, route.sourceChannelId, {
      ...message,
      clarification: { ...message.clarification, questions },
    }),
    channelId: route.localChannelId,
  };
}

/**
 * Accept a filled clarification → durable work-item contract (kanban) + contract text.
 * Mission open + coordinator wake happen in the HTTP handler (avoids circular imports).
 */
export function acceptChatClarification(
  db: Db,
  userId: number,
  channelId: string,
  messageId: string,
  opts?: { tokenBudget?: number; title?: string; missionId?: string },
): { message: ChatMessage; workItemId: string; contract: string; title: string; tokenBudget: number } {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db.prepare('SELECT *, rowid FROM chat_messages WHERE id = ? AND channel_id = ?')
    .get(messageId, route.sourceChannelId) as ChatMessageRow | undefined;
  if (!row) throw new Error('Message not found');
  const message = rowToMessage(row);
  const clarification = message.clarification;
  if (!clarification) throw new Error('Message is not a clarification');
  if (clarification.status === 'accepted' && clarification.workItemId) {
    return {
      message: { ...message, channelId: route.localChannelId },
      workItemId: clarification.workItemId,
      contract: clarification.questions.map((q, i) => (
        `Q${i + 1}: ${q.prompt}\nA${i + 1}: ${String(q.answer || '').trim()}`
      )).join('\n\n'),
      title: clarification.title,
      tokenBudget: clarification.tokenBudget || 0,
    };
  }
  if (clarification.status === 'canceled') throw new Error('Clarification was canceled');
  const unanswered = clarification.questions.filter((q) => {
    const kind = q.kind || 'text';
    // multi may be intentionally empty only if marked optional — require at least one pick when options exist
    if (kind === 'multi' && (q.options?.length || 0) > 0) {
      return !String(q.answer || '').trim();
    }
    return !String(q.answer || '').trim();
  });
  if (unanswered.length) {
    throw new Error(`Answer all questions first (${unanswered.length} remaining)`);
  }
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string };
  const contractLines = clarification.questions.map((q, i) => (
    `Q${i + 1}: ${q.prompt}\nA${i + 1}: ${String(q.answer || '').trim()}`
  ));
  const contract = contractLines.join('\n\n');
  const tokenBudget = Math.max(
    0,
    Math.floor(Number(opts?.tokenBudget ?? clarification.tokenBudget) || 0),
  );
  const title = String(opts?.title || clarification.title || 'Contract').trim().slice(0, 240) || 'Contract';
  const item = createWorkItem(db, userId, route.sourceVaultId, {
    title,
    brief: message.body || clarification.title,
    contract,
    channelId: route.sourceChannelId,
    sourceKind: 'contract',
    sourceId: messageId,
    workspaceMode: 'isolated',
    branch: `cascade/contract/${messageId.slice(0, 8)}`,
    assigneeRegistrationId: clarification.assigneeRegistrationId || null,
    tokenBudget,
    verification: 'Drive until completed, token budget hit, or manually stopped.',
  });
  const missionId = opts?.missionId || clarification.missionId;
  const updated: ChatMessage = {
    ...message,
    clarification: {
      ...clarification,
      status: 'accepted',
      workItemId: item.id,
      ...(missionId ? { missionId } : {}),
      tokenBudget,
      acceptedAt: new Date().toISOString(),
      acceptedBy: user.username,
    },
  };
  return {
    message: {
      ...persistChatMessageRow(db, route.sourceVaultId, route.sourceChannelId, updated),
      channelId: route.localChannelId,
    },
    workItemId: item.id,
    contract,
    title,
    tokenBudget,
  };
}

/** Attach mission id onto an already-accepted clarification card. */
export function attachClarificationMission(
  db: Db,
  userId: number,
  channelId: string,
  messageId: string,
  missionId: string,
): ChatMessage {
  const { route } = assertChatChannel(db, channelId, userId);
  const row = db.prepare('SELECT *, rowid FROM chat_messages WHERE id = ? AND channel_id = ?')
    .get(messageId, route.sourceChannelId) as ChatMessageRow | undefined;
  if (!row) throw new Error('Message not found');
  const message = rowToMessage(row);
  if (!message.clarification) throw new Error('Message is not a clarification');
  return {
    ...persistChatMessageRow(db, route.sourceVaultId, route.sourceChannelId, {
      ...message,
      clarification: { ...message.clarification, missionId: String(missionId).slice(0, 80) },
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

/** Incremental fold state for one run's append-only event stream. */
export type AgentChatContentAccumulator = {
  assistantText: string;
  blocks: ChatBlock[];
  harnessLog: string;
  status: ChatMessage['status'];
  terminalSummary: string;
  suppressChatBody: boolean;
  hasVisibleText: boolean;
};

export function createAgentChatContentAccumulator(): AgentChatContentAccumulator {
  return {
    assistantText: '',
    blocks: [],
    harnessLog: '',
    status: 'running',
    terminalSummary: '',
    suppressChatBody: false,
    hasVisibleText: false,
  };
}

/** Fold only newly appended events into an existing projection. */
export function appendAgentChatRunEvents(
  current: AgentChatContentAccumulator,
  events: Array<{ type: string; payload_json: string }>,
): AgentChatContentAccumulator {
  let blocks = current.blocks;
  let status = current.status;
  let terminalSummary = current.terminalSummary;
  let suppressChatBody = current.suppressChatBody;
  let hasVisibleText = current.hasVisibleText;
  const assistantChunks: string[] = [];
  const harnessChunks: string[] = [];

  for (const event of events) {
    let payload: any;
    try {
      payload = JSON.parse(event.payload_json);
    } catch {
      continue;
    }
    if (event.type === 'text') {
      const text = textFromRunContent(payload?.message?.content);
      if (text) assistantChunks.push(text);
      if (payload?.chatVisible === true && text.trim()) hasVisibleText = true;
      blocks = appendChatRunBlocks(blocks, normalizeChatRunBlocks(payload?.message?.content));
    } else if (event.type === 'user') {
      blocks = appendChatRunBlocks(blocks, normalizeChatRunBlocks(payload?.message?.content));
    } else if (event.type === 'harness') {
      const chunk = typeof payload?.data === 'string' ? payload.data : '';
      if (chunk) harnessChunks.push(chunk);
    } else if (event.type === 'status') {
      const nextStatus = payload?.status;
      if (payload?.suppressChatBody === true) suppressChatBody = true;
      if (nextStatus === 'completed') {
        status = undefined;
        terminalSummary = String(payload?.summary || 'Done.');
      } else if (nextStatus === 'failed') {
        status = 'failed';
        terminalSummary = String(payload?.summary || 'Agent failed.');
      } else if (nextStatus === 'canceled') {
        status = 'canceled';
        terminalSummary = String(payload?.summary || 'Run canceled by user.');
      }
    }
  }

  return {
    assistantText: current.assistantText + assistantChunks.join(''),
    blocks,
    harnessLog: harnessChunks.length
      ? appendHarnessLog(current.harnessLog, harnessChunks.join(''))
      : current.harnessLog,
    status,
    terminalSummary,
    suppressChatBody,
    hasVisibleText,
  };
}

export function agentChatContentFromAccumulator(
  state: AgentChatContentAccumulator,
): AgentChatContent {
  const {
    assistantText,
    blocks,
    harnessLog,
    status,
    terminalSummary,
    suppressChatBody,
    hasVisibleText,
  } = state;

  const trimmed = assistantText.trim();
  const done = status !== 'running';
  // Successful chat body = the runner's latest final answer when available.
  // Accumulated streamed text is a fallback because it may include progress.
  // Full step narration lives in `blocks` / `harnessLog` for the terminal pane.
  // Failures keep the scratchpad and append the reason. While still running,
  // only adapters that explicitly mark assistant-visible text enter the body.
  let body: string;
  if (!done) {
    body = hasVisibleText && trimmed ? trimmed : 'Thinking...';
  } else if (status === 'failed' || status === 'canceled') {
    const reason = terminalSummary.trim()
      || (status === 'canceled' ? 'Run canceled by user.' : 'Agent failed.');
    body = trimmed ? `${trimmed}\n\n> ⚠️ ${reason}` : reason;
  } else if (suppressChatBody) {
    body = '';
  } else if (terminalSummary.trim() && !isGenericRunSummary(terminalSummary)) {
    body = terminalSummary.trim();
  } else if (trimmed) {
    body = trimmed;
  } else {
    body = terminalSummary.trim() || 'Done.';
  }

  return { body, blocks, harnessLog, status, done };
}

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
  return agentChatContentFromAccumulator(appendAgentChatRunEvents(
    createAgentChatContentAccumulator(),
    events,
  ));
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
    missionTaskId?: string;
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
    missionTaskId: input.missionTaskId,
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
    missionTaskId: input.missionTaskId,
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

function getChannelKanbanNoteId(db: Db, sourceChannelId: string): string {
  const row = db.prepare('SELECT kanban_note_id FROM chat_channel_settings WHERE channel_id = ?')
    .get(sourceChannelId) as { kanban_note_id: string | null } | undefined;
  return String(row?.kanban_note_id || '').trim();
}

function channelKanbanMarkdown(channelId: string, channelTitle: string): string {
  const title = channelTitle.trim() || 'channel';
  return [
    '---',
    'kanban-plugin: board',
    'superkanban: true',
    `cascade-channel: ${channelId}`,
    '---',
    '',
    `# ${title} board`,
    '',
    'Local orchestration board for this channel. Superkanban collates every board in the vault, including this one.',
    '',
    '## Backlog',
    '',
    '## Ready',
    '',
    '## In progress',
    '',
    '## Blocked',
    '',
    '## Review',
    '',
    '## Done',
    '',
    '%% kanban:settings',
    '```',
    '{"kanban-plugin":"board"}',
    '```',
    '%%',
    '',
  ].join('\n');
}

function writeChannelKanbanPointer(db: Db, sourceChannelId: string, kanbanNoteId: string | null): void {
  db.prepare(`
    INSERT INTO chat_channel_settings (channel_id, cwd, kanban_note_id, updated_at)
    VALUES (?, '', ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET
      kanban_note_id = excluded.kanban_note_id,
      updated_at = excluded.updated_at
  `).run(sourceChannelId, kanbanNoteId);
}

/**
 * Point this channel at an existing vault Kanban note (LHS board), or clear.
 * Superkanban collates every board; the channel only stores a pointer.
 */
export function setChannelKanbanNoteId(
  db: Db,
  userId: number,
  channelId: string,
  kanbanNoteId: string | null,
): { cwd: string; kanbanNoteId: string } {
  const { route } = assertChatChannel(db, channelId, userId);
  const next = String(kanbanNoteId || '').trim();
  if (next) {
    const note = getNote(db, next);
    if (!note || note.vault_id !== route.sourceVaultId || note.is_archived) {
      throw new Error('Kanban board note not found in this vault');
    }
    if (!/kanban-plugin\s*:/i.test(note.content || note.content_preview || '')) {
      throw new Error('That note is not a Kanban board');
    }
    writeChannelKanbanPointer(db, route.sourceChannelId, next);
  } else {
    writeChannelKanbanPointer(db, route.sourceChannelId, null);
  }
  return getChannelSettings(db, channelId, userId);
}

/**
 * Optional: mint an unlisted internal board for this channel and point at it.
 * Prefer pointing at an existing LHS project board when one already exists.
 */
export function ensureChannelOrchestrationKanban(
  db: Db,
  userId: number,
  channelId: string,
  opts?: { createInternal?: boolean },
): { kanbanNoteId: string } | null {
  const { route } = assertChatChannel(db, channelId, userId);
  const existingId = getChannelKanbanNoteId(db, route.sourceChannelId);
  if (existingId) {
    const existing = getNote(db, existingId);
    if (existing && !existing.is_archived) return { kanbanNoteId: existingId };
  }

  // Recover a prior internal board tagged for this channel.
  const recovered = db.prepare(`
    SELECT id FROM notes
    WHERE vault_id = ?
      AND is_archived = 0
      AND (
        content LIKE ?
        OR content_preview LIKE ?
      )
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(
    route.sourceVaultId,
    `%cascade-channel: ${route.sourceChannelId}%`,
    `%cascade-channel: ${route.sourceChannelId}%`,
  ) as { id: string } | undefined;
  if (recovered?.id) {
    writeChannelKanbanPointer(db, route.sourceChannelId, recovered.id);
    return { kanbanNoteId: recovered.id };
  }

  if (!opts?.createInternal) return null;

  const channelNote = getNote(db, route.sourceChannelId);
  const channelTitle = channelNote?.title || 'channel';
  const board = createNote(db, route.sourceVaultId, userId, {
    title: `${channelTitle} board`,
    content: channelKanbanMarkdown(route.sourceChannelId, channelTitle),
    // Unlisted: LHS project boards stay the primary; this is an optional internal pad.
    is_listed: false,
  });
  writeChannelKanbanPointer(db, route.sourceChannelId, board.id);
  return { kanbanNoteId: board.id };
}

/** Read a channel's settings (resolves links to the source channel). */
export function getChannelSettings(db: Db, channelId: string, userId: number): {
  cwd: string;
  kanbanNoteId: string;
} {
  const { route } = assertChatChannel(db, channelId, userId);
  const kanbanNoteId = getChannelKanbanNoteId(db, route.sourceChannelId);
  // Drop stale pointers if the note vanished.
  if (kanbanNoteId) {
    const note = getNote(db, kanbanNoteId);
    if (!note || note.is_archived) {
      writeChannelKanbanPointer(db, route.sourceChannelId, null);
      return { cwd: getChannelCwd(db, route.sourceChannelId), kanbanNoteId: '' };
    }
  }
  return { cwd: getChannelCwd(db, route.sourceChannelId), kanbanNoteId };
}

/** Set the channel-wide cwd. Applies to the source channel; returns the value. */
export function setChannelCwd(db: Db, channelId: string, userId: number, cwd: string): {
  cwd: string;
  kanbanNoteId: string;
} {
  const { route } = assertChatChannel(db, channelId, userId);
  const value = String(cwd ?? '').trim();
  db.prepare(`
    INSERT INTO chat_channel_settings (channel_id, cwd, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(channel_id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at
  `).run(route.sourceChannelId, value);
  return getChannelSettings(db, channelId, userId);
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
  assertAgentManagementOwner(db, userId, route.sourceVaultId);

  // Prefer linking an existing vault agent when vaultAgentId is provided.
  if (input.vaultAgentId && String(input.vaultAgentId).trim()) {
    return addVaultAgentToChannel(db, userId, vaultId, channelId, String(input.vaultAgentId).trim(), {
      taggableByAgents: input.taggableByAgents,
      replyToEveryMessage: input.replyToEveryMessage,
      orchestrator: input.orchestrator,
      pingableByOthers: input.pingableByOthers,
      yolo: input.yolo,
      reasoningEffort: input.reasoningEffort,
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
  db.prepare(`
    UPDATE vault_agents SET owner_user_id = COALESCE(
      owner_user_id,
      (SELECT created_by FROM vaults WHERE id = ?)
    ) WHERE id = ?
  `).run(route.sourceVaultId, vaultAgent.id);
  member.vaultAgentId = vaultAgent.id;
  // Identity is canonical on vault_agents
  member.agentId = vaultAgent.agentId;
  member.displayName = vaultAgent.displayName;
  member.avatarUrl = vaultAgent.avatarUrl;
  member.mention = vaultAgent.mention;
  member.model = vaultAgent.model;
  member.cwd = vaultAgent.cwd;
  member.contextPrompt = vaultAgent.contextPrompt;
  assertCoordinatorSlot(db, route.sourceChannelId, member.id, member.orchestrator);

  if (existing) {
    db.prepare(`
      UPDATE chat_agent_members SET
        vault_agent_id = ?,
        agent_id = ?,
        display_name = ?,
        avatar_url = ?,
        mention = ?,
        model = ?,
        reasoning_effort = ?,
        cwd = ?,
        context_prompt = ?,
        taggable_by_agents = ?,
        reply_to_every_message = ?,
        orchestrator = ?,
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
      member.reasoningEffort,
      member.cwd,
      member.contextPrompt,
      member.taggableByAgents ? 1 : 0,
      member.replyToEveryMessage ? 1 : 0,
      member.orchestrator ? 1 : 0,
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
        model, reasoning_effort, cwd, context_prompt, taggable_by_agents, reply_to_every_message, orchestrator, pingable_by_others, yolo, conversation_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      member.reasoningEffort,
      member.cwd,
      member.contextPrompt,
      member.taggableByAgents ? 1 : 0,
      member.replyToEveryMessage ? 1 : 0,
      member.orchestrator ? 1 : 0,
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
  assertAgentManagementOwner(db, userId, route.sourceVaultId);

  const result = db.prepare('DELETE FROM chat_agent_members WHERE id = ? AND channel_id = ?').run(registrationId, route.sourceChannelId);
  return result.changes > 0;
}
