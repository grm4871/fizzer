/**
 * @file evolution.ts — Cascade Evolution Features 1–4 (v1)
 *
 * 1. Note ⇄ Chat backlinks (message references → note)
 * 2. Chat → note distillation (create / append / merge-with-confirm)
 * 3. Agent memory helpers (_agent/memory + INDEX injection)
 * 4. Unified search across notes + chat (FTS hybrid, scope filter)
 *
 * Vector embeddings (true semantic) deferred until an embedding provider is
 * configured; BM25 FTS across both corpora is the v1 retrieval layer.
 */

import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createFolder,
  createNote,
  getNote,
  getVault,
  listFolders,
  searchNotes,
  updateNote,
  type Note,
  type Vault,
} from './vault.js';
import { createNoteVersion } from './versions.js';
import { redactPrivateBlocks } from './privacy.js';
import {
  assertChatChannel,
  listChatMessages,
  type ChatMessage,
} from './chat.js';

type Db = Database.Database;

// ── Schema ─────────────────────────────────────────────────────────

export function ensureEvolutionSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_note_backlinks (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      note_id TEXT,
      target_title TEXT NOT NULL,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      author TEXT NOT NULL,
      snippet TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted INTEGER NOT NULL DEFAULT 0,
      UNIQUE(message_id, target_title)
    );
    CREATE INDEX IF NOT EXISTS chat_note_backlinks_note_idx
      ON chat_note_backlinks(note_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS chat_note_backlinks_msg_idx
      ON chat_note_backlinks(message_id);
    CREATE INDEX IF NOT EXISTS chat_note_backlinks_unresolved_idx
      ON chat_note_backlinks(vault_id, note_id, target_title);

    CREATE TABLE IF NOT EXISTS vault_settings (
      vault_id TEXT PRIMARY KEY,
      agent_memory_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS distill_jobs (
      id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      note_id TEXT,
      message_ids_json TEXT NOT NULL DEFAULT '[]',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      fingerprint TEXT
    );
    CREATE INDEX IF NOT EXISTS distill_jobs_fp_idx ON distill_jobs(vault_id, fingerprint);
  `);
}

// ── Feature 1: Chat → note backlinks ───────────────────────────────

const WIKILINK_RE = /!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

export function extractWikiTitles(body: string): string[] {
  const titles: string[] = [];
  const seen = new Set<string>();
  const text = String(body || '');
  let m: RegExpExecArray | null;
  const re = new RegExp(WIKILINK_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const title = m[1].trim();
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

function resolveNoteByTitle(db: Db, vaultId: string, title: string): { id: string; title: string } | undefined {
  return db.prepare(`
    SELECT id, title FROM notes
    WHERE vault_id = ? AND title = ? COLLATE NOCASE
    LIMIT 1
  `).get(vaultId, title) as { id: string; title: string } | undefined;
}

function truncateSnippet(value: string, limit = 500): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export type ChatNoteBacklink = {
  id: string;
  vaultId: string;
  noteId: string | null;
  targetTitle: string;
  messageId: string;
  channelId: string;
  author: string;
  snippet: string;
  createdAt: string;
  deleted: boolean;
};

export function indexChatMessageBacklinks(
  db: Db,
  vaultId: string,
  channelId: string,
  message: { id: string; author: string; body: string; createdAt?: string },
): number {
  const titles = extractWikiTitles(message.body);
  if (titles.length === 0) return 0;

  const snippet = truncateSnippet(message.body);
  const createdAt = message.createdAt || new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO chat_note_backlinks (
      id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(message_id, target_title) DO UPDATE SET
      note_id = excluded.note_id,
      author = excluded.author,
      snippet = excluded.snippet,
      deleted = 0
  `);

  let n = 0;
  for (const title of titles) {
    const resolved = resolveNoteByTitle(db, vaultId, title);
    upsert.run(
      crypto.randomUUID(),
      vaultId,
      resolved?.id ?? null,
      title,
      message.id,
      channelId,
      message.author,
      snippet,
      createdAt,
    );
    n += 1;
  }
  return n;
}

