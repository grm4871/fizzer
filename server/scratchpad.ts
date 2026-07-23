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
 * On top of the journal, three learning-loop extensions (all agent-driven):
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
 */

import type Database from 'better-sqlite3';
import { createFolder, createNote, getNote, getVault, moveNote, updateNote, type Note } from './vault.js';
import { ensureAgentMemoryFolders, ensureAgentNamedMemoryFolders } from './evolution.js';

type Db = Database.Database;

export const JOURNAL_KINDS = ['observation', 'outcome', 'dead-end', 'decision', 'todo'] as const;
export type JournalKind = typeof JOURNAL_KINDS[number];

const POLICIES_TITLE = 'POLICIES';
const MAX_BODY_CHARS = 4000;

// "Consolidation due" thresholds for the boot-injection nudge (env-tunable).
const DUE_MIN_ENTRIES = Math.max(1, Number(process.env.SCRATCHPAD_DUE_ENTRIES || 10));
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
  `);
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
  return {
    agentKey: key,
    unconsolidated: row?.n ?? 0,
    oldestUnconsolidatedAt: row?.oldest ?? null,
    lastConsolidationAt: state?.last_consolidation_at ?? null,
  };
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

/** Resolve a note by id or title (case-insensitive) within a vault. */
function resolveNoteRef(db: Db, vaultId: string, ref: string): Note | undefined {
  const trimmed = String(ref || '').trim();
  if (!trimmed) return undefined;
  const byId = getNote(db, trimmed);
  if (byId && byId.vault_id === vaultId) return byId;
  const byTitle = db.prepare(`
    SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE LIMIT 1
  `).get(vaultId, trimmed) as { id: string } | undefined;
  return byTitle ? getNote(db, byTitle.id) : undefined;
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
    SELECT id FROM notes WHERE vault_id = ? AND folder_id = ? AND title = ? COLLATE NOCASE
  `).get(vault.id, skillsId, title) as { id: string } | undefined;
  if (existing) {
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
    SELECT n.id, n.title, n.content, n.folder_id,
           s.uses AS uses, s.wins AS wins, s.losses AS losses
    FROM notes n
    LEFT JOIN scratchpad_note_stats s ON s.note_id = n.id
    WHERE n.vault_id = ? AND n.folder_id IN (${placeholders}) AND n.is_archived = 0
    ORDER BY COALESCE(s.wins, 0) - COALESCE(s.losses, 0) DESC, n.updated_at DESC
  `).all(vault.id, ...folders.map((f) => f.id)) as Array<{
    id: string; title: string; content: string; folder_id: string;
    uses: number | null; wins: number | null; losses: number | null;
  }>;
  const sharedIds = new Set(folders.filter((f) => f.shared).map((f) => f.id));
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: skillDescription(row.content),
    shared: sharedIds.has(row.folder_id),
    ...(row.uses != null
      ? { stats: { uses: row.uses, wins: row.wins || 0, losses: row.losses || 0 } }
      : {}),
  }));
}

export type OutcomeResult = 'win' | 'loss' | 'neutral';

/** Record that a remembered note/skill was applied and how it went. */
export function recordNoteOutcome(
  db: Db,
  userId: number,
  vaultId: string,
  input: { noteRef: string; result: OutcomeResult },
): { noteId: string; title: string; uses: number; wins: number; losses: number } {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const note = resolveNoteRef(db, vault.id, input.noteRef);
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
  input: { noteRef: string },
): { note: Note; kind: 'memory' | 'skill' } {
  const vault = getVault(db, vaultId, userId);
  if (!vault) throw new Error('Vault not found');
  const note = resolveNoteRef(db, vault.id, input.noteRef);
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

## Consolidation (when the boot context says it is due)

- You do this yourself — no external process will. When the journal backlog is
  flagged as due, consolidate after finishing the user's actual task (or
  delegate it to a subagent so it doesn't cost the main thread focus).
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
  const maxChars = Math.max(300, Math.min(Number(opts.maxChars || 1400), 4000));
  const key = normalizeAgentKey(opts.agentKey);
  const status = scratchpadStatus(db, vaultId, key);
  const lines = [
    'Scratchpad: append work notes with `cascade-scratchpad jot [--kind observation|outcome|dead-end|decision|todo] <text>` — cheap, append-only; they get consolidated into memory notes later. Jot dead ends and surprises especially. After applying a remembered note or skill, report `cascade-scratchpad outcome <title> --win|--loss`.',
    `Journal: ${status.unconsolidated} unconsolidated entr${status.unconsolidated === 1 ? 'y' : 'ies'}${status.lastConsolidationAt ? `; last consolidation ${status.lastConsolidationAt}` : ''}.`,
  ];
  if (isConsolidationDue(status)) {
    lines.push('Consolidation is due: after the user\'s task is done, distill the journal into memory notes per your POLICIES (or delegate this to a subagent), then run `cascade-scratchpad done --through <id>`.');
  }
  if (opts.userId != null) {
    try {
      const skills = listSkillNotes(db, opts.userId, vaultId, key).slice(0, 8);
      if (skills.length) {
        const skillLines = skills.map((s) => {
          const stats = s.stats && s.stats.uses > 0 ? ` (won ${s.stats.wins}/${s.stats.uses})` : '';
          return `  - [[${s.title}]]${s.shared ? ' [shared]' : ''} — ${s.description}${stats}`;
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

