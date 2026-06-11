import path from 'node:path';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';

const PORT = Number(process.env.API_PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'netaris-dev-secret';
const DB_PATH = process.env.DOCS_DB_PATH || path.join(process.cwd(), 'docs.db');

type User = { id: number; username: string; password_hash: string; created_at: string };
type Doc = { id: number; title: string; content: string; creator_id: number; created_at: string; updated_at: string };
type AuthedRequest = Request & { user?: { id: number; username: string } };

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sidebar_items (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, doc_id)
  );
`);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));

function signToken(user: { id: number; username: string }) {
  return jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
}

function publicUser(user: { id: number; username: string }) {
  return { id: user.id, username: user.username };
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; username: string };
    req.user = { id: decoded.id, username: decoded.username };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function getDocForUser(docId: number, userId: number) {
  return db.prepare(`
    SELECT d.id, d.title, d.content, d.creator_id, d.created_at, d.updated_at, u.username AS creator_username
    FROM docs d
    JOIN users u ON u.id = d.creator_id
    WHERE d.id = ?
  `).get(docId) as (Doc & { creator_username: string }) | undefined;
}

function ensureSidebarItem(userId: number, docId: number) {
  const maxPosition = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM sidebar_items WHERE user_id = ?').get(userId) as { next: number };
  db.prepare('INSERT OR IGNORE INTO sidebar_items (user_id, doc_id, position) VALUES (?, ?, ?)').run(userId, docId, maxPosition.next);
}

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/register', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 lowercase letters, numbers, or underscores' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
    const user = { id: Number(result.lastInsertRowid), username };
    res.status(201).json({ user: publicUser(user), token: signToken(user) });
  } catch {
    res.status(409).json({ error: 'Username is already taken' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  res.json({ user: publicUser(user), token: signToken(user) });
});

app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

app.get('/api/docs', requireAuth, (req: AuthedRequest, res) => {
  const docs = db.prepare(`
    SELECT d.id, d.title, d.creator_id, d.updated_at, u.username AS creator_username
    FROM sidebar_items s
    JOIN docs d ON d.id = s.doc_id
    JOIN users u ON u.id = d.creator_id
    WHERE s.user_id = ?
    ORDER BY s.position ASC, d.updated_at DESC
  `).all(req.user!.id);
  res.json({ docs });
});

app.post('/api/docs', requireAuth, (req: AuthedRequest, res) => {
  const title = String(req.body.title || 'Untitled').trim() || 'Untitled';
  const content = String(req.body.content || '');
  const result = db.prepare('INSERT INTO docs (title, content, creator_id) VALUES (?, ?, ?)').run(title, content, req.user!.id);
  const docId = Number(result.lastInsertRowid);
  ensureSidebarItem(req.user!.id, docId);
  res.status(201).json({ doc: getDocForUser(docId, req.user!.id) });
});

app.get('/api/docs/:id', requireAuth, (req: AuthedRequest, res) => {
  const docId = Number(req.params.id);
  const doc = getDocForUser(docId, req.user!.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  ensureSidebarItem(req.user!.id, docId);
  res.json({ doc, canEdit: doc.creator_id === req.user!.id });
});

app.patch('/api/docs/:id', requireAuth, (req: AuthedRequest, res) => {
  const docId = Number(req.params.id);
  const doc = getDocForUser(docId, req.user!.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.creator_id !== req.user!.id) return res.status(403).json({ error: 'Only the creator can edit this document' });

  const title = String(req.body.title ?? doc.title).trim() || 'Untitled';
  const content = String(req.body.content ?? doc.content);
  db.prepare('UPDATE docs SET title = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(title, content, docId);
  res.json({ doc: getDocForUser(docId, req.user!.id) });
});

app.delete('/api/docs/:id', requireAuth, (req: AuthedRequest, res) => {
  const docId = Number(req.params.id);
  const doc = getDocForUser(docId, req.user!.id);
  if (!doc) return res.status(404).json({ error: 'Document not found' });
  if (doc.creator_id !== req.user!.id) return res.status(403).json({ error: 'Only the creator can delete this document' });
  db.prepare('DELETE FROM docs WHERE id = ?').run(docId);
  res.json({ ok: true });
});

app.post('/api/sidebar/reorder', requireAuth, (req: AuthedRequest, res) => {
  const ids = Array.isArray(req.body.docIds) ? req.body.docIds.map(Number).filter(Number.isFinite) : [];
  const update = db.prepare('UPDATE sidebar_items SET position = ? WHERE user_id = ? AND doc_id = ?');
  const tx = db.transaction((docIds: number[]) => {
    docIds.forEach((docId, index) => update.run(index, req.user!.id, docId));
  });
  tx(ids);
  res.json({ ok: true });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Docs API running on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
