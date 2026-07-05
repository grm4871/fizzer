/**
 * @file index.ts — Express server entry point
 *
 * Starts the REST API and Socket.IO server namespaces (/runs and /vault) to orchestrate
 * user authentication, vaults, folders, notes, tagging, versions, and agent run sessions.
 *
 * Section Markers are used below to separate route namespaces and socket setup.
 *
 * @module index
 */

import path from 'node:path';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';
import {
  addTag,
  createFolder,
  createNote,
  createVault,
  deleteFolder,
  deleteNote,
  ensureVaultSchema,
  getBacklinks,
  getGraph,
  getNote,
  getVault,
  listFolders,
  listNotes,
  listTags,
  listVaults,
  moveNote,
  removeTag,
  renameNote,
  searchNotes,
  toggleArchive,
  togglePin,
  updateFolder,
  updateNote,
} from './server/vault.js';
import {
  createNoteVersion,
  diffNoteVersions,
  diffText,
  ensureVersionsSchema,
  listNoteVersions,
} from './server/versions.js';
import {
  ensureRunnerSchema,
  setRunEventSink,
  setChatSyncSink,
  listRuns,
  getRun,
  listRunEvents,
  startRun,
  cancelRun,
  findPriorSession,
  publishRunEvent,
  finishDelegatedRun,
  type AgentId,
} from './server/runner.js';
import {
  delegateRunToDesktop,
  getDesktopRunnerStatus,
  initDesktopRunners,
  waitForDesktopRunner,
} from './server/desktop-runner.js';
import {
  ensureFeedSchema,
  fetchFeed,
  pollWidgetFeeds,
  setFeedNotifySink,
  startFeedPoller,
} from './server/feeds.js';
import { fetchWidgetData } from './server/widgetData.js';
import { resolveDeploySecret } from './server/security.js';
import {
  buildAgentChatContentFromRunEvents,
  ensureChatSchema,
  listChatMessages,
  createChatMessage,
  updateChatMessage,
  settleChatMessagesForRun,
  listChatAgentMembers,
  upsertChatAgentMember,
  removeChatAgentMember,
} from './server/chat.js';
import {
  ensurePublishSchema,
  getPublishInfo,
  publishNote,
  unpublishNote,
  publicBaseUrl,
  serveOembed,
  servePublicNoteJson,
  servePublicNotePage,
} from './server/publish.js';
import { deleteNoteAssets, serveNoteAsset, uploadNoteAsset } from './server/noteAssets.js';

