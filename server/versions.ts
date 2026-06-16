/**
 * @file versions.ts — Note version history and diffing
 *
 * Tracks snapshots of note content over time, enabling undo / compare workflows.
 * Each snapshot carries an optional label (manual, auto, ai-edit, etc.) and is
 * stored in the `note_versions` table (schema created in index.ts).
 *
 * Diffing uses a custom LCS-based unified-diff implementation — no external
 * diff library is required.
 *
 * @module server/versions
 */

import type Database from 'better-sqlite3';

type Db = Database.Database;

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

export type NoteVersion = {
  id: string;
  note_id: string;
  content: string;
  label: string | null;
  created_at: string;
};

export type NoteVersionSummary = {
  id: string;
  note_id: string;
  label: string | null;
  created_at: string;
};

// ═══════════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════════

/**
 * Ensures the note_versions table exists.
 * Schema is now created in index.ts — this hook is kept for potential future migrations.
 */
export function ensureVersionsSchema(_db: Db) {
  // no-op — schema lives in index.ts
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

/**
 * Creates a new version snapshot for a note.
 *
 * Labels are validated against a whitelist; unrecognized labels are
 * discarded (set to null) to prevent arbitrary strings from leaking in.
 *
 * @param db      - SQLite database instance
 * @param noteId  - ID of the note to snapshot
 * @param content - Full markdown content at this point in time
 * @param label   - Optional label: 'manual' | 'auto' | 'ai-edit' | 'pre-ai' | 'save' | 'created'
 * @returns The created NoteVersion row, or undefined on failure
 */
export function createNoteVersion(db: Db, noteId: string, content: string, label?: string): NoteVersion | undefined {
  const id = crypto.randomUUID();
  const validLabels = ['manual', 'auto', 'ai-edit', 'pre-ai', 'save', 'created'];
  // Fixed: invalid labels are now correctly discarded (set to null) instead of
  // passing through. The previous expression was a no-op for invalid labels.
  const safeLabel = label && validLabels.includes(label) ? label : null;
  db.prepare(
    'INSERT INTO note_versions (id, note_id, content, label) VALUES (?, ?, ?, ?)'
  ).run(id, noteId, content, safeLabel);
  return db.prepare('SELECT * FROM note_versions WHERE id = ?').get(id) as NoteVersion | undefined;
}

/**
 * Lists all version snapshots for a note, newest first (metadata only, no content).
 *
 * @param db     - SQLite database instance
 * @param noteId - ID of the note
 * @returns Array of version summaries ordered by created_at DESC
 */
export function listNoteVersions(db: Db, noteId: string): NoteVersionSummary[] {
  return db.prepare(`
    SELECT id, note_id, label, created_at
    FROM note_versions
    WHERE note_id = ?
    ORDER BY created_at DESC
  `).all(noteId) as NoteVersionSummary[];
}

/**
 * Retrieves a single version snapshot including its full content.
 *
 * @param db - SQLite database instance
 * @param id - Version ID
 * @returns The NoteVersion row, or undefined if not found
 */
export function getNoteVersion(db: Db, id: string): NoteVersion | undefined {
  return db.prepare('SELECT * FROM note_versions WHERE id = ?').get(id) as NoteVersion | undefined;
}

/**
 * Generates a unified diff between two stored version snapshots.
 *
 * @param db     - SQLite database instance
 * @param fromId - Version ID for the "before" side
 * @param toId   - Version ID for the "after" side
 * @returns Unified diff string, or undefined if either version is missing
 */
export function diffNoteVersions(db: Db, fromId: string, toId: string) {
  const from = getNoteVersion(db, fromId);
  const to = getNoteVersion(db, toId);
  if (!from || !to) return undefined;
  return diffText(from.content, to.content, `version-${from.id.slice(0, 8)}`, `version-${to.id.slice(0, 8)}`);
}

/**
 * Generates a unified diff between two arbitrary text strings.
 *
 * @param from      - The "before" text
 * @param to        - The "after" text
 * @param fromLabel - Header label for the "before" side (default: 'before')
 * @param toLabel   - Header label for the "after" side (default: 'after')
 * @returns Unified diff string with --- / +++ headers
 */
export function diffText(from: string, to: string, fromLabel = 'before', toLabel = 'after') {
  return unifiedDiff(from, to, fromLabel, toLabel);
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL — LCS DIFF
// ═══════════════════════════════════════════════════════════════

/**
 * Produces a unified diff between two texts using the Longest Common
 * Subsequence (LCS) algorithm.
 *
 * Algorithm:
 * 1. Split both texts into line arrays `a` and `b`.
 * 2. Build a 2D LCS table via {@link buildLcsTable} where `table[i][j]`
 *    holds the length of the LCS of `a[i..]` and `b[j..]`.
 * 3. Walk both arrays simultaneously using the table as a guide:
 *    - If `a[i] === b[j]`, emit an unchanged context line and advance both.
 *    - If `table[i+1][j] >= table[i][j+1]`, emit a deletion (`-a[i]`) and advance `i`.
 *    - Otherwise emit an addition (`+b[j]`) and advance `j`.
 * 4. Flush any remaining lines from either side as additions or deletions.
 */
function unifiedDiff(from: string, to: string, fromLabel: string, toLabel: string) {
  const a = from.split(/\r?\n/);
  const b = to.split(/\r?\n/);
  const table = buildLcsTable(a, b);
  const lines: string[] = [`--- ${fromLabel}`, `+++ ${toLabel}`, '@@'];

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push(`-${a[i]}`);
      i += 1;
    } else {
      lines.push(`+${b[j]}`);
      j += 1;
    }
  }
  while (i < a.length) lines.push(`-${a[i++]}`);
  while (j < b.length) lines.push(`+${b[j++]}`);
  return lines.join('\n');
}

/**
 * Builds the LCS length table used by {@link unifiedDiff}.
 *
 * Returns a 2D array where `table[i][j]` = length of the longest common
 * subsequence of `a[i..]` and `b[j..]`. Filled bottom-up so the diff
 * walker can read it top-down.
 */
function buildLcsTable(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}
