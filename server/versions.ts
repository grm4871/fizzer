import type Database from 'better-sqlite3';

type Db = Database.Database;

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

/**
 * Schema is now created in index.ts (note_versions table).
 * This hook is kept for potential future migrations.
 */
export function ensureVersionsSchema(_db: Db) {
  // no-op — schema lives in index.ts
}

export function createNoteVersion(db: Db, noteId: string, content: string, label?: string): NoteVersion | undefined {
  const id = crypto.randomUUID();
  const validLabels = ['manual', 'auto', 'ai-edit', 'pre-ai', 'save', 'created'];
  const safeLabel = label && validLabels.includes(label) ? label : label || null;
  db.prepare(
    'INSERT INTO note_versions (id, note_id, content, label) VALUES (?, ?, ?, ?)'
  ).run(id, noteId, content, safeLabel);
  return db.prepare('SELECT * FROM note_versions WHERE id = ?').get(id) as NoteVersion | undefined;
}

export function listNoteVersions(db: Db, noteId: string): NoteVersionSummary[] {
  return db.prepare(`
    SELECT id, note_id, label, created_at
    FROM note_versions
    WHERE note_id = ?
    ORDER BY created_at DESC
  `).all(noteId) as NoteVersionSummary[];
}

export function getNoteVersion(db: Db, id: string): NoteVersion | undefined {
  return db.prepare('SELECT * FROM note_versions WHERE id = ?').get(id) as NoteVersion | undefined;
}

export function diffNoteVersions(db: Db, fromId: string, toId: string) {
  const from = getNoteVersion(db, fromId);
  const to = getNoteVersion(db, toId);
  if (!from || !to) return undefined;
  return diffText(from.content, to.content, `version-${from.id.slice(0, 8)}`, `version-${to.id.slice(0, 8)}`);
}

export function diffText(from: string, to: string, fromLabel = 'before', toLabel = 'after') {
  return unifiedDiff(from, to, fromLabel, toLabel);
}

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

function buildLcsTable(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () => Array.from({ length: b.length + 1 }, () => 0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}