const PORT = Number(process.env.API_PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'cascade-dev-secret';
const DB_PATH = process.env.DOCS_DB_PATH || path.join(process.cwd(), 'docs.db');

// Deploy trigger: the server runs inside the container and cannot run docker /
// nginx / certbot itself, so the endpoint only drops a request file into the
// shared data volume. A host-side watcher (deploy/deploy-watcher.sh) picks it up
// and runs deploy/deploy.sh. See deploy/install-deploy-watcher.sh.
const DEPLOY_SECRET = resolveDeploySecret();
const DATA_DIR = process.env.CASCADE_DATA_DIR || path.dirname(DB_PATH);
const DEPLOY_REQUEST_FILE = path.join(DATA_DIR, 'deploy.request');
const DEPLOY_RESULT_FILE = path.join(DATA_DIR, 'deploy.result');
const CLIENT_DIST_DIR = path.join(process.cwd(), 'client', 'dist');
const CLIENT_APP_HTML = path.join(CLIENT_DIST_DIR, 'app.html');

type User = { id: number; username: string; password_hash: string; created_at: string };
type AuthedRequest = Request & { user?: { id: number; username: string } };

// ── Database ───────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vaults (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS folders (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    content_preview TEXT NOT NULL DEFAULT '',
    is_pinned INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    word_count INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    UNIQUE(vault_id, name)
  );

  CREATE TABLE IF NOT EXISTS note_tags (
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (note_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS note_links (
    source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    target_id TEXT,
    target_title TEXT NOT NULL,
    context TEXT,
    PRIMARY KEY (source_id, target_title)
  );

  CREATE TABLE IF NOT EXISTS note_versions (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// FTS5 virtual table
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content, content='notes', content_rowid='rowid');`);

// FTS triggers for keeping the index in sync
db.exec(`
  CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
    INSERT INTO notes_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
  END;
  CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', OLD.rowid, OLD.title, OLD.content);
  END;
  CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
    INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', OLD.rowid, OLD.title, OLD.content);
    INSERT INTO notes_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
  END;
`);

ensureVaultSchema(db);
ensureVersionsSchema(db);
ensureRunnerSchema(db);
ensureFeedSchema(db);
ensureChatSchema(db);
ensurePublishSchema(db);

// ── Express & Socket.io setup ──────────────────────────────────────

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true },
  // The desktop runner shares the Electron main-process event loop with the
  // agent it's running; a busy stream can delay heartbeat pongs. Give the
  // heartbeat generous slack so a working local runner isn't falsely declared
  // dead (which would 503 the next chat message) mid-run.
  pingInterval: 25000,
  pingTimeout: 60000,
});
const runsNamespace = io.of('/runs');
const vaultNamespace = io.of('/vault');

// ── Auth helpers ───────────────────────────────────────────────────

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

// ── Socket.io auth & namespaces ────────────────────────────────────

function socketAuth(socket: { handshake: { auth: { token?: unknown } }; data: Record<string, unknown> }, next: (err?: Error) => void) {
  const token = typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : null;
  if (!token) return next(new Error('Authentication required'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; username: string };
    socket.data.user = { id: decoded.id, username: decoded.username };
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}

runsNamespace.use(socketAuth);
vaultNamespace.use(socketAuth);

vaultNamespace.on('connection', (socket) => {
  socket.on('joinVault', (vaultId: string) => {
    const user = socket.data.user as { id: number };
    const vault = getVault(db, vaultId, user.id);
    if (vault) socket.join(`vault:${vaultId}`);
  });
  socket.on('leaveVault', (vaultId: string) => {
    socket.leave(`vault:${vaultId}`);
  });
});

runsNamespace.on('connection', (socket) => {
  socket.on('joinRun', (runId: number) => {
    socket.join(`run:${runId}`);
  });
  socket.on('leaveRun', (runId: number) => {
    socket.leave(`run:${runId}`);
  });
});

setRunEventSink((event) => {
  runsNamespace.to(`run:${event.run_id}`).emit('event', event);
});

function emitVaultEvent(vaultId: string, event: string, data: unknown) {
  vaultNamespace.to(`vault:${vaultId}`).emit(event, data);
}

setFeedNotifySink(emitVaultEvent);

// ── Server-authoritative chat streaming ─────────────────────────────
// A chat-originated run is linked to the agent's chat message. As the run
// streams, the server folds its events into that message and broadcasts the
// update, so every client (including ones that never started the run, or after
// the initiator disconnects) sees the reply. Targets live in memory for the
// run's lifetime, mirroring the in-memory desktop-runner delegation model.
type ChatRunTarget = { userId: number; vaultId: string; channelId: string; messageId: string };
const chatRunTargets = new Map<number, ChatRunTarget>();
const chatRunFlushTimers = new Map<number, NodeJS.Timeout>();
const CHAT_RUN_THROTTLE_MS = 250;

function syncRunToChatMessage(runId: number) {
  const target = chatRunTargets.get(runId);
  if (!target) return;
  const content = buildAgentChatContentFromRunEvents(listRunEvents(db, runId));
  try {
    // Update only — the initiating client creates the placeholder message; if it
    // hasn't landed yet this no-ops and a later status event retries.
    const updated = updateChatMessage(db, target.userId, target.vaultId, target.channelId, target.messageId, {
      body: content.body,
      blocks: content.blocks.length ? content.blocks : undefined,
      status: content.status,
      runId,
    });
    if (updated) {
      emitVaultEvent(target.vaultId, 'vault:chatMessageUpdated', {
        vaultId: target.vaultId,
        channelId: target.channelId,
        message: updated,
      });
    }
  } catch {
    // Channel/message vanished (e.g. deleted mid-run) — drop the target below.
  }
  if (content.done) {
    chatRunTargets.delete(runId);
    const timer = chatRunFlushTimers.get(runId);
    if (timer) clearTimeout(timer);
    chatRunFlushTimers.delete(runId);
  }
}

setChatSyncSink((runId, eventType) => {
  if (!chatRunTargets.has(runId)) return;
  // Flush final run status immediately; throttle streaming token updates.
  if (eventType === 'status') {
    const timer = chatRunFlushTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      chatRunFlushTimers.delete(runId);
    }
    syncRunToChatMessage(runId);
    return;
  }
  if (chatRunFlushTimers.has(runId)) return;
  chatRunFlushTimers.set(runId, setTimeout(() => {
    chatRunFlushTimers.delete(runId);
    syncRunToChatMessage(runId);
  }, CHAT_RUN_THROTTLE_MS));
});

// Wire the desktop-runner relay: a user's signed-in desktop app registers here
// and executes delegated runs locally, streaming events back through the server.
// The server never runs an agent itself.
initDesktopRunners(io, db, { publishRunEvent, finishDelegatedRun });

// ── Health ──────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Deploy trigger ─────────────────────────────────────────────────

/** Bearer-token auth for the deploy routes, using the persisted deploy secret. */
function requireDeployAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const headerToken = typeof req.headers['x-deploy-token'] === 'string' ? req.headers['x-deploy-token'] : null;
  const token = bearerToken || headerToken;
  if (!token) return res.status(401).json({ error: 'Deploy token required' });
  const got = Buffer.from(token);
  const expected = Buffer.from(DEPLOY_SECRET);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
    return res.status(401).json({ error: 'Invalid deploy token' });
  }
  next();
}

// Queue a redeploy. Writes a request file the host watcher consumes; it does not
// (and cannot, from inside the container) run docker/deploy.sh directly.
app.post(['/api/deploy', '/api/admin/deploy'], requireDeployAuth, (req, res) => {
  const ref = typeof req.body?.ref === 'string' && req.body.ref.trim() ? req.body.ref.trim() : null;
  const payload = JSON.stringify({ requestedAt: new Date().toISOString(), ref });
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DEPLOY_REQUEST_FILE, payload + '\n');
    res.status(202).json({ status: 'queued', ref });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not queue deploy' });
  }
});

// Report whether a deploy is pending and the result of the last one.
app.get(['/api/deploy/status', '/api/admin/deploy/status'], requireDeployAuth, (_req, res) => {
  let pending = false;
  try {
    fs.accessSync(DEPLOY_REQUEST_FILE);
    pending = true;
  } catch {
    // no request queued
  }
  let last: unknown = null;
  try {
    last = JSON.parse(fs.readFileSync(DEPLOY_RESULT_FILE, 'utf8'));
  } catch {
    // no deploy has completed yet
  }
  res.json({ pending, last });
});

// ── Auth routes ────────────────────────────────────────────────────

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

// ── Vault routes ───────────────────────────────────────────────────

app.get('/api/vaults', requireAuth, (req: AuthedRequest, res) => {
  res.json({ vaults: listVaults(db, req.user!.id) });
});

app.post('/api/vaults', requireAuth, (req: AuthedRequest, res) => {
  try {
    const vault = createVault(db, req.user!.id, req.body || {});
    res.status(201).json({ vault });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create vault' });
  }
});

app.get('/api/vaults/:id', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ vault });
});

// ── Folder routes ──────────────────────────────────────────────────

app.get('/api/vaults/:id/folders', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ folders: listFolders(db, vault.id) });
});

app.post('/api/vaults/:id/folders', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const folder = createFolder(db, vault.id, req.body || {});
    res.status(201).json({ folder });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create folder' });
  }
});

app.patch('/api/folders/:id', requireAuth, (req: AuthedRequest, res) => {
  try {
    const folder = updateFolder(db, req.params.id, req.body || {});
    res.json({ folder });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not update folder';
    const status = msg === 'Folder not found' ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

app.delete('/api/folders/:id', requireAuth, (req: AuthedRequest, res) => {
  try {
    deleteFolder(db, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Could not delete folder';
    const status = msg === 'Folder not found' ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

// ── Note routes ────────────────────────────────────────────────────

app.get('/api/vaults/:id/notes', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const opts: { folder_id?: string; is_archived?: boolean; tag?: string } = {};
  if (typeof req.query.folder_id === 'string') opts.folder_id = req.query.folder_id;
  if (req.query.is_archived === 'true') opts.is_archived = true;
  if (req.query.is_archived === 'false') opts.is_archived = false;
  if (typeof req.query.tag === 'string') opts.tag = req.query.tag;

  res.json({ notes: listNotes(db, vault.id, opts) });
});

app.post('/api/vaults/:id/notes', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const note = createNote(db, vault.id, req.user!.id, req.body || {});
    createNoteVersion(db, note.id, note.content, 'created');
    emitVaultEvent(vault.id, 'vault:noteCreated', { noteId: note.id, vaultId: vault.id, title: note.title });
    res.status(201).json({ note });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create note' });
  }
});

app.get('/api/notes/:id', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  // Verify vault access
  const vault = getVault(db, note.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });
  res.json({ note });
});

app.put('/api/notes/:id', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, existing.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  try {
    const content = String(req.body.content ?? existing.content);
    const note = updateNote(db, req.params.id, content);
    createNoteVersion(db, note.id, content, 'auto');
    emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: note.id, vaultId: vault.id, title: note.title });
    res.json({ note });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update note' });
  }
});

app.post('/api/notes/:id/rename', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, existing.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  try {
    const note = renameNote(db, req.params.id, String(req.body.title ?? ''));
    emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: note.id, vaultId: vault.id });
    res.json({ note });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not rename note' });
  }
});

app.delete('/api/notes/:id', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, existing.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  deleteNoteAssets(db, req.params.id);
  deleteNote(db, req.params.id);
  emitVaultEvent(vault.id, 'vault:noteDeleted', { noteId: req.params.id, vaultId: vault.id, title: existing.title });
  res.json({ ok: true });
});

app.post('/api/notes/:id/move', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, existing.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  try {
    const folderId = req.body.folder_id !== undefined ? (req.body.folder_id || null) : null;
    moveNote(db, req.params.id, folderId);
    const note = getNote(db, req.params.id);
    emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, vaultId: vault.id, title: note?.title ?? existing.title });
    res.json({ note });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not move note' });
  }
});

app.post('/api/notes/:id/pin', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, existing.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  togglePin(db, req.params.id);
  const note = getNote(db, req.params.id);
  emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, vaultId: vault.id, title: note?.title ?? existing.title });
  res.json({ note });
});

app.post('/api/notes/:id/assets', requireAuth, (req: AuthedRequest, res) => {
  try {
    const result = uploadNoteAsset(db, req.params.id, req.user!.id, req.body || {});
    res.status(201).json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(message === 'Note not found' ? 404 : 400).json({ error: message });
  }
});

app.get('/api/notes/:id/assets/:assetId', requireAuth, serveNoteAsset(db));

app.post('/api/notes/:id/archive', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, existing.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  toggleArchive(db, req.params.id);
  const note = getNote(db, req.params.id);
  emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, vaultId: vault.id, title: note?.title ?? existing.title });
  res.json({ note });
});

// ── Search routes ──────────────────────────────────────────────────

app.get('/api/vaults/:id/search', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ results: [] });

  try {
    res.json({ results: searchNotes(db, vault.id, query) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Search failed' });
  }
});

// ── Backlinks routes ───────────────────────────────────────────────

app.get('/api/notes/:id/backlinks', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, note.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  res.json({ backlinks: getBacklinks(db, req.params.id) });
});

// ── Tag routes ─────────────────────────────────────────────────────

app.get('/api/vaults/:id/tags', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ tags: listTags(db, vault.id) });
});

app.post('/api/notes/:id/tags', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, note.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  try {
    addTag(db, req.params.id, vault.id, String(req.body.name || ''), req.body.color);
    const updated = getNote(db, req.params.id);
    res.json({ note: updated });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add tag' });
  }
});

app.delete('/api/notes/:id/tags/:tagId', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, note.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  removeTag(db, req.params.id, req.params.tagId);
  const updated = getNote(db, req.params.id);
  res.json({ note: updated });
});

// ── Version routes ─────────────────────────────────────────────────

app.get('/api/notes/:id/versions', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, note.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  res.json({ versions: listNoteVersions(db, req.params.id) });
});

app.get('/api/notes/:id/diff', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, note.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  const from = String(req.query.from || '');
  const to = String(req.query.to || '');

  if (from && to) {
    const diff = diffNoteVersions(db, from, to);
    if (!diff) return res.status(404).json({ error: 'Version not found' });
    return res.json({ diff });
  }

  // Diff current content against latest version
  const versions = listNoteVersions(db, req.params.id);
  const latest = versions[0];
  if (!latest) return res.json({ diff: diffText('', note.content, 'empty', note.title) });

  const latestVersion = db.prepare('SELECT content FROM note_versions WHERE id = ?').get(latest.id) as { content: string } | undefined;
  res.json({ diff: diffText(latestVersion?.content || '', note.content, `version-${latest.id.slice(0, 8)}`, note.title) });
});

// ── Graph routes ───────────────────────────────────────────────────

app.get('/api/vaults/:id/graph', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json(getGraph(db, vault.id));
});

// ── Feed routes ───────────────────────────────────────────────────

app.post('/api/vaults/:id/feed', requireAuth, async (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'Feed URL is required' });

  try {
    const feed = await fetchFeed(url, { force: Boolean(req.body?.force) });
    res.json({ feed });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not fetch feed' });
  }
});

app.post('/api/vaults/:id/feed/poll', requireAuth, async (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  await pollWidgetFeeds(db);
  res.json({ ok: true });
});

// ── Agent / Run routes ─────────────────────────────────────────────

app.get('/api/vaults/:id/runs', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ runs: listRuns(db, vault.id) });
});

app.post('/api/vaults/:id/runs', requireAuth, async (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const { prompt, note_id, agent, conversation_id, images, model, cwd, yolo } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }
  const yoloMode = yolo === true;

  const validAgents = ['claude-code', 'codex', 'grok', 'antigravity', 'copilot', 'hermes'] as const satisfies readonly AgentId[];
  const selectedAgent: AgentId = validAgents.includes(agent) ? agent : 'claude-code';
  // Every agent — Claude included — executes on the user's own machine via the
  // desktop runner relay. The server never runs an LLM itself (no API keys / no
  // Claude login on the server); it only relays runs to a connected desktop.
  // Poll briefly rather than checking once: a busy or reconnecting local runner
  // can be absent for a moment (a lapsed heartbeat, a socket.io reconnect) even
  // though it's about to be dispatchable. Hard-failing here is what surfaces the
  // spurious "no runner connected" mid-run.
  if (!(await waitForDesktopRunner(req.user!.id))) {
    return res.status(503).json({
      error: 'No desktop agent runner is connected. Open Cascade on your computer (signed in to the same account) to run agents from chat.',
    });
  }
  const removedModelPresets = new Set([
    'codex-flash',
    'codex-pro',
    'grok-2',
    'grok-beta',
    'gpt-4o',
    'claude-3.5-sonnet',
    'o1-mini',
  ]);
  const selectedModel = typeof model === 'string' && model.trim() && !removedModelPresets.has(model.trim())
    ? model.trim()
    : undefined;
  let selectedCwd: string | undefined;
  if (typeof cwd === 'string' && cwd.trim()) {
    const rawCwd = cwd.trim();
    if (!/^(vault\s*root|root|\.\/?)$/i.test(rawCwd)) {
      selectedCwd = rawCwd;
    }
  }

  // Sanitize image attachments to { media_type, data } base64 entries.
  const cleanImages = Array.isArray(images)
    ? images
        .filter((im: any) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
        .slice(0, 8)
        .map((im: any) => ({ media_type: im.media_type, data: im.data }))
    : [];

  try {
    const run = await startRun(db, vault, note_id || null, prompt, selectedAgent, {
      conversationId: typeof conversation_id === 'string' && conversation_id ? conversation_id : undefined,
      model: selectedModel,
    });

    // Link this run to the chat message it's answering so the server can persist
    // and broadcast the streamed reply itself. Registered before delegation so no
    // early event is missed.
    const chatChannelId = typeof req.body?.chat?.channelId === 'string' ? req.body.chat.channelId.trim() : '';
    const chatMessageId = typeof req.body?.chat?.messageId === 'string' ? req.body.chat.messageId.trim() : '';
    if (chatChannelId && chatMessageId) {
      chatRunTargets.set(run.id, {
        userId: req.user!.id,
        vaultId: vault.id,
        channelId: chatChannelId,
        messageId: chatMessageId,
      });
    }

    const delegated = delegateRunToDesktop(req.user!.id, {
      runId: run.id,
      vaultId: vault.id,
      agent: selectedAgent,
      prompt,
      cwd: selectedCwd,
      vaultRoot: vault.root_path,
      model: selectedModel,
      resumeSessionId: findPriorSession(db, run),
      chatChannelId,
      chatMessageId,
      images: cleanImages,
      yolo: yoloMode,
    });
    if (!delegated) {
      chatRunTargets.delete(run.id);
      return res.status(503).json({
        error: 'Desktop agent runner disconnected before the run could start. Open Cascade on your computer and try again.',
      });
    }

    res.json({ run });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/vaults/:id/widget-data/:key', requireAuth, async (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const key = String(req.params.key || '').trim();
  if (!key) return res.status(400).json({ error: 'Widget data key is required' });

  try {
    const result = await fetchWidgetData(vault.root_path, key, {
      force: req.query.force === '1' || req.query.force === 'true',
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not fetch widget data' });
  }
});

app.get('/api/runs/:id', requireAuth, (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const vault = getVault(db, run.vault_id, req.user!.id);
  if (!vault) return res.status(403).json({ error: 'Access denied' });

  res.json({ run });
});

app.get('/api/runs/:id/events', requireAuth, (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const vault = getVault(db, run.vault_id, req.user!.id);
  if (!vault) return res.status(403).json({ error: 'Access denied' });

  res.json({ events: listRunEvents(db, run.id) });
});

// Whether this user's desktop app is connected and able to host agent runs.
app.get('/api/me/desktop-runner', requireAuth, (req: AuthedRequest, res) => {
  res.json(getDesktopRunnerStatus(req.user!.id));
});

app.post('/api/runs/:id/cancel', requireAuth, async (req: AuthedRequest, res) => {
  const run = getRun(db, Number(req.params.id));
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const vault = getVault(db, run.vault_id, req.user!.id);
  if (!vault) return res.status(403).json({ error: 'Access denied' });

  try {
    const success = await cancelRun(db, run.id);
    if (success) {
      for (const update of settleChatMessagesForRun(db, run.id)) {
        emitVaultEvent(update.vaultId, 'vault:chatMessageUpdated', {
          vaultId: update.vaultId,
          channelId: update.channelId,
          message: update.message,
        });
      }
    }
    res.json({ success });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Chat channels ──────────────────────────────────────────────────

app.get('/api/vaults/:vaultId/channels/:channelId/messages', requireAuth, (req: AuthedRequest, res) => {
  try {
    const messages = listChatMessages(db, req.params.channelId, req.user!.id);
    res.json({ messages });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/messages', requireAuth, (req: AuthedRequest, res) => {
  try {
    const message = createChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, req.body);
    emitVaultEvent(req.params.vaultId, 'vault:chatMessageCreated', { vaultId: req.params.vaultId, channelId: req.params.channelId, message });
    res.status(201).json({ message });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/vaults/:vaultId/channels/:channelId/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const message = updateChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, req.params.messageId, req.body);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    emitVaultEvent(req.params.vaultId, 'vault:chatMessageUpdated', { vaultId: req.params.vaultId, channelId: req.params.channelId, message });
    res.json({ message });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/agents', requireAuth, (req: AuthedRequest, res) => {
  try {
    const agents = listChatAgentMembers(db, req.params.channelId, req.user!.id);
    res.json({ agents });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

app.put('/api/vaults/:vaultId/channels/:channelId/agents', requireAuth, (req: AuthedRequest, res) => {
  try {
    const registration = upsertChatAgentMember(db, req.user!.id, req.params.vaultId, req.params.channelId, req.body);
    emitVaultEvent(req.params.vaultId, 'vault:chatAgentMemberUpserted', { vaultId: req.params.vaultId, channelId: req.params.channelId, registration });
    res.json({ registration });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/vaults/:vaultId/channels/:channelId/agents/:registrationId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const removed = removeChatAgentMember(db, req.user!.id, req.params.vaultId, req.params.channelId, req.params.registrationId);
    if (!removed) return res.status(404).json({ error: 'Agent member not found' });
    emitVaultEvent(req.params.vaultId, 'vault:chatAgentMemberRemoved', { vaultId: req.params.vaultId, channelId: req.params.channelId, registrationId: req.params.registrationId });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Public note publishing ─────────────────────────────────────────

app.get('/p/:slug', servePublicNotePage(db));
app.get('/p/:slug.json', servePublicNoteJson(db));
app.get('/oembed', serveOembed(db));

app.get('/api/notes/:id/publish', requireAuth, (req: AuthedRequest, res) => {
  try {
    const note = getNote(db, req.params.id);
    if (!note || !getVault(db, note.vault_id, req.user!.id)) return res.status(404).json({ error: 'Note not found' });
    const info = getPublishInfo(db, req.params.id);
    if (!info) return res.json({ published: false });
    const url = `${publicBaseUrl(req)}/p/${info.slug}`;
    res.json({
      published: true,
      slug: info.slug,
      url,
      published_at: info.published_at,
      updated_at: info.updated_at,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/notes/:id/publish', requireAuth, (req: AuthedRequest, res) => {
  try {
    const snapshot = req.body && typeof req.body === 'object'
      ? { title: typeof req.body.title === 'string' ? req.body.title : undefined, content: typeof req.body.content === 'string' ? req.body.content : undefined }
      : undefined;
    const result = publishNote(db, req.params.id, req.user!.id, req.user!.username, snapshot);
    const url = `${publicBaseUrl(req)}/p/${result.slug}`;
    res.json({
      slug: result.slug,
      url,
      published_at: result.published_at,
      updated_at: result.updated_at,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(message === 'Note not found' ? 404 : 400).json({ error: message });
  }
});

app.delete('/api/notes/:id/publish', requireAuth, (req: AuthedRequest, res) => {
  try {
    const removed = unpublishNote(db, req.params.id, req.user!.id);
    if (!removed) return res.status(404).json({ error: 'Note is not published' });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Static client ──────────────────────────────────────────────────

if (fs.existsSync(CLIENT_APP_HTML)) {
  app.use(express.static(CLIENT_DIST_DIR));
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api/')
      || req.path.startsWith('/socket.io/')
      || req.path.startsWith('/p/')
      || req.path === '/oembed'
    ) return next();
    res.sendFile(CLIENT_APP_HTML);
  });
}

// ── 404 fallback ───────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start server ───────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Cascade Notes API running on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
  startFeedPoller(db);
});
