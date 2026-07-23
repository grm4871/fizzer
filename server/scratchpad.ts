/**
 * @file scratchpad.ts — Agent scratchpad: append-only journal + consolidation state.
 *
 * The scratchpad splits agent memory into two layers with different write costs:
 *
 *  1. Journal — an append-only log agents write to *during* work via
 *     `cascade-scratchpad jot`. Zero-decision capture: observations, outcomes,
 *     dead ends. Rows live in `agent_journal` and are cheap and unstructured.
 *  2. Distilled notes — the existing `_agent/<key>/memory` notes (evolution.ts),
 *     written only during consolidation, by reading the journal after the fact.
 *
 * Consolidation is agent-driven, never server-spawned: the server's whole job
 * is bookkeeping plus surfacing "consolidation is due" in the boot injection.
 * The tool-using agent (or a subagent it delegates to) reads the journal,
 * distills it into memory notes per its POLICIES note, and marks entries
 * consolidated via `cascade-scratchpad done`. POLICIES is a normal note the
 * agent may rewrite — the capture/consolidation rules are themselves
 * agent-editable memory, with note versioning as the audit trail.
 *
 * On top of the journal, four learning-loop extensions (all agent-driven):
 *  - Skills — executable procedures in `_agent/<key>/skills/` (shared:
 *    `_agent/skills/`). Consolidation may emit a *recipe* instead of prose;
 *    the boot injection lists skill titles + descriptions and the agent reads
 *    the full note only when relevant (progressive disclosure).
 *  - Outcome stats — `scratchpad_note_stats` counts wins/losses per note.
 *    Agents report `cascade-scratchpad outcome <note> --win|--loss` after
 *    applying a remembered strategy, turning single reflections into
 *    accumulated evidence; consolidation retires notes that keep losing.
 *  - Promotion — `cascade-scratchpad promote <note>` moves a per-agent memory
 *    or skill note into the shared `_agent/` folders so every agent inherits.
 *  - Open threads — a thin intentional trail of unfinished work
 *    (`cascade-scratchpad open` / `close`). Not a diary: at most a handful of
 *    living "continue / blocked / next" items injected at boot so a cold run
 *    can pick up without re-deriving from chat archaeology.
 */

import type Database from 'better-sqlite3';
import { createFolder, createNote, getNote, getVault, moveNote, updateNote, type Note } from './vault.js';
import { ensureAgentMemoryFolders, ensureAgentNamedMemoryFolders } from './evolution.js';

type Db = Database.Database;

export const JOURNAL_KINDS = ['observation', 'outcome', 'dead-end', 'decision', 'todo'] as const;
export type JournalKind = typeof JOURNAL_KINDS[number];

const POLICIES_TITLE = 'POLICIES';
const MAX_BODY_CHARS = 4000;
const MAX_THREAD_FIELD = 500;
/** Cap living open threads per agent so the boot surface stays a trail, not a kanban. */
const MAX_OPEN_THREADS = Math.max(1, Math.min(Number(process.env.SCRATCHPAD_MAX_OPEN_THREADS || 7), 20));
/** Boot injects at most this many open threads (newest first). */
const BOOT_OPEN_THREADS = Math.max(1, Math.min(Number(process.env.SCRATCHPAD_BOOT_OPEN_THREADS || 5), MAX_OPEN_THREADS));

// "Consolidation due" thresholds for the boot-injection nudge (env-tunable).
// Default 3 (was 10): short multiuser chat runs rarely hit 10 jots before
// the journal becomes a graveyard — nudge earlier so agents actually consolidate.
const DUE_MIN_ENTRIES = Math.max(1, Number(process.env.SCRATCHPAD_DUE_ENTRIES || 3));
const DUE_MAX_AGE_HOURS = Math.max(1, Number(process.env.SCRATCHPAD_DUE_AGE_HOURS || 24));

