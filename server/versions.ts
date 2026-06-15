type Db = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number };
  };
};

export type SpecVersion = {
  id: number;
  spec_id: string;
  content: string;
  label: string | null;
  created_at: string;
};

export function ensureVersionsSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS spec_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function createSpecVersion(db: Db, specId: string, content: string, label?: string) {
  const result = db.prepare('INSERT INTO spec_versions (spec_id, content, label) VALUES (?, ?, ?)').run(specId, content, label || null);
  return getSpecVersion(db, Number(result.lastInsertRowid));
}

export function listSpecVersions(db: Db, specId: string) {
  return db.prepare(`
    SELECT id, spec_id, label, created_at
    FROM spec_versions
    WHERE spec_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(specId);
}

export function getSpecVersion(db: Db, id: number) {
  return db.prepare('SELECT * FROM spec_versions WHERE id = ?').get(id) as SpecVersion | undefined;
}

export function diffVersions(db: Db, fromId: number, toId: number) {
  const from = getSpecVersion(db, fromId);
  const to = getSpecVersion(db, toId);
  if (!from || !to) return undefined;
  return unifiedDiff(from.content, to.content, `version-${from.id}`, `version-${to.id}`);
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