export function tombstoneChatMessageBacklinks(db: Db, messageId: string): void {
  db.prepare('UPDATE chat_note_backlinks SET deleted = 1 WHERE message_id = ?').run(messageId);
}

/** Lazily resolve unresolved titles when a note appears / is renamed. */
export function reresolveChatBacklinksForNote(db: Db, vaultId: string, noteId: string, title: string): number {
  const result = db.prepare(`
    UPDATE chat_note_backlinks
    SET note_id = ?
    WHERE vault_id = ? AND note_id IS NULL AND target_title = ? COLLATE NOCASE AND deleted = 0
  `).run(noteId, vaultId, title);
  return result.changes;
}

export function listChatNoteBacklinks(
  db: Db,
  noteId: string,
  opts: { limit?: number; offset?: number; includeDeleted?: boolean } = {},
): ChatNoteBacklink[] {
  const limit = Math.max(1, Math.min(Number(opts.limit || 50), 200));
  const offset = Math.max(0, Number(opts.offset || 0));
  const note = db.prepare('SELECT id, title, vault_id FROM notes WHERE id = ?').get(noteId) as
    | { id: string; title: string; vault_id: string }
    | undefined;
  if (!note) return [];

  // Resolve any lingering title matches for this note first.
  reresolveChatBacklinksForNote(db, note.vault_id, note.id, note.title);

  const deletedClause = opts.includeDeleted ? '' : 'AND deleted = 0';
  const rows = db.prepare(`
    SELECT *
    FROM chat_note_backlinks
    WHERE (note_id = ? OR (note_id IS NULL AND target_title = ? COLLATE NOCASE AND vault_id = ?))
      ${deletedClause}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(noteId, note.title, note.vault_id, limit, offset) as Array<{
    id: string;
    vault_id: string;
    note_id: string | null;
    target_title: string;
    message_id: string;
    channel_id: string;
    author: string;
    snippet: string;
    created_at: string;
    deleted: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    vaultId: row.vault_id,
    noteId: row.note_id,
    targetTitle: row.target_title,
    messageId: row.message_id,
    channelId: row.channel_id,
    author: row.author,
    snippet: row.snippet,
    createdAt: row.created_at,
    deleted: row.deleted !== 0,
  }));
}

/**
 * Idempotent, resumable backfill of chat → note backlinks for a vault.
 * Processes messages ordered by rowid; pass afterRowid to resume.
 */
export function backfillChatNoteBacklinks(
  db: Db,
  vaultId: string,
  opts: { afterRowid?: number; limit?: number } = {},
): { processed: number; indexed: number; nextAfterRowid: number | null } {
  const limit = Math.max(1, Math.min(Number(opts.limit || 500), 5000));
  const after = Number(opts.afterRowid || 0);
  const rows = db.prepare(`
    SELECT rowid, id, channel_id, author, body, created_at
    FROM chat_messages
    WHERE vault_id = ? AND rowid > ?
    ORDER BY rowid ASC
    LIMIT ?
  `).all(vaultId, after, limit) as Array<{
    rowid: number;
    id: string;
    channel_id: string;
    author: string;
    body: string;
    created_at: string;
  }>;

  let indexed = 0;
  let last = after;
  for (const row of rows) {
    indexed += indexChatMessageBacklinks(db, vaultId, row.channel_id, {
      id: row.id,
      author: row.author,
      body: row.body,
      createdAt: row.created_at,
    });
    last = row.rowid;
  }
  return {
    processed: rows.length,
    indexed,
    nextAfterRowid: rows.length === limit ? last : null,
  };
}

// ── Feature 2: Distillation ────────────────────────────────────────

export type DistillMode = 'create' | 'append' | 'merge';

export type DistillInput = {
  mode: DistillMode;
  fromMessageId?: string;
  toMessageId?: string;
  lastN?: number;
  noteRef?: string;
  title?: string;
  confirm?: boolean;
  by?: string;
};

function fingerprintMessages(ids: string[]): string {
  return crypto.createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 24);
}

function selectMessagesForDistill(
  messages: ChatMessage[],
  input: DistillInput,
): ChatMessage[] {
  if (input.lastN && input.lastN > 0) {
    return messages.slice(-Math.min(input.lastN, 500));
  }
  if (input.fromMessageId) {
    const start = messages.findIndex((m) => m.id === input.fromMessageId);
    if (start < 0) throw new Error(`from message not found: ${input.fromMessageId}`);
    if (input.toMessageId) {
      const end = messages.findIndex((m) => m.id === input.toMessageId);
      if (end < 0) throw new Error(`to message not found: ${input.toMessageId}`);
      if (end < start) return messages.slice(end, start + 1);
      return messages.slice(start, end + 1);
    }
    // Thread-ish: from root through rest of channel (capped)
    return messages.slice(start, start + 200);
  }
  return messages.slice(-30);
}

function formatTranscript(messages: ChatMessage[]): string {
  return messages.map((m) => {
    const ts = m.createdAt || '';
    return `### ${m.author} (${m.id})${ts ? ` — ${ts}` : ''}\n\n${m.body || '(empty)'}`;
  }).join('\n\n');
}

