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
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';
import { addTag, createFolder, createNote, createVault, deleteFolder, deleteNote, deleteNotes, ensureVaultSchema, getBacklinks, getGraph, getNote, getVault, listFolders, listNotes, listTags, linkifyTerm, listVaults, moveNote, removeTag, renameNote, searchNotes, toggleArchive, togglePin, updateFolder, updateNote, } from './server/vault.js';
import { createNoteVersion, diffNoteVersions, diffText, ensureVersionsSchema, listNoteVersions, } from './server/versions.js';
import { ensureRunnerSchema, setRunEventSink, setVaultEventSink, listRuns, getRun, listRunEvents, startRun, sendRunMessage, cancelRun, } from './server/runner.js';
import { ensureFeedSchema, fetchFeed, pollWidgetFeeds, setFeedNotifySink, startFeedPoller, } from './server/feeds.js';
import { fetchWidgetData } from './server/widgetData.js';
import { NETWORK_MODE, WIDGET_SHELL_ENABLED, corsOrigin, rateLimit, resolveJwtSecret, } from './server/security.js';
const PORT = Number(process.env.API_PORT || 3000);
const HOST = process.env.API_HOST || (NETWORK_MODE ? '0.0.0.0' : '127.0.0.1');
const JWT_SECRET = resolveJwtSecret();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
function getDefaultDbPath() {
    const dataDir = path.join(os.homedir(), '.cascade');
    fs.mkdirSync(dataDir, { recursive: true });
    return path.join(dataDir, 'docs.db');
}
function migrateLegacyDbIfNeeded(nextPath) {
    if (process.env.DOCS_DB_PATH)
        return;
    const legacyPath = path.join(process.cwd(), 'docs.db');
    if (path.resolve(legacyPath) === path.resolve(nextPath))
        return;
    if (fs.existsSync(nextPath) || !fs.existsSync(legacyPath))
        return;
    fs.mkdirSync(path.dirname(nextPath), { recursive: true });
    for (const suffix of ['', '-shm', '-wal']) {
        const from = `${legacyPath}${suffix}`;
        if (fs.existsSync(from))
            fs.copyFileSync(from, `${nextPath}${suffix}`);
    }
    console.log(`Migrated SQLite database from ${legacyPath} to ${nextPath}`);
}
const DB_PATH = process.env.DOCS_DB_PATH || getDefaultDbPath();
migrateLegacyDbIfNeeded(DB_PATH);
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
// ── Express & Socket.io setup ──────────────────────────────────────
const app = express();
if (NETWORK_MODE)
    app.set('trust proxy', Number(process.env.CASCADE_TRUST_PROXY_HOPS || 1));
