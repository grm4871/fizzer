import path from 'node:path';
import http from 'node:http';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';
import {
  createSpecFile,
  createWorkspace,
  ensureWorkspaceSchema,
  getSpec,
  getWorkspace,
  listAllWorkspaces,
  listSpecs,
  listWorkspaces,
  readSpecFile,
  scanWorkspace,
  watchWorkspace,
  writeSpecFile,
} from './server/workspace.js';
import {
  createSpecVersion,
  diffText,
  diffVersions,
  ensureVersionsSchema,
  listSpecVersions,
} from './server/versions.js';
import {
  addThreadMessage,
  createThread,
  ensureThreadsSchema,
  getThread,
  listThreads,
  setThreadStatus,
} from './server/threads.js';
import {
  discardRun,
  ensureRunnerSchema,
  getRun,
  getRunDiff,
  listRunEvents,
  listRuns,
  mergeRun,
  sendRunMessage,
  setRunEventSink,
  startRun,
} from './server/runner.js';

const PORT = Number(process.env.API_PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'cascade-dev-secret';
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
ensureWorkspaceSchema(db);
ensureVersionsSchema(db);
ensureRunnerSchema(db);
ensureThreadsSchema(db);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: true, credentials: true } });
const runsNamespace = io.of('/runs');
const workspaceWatchers = new Map<number, () => void>();

setRunEventSink((event) => {
  runsNamespace.to(`run:${event.run_id}`).emit('event', event);
  if (event.type === 'status') {
    const payload = safeJson(event.payload_json) as { status?: string };
    runsNamespace.to(`run:${event.run_id}`).emit('status', { runId: event.run_id, status: payload.status });
  }
});

for (const workspace of listAllWorkspaces(db)) registerWorkspaceWatcher(workspace);

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

runsNamespace.use((socket, next) => {
  const token = typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : null;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; username: string };
    socket.data.user = { id: decoded.id, username: decoded.username };
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
});

runsNamespace.on('connection', (socket) => {
  socket.on('join', (runId: number) => {
    const id = Number(runId);
    const run = Number.isFinite(id) ? getRun(db, id) : undefined;
    if (run && canAccessRun(run.spec_id, socket.data.user.id)) socket.join(`run:${id}`);
  });
  socket.on('leave', (runId: number) => {
    if (Number.isFinite(Number(runId))) socket.leave(`run:${Number(runId)}`);
  });
  socket.on('joinWorkspace', (workspaceId: number) => {
    const workspace = getWorkspace(db, Number(workspaceId), socket.data.user.id);
    if (workspace) socket.join(`workspace:${workspace.id}`);
  });
  socket.on('leaveWorkspace', (workspaceId: number) => {
    if (Number.isFinite(Number(workspaceId))) socket.leave(`workspace:${Number(workspaceId)}`);
  });
});

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

app.get('/api/workspaces', requireAuth, (req: AuthedRequest, res) => {
  res.json({ workspaces: listWorkspaces(db, req.user!.id) });
});

app.post('/api/workspaces', requireAuth, (req: AuthedRequest, res) => {
  try {
    const workspace = createWorkspace(db, req.user!.id, req.body || {});
    registerWorkspaceWatcher(workspace);
    res.status(201).json({ workspace });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create workspace' });
  }
});

app.post('/api/workspaces/:id/rescan', requireAuth, (req: AuthedRequest, res) => {
  const workspace = getWorkspace(db, Number(req.params.id), req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  registerWorkspaceWatcher(workspace);
  res.json({ specs: scanWorkspace(db, workspace) });
});

app.get('/api/workspaces/:id/specs', requireAuth, (req: AuthedRequest, res) => {
  const workspace = getWorkspace(db, Number(req.params.id), req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  res.json({ specs: listSpecs(db, workspace.id) });
});

app.post('/api/workspaces/:id/specs', requireAuth, (req: AuthedRequest, res) => {
  const workspace = getWorkspace(db, Number(req.params.id), req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  try {
    const spec = createSpecFile(db, workspace, req.body || {});
    if (!spec) return res.status(500).json({ error: 'Spec was created but could not be read' });
    createSpecVersion(db, spec.id, spec.content, 'created');
    res.status(201).json({ spec });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create spec' });
  }
});

app.get('/api/specs/:id', requireAuth, (req: AuthedRequest, res) => {
  const spec = readSpecFile(db, req.params.id);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, spec.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });
  res.json({ spec, canEdit: true });
});

app.put('/api/specs/:id', requireAuth, (req: AuthedRequest, res) => {
  const existing = readSpecFile(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, existing.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });

  const content = String(req.body.content ?? existing.content);
  const spec = writeSpecFile(db, req.params.id, content);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  createSpecVersion(db, spec.id, spec.content, 'save');
  res.json({ spec });
});

app.get('/api/specs/:id/versions', requireAuth, (req: AuthedRequest, res) => {
  const spec = getSpec(db, req.params.id);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, spec.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });
  res.json({ versions: listSpecVersions(db, spec.id) });
});

