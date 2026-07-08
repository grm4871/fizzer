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
  type Vault,
} from './server/vault.js';
import {
  createNoteVersion,
  diffNoteVersions,
  diffText,
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
import { corsOrigin, rateLimit, resolveDeploySecret, resolveJwtSecret } from './server/security.js';
import {
  assertChatChannel,
  buildAgentChatContentFromRunEvents,
  CHAT_NOTE_MARKER,
  ensureChatSchema,
  linkChatChannel,
  listChatChannelRoutes,
  listChatMessages,
  createChatMessage,
  updateChatMessage,
  settleChatMessagesForRun,
  listChatAgentMembers,
  listChatChannelParticipants,
  listChatChannelParticipantUsernames,
  upsertChatAgentMember,
  removeChatAgentMember,
  resolveChatAgentRun,
  type ChatMessage,
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
import {
  buildRecallContext,
  createMemoryNote,
  getMemoryNote,
  recallExocortex,
} from './server/exocortex.js';

const PORT = Number(process.env.API_PORT || 3000);
/** Single source of truth with desktop-runner (persisted secret when env unset). */
const JWT_SECRET = resolveJwtSecret();
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
type ChatInviteToken = {
  type: 'chat-invite';
  sourceVaultId: string;
  sourceChannelId: string;
};

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

ensureRunnerSchema(db);
ensureFeedSchema(db);
ensureChatSchema(db);
ensurePublishSchema(db);

// ── Express & Socket.io setup ──────────────────────────────────────

const app = express();
const corsOriginOption = corsOrigin();
app.use(cors({ origin: corsOriginOption, credentials: true }));
app.use(express.json({ limit: '2mb' }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: corsOriginOption, credentials: true },
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

function signChatInvite(sourceVaultId: string, sourceChannelId: string) {
  return jwt.sign({ type: 'chat-invite', sourceVaultId, sourceChannelId } satisfies ChatInviteToken, JWT_SECRET);
}

function verifyChatInvite(token: string): ChatInviteToken {
  const decoded = jwt.verify(token, JWT_SECRET) as Partial<ChatInviteToken>;
  if (
    decoded.type !== 'chat-invite'
    || typeof decoded.sourceVaultId !== 'string'
    || typeof decoded.sourceChannelId !== 'string'
  ) {
    throw new Error('Invalid invite link');
  }
  return {
    type: 'chat-invite',
    sourceVaultId: decoded.sourceVaultId,
    sourceChannelId: decoded.sourceChannelId,
  };
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

  socket.on('joinChatChannel', async (localChannelId: string) => {
    const user = socket.data.user as { id: number; username: string };
    if (typeof localChannelId !== 'string' || !localChannelId) return;
    try {
      const { route } = assertChatChannel(db, localChannelId, user.id);
      await socket.join(chatPresenceRoom(route.sourceChannelId));
      const tracked = socket.data.chatPresenceChannels as Map<string, string> | undefined
        ?? (socket.data.chatPresenceChannels = new Map<string, string>());
      tracked.set(route.sourceChannelId, route.sourceVaultId);
      const online = await getOnlineUsernamesForChannel(route.sourceChannelId);
      const participants = listChatChannelParticipantUsernames(db, route.sourceVaultId, route.sourceChannelId);
      socket.emit('vault:chatPresence', {
        vaultId: route.localVaultId,
        channelId: localChannelId,
        online,
        participants,
      });
      await emitChatPresence(route.sourceVaultId, route.sourceChannelId);
    } catch {
      // ignore unauthorized / non-chat channels
    }
  });

  socket.on('leaveChatChannel', async (localChannelId: string) => {
    const user = socket.data.user as { id: number };
    if (typeof localChannelId !== 'string' || !localChannelId) return;
    try {
      const { route } = assertChatChannel(db, localChannelId, user.id);
      await socket.leave(chatPresenceRoom(route.sourceChannelId));
      (socket.data.chatPresenceChannels as Map<string, string> | undefined)?.delete(route.sourceChannelId);
      await emitChatPresence(route.sourceVaultId, route.sourceChannelId);
    } catch {
      // ignore
    }
  });

  socket.on('disconnect', async () => {
    const tracked = socket.data.chatPresenceChannels as Map<string, string> | undefined;
    if (!tracked?.size) return;
    for (const [sourceChannelId, sourceVaultId] of tracked.entries()) {
      await emitChatPresence(sourceVaultId, sourceChannelId);
    }
    tracked.clear();
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

function emitChatMessageEvent(sourceVaultId: string, sourceChannelId: string, event: 'vault:chatMessageCreated' | 'vault:chatMessageUpdated', message: ChatMessage) {
  for (const route of listChatChannelRoutes(db, sourceVaultId, sourceChannelId)) {
    emitVaultEvent(route.localVaultId, event, {
      vaultId: route.localVaultId,
      channelId: route.localChannelId,
      message: { ...message, channelId: route.localChannelId },
    });
  }
}

function emitChatAgentEvent(sourceVaultId: string, sourceChannelId: string, event: 'vault:chatAgentMemberUpserted' | 'vault:chatAgentMemberRemoved', payload: Record<string, unknown>) {
  for (const route of listChatChannelRoutes(db, sourceVaultId, sourceChannelId)) {
    emitVaultEvent(route.localVaultId, event, {
      ...payload,
      vaultId: route.localVaultId,
      channelId: route.localChannelId,
    });
  }
}

function chatPresenceRoom(sourceChannelId: string) {
  return `chat:${sourceChannelId}`;
}

async function getOnlineUsernamesForChannel(sourceChannelId: string): Promise<string[]> {
  const sockets = await vaultNamespace.in(chatPresenceRoom(sourceChannelId)).fetchSockets();
  const names = new Set<string>();
  for (const socket of sockets) {
    const user = socket.data.user as { username?: string } | undefined;
    if (user?.username) names.add(user.username);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

async function emitChatPresence(sourceVaultId: string, sourceChannelId: string) {
  const online = await getOnlineUsernamesForChannel(sourceChannelId);
  const participants = listChatChannelParticipantUsernames(db, sourceVaultId, sourceChannelId);
  for (const route of listChatChannelRoutes(db, sourceVaultId, sourceChannelId)) {
    emitVaultEvent(route.localVaultId, 'vault:chatPresence', {
      vaultId: route.localVaultId,
      channelId: route.localChannelId,
      online,
      participants,
    });
  }
}

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
      const { route } = assertChatChannel(db, target.channelId, target.userId);
      emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', updated);
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

const authRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

app.post('/api/auth/register', authRateLimit, async (req, res) => {
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

app.post('/api/auth/login', authRateLimit, async (req, res) => {
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

app.get('/api/vaults/:id/exocortex/recall', requireAuth, (req: AuthedRequest, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const channelId = typeof req.query.channel === 'string' ? req.query.channel.trim() : undefined;
    const limit = Number(req.query.limit || 8);
    const results = recallExocortex(db, req.user!.id, req.params.id, q, { channelId, limit });
    res.json({ results });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Recall failed' });
  }
});

app.post('/api/vaults/:id/exocortex/memories', requireAuth, (req: AuthedRequest, res) => {
  try {
    const note = createMemoryNote(db, req.user!.id, req.params.id, {
      body: String(req.body?.body || ''),
      type: req.body?.type,
      scope: req.body?.scope,
      source: req.body?.source,
      title: req.body?.title,
      createdBy: req.user!.username,
    });
    res.status(201).json({ note });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create memory' });
  }
});

app.delete('/api/exocortex/memories/:id', requireAuth, (req: AuthedRequest, res) => {
  const note = getMemoryNote(db, req.user!.id, req.params.id);
  if (!note) return res.status(404).json({ error: 'Memory not found' });
  deleteNoteAssets(db, note.id);
  deleteNote(db, note.id);
  res.json({ ok: true });
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
  const { prompt, note_id, agent, conversation_id, images, model, cwd, yolo } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const validAgents = ['claude-code', 'codex', 'grok', 'antigravity', 'copilot', 'hermes'] as const satisfies readonly AgentId[];
  const removedModelPresets = new Set([
    'codex-flash',
    'codex-pro',
    'grok-2',
    'grok-beta',
    'gpt-4o',
    'claude-3.5-sonnet',
    'o1-mini',
  ]);
  const normalizeRunModel = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() && !removedModelPresets.has(value.trim()) ? value.trim() : undefined;
  const normalizeRunCwd = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const rawCwd = value.trim();
    return /^(vault\s*root|root|\.\/?)$/i.test(rawCwd) ? undefined : rawCwd;
  };
  const pickAgent = (value: unknown): AgentId => (validAgents.includes(value as AgentId) ? (value as AgentId) : 'claude-code');

  const chatChannelId = typeof req.body?.chat?.channelId === 'string' ? req.body.chat.channelId.trim() : '';
  const chatMessageId = typeof req.body?.chat?.messageId === 'string' ? req.body.chat.messageId.trim() : '';
  const registrationId = typeof req.body?.registrationId === 'string' ? req.body.registrationId.trim() : '';

  // Resolve the run's execution context. A chat-agent ping always executes on the
  // *agent owner's* desktop runner using the owner's stored registration — never
  // the pinger's machine or client-supplied cwd/model/yolo. Non-chat runs (note
  // panes) and legacy chat runs execute on the requesting user's own runner.
  let runVault: Vault;
  let runnerUserId: number;
  let selectedAgent: AgentId;
  let selectedModel: string | undefined;
  let selectedCwd: string | undefined;
  let yoloMode: boolean;
  let targetChannelId = chatChannelId;
  let requesterIsOwner = true;
  let chatAuthor = '';
  let chatRegistrationId = '';

  if (chatChannelId && registrationId) {
    let resolved: ReturnType<typeof resolveChatAgentRun>;
    try {
      resolved = resolveChatAgentRun(db, req.user!.id, chatChannelId, registrationId);
    } catch {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const { registration, sourceVault, route, ownerId } = resolved;
    requesterIsOwner = req.user!.id === ownerId;
    if (!requesterIsOwner && !registration.pingableByOthers) {
      return res.status(403).json({ error: "This agent isn't accepting pings from other users." });
    }
    // Owner's registration is authoritative — the pinger's request body can't
    // override the agent, model, cwd, or yolo it runs with on the owner's box.
    runVault = sourceVault;
    runnerUserId = ownerId;
    selectedAgent = pickAgent(registration.agentId);
    selectedModel = normalizeRunModel(registration.model);
    selectedCwd = normalizeRunCwd(registration.cwd);
    yoloMode = registration.yolo;
    targetChannelId = route.sourceChannelId;
    chatAuthor = registration.displayName || registration.agentId;
    chatRegistrationId = registration.id;
  } else {
    const vault = getVault(db, req.params.id, req.user!.id);
    if (!vault) return res.status(404).json({ error: 'Vault not found' });
    runVault = vault;
    runnerUserId = req.user!.id;
    selectedAgent = pickAgent(agent);
    selectedModel = normalizeRunModel(model);
    selectedCwd = normalizeRunCwd(cwd);
    yoloMode = yolo === true;
    chatAuthor = typeof req.body?.chat?.author === 'string' ? req.body.chat.author.trim() : '';
    chatRegistrationId = registrationId;
  }

  // Every agent — Claude included — executes on a user's own machine via the
  // desktop runner relay. The server never runs an LLM itself (no API keys / no
  // Claude login on the server); it only relays runs to a connected desktop.
  // Poll briefly rather than checking once: a busy or reconnecting local runner
  // can be absent for a moment (a lapsed heartbeat, a socket.io reconnect) even
  // though it's about to be dispatchable. Hard-failing here is what surfaces the
  // spurious "no runner connected" mid-run.
  if (!(await waitForDesktopRunner(runnerUserId))) {
    return res.status(503).json({
      error: requesterIsOwner
        ? 'No desktop agent runner is connected. Open Cascade on your computer (signed in to the same account) to run agents from chat.'
        : "This agent's owner is offline — their desktop runner isn't connected, so the agent can't run right now.",
    });
  }

  // Sanitize image attachments to { media_type, data } base64 entries.
  const cleanImages = Array.isArray(images)
    ? images
        .filter((im: any) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
        .slice(0, 8)
        .map((im: any) => ({ media_type: im.media_type, data: im.data }))
    : [];

  try {
    let effectivePrompt = prompt;
    try {
      const recentMessages = targetChannelId
        ? listChatMessages(db, targetChannelId, runnerUserId).slice(-8).map((message) => `${message.author}: ${message.body}`).join('\n')
        : '';
      const recallQuery = [prompt, recentMessages].filter(Boolean).join('\n');
      const recall = buildRecallContext(
        recallExocortex(db, runnerUserId, runVault.id, recallQuery, {
          channelId: targetChannelId || undefined,
          limit: 6,
        }),
      );
      if (recall) {
        effectivePrompt = `${prompt}\n\n[Context: ${recall}]`;
      }
    } catch (error) {
      console.warn('Exocortex recall skipped:', error instanceof Error ? error.message : error);
    }

    const run = await startRun(db, runVault, note_id || null, effectivePrompt, selectedAgent, {
      conversationId: typeof conversation_id === 'string' && conversation_id ? conversation_id : undefined,
      model: selectedModel,
    });

    // Link this run to the chat message it's answering so the server can persist
    // and broadcast the streamed reply itself. Keyed to the runner user (agent
    // owner for cross-user pings) and the source channel, so the fan-out reaches
    // every linked channel. Registered before delegation so no early event is missed.
    if (targetChannelId && chatMessageId) {
      chatRunTargets.set(run.id, {
        userId: runnerUserId,
        vaultId: runVault.id,
        channelId: targetChannelId,
        messageId: chatMessageId,
      });
    }

    const delegated = delegateRunToDesktop(runnerUserId, {
      runId: run.id,
      vaultId: runVault.id,
      agent: selectedAgent,
      prompt: effectivePrompt,
      cwd: selectedCwd,
      vaultRoot: runVault.root_path,
      model: selectedModel,
      resumeSessionId: findPriorSession(db, run),
      chatChannelId: targetChannelId,
      chatMessageId,
      chatAuthor,
      chatRegistrationId,
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
        emitChatMessageEvent(update.vaultId, update.channelId, 'vault:chatMessageUpdated', update.message);
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
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const message = createChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, req.body);
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageCreated', message);
    res.status(201).json({ message });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.patch('/api/vaults/:vaultId/channels/:channelId/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const message = updateChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, req.params.messageId, req.body);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', message);
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

app.get('/api/vaults/:vaultId/channels/:channelId/presence', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const participants = listChatChannelParticipants(db, req.params.channelId, req.user!.id);
    const online = await getOnlineUsernamesForChannel(route.sourceChannelId);
    res.json({ participants, online });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

app.put('/api/vaults/:vaultId/channels/:channelId/agents', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const registration = upsertChatAgentMember(db, req.user!.id, req.params.vaultId, req.params.channelId, req.body);
    emitChatAgentEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatAgentMemberUpserted', { registration });
    res.json({ registration });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/vaults/:vaultId/channels/:channelId/agents/:registrationId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const removed = removeChatAgentMember(db, req.user!.id, req.params.vaultId, req.params.channelId, req.params.registrationId);
    if (!removed) return res.status(404).json({ error: 'Agent member not found' });
    emitChatAgentEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatAgentMemberRemoved', { registrationId: req.params.registrationId });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function firstOwnedVault(userId: number) {
  return db.prepare('SELECT * FROM vaults WHERE created_by = ? ORDER BY created_at ASC LIMIT 1').get(userId) as ReturnType<typeof createVault> | undefined;
}

function uniqueSharedChatTitle(vaultId: string, baseTitle: string): string {
  const base = String(baseTitle || 'shared-chat').trim() || 'shared-chat';
  for (let i = 0; i < 50; i++) {
    const title = i === 0 ? base : `${base} ${i + 1}`;
    const existing = db.prepare('SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE').get(vaultId, title);
    if (!existing) return title;
  }
  return `${base} ${Date.now()}`;
}

function addLinkedChatToUserVault(sourceVault: { id: string }, sourceChannel: { id: string; title: string }, userId: number, createdBy: number) {
  let targetVault = firstOwnedVault(userId);
  if (!targetVault) targetVault = createVault(db, userId, { name: 'My Vault' });

  const existingLink = db.prepare(`
    SELECT local_channel_id AS localChannelId, local_vault_id AS localVaultId
    FROM chat_channel_links
    WHERE source_channel_id = ?
      AND local_vault_id IN (SELECT id FROM vaults WHERE created_by = ?)
    ORDER BY created_at ASC
    LIMIT 1
  `).get(sourceChannel.id, userId) as { localChannelId: string; localVaultId: string } | undefined;

  if (existingLink) {
    return { vaultId: existingLink.localVaultId, channelId: existingLink.localChannelId, title: sourceChannel.title, created: false };
  }

  const title = uniqueSharedChatTitle(targetVault.id, sourceChannel.title);
  const localChannel = createNote(db, targetVault.id, userId, {
    title,
    content: `${CHAT_NOTE_MARKER}\nshared_from=${sourceChannel.id}`,
  });
  linkChatChannel(db, {
    localVaultId: targetVault.id,
    localChannelId: localChannel.id,
    sourceVaultId: sourceVault.id,
    sourceChannelId: sourceChannel.id,
    createdBy,
  });
  emitVaultEvent(targetVault.id, 'vault:noteCreated', { noteId: localChannel.id, vaultId: targetVault.id, title: localChannel.title });
  return { vaultId: targetVault.id, channelId: localChannel.id, title: localChannel.title, created: true };
}

app.post('/api/vaults/:vaultId/channels/:channelId/invites', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.vaultId, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const channel = getNote(db, req.params.channelId);
  if (!channel || channel.vault_id !== vault.id || !channel.content.trim().startsWith(CHAT_NOTE_MARKER)) {
    return res.status(404).json({ error: 'Chat channel not found' });
  }
  if (vault.created_by !== req.user!.id) {
    return res.status(403).json({ error: 'Only the chat owner can invite users' });
  }

  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-32 lowercase letters, numbers, or underscores' });
    }
    const invitedUser = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username) as { id: number; username: string } | undefined;
    if (!invitedUser) return res.status(404).json({ error: 'User not found' });
    if (invitedUser.id === req.user!.id) return res.status(400).json({ error: 'You already have this chat' });

    const linked = addLinkedChatToUserVault(vault, channel, invitedUser.id, req.user!.id);

    const message = createChatMessage(db, req.user!.id, vault.id, channel.id, {
      id: crypto.randomUUID(),
      channelId: channel.id,
      author: 'Cascade',
      body: `@${req.user!.username} invited @${invitedUser.username} to add this chat to their vault.`,
      createdAt: new Date().toISOString(),
    });
    emitChatMessageEvent(vault.id, channel.id, 'vault:chatMessageCreated', message);
    res.status(201).json({ user: publicUser(invitedUser), vaultId: linked.vaultId, channelId: linked.channelId, title: linked.title, message });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: message });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/invite-link', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.vaultId, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const channel = getNote(db, req.params.channelId);
  if (!channel || channel.vault_id !== vault.id || !channel.content.trim().startsWith(CHAT_NOTE_MARKER)) {
    return res.status(404).json({ error: 'Chat channel not found' });
  }
  if (vault.created_by !== req.user!.id) {
    return res.status(403).json({ error: 'Only the chat owner can create invite links' });
  }
  const token = signChatInvite(vault.id, channel.id);
  res.json({ token, url: `${publicBaseUrl(req)}/invite/${encodeURIComponent(token)}` });
});

app.get('/api/chat-invites/:token', (req, res) => {
  try {
    const invite = verifyChatInvite(req.params.token);
    const channel = getNote(db, invite.sourceChannelId);
    const vault = db.prepare('SELECT id, name, created_by FROM vaults WHERE id = ?').get(invite.sourceVaultId) as { id: string; name: string; created_by: number } | undefined;
    if (!channel || !vault || channel.vault_id !== vault.id || !channel.content.trim().startsWith(CHAT_NOTE_MARKER)) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(vault.created_by) as { username: string } | undefined;
    res.json({
      invite: {
        title: channel.title,
        vaultName: vault.name,
        owner: owner?.username || 'unknown',
      },
    });
  } catch {
    res.status(404).json({ error: 'Invite not found' });
  }
});

app.post('/api/chat-invites/:token/accept', requireAuth, (req: AuthedRequest, res) => {
  try {
    const invite = verifyChatInvite(req.params.token);
    const channel = getNote(db, invite.sourceChannelId);
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(invite.sourceVaultId) as ReturnType<typeof createVault> | undefined;
    if (!channel || !vault || channel.vault_id !== vault.id || !channel.content.trim().startsWith(CHAT_NOTE_MARKER)) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    if (vault.created_by === req.user!.id) {
      return res.json({ vaultId: vault.id, channelId: channel.id, title: channel.title, alreadyOwned: true });
    }
    const linked = addLinkedChatToUserVault(vault, channel, req.user!.id, vault.created_by);
    res.status(201).json({ vaultId: linked.vaultId, channelId: linked.channelId, title: linked.title, created: linked.created });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not accept invite' });
  }
});

function parseInviteUrl(rawUrl: string, base: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const expected = new URL(base);
    if (parsed.origin !== expected.origin) return null;
    const match = parsed.pathname.match(/^\/invite\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function escapeOembedHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function serveInviteOembed(req: Request, res: Response): boolean {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  const base = publicBaseUrl(req);
  const token = parseInviteUrl(rawUrl, base);
  if (!token) return false;

  try {
    const invite = verifyChatInvite(token);
    const channel = getNote(db, invite.sourceChannelId);
    const vault = db.prepare('SELECT id, name, created_by FROM vaults WHERE id = ?').get(invite.sourceVaultId) as { id: string; name: string; created_by: number } | undefined;
    if (!channel || !vault || channel.vault_id !== vault.id || !channel.content.trim().startsWith(CHAT_NOTE_MARKER)) {
      res.status(404).json({ error: 'Invite not found' });
      return true;
    }
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(vault.created_by) as { username: string } | undefined;
    const inviteUrl = `${base}/invite/${encodeURIComponent(token)}`;
    const title = `Join #${channel.title} on Cascade`;
    const description = `${owner?.username || 'Someone'} invited you to add this chat to your own vault.`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      version: '1.0',
      type: 'rich',
      provider_name: 'Cascade',
      provider_url: base,
      title,
      author_name: owner?.username || 'Cascade',
      html: `<a href="${escapeOembedHtml(inviteUrl)}" target="_blank" rel="noopener noreferrer">${escapeOembedHtml(title)}</a>`,
      width: 420,
      height: 96,
      description,
    });
    return true;
  } catch {
    res.status(404).json({ error: 'Invite not found' });
    return true;
  }
}

// ── Public note publishing ─────────────────────────────────────────

app.get('/p/:slug', servePublicNotePage(db));
app.get('/p/:slug.json', servePublicNoteJson(db));
const publicNoteOembed = serveOembed(db);
app.get('/oembed', (req, res) => {
  if (serveInviteOembed(req, res)) return;
  publicNoteOembed(req, res);
});

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