app.use(cors({ origin: corsOrigin(), credentials: true }));
app.use(express.json({ limit: '2mb' }));
const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: { origin: corsOrigin(), credentials: true } });
const runsNamespace = io.of('/runs');
const vaultNamespace = io.of('/vault');
// ── Auth helpers ───────────────────────────────────────────────────
function signToken(user) {
    return jwt.sign(user, JWT_SECRET, { expiresIn: '30d' });
}
function publicUser(user) {
    return { id: user.id, username: user.username };
}
function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!token)
        return res.status(401).json({ error: 'Authentication required' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { id: decoded.id, username: decoded.username };
        next();
    }
    catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
}
// ── Socket.io auth & namespaces ────────────────────────────────────
function socketAuth(socket, next) {
    const token = typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : null;
    if (!token)
        return next(new Error('Authentication required'));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.data.user = { id: decoded.id, username: decoded.username };
        next();
    }
    catch {
        next(new Error('Invalid or expired token'));
    }
}
runsNamespace.use(socketAuth);
vaultNamespace.use(socketAuth);
vaultNamespace.on('connection', (socket) => {
    socket.on('joinVault', (vaultId) => {
        const user = socket.data.user;
        const vault = getVault(db, vaultId, user.id);
        if (vault)
            socket.join(`vault:${vaultId}`);
    });
    socket.on('leaveVault', (vaultId) => {
        socket.leave(`vault:${vaultId}`);
    });
});
runsNamespace.on('connection', (socket) => {
    socket.on('joinRun', (runId) => {
        socket.join(`run:${runId}`);
    });
    socket.on('leaveRun', (runId) => {
        socket.leave(`run:${runId}`);
    });
});
setRunEventSink((event) => {
    runsNamespace.to(`run:${event.run_id}`).emit('event', event);
});
function emitVaultEvent(vaultId, event, data) {
    vaultNamespace.to(`vault:${vaultId}`).emit(event, data);
}
// Let the agent runner notify clients (e.g. reload an open note after edits).
setVaultEventSink(emitVaultEvent);
setFeedNotifySink(emitVaultEvent);
// ── Health ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
});
// ── Auth routes ────────────────────────────────────────────────────
// Blunt credential stuffing / abuse on the unauthenticated auth routes.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
app.post('/api/auth/register', authLimiter, async (req, res) => {
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
    }
    catch {
        res.status(409).json({ error: 'Username is already taken' });
    }
});
app.post('/api/auth/login', authLimiter, async (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    res.json({ user: publicUser(user), token: signToken(user) });
});
app.get('/api/me', requireAuth, (req, res) => {
    res.json({ user: req.user });
});
// ── Vault routes ───────────────────────────────────────────────────
app.get('/api/vaults', requireAuth, (req, res) => {
    res.json({ vaults: listVaults(db, req.user.id) });
});
app.post('/api/vaults', requireAuth, (req, res) => {
    try {
        const vault = createVault(db, req.user.id, req.body || {});
        res.status(201).json({ vault });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create vault' });
    }
});
app.get('/api/vaults/:id', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    res.json({ vault });
});
// ── Folder routes ──────────────────────────────────────────────────
app.get('/api/vaults/:id/folders', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    res.json({ folders: listFolders(db, vault.id) });
});
app.post('/api/vaults/:id/folders', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    try {
        const folder = createFolder(db, vault.id, req.body || {});
        res.status(201).json({ folder });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create folder' });
    }
});
app.patch('/api/folders/:id', requireAuth, (req, res) => {
    try {
        const folder = updateFolder(db, req.params.id, req.body || {});
        res.json({ folder });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : 'Could not update folder';
        const status = msg === 'Folder not found' ? 404 : 400;
        res.status(status).json({ error: msg });
    }
});
app.delete('/api/folders/:id', requireAuth, (req, res) => {
    try {
        deleteFolder(db, req.params.id);
        res.json({ ok: true });
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : 'Could not delete folder';
        const status = msg === 'Folder not found' ? 404 : 400;
        res.status(status).json({ error: msg });
    }
});
// ── Note routes ────────────────────────────────────────────────────
app.get('/api/vaults/:id/notes', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    const opts = {};
    if (typeof req.query.folder_id === 'string')
        opts.folder_id = req.query.folder_id;
    if (req.query.is_archived === 'true')
        opts.is_archived = true;
    if (req.query.is_archived === 'false')
        opts.is_archived = false;
    if (typeof req.query.tag === 'string')
        opts.tag = req.query.tag;
    res.json({ notes: listNotes(db, vault.id, opts) });
});
app.post('/api/vaults/:id/notes', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    try {
        const note = createNote(db, vault.id, req.user.id, req.body || {});
        createNoteVersion(db, note.id, note.content, 'created');
        emitVaultEvent(vault.id, 'vault:noteCreated', { noteId: note.id, title: note.title });
        res.status(201).json({ note });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create note' });
    }
});
// Resolve a selected term to a note to link to: an existing fuzzy match, or a
// freshly created minimal stub. The agent fills in / files the note afterwards.
app.post('/api/vaults/:id/notes/linkify', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    try {
        const { note, matched, score } = linkifyTerm(db, vault.id, req.user.id, {
            term: String(req.body?.term ?? ''),
        });
        if (!matched) {
            createNoteVersion(db, note.id, note.content, 'created');
            emitVaultEvent(vault.id, 'vault:noteCreated', { noteId: note.id, vaultId: vault.id, title: note.title });
        }
        res.status(matched ? 200 : 201).json({ note, matched, score });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not link term' });
    }
});
app.get('/api/notes/:id', requireAuth, (req, res) => {
    const note = getNote(db, req.params.id);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    // Verify vault access
    const vault = getVault(db, note.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    res.json({ note });
});
app.put('/api/notes/:id', requireAuth, (req, res) => {
    const existing = getNote(db, req.params.id);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, existing.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    try {
        const content = String(req.body.content ?? existing.content);
        const note = updateNote(db, req.params.id, content);
        createNoteVersion(db, note.id, content, 'auto');
        emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: note.id, title: note.title });
        res.json({ note });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update note' });
    }
});
app.post('/api/notes/:id/rename', requireAuth, (req, res) => {
    const existing = getNote(db, req.params.id);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, existing.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    try {
        const note = renameNote(db, req.params.id, String(req.body.title ?? ''));
        emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: note.id, vaultId: vault.id });
        res.json({ note });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not rename note' });
    }
});
app.delete('/api/notes/:id', requireAuth, (req, res) => {
    const existing = getNote(db, req.params.id);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, existing.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    deleteNote(db, req.params.id);
    emitVaultEvent(vault.id, 'vault:noteDeleted', { noteId: req.params.id, title: existing.title });
    res.json({ ok: true });
});
app.post('/api/notes/bulk-delete', requireAuth, (req, res) => {
    const rawIds = req.body?.noteIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
        return res.status(400).json({ error: 'noteIds array is required' });
    }
    const noteIds = rawIds.map((id) => String(id));
    const authorized = [];
    for (const noteId of noteIds) {
        const existing = getNote(db, noteId);
        if (!existing)
            continue;
        const vault = getVault(db, existing.vault_id, req.user.id);
        if (!vault)
            continue;
        authorized.push({ noteId, title: existing.title, vaultId: vault.id });
    }
    if (authorized.length === 0) {
        return res.status(404).json({ error: 'No notes found' });
    }
    const deleted = deleteNotes(db, authorized.map((entry) => entry.noteId));
    const deletedSet = new Set(deleted);
    for (const entry of authorized) {
        if (!deletedSet.has(entry.noteId))
            continue;
        emitVaultEvent(entry.vaultId, 'vault:noteDeleted', { noteId: entry.noteId, title: entry.title });
    }
    res.json({ ok: true, deleted });
});
app.post('/api/notes/:id/move', requireAuth, (req, res) => {
    const existing = getNote(db, req.params.id);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, existing.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    try {
        const folderId = req.body.folder_id !== undefined ? (req.body.folder_id || null) : null;
        moveNote(db, req.params.id, folderId);
        const note = getNote(db, req.params.id);
        emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, title: existing.title });
        res.json({ note });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not move note' });
    }
});
app.post('/api/notes/:id/pin', requireAuth, (req, res) => {
    const existing = getNote(db, req.params.id);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, existing.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    togglePin(db, req.params.id);
    const note = getNote(db, req.params.id);
    res.json({ note });
});
app.post('/api/notes/:id/archive', requireAuth, (req, res) => {
    const existing = getNote(db, req.params.id);
    if (!existing)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, existing.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    toggleArchive(db, req.params.id);
    const note = getNote(db, req.params.id);
    res.json({ note });
});
// ── Search routes ──────────────────────────────────────────────────
app.get('/api/vaults/:id/search', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    const query = String(req.query.q || '').trim();
    if (!query)
        return res.json({ results: [] });
    try {
        res.json({ results: searchNotes(db, vault.id, query) });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Search failed' });
    }
});
// ── Backlinks routes ───────────────────────────────────────────────
app.get('/api/notes/:id/backlinks', requireAuth, (req, res) => {
    const note = getNote(db, req.params.id);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, note.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    res.json({ backlinks: getBacklinks(db, req.params.id) });
});
// ── Tag routes ─────────────────────────────────────────────────────
app.get('/api/vaults/:id/tags', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    res.json({ tags: listTags(db, vault.id) });
});
app.post('/api/notes/:id/tags', requireAuth, (req, res) => {
    const note = getNote(db, req.params.id);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, note.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    try {
        addTag(db, req.params.id, vault.id, String(req.body.name || ''), req.body.color);
        const updated = getNote(db, req.params.id);
        res.json({ note: updated });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add tag' });
    }
});
app.delete('/api/notes/:id/tags/:tagId', requireAuth, (req, res) => {
    const note = getNote(db, req.params.id);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, note.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    removeTag(db, req.params.id, req.params.tagId);
    const updated = getNote(db, req.params.id);
    res.json({ note: updated });
});
// ── Version routes ─────────────────────────────────────────────────
app.get('/api/notes/:id/versions', requireAuth, (req, res) => {
    const note = getNote(db, req.params.id);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, note.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    res.json({ versions: listNoteVersions(db, req.params.id) });
});
app.get('/api/notes/:id/diff', requireAuth, (req, res) => {
    const note = getNote(db, req.params.id);
    if (!note)
        return res.status(404).json({ error: 'Note not found' });
    const vault = getVault(db, note.vault_id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Note not found' });
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (from && to) {
        const diff = diffNoteVersions(db, from, to);
        if (!diff)
            return res.status(404).json({ error: 'Version not found' });
        return res.json({ diff });
    }
    // Diff current content against latest version
    const versions = listNoteVersions(db, req.params.id);
    const latest = versions[0];
    if (!latest)
        return res.json({ diff: diffText('', note.content, 'empty', note.title) });
    const latestVersion = db.prepare('SELECT content FROM note_versions WHERE id = ?').get(latest.id);
    res.json({ diff: diffText(latestVersion?.content || '', note.content, `version-${latest.id.slice(0, 8)}`, note.title) });
});
// ── Graph routes ───────────────────────────────────────────────────
app.get('/api/vaults/:id/graph', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    res.json(getGraph(db, vault.id));
});
// ── Feed routes ───────────────────────────────────────────────────
app.post('/api/vaults/:id/feed', requireAuth, async (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!url)
        return res.status(400).json({ error: 'Feed URL is required' });
    try {
        const feed = await fetchFeed(url, { force: Boolean(req.body?.force) });
        res.json({ feed });
    }
    catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'Could not fetch feed' });
    }
});
app.post('/api/vaults/:id/feed/poll', requireAuth, async (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    await pollWidgetFeeds(db);
    res.json({ ok: true });
});
// ── Agent / Run routes ─────────────────────────────────────────────
app.get('/api/vaults/:id/runs', requireAuth, (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    res.json({ runs: listRuns(db, vault.id) });
});
app.post('/api/vaults/:id/runs', requireAuth, async (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    const { prompt, note_id, agent, conversation_id, images, model, cwd } = req.body;
    if (!prompt || !prompt.trim()) {
        return res.status(400).json({ error: 'Prompt is required' });
    }
    const validAgents = ['claude-code', 'codex', 'grok', 'antigravity', 'copilot', 'hermes'];
    const selectedAgent = validAgents.includes(agent) ? agent : 'claude-code';
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
    let selectedCwd;
    if (typeof cwd === 'string' && cwd.trim()) {
        const rawCwd = cwd.trim();
        if (!/^(vault\s*root|root|\.\/?)$/i.test(rawCwd)) {
            const expandedCwd = rawCwd === '~'
                ? os.homedir()
                : rawCwd.startsWith('~/')
                    ? path.join(os.homedir(), rawCwd.slice(2))
                    : rawCwd;
            const resolvedCwd = path.resolve(path.isAbsolute(expandedCwd) ? expandedCwd : path.join(vault.root_path, expandedCwd));
            if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
                return res.status(400).json({ error: 'cwd must be an existing directory' });
            }
            selectedCwd = resolvedCwd;
        }
    }
    // Sanitize image attachments to { media_type, data } base64 entries.
    const cleanImages = Array.isArray(images)
        ? images
            .filter((im) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
            .slice(0, 8)
            .map((im) => ({ media_type: im.media_type, data: im.data }))
        : [];
    try {
        const run = await startRun(db, vault, note_id || null, prompt, selectedAgent, {
            conversationId: typeof conversation_id === 'string' && conversation_id ? conversation_id : undefined,
            images: cleanImages,
            model: selectedModel,
            cwd: selectedCwd,
        });
        res.json({ run });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get('/api/vaults/:id/widget-data/:key', requireAuth, async (req, res) => {
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    const key = String(req.params.key || '').trim();
    if (!key)
        return res.status(400).json({ error: 'Widget data key is required' });
    try {
        const result = await fetchWidgetData(vault.root_path, key, {
            force: req.query.force === '1' || req.query.force === 'true',
        });
        res.json(result);
    }
    catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Could not fetch widget data' });
    }
});
app.post('/api/vaults/:id/widget-command', requireAuth, async (req, res) => {
    if (!WIDGET_SHELL_ENABLED) {
        return res.status(403).json({
            error: 'Widget terminal commands are disabled on this server',
        });
    }
    const vault = getVault(db, req.params.id, req.user.id);
    if (!vault)
        return res.status(404).json({ error: 'Vault not found' });
    const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
    if (!command)
        return res.status(400).json({ error: 'Command is required' });
    if (command.length > 4000)
        return res.status(400).json({ error: 'Command is too long' });
    const timeoutMs = Math.min(Math.max(Number(req.body?.timeout_ms) || 10000, 1000), 30000);
    try {
        const result = await new Promise((resolve, reject) => {
            const child = spawn('/bin/bash', ['-lc', command], {
                cwd: vault.root_path,
                env: process.env,
            });
            let stdout = '';
            let stderr = '';
            let timedOut = false;
            const limit = 64 * 1024;
            const appendCapped = (current, chunk) => (current + chunk.toString()).slice(-limit);
            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
            }, timeoutMs);
            child.stdout.on('data', (chunk) => { stdout = appendCapped(stdout, chunk); });
            child.stderr.on('data', (chunk) => { stderr = appendCapped(stderr, chunk); });
            child.on('error', reject);
            child.on('close', (code) => {
                clearTimeout(timer);
                resolve({ stdout, stderr, exit_code: code, timed_out: timedOut });
            });
        });
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.get('/api/runs/:id', requireAuth, (req, res) => {
    const run = getRun(db, Number(req.params.id));
    if (!run)
        return res.status(404).json({ error: 'Run not found' });
    const vault = getVault(db, run.vault_id, req.user.id);
    if (!vault)
        return res.status(403).json({ error: 'Access denied' });
    res.json({ run });
});
app.get('/api/runs/:id/events', requireAuth, (req, res) => {
    const run = getRun(db, Number(req.params.id));
    if (!run)
        return res.status(404).json({ error: 'Run not found' });
    const vault = getVault(db, run.vault_id, req.user.id);
    if (!vault)
        return res.status(403).json({ error: 'Access denied' });
    res.json({ events: listRunEvents(db, run.id) });
});
app.post('/api/runs/:id/messages', requireAuth, async (req, res) => {
    const run = getRun(db, Number(req.params.id));
    if (!run)
        return res.status(404).json({ error: 'Run not found' });
    const vault = getVault(db, run.vault_id, req.user.id);
    if (!vault)
        return res.status(403).json({ error: 'Access denied' });
    const { message } = req.body;
    try {
        const event = await sendRunMessage(db, run.id, message);
        res.json({ event });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
app.post('/api/runs/:id/cancel', requireAuth, async (req, res) => {
    const run = getRun(db, Number(req.params.id));
    if (!run)
        return res.status(404).json({ error: 'Run not found' });
    const vault = getVault(db, run.vault_id, req.user.id);
    if (!vault)
        return res.status(403).json({ error: 'Access denied' });
    try {
        const success = await cancelRun(db, run.id);
        res.json({ success });
    }
    catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});
// -- Static client ---------------------------------------------------
const clientDistPath = process.env.CASCADE_CLIENT_DIST
    ? path.resolve(process.env.CASCADE_CLIENT_DIST)
    : path.resolve(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath, {
        index: false,
        setHeaders(res, filePath) {
            if (filePath.endsWith('app.html') || filePath.endsWith('index.html')) {
                res.setHeader('Cache-Control', 'no-cache');
            }
        },
    }));
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/socket.io'))
            return next();
        const appHtml = path.join(clientDistPath, 'app.html');
        const indexHtml = path.join(clientDistPath, 'index.html');
        res.sendFile(fs.existsSync(appHtml) ? appHtml : indexHtml);
    });
}
// ── 404 fallback ───────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});
// ── Start server ───────────────────────────────────────────────────
httpServer.listen(PORT, HOST, () => {
    console.log(`Cascade Notes API running on http://${HOST}:${PORT}`);
    console.log(`SQLite database: ${DB_PATH}`);
    if (fs.existsSync(clientDistPath))
        console.log(`Serving client from ${clientDistPath}`);
    startFeedPoller(db);
});
