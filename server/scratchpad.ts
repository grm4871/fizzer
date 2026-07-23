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
 */

import type Database from 'better-sqlite3';
import { createNote, getVault, type Note } from './vault.js';
import { ensureAgentNamedMemoryFolders } from './evolution.js';

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
- Finish by marking entries consolidated: \`cascade-scratchpad done --through <id>\`.

## Promotion / demotion

- INDEX holds one-line pointers, most useful first. Trim pointers that stopped
  earning recall; the notes remain searchable without them.
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
  opts: { agentKey?: string; maxChars?: number } = {},
): string {
  const maxChars = Math.max(300, Math.min(Number(opts.maxChars || 1400), 4000));
  const key = normalizeAgentKey(opts.agentKey);
  const status = scratchpadStatus(db, vaultId, key);
  const lines = [
    'Scratchpad: append work notes with `cascade-scratchpad jot [--kind observation|outcome|dead-end|decision|todo] <text>` — cheap, append-only; they get consolidated into memory notes later. Jot dead ends and surprises especially.',
    `Journal: ${status.unconsolidated} unconsolidated entr${status.unconsolidated === 1 ? 'y' : 'ies'}${status.lastConsolidationAt ? `; last consolidation ${status.lastConsolidationAt}` : ''}.`,
  ];
  if (isConsolidationDue(status)) {
    lines.push('Consolidation is due: after the user\'s task is done, distill the journal into memory notes per your POLICIES (or delegate this to a subagent), then run `cascade-scratchpad done --through <id>`.');
  }
  const note = policiesNote(db, vaultId, key);
  if (note) {
    const body = note.content.replace(/\s+/g, ' ').trim();
    const budget = maxChars - lines.join('\n').length - 24;
    if (budget > 120) lines.push(`Your POLICIES note: ${body.slice(0, budget)}`);
  }
  return lines.join('\n');
}

