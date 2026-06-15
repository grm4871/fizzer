import type Database from 'better-sqlite3';

type Db = Database.Database;

export type Thread = {
  id: number;
  spec_id: string;
  anchor: string;
  status: 'open' | 'resolved' | 'dismissed';
  run_id: number | null;
  created_at: string;
  updated_at: string;
};

export function ensureThreadsSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
      anchor TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      run_id INTEGER REFERENCES runs(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export function listThreads(db: Db, specId: string) {
  const threads = db.prepare('SELECT * FROM threads WHERE spec_id = ? ORDER BY updated_at DESC, id DESC').all(specId) as Thread[];
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC');
  return threads.map((thread) => ({ ...thread, messages: messages.all(thread.id) }));
}

export function createThread(db: Db, specId: string, input: { anchor?: unknown; content?: unknown; role?: unknown; run_id?: unknown }) {
  const result = db.prepare('INSERT INTO threads (spec_id, anchor, run_id) VALUES (?, ?, ?)').run(
    specId,
    String(input.anchor || ''),
    Number.isFinite(Number(input.run_id)) ? Number(input.run_id) : null,
  );
  const threadId = Number(result.lastInsertRowid);
  addThreadMessage(db, threadId, String(input.role || 'user'), String(input.content || ''));
  return getThread(db, threadId);
}

export function getThread(db: Db, id: number) {
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Thread | undefined;
  if (!thread) return undefined;
  const messages = db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC').all(thread.id);
  return { ...thread, messages };
}

export function addThreadMessage(db: Db, threadId: number, role: string, content: string) {
  const text = content.trim();
  if (!text) throw new Error('Message cannot be empty');
  db.prepare('INSERT INTO thread_messages (thread_id, role, content) VALUES (?, ?, ?)').run(threadId, normalizeRole(role), text);
  db.prepare('UPDATE threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(threadId);
  return getThread(db, threadId);
}

export function setThreadStatus(db: Db, threadId: number, status: 'open' | 'resolved' | 'dismissed') {
  db.prepare('UPDATE threads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, threadId);
  return getThread(db, threadId);
}

function normalizeRole(role: string) {
  return role === 'agent' || role === 'system' ? role : 'user';
}