function extractiveSummary(messages: ChatMessage[]): string {
  const lines: string[] = ['## Summary', ''];
  const authors = [...new Set(messages.map((m) => m.author))];
  lines.push(`- **Participants:** ${authors.join(', ') || '—'}`);
  lines.push(`- **Messages:** ${messages.length}`);
  lines.push(`- **Span:** ${messages[0]?.createdAt || '?'} → ${messages[messages.length - 1]?.createdAt || '?'}`);
  lines.push('');
  lines.push('## Highlights');
  lines.push('');
  // Prefer longer substantive lines, skip pure noise
  const candidates = messages
    .map((m) => ({ author: m.author, body: (m.body || '').trim() }))
    .filter((m) => m.body.length > 40 && !/^thinking\.\.\.?$/i.test(m.body))
    .slice(-12);
  for (const c of candidates) {
    const one = c.body.replace(/\s+/g, ' ').slice(0, 220);
    lines.push(`- **${c.author}:** ${one}${c.body.length > 220 ? '…' : ''}`);
  }
  if (candidates.length === 0) {
    lines.push('_No long messages to highlight — see transcript._');
  }
  lines.push('');
  lines.push('## Decisions / action items');
  lines.push('');
  const decisionish = messages.filter((m) =>
    /\b(decid|action|todo|ship|fix|deploy|agree|will|should)\b/i.test(m.body || ''),
  ).slice(-10);
  if (decisionish.length === 0) {
    lines.push('_None auto-detected — review transcript._');
  } else {
    for (const m of decisionish) {
      lines.push(`- (${m.author}) ${m.body.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
  }
  return lines.join('\n');
}

function resolveNoteRef(db: Db, vaultId: string, ref: string): Note | undefined {
  const byId = getNote(db, ref);
  if (byId && byId.vault_id === vaultId) return byId;
  const byTitle = resolveNoteByTitle(db, vaultId, ref);
  return byTitle ? getNote(db, byTitle.id) : undefined;
}

export type DistillResult = {
  status: 'completed' | 'needs_confirm' | 'exists';
  mode: DistillMode;
  note?: Note;
  draft?: string;
  messageIds: string[];
  jobId?: string;
  priorNoteId?: string;
};

export function distillChatToNote(
  db: Db,
  userId: number,
  vaultId: string,
  channelId: string,
  input: DistillInput,
): DistillResult {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const { route } = assertChatChannel(db, channelId, userId);
  if (route.localVaultId !== vaultId) throw new Error('Chat channel not found');

  const all = listChatMessages(db, channelId, userId, { detail: 'full', limit: 500 });
  const selected = selectMessagesForDistill(all, input);
  if (selected.length === 0) throw new Error('No messages to distill');

  const messageIds = selected.map((m) => m.id);
  const fp = fingerprintMessages(messageIds);
  const mode = input.mode || 'create';

  if (mode === 'create') {
    const prior = db.prepare(`
      SELECT note_id FROM distill_jobs
      WHERE vault_id = ? AND fingerprint = ? AND mode = 'create' AND note_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(vaultId, fp) as { note_id: string } | undefined;
    if (prior?.note_id) {
      const existing = getNote(db, prior.note_id);
      if (existing) {
        return {
          status: 'exists',
          mode,
          note: existing,
          messageIds,
          priorNoteId: existing.id,
        };
      }
    }
  }

  const summary = extractiveSummary(selected);
  const transcript = formatTranscript(selected);
  const by = input.by || 'distill';
  const at = new Date().toISOString();
  const sources = messageIds.map((id) => `- \`${id}\``).join('\n');
  const provenance = [
    '',
    '---',
    '',
    '## Sources',
    '',
    `distilled_from:`,
    `- channel_id: \`${route.sourceChannelId}\``,
    `- at: ${at}`,
    `- by: ${by}`,
    `- mode: ${mode}`,
    `- message_ids:`,
    ...messageIds.map((id) => `  - \`${id}\``),
    '',
    sources,
    '',
  ].join('\n');

  const bodyCore = `${summary}\n\n## Transcript\n\n${transcript}${provenance}`;

  if (mode === 'merge') {
    if (!input.noteRef) throw new Error('merge mode requires --note');
    const target = resolveNoteRef(db, vaultId, input.noteRef);
    if (!target) throw new Error(`Note not found: ${input.noteRef}`);
    const draft = [
      target.content.trimEnd(),
      '',
      '---',
      '',
      `## Distilled update (${at})`,
      '',
      summary,
      '',
      '### Incoming transcript',
      '',
      transcript,
      provenance,
    ].join('\n');
    if (!input.confirm) {
      return { status: 'needs_confirm', mode, draft, messageIds, priorNoteId: target.id };
    }
    const note = updateNote(db, target.id, draft);
    createNoteVersion(db, note.id, draft, 'distill-merge');
    // Index citations as chat backlinks onto the note for each source message
    for (const m of selected) {
      indexChatMessageBacklinks(db, vaultId, route.sourceChannelId, {
        id: m.id,
        author: m.author,
        body: `${m.body}\n![[${note.title}]]`,
        createdAt: m.createdAt,
      });
    }
    const jobId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO distill_jobs (id, vault_id, channel_id, mode, status, note_id, message_ids_json, created_by, fingerprint)
      VALUES (?, ?, ?, 'merge', 'completed', ?, ?, ?, ?)
    `).run(jobId, vaultId, route.sourceChannelId, note.id, JSON.stringify(messageIds), userId, fp);
    return { status: 'completed', mode, note, messageIds, jobId };
  }

  if (mode === 'append') {
    if (!input.noteRef) throw new Error('append mode requires --note');
    const target = resolveNoteRef(db, vaultId, input.noteRef);
    if (!target) throw new Error(`Note not found: ${input.noteRef}`);
    const section = [
      target.content.trimEnd(),
      '',
      '---',
      '',
      `## Distilled from chat (${at})`,
      '',
      bodyCore,
    ].join('\n');
    const note = updateNote(db, target.id, section);
    createNoteVersion(db, note.id, section, 'distill-append');
    for (const m of selected) {
      indexChatMessageBacklinks(db, vaultId, route.sourceChannelId, {
        id: m.id,
        author: m.author,
        body: `${m.body}\n![[${note.title}]]`,
        createdAt: m.createdAt,
      });
    }
    const jobId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO distill_jobs (id, vault_id, channel_id, mode, status, note_id, message_ids_json, created_by, fingerprint)
      VALUES (?, ?, ?, 'append', 'completed', ?, ?, ?, ?)
    `).run(jobId, vaultId, route.sourceChannelId, note.id, JSON.stringify(messageIds), userId, fp);
    return { status: 'completed', mode, note, messageIds, jobId };
  }

  // create
  const titleBase = (input.title || `Chat distill ${at.slice(0, 10)}`).trim();
  const note = createNote(db, vaultId, userId, {
    title: titleBase,
    content: `# ${titleBase}\n\n${bodyCore}\n`,
    // Distill is agent-initiated — keep out of the human sidebar tree by default.
    is_listed: false,
  });
  createNoteVersion(db, note.id, note.content, 'distill-create');
  for (const m of selected) {
    indexChatMessageBacklinks(db, vaultId, route.sourceChannelId, {
      id: m.id,
      author: m.author,
      body: `${m.body}\n![[${note.title}]]`,
      createdAt: m.createdAt,
    });
  }
  const jobId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO distill_jobs (id, vault_id, channel_id, mode, status, note_id, message_ids_json, created_by, fingerprint)
    VALUES (?, ?, ?, 'create', 'completed', ?, ?, ?, ?)
  `).run(jobId, vaultId, route.sourceChannelId, note.id, JSON.stringify(messageIds), userId, fp);
  return { status: 'completed', mode: 'create', note, messageIds, jobId };
}

// ── Feature 3: Agent memory ────────────────────────────────────────

const AGENT_ROOT = '_agent';
const AGENT_MEMORY = 'memory';

function getOrCreateNamedFolder(db: Db, vaultId: string, name: string, parentId: string | null): { id: string; name: string } {
  const existing = parentId
    ? db.prepare(`
        SELECT id, name FROM folders
        WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
      `).get(vaultId, parentId, name)
    : db.prepare(`
        SELECT id, name FROM folders
        WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
      `).get(vaultId, name);
  if (existing) return existing as { id: string; name: string };
  const folder = createFolder(db, vaultId, {
    name,
    ...(parentId ? { parent_id: parentId } : {}),
  });
  return { id: folder.id, name: folder.name };
}

function sanitizeAgentFolderName(name: string): string {
  return String(name || 'agent')
    .replace(/^@+/, '')
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 64) || 'agent';
}

function ensureIndexNote(db: Db, vaultId: string, userId: number, folderId: string, heading: string): void {
  const index = db.prepare(`
    SELECT id FROM notes WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE
  `).get(vaultId, folderId) as { id: string } | undefined;
  if (index) {
    db.prepare('UPDATE notes SET is_listed = 1 WHERE id = ?').run(index.id);
    return;
  }
  createNote(db, vaultId, userId, {
    title: 'INDEX',
    folder_id: folderId,
    is_listed: true,
    content: [
      `# ${heading}`,
      '',
      'One-line pointers to memory notes in this folder. Higher lines = higher priority when trimming injection.',
      '',
      '## Pointers',
      '',
      '- (add bullets as agents learn facts)',
      '',
    ].join('\n'),
  });
}