export function ensureScratchpadSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL,
      agent_key TEXT NOT NULL DEFAULT '',
      run_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'observation',
      body TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      consolidated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_journal_vault_idx
      ON agent_journal(vault_id, agent_key, id);
    CREATE INDEX IF NOT EXISTS agent_journal_open_idx
      ON agent_journal(vault_id, agent_key, consolidated_at);

    CREATE TABLE IF NOT EXISTS scratchpad_state (
      vault_id TEXT NOT NULL,
      agent_key TEXT NOT NULL DEFAULT '',
      last_consolidation_at TEXT,
      PRIMARY KEY (vault_id, agent_key)
    );

    CREATE TABLE IF NOT EXISTS scratchpad_note_stats (
      note_id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      last_result TEXT,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS scratchpad_note_stats_vault_idx
      ON scratchpad_note_stats(vault_id);

    CREATE TABLE IF NOT EXISTS agent_open_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL,
      agent_key TEXT NOT NULL DEFAULT '',
      intent TEXT NOT NULL,
      blocked_on TEXT NOT NULL DEFAULT '',
      next_try TEXT NOT NULL DEFAULT '',
      pointer TEXT NOT NULL DEFAULT '',
      run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT,
      close_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_open_threads_open_idx
      ON agent_open_threads(vault_id, agent_key, closed_at, id);
  `);
  // Sweep stats orphaned by note deletions that predate delete-time pruning.
  try {
    db.prepare('DELETE FROM scratchpad_note_stats WHERE note_id NOT IN (SELECT id FROM notes)').run();
  } catch { /* notes table may not exist yet in partial test schemas */ }
}

/** Drop a note's outcome stats (call when the note is deleted). */
export function deleteNoteStats(db: Db, noteId: string): void {
  db.prepare('DELETE FROM scratchpad_note_stats WHERE note_id = ?').run(noteId);
}

export type JournalEntry = {
  id: number;
  vaultId: string;
  agentKey: string;
  runId: number | null;
  kind: JournalKind;
  body: string;
  createdAt: string;
  consolidatedAt: string | null;
};

type JournalRow = {
  id: number;
  vault_id: string;
  agent_key: string;
  run_id: number | null;
  kind: string;
  body: string;
  created_at: string;
  consolidated_at: string | null;
};

function toEntry(row: JournalRow): JournalEntry {
  return {
    id: row.id,
    vaultId: row.vault_id,
    agentKey: row.agent_key,
    runId: row.run_id,
    kind: (JOURNAL_KINDS as readonly string[]).includes(row.kind) ? (row.kind as JournalKind) : 'observation',
    body: row.body,
    createdAt: row.created_at,
    consolidatedAt: row.consolidated_at,
  };
}

function normalizeAgentKey(agentKey?: string): string {
  return String(agentKey || '').replace(/^@+/, '').trim().slice(0, 64);
}

export function appendJournalEntry(
  db: Db,
  userId: number,
  vaultId: string,
  input: { agentKey?: string; runId?: number; kind?: string; body: string },
): JournalEntry {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const body = String(input.body || '').trim().slice(0, MAX_BODY_CHARS);
  if (!body) throw new Error('Journal entry body is required');
  const kind = (JOURNAL_KINDS as readonly string[]).includes(String(input.kind || ''))
    ? String(input.kind)
    : 'observation';
  const runId = Number.isFinite(Number(input.runId)) && Number(input.runId) > 0 ? Number(input.runId) : null;
  const result = db.prepare(`
    INSERT INTO agent_journal (vault_id, agent_key, run_id, kind, body)
    VALUES (?, ?, ?, ?, ?)
  `).run(vault.id, normalizeAgentKey(input.agentKey), runId, kind, body);
  const row = db.prepare('SELECT * FROM agent_journal WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as JournalRow;
  return toEntry(row);
}

export function listJournalEntries(
  db: Db,
  userId: number,
  vaultId: string,
  opts: { agentKey?: string; unconsolidatedOnly?: boolean; sinceId?: number; limit?: number } = {},
): JournalEntry[] {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const limit = Math.max(1, Math.min(Number(opts.limit || 100), 500));
  const clauses = ['vault_id = ?'];
  const params: unknown[] = [vault.id];
  const agentKey = normalizeAgentKey(opts.agentKey);
  if (agentKey) {
    clauses.push('agent_key = ?');
    params.push(agentKey);
  }
  if (opts.unconsolidatedOnly) clauses.push('consolidated_at IS NULL');
  if (Number.isFinite(Number(opts.sinceId)) && Number(opts.sinceId) > 0) {
    clauses.push('id > ?');
    params.push(Number(opts.sinceId));
  }
  const rows = db.prepare(`
    SELECT * FROM agent_journal
    WHERE ${clauses.join(' AND ')}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params, limit) as JournalRow[];
  return rows.map(toEntry);
}

export function markJournalConsolidated(
  db: Db,
  userId: number,
  vaultId: string,
  opts: { agentKey?: string; throughId: number },
): number {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const throughId = Number(opts.throughId);
  if (!Number.isFinite(throughId) || throughId <= 0) throw new Error('throughId is required');
  const agentKey = normalizeAgentKey(opts.agentKey);
  const params: unknown[] = agentKey ? [vault.id, agentKey, throughId] : [vault.id, throughId];
  const result = db.prepare(`
    UPDATE agent_journal
    SET consolidated_at = datetime('now')
    WHERE vault_id = ? ${agentKey ? 'AND agent_key = ?' : ''} AND id <= ? AND consolidated_at IS NULL
  `).run(...params);
  db.prepare(`
    INSERT INTO scratchpad_state (vault_id, agent_key, last_consolidation_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(vault_id, agent_key) DO UPDATE SET last_consolidation_at = datetime('now')
  `).run(vault.id, agentKey);
  return result.changes;
}

export type ScratchpadStatus = {
  agentKey: string;
  unconsolidated: number;
  oldestUnconsolidatedAt: string | null;
  lastConsolidationAt: string | null;
  openThreads: number;
};

export function scratchpadStatus(db: Db, vaultId: string, agentKey?: string): ScratchpadStatus {
  const key = normalizeAgentKey(agentKey);
  const params: unknown[] = key ? [vaultId, key] : [vaultId];
  const row = db.prepare(`
    SELECT COUNT(*) AS n, MIN(created_at) AS oldest
    FROM agent_journal
    WHERE vault_id = ? ${key ? 'AND agent_key = ?' : ''} AND consolidated_at IS NULL
  `).get(...params) as { n: number; oldest: string | null };
  const state = db.prepare(`
    SELECT last_consolidation_at FROM scratchpad_state WHERE vault_id = ? AND agent_key = ?
  `).get(vaultId, key) as { last_consolidation_at: string | null } | undefined;
  const openRow = db.prepare(`
    SELECT COUNT(*) AS n FROM agent_open_threads
    WHERE vault_id = ? ${key ? 'AND agent_key = ?' : ''} AND closed_at IS NULL
  `).get(...params) as { n: number };
  return {
    agentKey: key,
    unconsolidated: row?.n ?? 0,
    oldestUnconsolidatedAt: row?.oldest ?? null,
    lastConsolidationAt: state?.last_consolidation_at ?? null,
    openThreads: openRow?.n ?? 0,
  };
}

// ── Open threads (intentional unfinished trail) ────────────────────

export type OpenThread = {
  id: number;
  vaultId: string;
  agentKey: string;
  intent: string;
  blockedOn: string;
  nextTry: string;
  pointer: string;
  runId: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: string | null;
};