app.get('/api/specs/:id/diff', requireAuth, (req: AuthedRequest, res) => {
  const spec = readSpecFile(db, req.params.id);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, spec.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });

  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (Number.isFinite(from) && Number.isFinite(to)) {
    const diff = diffVersions(db, from, to);
    if (!diff) return res.status(404).json({ error: 'Version not found' });
    return res.json({ diff });
  }

  const versions = listSpecVersions(db, spec.id) as { id: number }[];
  const latest = versions[0]?.id;
  if (!latest) return res.json({ diff: diffText('', spec.content, 'empty', spec.rel_path) });
  const latestVersion = db.prepare('SELECT content FROM spec_versions WHERE id = ?').get(latest) as { content: string } | undefined;
  res.json({ diff: diffText(latestVersion?.content || '', spec.content, `version-${latest}`, spec.rel_path) });
});

app.get('/api/specs/:id/runs', requireAuth, (req: AuthedRequest, res) => {
  const spec = getSpec(db, req.params.id);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, spec.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });
  res.json({ runs: listRuns(db, spec.id) });
});

app.post('/api/specs/:id/runs', requireAuth, async (req: AuthedRequest, res) => {
  const spec = getSpec(db, req.params.id);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, spec.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });

  try {
    const kind = req.body?.kind === 'describe' ? 'describe' : 'reconcile';
    const run = await startRun(db, workspace, spec.id, kind);
    res.status(201).json({ run });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not start run' });
  }
});

app.get('/api/runs/:id', requireAuth, (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!canAccessRun(run.spec_id, req.user!.id)) return res.status(404).json({ error: 'Run not found' });
  res.json({ run });
});

app.get('/api/runs/:id/events', requireAuth, (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!canAccessRun(run.spec_id, req.user!.id)) return res.status(404).json({ error: 'Run not found' });
  res.json({ events: listRunEvents(db, run.id) });
});

app.get('/api/runs/:id/diff', requireAuth, async (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!canAccessRun(run.spec_id, req.user!.id)) return res.status(404).json({ error: 'Run not found' });
  res.json({ diff: await getRunDiff(db, run.id) });
});

app.post('/api/runs/:id/merge', requireAuth, async (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!canAccessRun(run.spec_id, req.user!.id)) return res.status(404).json({ error: 'Run not found' });
  try {
    res.json({ run: await mergeRun(db, run.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not merge run' });
  }
});

app.post('/api/runs/:id/discard', requireAuth, async (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!canAccessRun(run.spec_id, req.user!.id)) return res.status(404).json({ error: 'Run not found' });
  try {
    res.json({ run: await discardRun(db, run.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not discard run' });
  }
});

app.post('/api/runs/:id/message', requireAuth, async (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!canAccessRun(run.spec_id, req.user!.id)) return res.status(404).json({ error: 'Run not found' });
  try {
    const event = await sendRunMessage(db, run.id, String(req.body.message || ''));
    res.status(201).json({ event });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not send message' });
  }
});

app.get('/api/specs/:id/threads', requireAuth, (req: AuthedRequest, res) => {
  const spec = getSpec(db, req.params.id);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, spec.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });
  res.json({ threads: listThreads(db, spec.id) });
});

app.post('/api/specs/:id/threads', requireAuth, (req: AuthedRequest, res) => {
  const spec = getSpec(db, req.params.id);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  const workspace = getWorkspace(db, spec.workspace_id, req.user!.id);
  if (!workspace) return res.status(404).json({ error: 'Spec not found' });
  try {
    res.status(201).json({ thread: createThread(db, spec.id, req.body || {}) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create thread' });
  }
});

app.post('/api/threads/:id/messages', requireAuth, (req: AuthedRequest, res) => {
  const thread = getThread(db, Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  if (!canAccessThread(thread.spec_id, req.user!.id)) return res.status(404).json({ error: 'Thread not found' });
  try {
    res.status(201).json({ thread: addThreadMessage(db, thread.id, String(req.body.role || 'user'), String(req.body.content || '')) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add message' });
  }
});

app.post('/api/threads/:id/resolve', requireAuth, (req: AuthedRequest, res) => {
  const thread = getThread(db, Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  if (!canAccessThread(thread.spec_id, req.user!.id)) return res.status(404).json({ error: 'Thread not found' });
  res.json({ thread: setThreadStatus(db, thread.id, 'resolved') });
});

app.post('/api/threads/:id/dismiss', requireAuth, (req: AuthedRequest, res) => {
  const thread = getThread(db, Number(req.params.id));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  if (!canAccessThread(thread.spec_id, req.user!.id)) return res.status(404).json({ error: 'Thread not found' });
  res.json({ thread: setThreadStatus(db, thread.id, 'dismissed') });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

function canAccessRun(specId: string, userId: number) {
  const row = db.prepare(`
    SELECT w.id
    FROM specs s
    JOIN workspaces w ON w.id = s.workspace_id
    WHERE s.id = ? AND w.created_by = ?
  `).get(specId, userId);
  return Boolean(row);
}

function canAccessThread(specId: string, userId: number) {
  return canAccessRun(specId, userId);
}

function safeJson(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function registerWorkspaceWatcher(workspace: { id: number; name: string; repo_path: string; specs_dir: string; created_by: number; created_at: string }) {
  workspaceWatchers.get(workspace.id)?.();
  workspaceWatchers.set(workspace.id, watchWorkspace(db, workspace, (changed) => {
    runsNamespace.to(`workspace:${changed.id}`).emit('workspace:changed', { workspaceId: changed.id });
  }));
}

httpServer.listen(PORT, () => {
  console.log(`Docs API running on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