/** Shared vault-level agent memory: `_agent/memory/`. */
export function ensureAgentMemoryFolders(
  db: Db,
  vaultId: string,
  userId: number,
): { rootId: string; memoryId: string } {
  const root = getOrCreateNamedFolder(db, vaultId, AGENT_ROOT, null);
  const memory = getOrCreateNamedFolder(db, vaultId, AGENT_MEMORY, root.id);
  ensureIndexNote(db, vaultId, userId, memory.id, 'Agent memory index (shared)');
  return { rootId: root.id, memoryId: memory.id };
}

/**
 * Per-agent memory: `_agent/<mention>/memory/`.
 * Falls back to shared memory folder when agentKey is empty.
 */
export function ensureAgentNamedMemoryFolders(
  db: Db,
  vaultId: string,
  userId: number,
  agentKey: string,
): { rootId: string; agentRootId: string; memoryId: string } {
  const root = getOrCreateNamedFolder(db, vaultId, AGENT_ROOT, null);
  const key = sanitizeAgentFolderName(agentKey);
  if (!key || key === 'memory') {
    const shared = ensureAgentMemoryFolders(db, vaultId, userId);
    return { rootId: shared.rootId, agentRootId: shared.rootId, memoryId: shared.memoryId };
  }
  const agentRoot = getOrCreateNamedFolder(db, vaultId, key, root.id);
  const memory = getOrCreateNamedFolder(db, vaultId, AGENT_MEMORY, agentRoot.id);
  ensureIndexNote(db, vaultId, userId, memory.id, `Agent memory — @${key}`);
  return { rootId: root.id, agentRootId: agentRoot.id, memoryId: memory.id };
}