type OpenThreadRow = {
  id: number;
  vault_id: string;
  agent_key: string;
  intent: string;
  blocked_on: string;
  next_try: string;
  pointer: string;
  run_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  close_reason: string | null;
};

function toOpenThread(row: OpenThreadRow): OpenThread {
  return {
    id: row.id,
    vaultId: row.vault_id,
    agentKey: row.agent_key,
    intent: row.intent,
    blockedOn: row.blocked_on || '',
    nextTry: row.next_try || '',
    pointer: row.pointer || '',
    runId: row.run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
  };
}

function clipThreadField(value: unknown, label: string, required = false): string {
  const text = String(value || '').trim().slice(0, MAX_THREAD_FIELD);
  if (required && !text) throw new Error(`${label} is required`);
  return text;
}

export function listOpenThreads(
  db: Db,
  userId: number,
  vaultId: string,
  opts: { agentKey?: string; includeClosed?: boolean; limit?: number } = {},
): OpenThread[] {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const limit = Math.max(1, Math.min(Number(opts.limit || 50), 200));
  const clauses = ['vault_id = ?'];
  const params: unknown[] = [vault.id];
  const agentKey = normalizeAgentKey(opts.agentKey);
  if (agentKey) {
    clauses.push('agent_key = ?');
    params.push(agentKey);
  }
  if (!opts.includeClosed) clauses.push('closed_at IS NULL');
  const rows = db.prepare(`
    SELECT * FROM agent_open_threads
    WHERE ${clauses.join(' AND ')}
    ORDER BY CASE WHEN closed_at IS NULL THEN 0 ELSE 1 END, id DESC
    LIMIT ?
  `).all(...params, limit) as OpenThreadRow[];
  return rows.map(toOpenThread);
}