export function isAgentMemoryEnabled(db: Db, vaultId: string): boolean {
  const row = db.prepare('SELECT agent_memory_enabled FROM vault_settings WHERE vault_id = ?').get(vaultId) as
    | { agent_memory_enabled: number }
    | undefined;
  return row ? row.agent_memory_enabled !== 0 : true;
}

export function setAgentMemoryEnabled(db: Db, vaultId: string, enabled: boolean): void {
  db.prepare(`
    INSERT INTO vault_settings (vault_id, agent_memory_enabled, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(vault_id) DO UPDATE SET
      agent_memory_enabled = excluded.agent_memory_enabled,
      updated_at = datetime('now')
  `).run(vaultId, enabled ? 1 : 0);
}

export type AgentMemoryInjection = {
  enabled: boolean;
  text: string;
  noteIds: string[];
  truncated: boolean;
};

/**
 * Build injection text for session start (INDEX + topic-matched memory notes).
 *
 * Selection tiers: `rankedNoteIds` (semantic+lexical hybrid ranking from QMD,
 * computed by the caller — fixes paraphrase misses that literal keyword
 * matching can't) → keyword substring match → recency. `noteStats` adds
 * win/loss labels so the agent can weigh how a remembered strategy has fared.
 */
export function buildAgentMemoryInjection(
  db: Db,
  vaultId: string,
  opts: {
    channelTopic?: string;
    maxChars?: number;
    agentKey?: string;
    rankedNoteIds?: string[];
    noteStats?: Map<string, { uses: number; wins: number; losses: number }>;
  } = {},
): AgentMemoryInjection {
  if (!isAgentMemoryEnabled(db, vaultId)) {
    return { enabled: false, text: '', noteIds: [], truncated: false };
  }
  const maxChars = Math.max(500, Math.min(Number(opts.maxChars || 4000), 12000));
  const folders = listFolders(db, vaultId);
  const agentRoot = folders.find((f) => !f.parent_id && f.name.toLowerCase() === AGENT_ROOT);
  // Shared `_agent/memory`
  const sharedMemory = agentRoot
    ? folders.find((f) => f.parent_id === agentRoot.id && f.name.toLowerCase() === AGENT_MEMORY)
    : undefined;
  // Per-agent `_agent/<mention>/memory`
  const agentKey = sanitizeAgentFolderName(opts.agentKey || '');
  const namedRoot = agentRoot && agentKey
    ? folders.find((f) => f.parent_id === agentRoot.id && f.name.toLowerCase() === agentKey.toLowerCase())
    : undefined;
  const namedMemory = namedRoot
    ? folders.find((f) => f.parent_id === namedRoot.id && f.name.toLowerCase() === AGENT_MEMORY)
    : undefined;

  // Prefer per-agent memory first (higher priority via sort order of folderIds query — we'll boost later).
  const folderIds = [namedMemory?.id, sharedMemory?.id].filter(Boolean) as string[];
  if (folderIds.length === 0) {
    return { enabled: true, text: '', noteIds: [], truncated: false };
  }

  const placeholders = folderIds.map(() => '?').join(',');
  const notes = (db.prepare(`
    SELECT id, title, content, folder_id, updated_at
    FROM notes
    WHERE vault_id = ? AND folder_id IN (${placeholders}) AND is_archived = 0
    ORDER BY
      CASE WHEN title = 'INDEX' COLLATE NOCASE THEN 0 ELSE 1 END,
      updated_at DESC
  `).all(vaultId, ...folderIds) as Array<{ id: string; title: string; content: string }>).map((note) => ({
    ...note,
    content: redactPrivateBlocks(note.content),
  }));

  const topicTerms = String(opts.channelTopic || '')
    .toLowerCase()
    .match(/[a-z0-9_]{3,}/g) ?? [];

  const indexNote = notes.find((n) => n.title.toLowerCase() === 'index');
  const others = notes.filter((n) => n.title.toLowerCase() !== 'index');

  // Tier 1: hybrid semantic/lexical rank from the caller (QMD), when present.
  const rankIndex = new Map((opts.rankedNoteIds || []).map((id, i) => [id, i]));
  const semantic = others
    .filter((n) => rankIndex.has(n.id))
    .sort((a, b) => (rankIndex.get(a.id) ?? 0) - (rankIndex.get(b.id) ?? 0));
  // Tier 2: literal keyword match (fallback when no ranking is available).
  const seen = new Set(semantic.map((n) => n.id));
  const keyword = topicTerms.length
    ? others.filter((n) => {
        if (seen.has(n.id)) return false;
        const hay = `${n.title}\n${n.content}`.toLowerCase();
        return topicTerms.some((t) => hay.includes(t));
      })
    : [];
  // Tier 3: recency, only when nothing matched at all.
  const matched = semantic.length + keyword.length > 0
    ? [...semantic, ...keyword]
    : others.slice(0, 8);

  const ordered = [
    ...(indexNote ? [indexNote] : []),
    ...matched.slice(0, 12),
  ];

  const parts: string[] = ['Agent memory (vault):'];
  const noteIds: string[] = [];
  let used = parts[0].length;
  let truncated = false;
  for (const note of ordered) {
    const body = note.content
      .replace(/^---[\s\S]*?---\n/, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    const stats = opts.noteStats?.get(note.id);
    // Neutral applications count as usage, not evidence — only wins+losses
    // form the denominator (mirrors formatWinRecord in scratchpad.ts, not
    // imported to avoid a module cycle).
    const decided = stats ? stats.wins + stats.losses : 0;
    const record = stats && stats.uses > 0
      ? (decided > 0 ? ` [won ${stats.wins}/${decided}]` : ` [used ${stats.uses}×]`)
      : '';
    const chunk = `\n- [[${note.title}]]${record}: ${body}`;
    if (used + chunk.length > maxChars) {
      truncated = true;
      break;
    }
    parts.push(chunk);
    noteIds.push(note.id);
    used += chunk.length;
  }

  const text = noteIds.length ? parts.join('') : '';
  return { enabled: true, text, noteIds, truncated };
}

export function createAgentMemoryNote(
  db: Db,
  userId: number,
  vaultId: string,
  input: { title?: string; body: string; agentKey?: string; listed?: boolean },
): Note {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const { memoryId } = input.agentKey
    ? ensureAgentNamedMemoryFolders(db, vaultId, userId, input.agentKey)
    : ensureAgentMemoryFolders(db, vaultId, userId);
  const body = String(input.body || '').trim();
  if (!body) throw new Error('Memory body is required');
  const title = String(input.title || body.split('\n')[0] || 'Memory').slice(0, 80);
  const note = createNote(db, vaultId, userId, {
    title,
    folder_id: memoryId,
    content: `${body}\n`,
    is_listed: input.listed === true,
  });
  // Prepend pointer to INDEX
  const index = db.prepare(`
    SELECT id, content FROM notes
    WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE
  `).get(vaultId, memoryId) as { id: string; content: string } | undefined;
  if (index) {
    const pointer = `- [[${note.title}]] — ${body.replace(/\s+/g, ' ').slice(0, 120)}`;
    const next = index.content.includes('## Pointers')
      ? index.content.replace('## Pointers\n', `## Pointers\n\n${pointer}\n`)
      : `${index.content.trimEnd()}\n\n${pointer}\n`;
    updateNote(db, index.id, next);
  }
  return note;
}

// ── Feature 4: Unified search ──────────────────────────────────────

export type UnifiedSearchHit = {
  type: 'note' | 'chat';
  id: string;
  title: string;
  channelId?: string;
  snippet: string;
  score: number;
  timestamp?: string;
};

function sanitizeFts(raw: string): string {
  const terms = raw
    .toLowerCase()
    .match(/[a-z0-9_@#./:-]{2,}/g)
    ?.slice(0, 16) ?? [];
  return Array.from(new Set(terms)).map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

export function unifiedSearch(
  db: Db,
  userId: number,
  vaultId: string,
  rawQuery: string,
  opts: { scope?: 'notes' | 'chat' | 'all'; limit?: number; channelId?: string } = {},
): UnifiedSearchHit[] {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const scope = opts.scope || 'all';
  const limit = Math.max(1, Math.min(Number(opts.limit || 40), 100));
  const fts = sanitizeFts(rawQuery);
  if (!fts) return [];

  const hits: UnifiedSearchHit[] = [];

  if (scope === 'notes' || scope === 'all') {
    // notes FTS accepts the same MATCH string the vault search route uses
    try {
      const noteHits = searchNotes(db, vaultId, fts);
      for (const row of noteHits) {
        hits.push({
          type: 'note',
          id: row.id,
          title: row.title,
          snippet: String(row.snippet || ''),
          score: 500 - Math.abs(Number((row as { rank?: number }).rank) || 0),
        });
      }
    } catch {
      // Fall back to raw query if quoted MATCH fails
      try {
        const noteHits = searchNotes(db, vaultId, rawQuery);
        for (const row of noteHits) {
          hits.push({
            type: 'note',
            id: row.id,
            title: row.title,
            snippet: String(row.snippet || ''),
            score: 450,
          });
        }
      } catch { /* ignore */ }
    }
  }

  if (scope === 'chat' || scope === 'all') {
    // Only messages in channels the user can access via vault ownership / links.
    // For v1: messages in this vault_id (local channels + source rows stored here).
    const channelFilter = opts.channelId ? 'AND cm.channel_id = ?' : '';
    const params = opts.channelId
      ? [fts, vaultId, opts.channelId, limit]
      : [fts, vaultId, limit];
    const chatRows = db.prepare(`
      SELECT cm.id, cm.channel_id, cm.author, cm.body, cm.created_at,
             snippet(chat_messages_fts, 1, '<mark>', '</mark>', '...', 32) AS snippet,
             rank
      FROM chat_messages_fts
      JOIN chat_messages cm ON cm.rowid = chat_messages_fts.rowid
      WHERE chat_messages_fts MATCH ? AND cm.vault_id = ? ${channelFilter}
      ORDER BY rank
      LIMIT ?
    `).all(...params) as Array<{
      id: string;
      channel_id: string;
      author: string;
      body: string;
      created_at: string;
      snippet: string;
      rank: number;
    }>;

    for (const row of chatRows) {
      // Permission: user must be able to assertChatChannel
      try {
        assertChatChannel(db, row.channel_id, userId);
      } catch {
        continue;
      }
      hits.push({
        type: 'chat',
        id: row.id,
        title: `${row.author}`,
        channelId: row.channel_id,
        snippet: row.snippet || truncateSnippet(row.body, 200),
        score: 200 - Math.abs(row.rank || 0),
        timestamp: row.created_at,
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

// silence unused Vault import warning if any
export type { Vault };