export function openThread(
  db: Db,
  userId: number,
  vaultId: string,
  input: {
    intent: string;
    blockedOn?: string;
    nextTry?: string;
    pointer?: string;
    agentKey?: string;
    runId?: number;
  },
): OpenThread {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const agentKey = normalizeAgentKey(input.agentKey);
  const intent = clipThreadField(input.intent, 'intent', true);
  const blockedOn = clipThreadField(input.blockedOn, 'blockedOn');
  const nextTry = clipThreadField(input.nextTry, 'nextTry');
  const pointer = clipThreadField(input.pointer, 'pointer');
  const openCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM agent_open_threads
    WHERE vault_id = ? AND agent_key = ? AND closed_at IS NULL
  `).get(vault.id, agentKey) as { n: number }).n;
  if (openCount >= MAX_OPEN_THREADS) {
    throw new Error(
      `already have ${openCount} open threads (max ${MAX_OPEN_THREADS}); close one first with cascade-scratchpad close <id>`,
    );
  }
  const runId = Number.isFinite(Number(input.runId)) && Number(input.runId) > 0 ? Number(input.runId) : null;
  const result = db.prepare(`
    INSERT INTO agent_open_threads
      (vault_id, agent_key, intent, blocked_on, next_try, pointer, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(vault.id, agentKey, intent, blockedOn, nextTry, pointer, runId);
  const row = db.prepare('SELECT * FROM agent_open_threads WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as OpenThreadRow;
  return toOpenThread(row);
}

export function closeOpenThread(
  db: Db,
  userId: number,
  vaultId: string,
  opts: { threadId: number; agentKey?: string; reason?: string },
): OpenThread {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const threadId = Number(opts.threadId);
  if (!Number.isFinite(threadId) || threadId <= 0) throw new Error('threadId is required');
  const agentKey = normalizeAgentKey(opts.agentKey);
  const existing = db.prepare(`
    SELECT * FROM agent_open_threads WHERE id = ? AND vault_id = ?
  `).get(threadId, vault.id) as OpenThreadRow | undefined;
  if (!existing) throw new Error(`open thread #${threadId} not found`);
  if (agentKey && existing.agent_key && existing.agent_key !== agentKey) {
    throw new Error(`open thread #${threadId} belongs to @${existing.agent_key}, not @${agentKey}`);
  }
  if (existing.closed_at) return toOpenThread(existing);
  const reason = clipThreadField(opts.reason, 'reason') || 'closed';
  db.prepare(`
    UPDATE agent_open_threads
    SET closed_at = datetime('now'), close_reason = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, threadId);
  const row = db.prepare('SELECT * FROM agent_open_threads WHERE id = ?').get(threadId) as OpenThreadRow;
  return toOpenThread(row);
}

function formatOpenThreadLine(t: OpenThread): string {
  const bits = [`#${t.id} ${t.intent}`];
  if (t.blockedOn) bits.push(`blocked: ${t.blockedOn}`);
  if (t.nextTry) bits.push(`next: ${t.nextTry}`);
  if (t.pointer) bits.push(`ptr: ${t.pointer}`);
  return bits.join(' | ');
}

// ── Skills, outcome stats, promotion ───────────────────────────────

const AGENT_ROOT = '_agent';
const SKILLS_FOLDER = 'skills';

function getOrCreateChildFolder(db: Db, vaultId: string, name: string, parentId: string | null): { id: string } {
  const existing = (parentId
    ? db.prepare(`
        SELECT id FROM folders
        WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
      `).get(vaultId, parentId, name)
    : db.prepare(`
        SELECT id FROM folders
        WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
      `).get(vaultId, name)) as { id: string } | undefined;
  if (existing) return existing;
  const folder = createFolder(db, vaultId, { name, ...(parentId ? { parent_id: parentId } : {}) });
  return { id: folder.id };
}

/** Lookup (never create) the agent-scoped and shared memory/skills folder ids. */
function findAgentFolderIds(db: Db, vaultId: string, agentKey: string): { own: Set<string>; shared: Set<string> } {
  const own = new Set<string>();
  const shared = new Set<string>();
  const child = db.prepare(`
    SELECT id FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
  `);
  const root = db.prepare(`
    SELECT id FROM folders WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
  `).get(vaultId, AGENT_ROOT) as { id: string } | undefined;
  if (!root) return { own, shared };
  for (const name of ['memory', SKILLS_FOLDER]) {
    const folder = child.get(vaultId, root.id, name) as { id: string } | undefined;
    if (folder) shared.add(folder.id);
  }
  const key = normalizeAgentKey(agentKey);
  if (key) {
    const agentRoot = child.get(vaultId, root.id, key) as { id: string } | undefined;
    if (agentRoot) {
      for (const name of ['memory', SKILLS_FOLDER]) {
        const folder = child.get(vaultId, agentRoot.id, name) as { id: string } | undefined;
        if (folder) own.add(folder.id);
      }
    }
  }
  return { own, shared };
}

export type RecallHit = {
  id: string;
  title: string;
  snippet: string;
  kind: 'memory' | 'skill';
  shared: boolean;
  stats?: { uses: number; wins: number; losses: number };
};

/** folder_id -> {kind, shared} for the agent's own + shared memory/skills folders. */
function recallScopeFolders(db: Db, vaultId: string, agentKey: string): Map<string, { kind: 'memory' | 'skill'; shared: boolean }> {
  const map = new Map<string, { kind: 'memory' | 'skill'; shared: boolean }>();
  const child = db.prepare(`
    SELECT id FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
  `);
  const root = db.prepare(`
    SELECT id FROM folders WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
  `).get(vaultId, AGENT_ROOT) as { id: string } | undefined;
  if (!root) return map;
  const add = (parentId: string, shared: boolean) => {
    for (const name of ['memory', SKILLS_FOLDER] as const) {
      const folder = child.get(vaultId, parentId, name) as { id: string } | undefined;
      if (folder) map.set(folder.id, { kind: name === 'memory' ? 'memory' : 'skill', shared });
    }
  };
  add(root.id, true);
  const key = normalizeAgentKey(agentKey);
  if (key) {
    const agentRoot = child.get(vaultId, root.id, key) as { id: string } | undefined;
    if (agentRoot) add(agentRoot.id, false);
  }
  return map;
}

/** Auto-captured run summaries (post-hoc request/outcome dumps) — useful archive, noisy for mid-task recall. */
function isAutoRunCapture(title: string, content: string): boolean {
  if (/Captured from completed run/i.test(content)) return true;
  if (/##\s*Request\b/i.test(content) && /##\s*Outcome\b/i.test(content)) return true;
  // Titles look like truncated user pings with a trailing (runId).
  if (/\(\d{2,}\)\s*$/.test(title) && /Channel:\s*/i.test(content)) return true;
  return false;
}

function queryTerms(query: string): string[] {
  return String(query || '').toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
}

/** Distinct query terms found in haystack. */
function lexicalHits(terms: string[], haystack: string): number {
  if (terms.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let n = 0;
  for (const t of terms) {
    if (hay.includes(t)) n += 1;
  }
  return n;
}

/**
 * On-demand recall: search the agent's memory + skills (own and shared) for the
 * few notes relevant to `query`, for use *mid-task* when the agent hits a
 * familiar problem — not just the static boot injection.
 *
 * Relevance-gated (agent preference from dogfood):
 *  - Every hit needs real lexical term overlap. Semantic `rankedIds` only
 *    reorders / boosts candidates that already match; they never pull in
 *    unrelated notes (QMD is noisy on garbage queries).
 *  - Skills and agent-authored notes outrank auto-captured run dumps.
 *  - Auto-captures need stronger term overlap to appear at all.
 *  - Empty is a valid answer — better than trusting garbage hits.
 */
export function recallScratchpad(
  db: Db,
  userId: number,
  vaultId: string,
  input: { query: string; agentKey?: string; limit?: number; rankedIds?: string[] },
): RecallHit[] {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const query = String(input.query || '').trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(Number(input.limit || 5), 20));
  const scope = recallScopeFolders(db, vault.id, normalizeAgentKey(input.agentKey));
  if (scope.size === 0) return [];

  const folderIds = [...scope.keys()];
  const placeholders = folderIds.map(() => '?').join(',');
  const inScope = db.prepare(`
    SELECT id, title, content, folder_id FROM notes
    WHERE vault_id = ? AND folder_id IN (${placeholders})
      AND is_archived = 0 AND title <> 'INDEX' COLLATE NOCASE
  `).all(vault.id, ...folderIds) as Array<{ id: string; title: string; content: string; folder_id: string }>;

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const rankIndex = new Map((input.rankedIds || []).map((id, i) => [id, i]));
  const stats = getNoteStatsForVault(db, vault.id);

  type Scored = {
    n: (typeof inScope)[number];
    score: number;
    kind: 'memory' | 'skill';
    shared: boolean;
    auto: boolean;
  };
  const scored: Scored[] = [];

  for (const n of inScope) {
    const meta = scope.get(n.folder_id);
    if (!meta) continue;
    const body = n.content.replace(/^---[\s\S]*?---\n/, '');
    const auto = meta.kind === 'memory' && isAutoRunCapture(n.title, body);
    const titleHits = lexicalHits(terms, n.title);
    const bodyHits = lexicalHits(terms, `${n.title}\n${body}`);
    // Require at least one term match always; auto-captures need more signal
    // so they don't dominate mid-task recall over deliberate skills/notes.
    const minLex = auto ? Math.min(2, terms.length) : 1;
    if (bodyHits < minLex) continue;

    let score = bodyHits + titleHits * 0.75;
    if (meta.kind === 'skill') score += 2.5; // procedures beat prose dumps
    if (!meta.shared) score += 0.5; // prefer own notes over shared
    if (auto) score -= 2.0;
    const s = stats.get(n.id);
    if (s) score += smoothedWinRate(s) * 0.75;
    const rank = rankIndex.get(n.id);
    if (rank != null) score += Math.max(0, 1.2 - rank * 0.08);

    scored.push({ n, score, kind: meta.kind, shared: meta.shared, auto });
  }

  // Absolute floor: a single weak shared auto-capture with one term shouldn't win.
  const MIN_ACCEPT = 1.0;
  scored.sort((a, b) => b.score - a.score || a.n.title.localeCompare(b.n.title));
  const accepted = scored.filter((x) => x.score >= MIN_ACCEPT).slice(0, limit);

  return accepted.map(({ n, kind, shared }) => {
    const s = stats.get(n.id);
    return {
      id: n.id,
      title: n.title,
      snippet: n.content.replace(/^---[\s\S]*?---\n/, '').replace(/\s+/g, ' ').trim().slice(0, 240),
      kind,
      shared,
      ...(s ? { stats: s } : {}),
    };
  });
}

/**
 * Resolve a note by id, or by title scoped to the calling agent. Titles are
 * not unique across folders, and outcome attribution crediting the wrong note
 * is the worst failure this system can have — so title matches prefer the
 * agent's own memory/skills folders, then the shared ones, and refuse with
 * the candidate ids when still ambiguous.
 */
function resolveNoteRef(db: Db, vaultId: string, ref: string, agentKey?: string): Note | undefined {
  const trimmed = String(ref || '').trim();
  if (!trimmed) return undefined;
  const byId = getNote(db, trimmed);
  if (byId && byId.vault_id === vaultId) return byId;

  const rows = db.prepare(`
    SELECT id, folder_id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE
  `).all(vaultId, trimmed) as Array<{ id: string; folder_id: string | null }>;
  if (rows.length === 0) return undefined;
  if (rows.length === 1) return getNote(db, rows[0].id);

  // Scope preference needs a caller identity — with no agent key, guessing
  // between same-titled notes is exactly the misattribution to avoid.
  const key = normalizeAgentKey(agentKey || '');
  if (key) {
    const { own, shared } = findAgentFolderIds(db, vaultId, key);
    for (const scope of [own, shared]) {
      const inScope = rows.filter((r) => r.folder_id && scope.has(r.folder_id));
      if (inScope.length === 1) return getNote(db, inScope[0].id);
      if (inScope.length > 1) break; // ambiguous even within one scope
    }
  }
  throw new Error(
    `Ambiguous title "${trimmed}" matches ${rows.length} notes — use a note id: ${rows.map((r) => r.id).join(', ')}`,
  );
}

/** Per-agent skills folder `_agent/<key>/skills` (shared `_agent/skills` when key empty). */
export function ensureSkillsFolder(db: Db, vaultId: string, userId: number, agentKey: string): { skillsId: string } {
  const key = normalizeAgentKey(agentKey);
  if (!key) {
    const { rootId } = ensureAgentMemoryFolders(db, vaultId, userId);
    return { skillsId: getOrCreateChildFolder(db, vaultId, SKILLS_FOLDER, rootId).id };
  }
  const { agentRootId } = ensureAgentNamedMemoryFolders(db, vaultId, userId, key);
  return { skillsId: getOrCreateChildFolder(db, vaultId, SKILLS_FOLDER, agentRootId).id };
}

export type SkillSummary = {
  id: string;
  title: string;
  description: string;
  shared: boolean;
  stats?: { uses: number; wins: number; losses: number };
};

/**
 * Human label for a note's outcome record. Neutral applications count as
 * usage but not as evidence — `(won 0/10)` when all ten were neutral would
 * read as ten losses and get a good note retired.
 */
export function formatWinRecord(stats?: { uses: number; wins: number; losses: number }): string {
  if (!stats || stats.uses === 0) return '';
  const decided = stats.wins + stats.losses;
  if (decided === 0) return `used ${stats.uses}×`;
  return `won ${stats.wins}/${decided}`;
}

/** Laplace-smoothed win rate: a fluke 1-0 shouldn't outrank a proven 40-2. */
function smoothedWinRate(stats?: { uses: number; wins: number; losses: number }): number {
  if (!stats) return 0.5; // unknown — prior only
  return (stats.wins + 1) / (stats.wins + stats.losses + 2);
}

function skillDescription(content: string): string {
  const line = content
    .replace(/^---[\s\S]*?---\n/, '')
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find(Boolean) || '';
  return line.slice(0, 140);
}

/**
 * Create (or replace) a skill note: an executable procedure the agent distilled
 * from experience. First line of the body should say when to use it.
 */
export function createSkillNote(
  db: Db,
  userId: number,
  vaultId: string,
  input: { title: string; body: string; agentKey?: string },
): Note {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const title = String(input.title || '').trim().slice(0, 120);
  const body = String(input.body || '').trim();
  if (!title) throw new Error('Skill title is required');
  if (!body) throw new Error('Skill body is required');
  const { skillsId } = ensureSkillsFolder(db, vault.id, userId, normalizeAgentKey(input.agentKey));
  const existing = db.prepare(`
    SELECT id, content FROM notes WHERE vault_id = ? AND folder_id = ? AND title = ? COLLATE NOCASE
  `).get(vault.id, skillsId, title) as { id: string; content: string } | undefined;
  if (existing) {
    // A rewritten skill is a new procedure: its old win/loss record is
    // evidence about content that no longer exists, so reset it rather than
    // let a fixed skill get retired on its predecessor's losses.
    if (existing.content.trim() !== body) deleteNoteStats(db, existing.id);
    return updateNote(db, existing.id, `${body}\n`);
  }
  // Skills are listed on purpose: procedures are the part of agent memory the
  // human most wants to see and correct.
  return createNote(db, vault.id, userId, {
    title,
    folder_id: skillsId,
    is_listed: true,
    content: `${body}\n`,
  });
}

/** Skills visible to an agent: its own folder plus the shared `_agent/skills`. */
export function listSkillNotes(db: Db, userId: number, vaultId: string, agentKey?: string): SkillSummary[] {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const key = normalizeAgentKey(agentKey);
  const folders: Array<{ id: string; shared: boolean }> = [];
  const root = db.prepare(`
    SELECT id FROM folders WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE
  `).get(vault.id, AGENT_ROOT) as { id: string } | undefined;
  if (!root) return [];
  const sharedSkills = db.prepare(`
    SELECT id FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
  `).get(vault.id, root.id, SKILLS_FOLDER) as { id: string } | undefined;
  if (sharedSkills) folders.push({ id: sharedSkills.id, shared: true });
  if (key) {
    const agentRoot = db.prepare(`
      SELECT id FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
    `).get(vault.id, root.id, key) as { id: string } | undefined;
    const ownSkills = agentRoot
      ? db.prepare(`
          SELECT id FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE
        `).get(vault.id, agentRoot.id, SKILLS_FOLDER) as { id: string } | undefined
      : undefined;
    if (ownSkills) folders.push({ id: ownSkills.id, shared: false });
  }
  if (folders.length === 0) return [];

  const placeholders = folders.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT n.id, n.title, n.content, n.folder_id, n.updated_at,
           s.uses AS uses, s.wins AS wins, s.losses AS losses
    FROM notes n
    LEFT JOIN scratchpad_note_stats s ON s.note_id = n.id
    WHERE n.vault_id = ? AND n.folder_id IN (${placeholders}) AND n.is_archived = 0
  `).all(vault.id, ...folders.map((f) => f.id)) as Array<{
    id: string; title: string; content: string; folder_id: string; updated_at: string;
    uses: number | null; wins: number | null; losses: number | null;
  }>;
  const sharedIds = new Set(folders.filter((f) => f.shared).map((f) => f.id));
  const skills = rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: skillDescription(row.content),
    shared: sharedIds.has(row.folder_id),
    updatedAt: row.updated_at,
    ...(row.uses != null
      ? { stats: { uses: row.uses, wins: row.wins || 0, losses: row.losses || 0 } }
      : {}),
  }));
  return skills
    .sort((a, b) => {
      const rate = smoothedWinRate(b.stats) - smoothedWinRate(a.stats);
      if (Math.abs(rate) > 1e-9) return rate;
      const decided = ((b.stats?.wins || 0) + (b.stats?.losses || 0)) - ((a.stats?.wins || 0) + (a.stats?.losses || 0));
      if (decided !== 0) return decided;
      return b.updatedAt.localeCompare(a.updatedAt);
    })
    .map(({ updatedAt: _updatedAt, ...skill }) => skill);
}

export type OutcomeResult = 'win' | 'loss' | 'neutral';

/** Record that a remembered note/skill was applied and how it went. */
export function recordNoteOutcome(
  db: Db,
  userId: number,
  vaultId: string,
  input: { noteRef: string; result: OutcomeResult; agentKey?: string },
): { noteId: string; title: string; uses: number; wins: number; losses: number } {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const note = resolveNoteRef(db, vault.id, input.noteRef, input.agentKey);
  if (!note) throw new Error(`Note not found: ${input.noteRef}`);
  const result: OutcomeResult = input.result === 'win' || input.result === 'loss' ? input.result : 'neutral';
  db.prepare(`
    INSERT INTO scratchpad_note_stats (note_id, vault_id, uses, wins, losses, last_result, last_used_at)
    VALUES (?, ?, 1, ?, ?, ?, datetime('now'))
    ON CONFLICT(note_id) DO UPDATE SET
      uses = uses + 1,
      wins = wins + excluded.wins,
      losses = losses + excluded.losses,
      last_result = excluded.last_result,
      last_used_at = datetime('now')
  `).run(note.id, vault.id, result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0, result);
  const row = db.prepare('SELECT uses, wins, losses FROM scratchpad_note_stats WHERE note_id = ?')
    .get(note.id) as { uses: number; wins: number; losses: number };
  return { noteId: note.id, title: note.title, ...row };
}

/** Outcome stats for a vault, keyed by note id (for injection ordering/labels). */
export function getNoteStatsForVault(db: Db, vaultId: string): Map<string, { uses: number; wins: number; losses: number }> {
  const rows = db.prepare(`
    SELECT note_id, uses, wins, losses FROM scratchpad_note_stats WHERE vault_id = ?
  `).all(vaultId) as Array<{ note_id: string; uses: number; wins: number; losses: number }>;
  return new Map(rows.map((r) => [r.note_id, { uses: r.uses, wins: r.wins, losses: r.losses }]));
}

/**
 * Promote a per-agent memory or skill note into the shared `_agent/` folders
 * so every agent in the vault inherits it. Memory notes also get a pointer
 * appended to the shared INDEX.
 */
export function promoteNote(
  db: Db,
  userId: number,
  vaultId: string,
  input: { noteRef: string; agentKey?: string },
): { note: Note; kind: 'memory' | 'skill' } {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const note = resolveNoteRef(db, vault.id, input.noteRef, input.agentKey);
  if (!note) throw new Error(`Note not found: ${input.noteRef}`);
  if (!note.folder_id) throw new Error('Note is not in an agent folder');
  const folder = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?')
    .get(note.folder_id) as { id: string; name: string; parent_id: string | null } | undefined;
  if (!folder) throw new Error('Note folder not found');
  const folderName = folder.name.toLowerCase();
  if (folderName !== 'memory' && folderName !== SKILLS_FOLDER) {
    throw new Error('Only notes in an agent memory or skills folder can be promoted');
  }
  const kind: 'memory' | 'skill' = folderName === 'memory' ? 'memory' : 'skill';

  const shared = ensureAgentMemoryFolders(db, vault.id, userId);
  const targetId = kind === 'memory'
    ? shared.memoryId
    : getOrCreateChildFolder(db, vault.id, SKILLS_FOLDER, shared.rootId).id;
  if (note.folder_id === targetId) return { note, kind }; // already shared

  moveNote(db, note.id, targetId);

  if (kind === 'memory') {
    const index = db.prepare(`
      SELECT id, content FROM notes
      WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE
    `).get(vault.id, shared.memoryId) as { id: string; content: string } | undefined;
    if (index && !index.content.includes(`[[${note.title}]]`)) {
      const hook = note.content.replace(/^---[\s\S]*?---\n/, '').replace(/\s+/g, ' ').trim().slice(0, 120);
      const pointer = `- [[${note.title}]] — ${hook}`;
      const next = index.content.includes('## Pointers')
        ? index.content.replace('## Pointers\n', `## Pointers\n\n${pointer}\n`)
        : `${index.content.trimEnd()}\n\n${pointer}\n`;
      updateNote(db, index.id, next);
    }
  }
  return { note: getNote(db, note.id)!, kind };
}

/** Whether the journal backlog warrants a consolidation nudge at boot. */
function isConsolidationDue(status: ScratchpadStatus): boolean {
  if (status.unconsolidated === 0) return false;
  if (status.unconsolidated >= DUE_MIN_ENTRIES) return true;
  if (status.oldestUnconsolidatedAt) {
    const ageMs = Date.now() - new Date(`${status.oldestUnconsolidatedAt}Z`).getTime();
    if (Number.isFinite(ageMs) && ageMs >= DUE_MAX_AGE_HOURS * 3600_000) return true;
  }
  return false;
}

const DEFAULT_POLICIES = `# Scratchpad policies

These policies are yours to evolve. When experience shows a rule is wrong,
rewrite it here (note versions keep the audit trail). Keep this note short —
it is injected into every run's context.

## Capture (during work)

- Jot liberally with \`cascade-scratchpad jot\` — it is append-only and costs
  nothing to curate later. Do not stop to decide what is "durable".
- Always jot: dead ends (\`--kind dead-end\`: what you tried and why it failed),
  surprising observations, decisions and their reasons, outcomes of risky steps.
- One entry per fact. Plain prose, no formatting required.
- Short chat runs still count: if you learned something the *next* ping would
  re-derive (a root cause, a fix path, a dead end), jot it before your final
  reply. One \`jot\` is enough; do not write a report.

## Recall (mid-task, when you're stuck)

- The boot injection is a *guess* at what's relevant, made before you saw the
  problem. When you hit a familiar failure or a task you suspect you've handled
  before, don't re-derive — run \`cascade-scratchpad recall <query>\` to pull the
  few matching memory notes and skills. Empty results mean "nothing relevant" —
  do not invent a match. Prefer **skills** over auto-captured run dumps.
- Read the full note/skill (\`cascade-note get <title>\`) before applying it,
  then report the outcome.

## Consolidation (when the boot context says it is due)

- You do this yourself — no external process will. When the journal backlog is
  flagged as due (or you just finished a multi-step fix worth keeping),
  consolidate after finishing the user's actual task (or delegate it to a
  subagent so it doesn't cost the main thread focus).
- Read unconsolidated journal entries oldest-first
  (\`cascade-scratchpad journal --unconsolidated\`); distill durable facts into
  memory notes (\`cascade-note memory write/update\`). Merge into existing notes
  rather than duplicating; cite source entries as \`journal#<id>\`.
- Superseded beliefs: correct the note but keep a line noting what was
  previously believed and why it changed.
- Session-local noise (progress chatter, one-off details) gets no note —
  marking it consolidated is enough. Forgetting is allowed.
- Repeatable procedures become **skills**, not prose: if the journal shows the
  same sequence of steps worked twice, write it as a skill
  (\`cascade-scratchpad skill write --title T\` — first line says when to use
  it, body is the exact commands/steps). Next time, execute the skill instead
  of re-deriving it.
- Finish by marking entries consolidated: \`cascade-scratchpad done --through <id>\`.

## Outcomes (close the loop)

- When you apply a remembered note or skill, report how it went:
  \`cascade-scratchpad outcome <note-title> --win\` (or \`--loss\`). One command,
  right after you know the result.
- During consolidation, use the counters: rewrite or retire notes that keep
  losing (several uses, mostly losses); trust and keep ones that keep winning.

## Open threads (unfinished intentional trail)

- Separate from the journal: open threads are what past-you wanted to *continue*,
  not every observation. At most a handful live at once.
- When a run ends unfinished, blocked, or with a clear "next", open a thread:
  \`cascade-scratchpad open --text "continue: …" [--blocked "…"] [--next "…"] [--pointer journal#N|path]\`.
  Shape the intent as continue/blocked/next so a cold run can act without
  re-reading chat history.
- Do **not** open a thread for every completed task or for noise. Ruthlessly
  \`cascade-scratchpad close <id> [--reason "…"]\` when done or abandoned —
  stale threads are worse than none.
- Boot injects open threads when any exist. Prefer them over archaeology when
  the user asks what is left or says "continue".

## Promotion / demotion

- INDEX holds one-line pointers, most useful first. Trim pointers that stopped
  earning recall; the notes remain searchable without them.
- When a note or skill proves useful beyond your own context — it keeps
  winning, or another agent would clearly benefit — share it:
  \`cascade-scratchpad promote <note-title>\` moves it to the vault-wide agent
  folders every agent sees.
- Promote a fact into POLICIES itself only if it changes how future runs
  should *behave*, not just what they know.
`;

/**
 * Ensure the POLICIES note exists in `_agent/<key>/memory`. Listed on purpose:
 * the human should be able to see and correct the agent's operating rules.
 */
export function ensureScratchpadPolicies(
  db: Db,
  vaultId: string,
  userId: number,
  agentKey: string,
): Note | undefined {
  const { memoryId } = ensureAgentNamedMemoryFolders(db, vaultId, userId, agentKey);
  const existing = db.prepare(`
    SELECT id FROM notes WHERE vault_id = ? AND folder_id = ? AND title = ? COLLATE NOCASE
  `).get(vaultId, memoryId, POLICIES_TITLE) as { id: string } | undefined;
  if (existing) return undefined;
  return createNote(db, vaultId, userId, {
    title: POLICIES_TITLE,
    folder_id: memoryId,
    is_listed: true,
    content: DEFAULT_POLICIES,
  });
}

function policiesNote(db: Db, vaultId: string, agentKey: string): { id: string; content: string } | undefined {
  // Match by folder path lookup: any POLICIES note inside a memory folder for this key.
  const rows = db.prepare(`
    SELECT n.id, n.content, f.parent_id
    FROM notes n
    JOIN folders f ON f.id = n.folder_id
    WHERE n.vault_id = ? AND n.title = ? COLLATE NOCASE AND f.name = 'memory' COLLATE NOCASE
  `).all(vaultId, POLICIES_TITLE) as Array<{ id: string; content: string; parent_id: string | null }>;
  if (rows.length === 0) return undefined;
  if (rows.length === 1 || !agentKey) return rows[0];
  const parent = db.prepare(`
    SELECT id FROM folders WHERE vault_id = ? AND name = ? COLLATE NOCASE
  `).get(vaultId, normalizeAgentKey(agentKey)) as { id: string } | undefined;
  return rows.find((r) => r.parent_id === parent?.id) || rows[0];
}

/**
 * Boot-time injection: the agent's own POLICIES plus journal state, so every
 * run knows the scratchpad exists, what its rules are, and whether the journal
 * is piling up.
 */
export function buildScratchpadInjection(
  db: Db,
  vaultId: string,
  opts: { agentKey?: string; userId?: number; maxChars?: number } = {},
): string {
  const maxChars = Math.max(300, Math.min(Number(opts.maxChars || 1600), 4000));
  const key = normalizeAgentKey(opts.agentKey);
  const status = scratchpadStatus(db, vaultId, key);
  const lines = [
    'Scratchpad is a work journal (use it, do not wait to be asked): jot liberally mid-task with `cascade-scratchpad jot [--kind observation|outcome|dead-end|decision|todo] [--text "…"]` — especially dead ends; do not save jots for the final reply. Before a final reply on a non-trivial fix, still ensure you jotted the root cause or fix path if a future you would re-derive it. When stuck on something familiar: `cascade-scratchpad recall <query>` (empty = nothing relevant; prefer skills over auto-run dumps). After applying a hit: `cascade-scratchpad outcome <title> --win|--loss`. Unfinished intent: `cascade-scratchpad open` / `close <id>` (boot lists open threads).',
    `Journal: ${status.unconsolidated} unconsolidated entr${status.unconsolidated === 1 ? 'y' : 'ies'}${status.lastConsolidationAt ? `; last consolidation ${status.lastConsolidationAt}` : ''}; open threads: ${status.openThreads}.`,
  ];
  if (isConsolidationDue(status)) {
    lines.push('Consolidation is due: after the user\'s task is done, distill the journal into memory notes / skills per your POLICIES (or delegate), then `cascade-scratchpad done --through <id>`. Do not leave the backlog for "later".');
  }
  // Open threads go high in the injection — they are the intentional trail for
  // "continue / what's left", not something to mine from journal chrono.
  try {
    const openParams: unknown[] = key ? [vaultId, key] : [vaultId];
    const openRows = db.prepare(`
      SELECT * FROM agent_open_threads
      WHERE vault_id = ? ${key ? 'AND agent_key = ?' : ''} AND closed_at IS NULL
      ORDER BY id DESC
      LIMIT ?
    `).all(...openParams, BOOT_OPEN_THREADS) as OpenThreadRow[];
    if (openRows.length) {
      const more = status.openThreads > openRows.length
        ? ` (+${status.openThreads - openRows.length} more — cascade-scratchpad open)`
        : '';
      const threadLines = openRows.map((r) => `  - ${formatOpenThreadLine(toOpenThread(r))}`);
      lines.push(
        `Open threads${more} (continue these or close — stale is worse than empty):\n${threadLines.join('\n')}`,
      );
    }
  } catch { /* open threads listing is best-effort */ }
  if (opts.userId != null) {
    try {
      const skills = listSkillNotes(db, opts.userId, vaultId, key).slice(0, 8);
      if (skills.length) {
        const skillLines = skills.map((s) => {
          const record = formatWinRecord(s.stats);
          return `  - [[${s.title}]]${s.shared ? ' [shared]' : ''} — ${s.description}${record ? ` (${record})` : ''}`;
        });
        lines.push(`Skills (read the full note with \`cascade-note get <title>\` before applying):\n${skillLines.join('\n')}`);
      }
    } catch { /* skills listing is best-effort */ }
  }
  const note = policiesNote(db, vaultId, key);
  if (note) {
    const body = note.content.replace(/\s+/g, ' ').trim();
    const budget = maxChars - lines.join('\n').length - 24;
    if (budget > 120) lines.push(`Your POLICIES note: ${body.slice(0, budget)}`);
  }
  return lines.join('\n');
}

