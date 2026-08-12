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
import compression from 'compression';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import Database from 'better-sqlite3';
import { Server } from 'socket.io';
import {
  addTag,
  createFolder,
  createNote,
  createVault,
  deleteVault,
  renameVault,
  enforceVaultStorageIsolation,
  deleteFolder,
  deleteNote,
  getBacklinks,
  getGraph,
  getNote,
  getVault,
  getWritableVault,
  listFolders,
  listNotes,
  listTags,
  listVaults,
  moveNote,
  unlistNote,
  removeTag,
  renameNote,
  setNoteMutationSink,
  toggleArchive,
  togglePin,
  updateFolder,
  updateNote,
  type Vault,
} from './server/vault.js';
import {
  addVaultMember,
  ensureVaultMembersSchema,
  getVaultRole,
  isReadOnlyVaultMutation,
  isVaultRole,
  listVaultMembers,
  removeVaultMember,
  setVaultMemberRole,
  type VaultRole,
} from './server/vaultMembers.js';
import {
  ensurePublicVaultSchema,
  getPublicVaultDetail,
  getVaultVisibility,
  joinPublicVault,
  listPublicHomeNoteChoices,
  listPublicVaultJoinRequests,
  listPublicVaults,
  reviewPublicVaultJoinRequest,
  setVaultVisibility,
} from './server/publicVaults.js';
import {
  banVaultMember,
  createContentReport,
  ensureCommunityModerationSchema,
  isReportStatus,
  listGlobalReports,
  listVaultBans,
  listVaultReports,
  reviewGlobalReport,
  reviewVaultReport,
  unbanVaultMember,
} from './server/communityModeration.js';
import {
  allowsDirectMessages,
  assertChannelPushAllowed,
  assertDirectMessageSendAllowed,
  assertShareableChatChannel,
  blockUser,
  ensureDirectMessageSchema,
  isDirectMessageChannel,
  listBlockedUsers,
  listDirectMessages,
  openDirectMessage,
  resolveUserByUsername,
  setAllowDirectMessages,
  unblockUser,
  UNREACHABLE_USER_MESSAGE,
  vaultHoldsDirectMessages,
} from './server/directMessages.js';
import {
  ensureCommunityActivitySchema,
  listCommunityUpdates,
  markAllCommunityUpdatesRead,
  markCommunityTargetRead,
  recordCommunityNoteChange,
} from './server/communityActivity.js';
import {
  acquireWorkItemLease,
  addWorkItemTokenUsage,
  bindWorkItemWorkspace,
  createWorkItem,
  createWorkItemHandoff,
  createWorkItemReview,
  ensureWorkItemSchema,
  getWorkItem,
  linkWorkItemRun,
  listSiblingWorkItems,
  listWorkItemReviews,
  listWorkItems,
  listWorkItemsForRun,
  reapExpiredWorkItemLeases,
  reportWorkItemGitState,
  releaseWorkItemLease,
  stopWorkItem,
  updateWorkItem,
  type WorkItemStatus,
  type WorkspaceMode,
} from './server/workItems.js';
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
  listActiveSessions,
  getRun,
  getOwnedRun,
  listRunEvents,
  startRun,
  cancelRun,
  countConversationSessionRuns,
  findConversationSession,
  publishRunEvent,
  finishDelegatedRun,
  findRunByChatDispatch,
  findOpenRunForChatRegistration,
  forceCancelUnreclaimableRun, getDelegatedRunOwnerFromDb,
  listOpenDelegatedRuns,
  type AgentId,
} from './server/runner.js';
import {
  delegateRunToDesktop, getDelegatedRunOwner,
  getDesktopRunnerStatus,
  initDesktopRunners, isDesktopRunnerOnline,
  noteDesktopRunnerError,
  prepareDesktopWorkspace,
  scheduleOrphanReclaimAfterRestart,
  waitForDesktopRunner,
} from './server/desktop-runner.js';
import {
  clearUserSessionCookies,
  corsOrigin,
  NETWORK_MODE,
  passwordPolicyError,
  rateLimit,
  resolveDeploySecret,
  resolveJwtSecret,
  resolveTrustProxyHops,
  securityHeaders,
  sessionIssuedAtIsCurrent,
  sessionTokenFromCookie,
  USER_SESSION_MAX_AGE_SECONDS,
  userSessionCookie,
} from './server/security.js';
import { ensureAndroidBatterySchema, listAndroidBatterySamples, parseAndroidBatterySample, recordAndroidBatterySample } from './server/androidBattery.js';
import { clientAssetCacheControl } from './server/staticAssets.js';
import {
  assertChatChannel,
  agentChatContentFromAccumulator,
  appendAgentChatRunEvents,
  buildAgentChannelWorkspaceContext,
  CASCADE_AGENT_APP_CONTEXT,
  CASCADE_MISSION_DISCRETION_CONTEXT,
  CHAT_NOTE_MARKER,
  createAgentChatContentAccumulator,
  ensureAgentChatMessage,
  ensureChatSchema,
  linkChatChannel,
  listChatChannelRoutes,
  listChatMessages,
  getChatMessage,
  createChatMessage,
  updateChatMessage,
  deleteChatMessage,
  forwardChatMessage,
  approveChatChangeRequest,
  mergeChatChangeRequest,
  answerChatClarification,
  acceptChatClarification,
  attachClarificationMission,
  settleChatMessagesForRun,
  listChatAgentMembers,
  listChatChannelParticipants,
  listChatChannelParticipantUsernames,
  listVaultAgents,
  upsertVaultAgent,
  deleteVaultAgent,
  removeVaultAgentFromVault,
  getVaultAgent,
  addVaultAgentToChannel,
  ensureVaultWideAgents,
  upsertChatAgentMember,
  setChatAgentAvatar,
  removeChatAgentMember,
  resolveChatAgentRun,
  getChannelCwd,
  getChannelSettings,
  setChannelKanbanNoteId,
  ensureChannelOrchestrationKanban,
  setChannelCwd,
  type AgentChatContentAccumulator,
  type ChatMessage,
  type ChatReplyRef,
} from './server/chat.js';
import { createChatCollaboration } from './server/chat-collaboration.js';
import { buildAgentRoomContext, inferNaturalChatLink } from './server/chat-room-context.js';
import {
  attachRunToChatAgentDispatch,
  createChatAgentDispatchForRegistration,
  createChatAgentDispatches,
  ensureChatDispatchSchema,
  getChatAgentDispatch,
  listPendingChatAgentDispatches,
  type ChatAgentDispatch,
} from './server/chat-dispatch.js';
import {
  addChatMissionTask,
  attachRunToMissionTaskByDispatch,
  claimMissionCoordinatorWake,
  createChatMission,
  ensureChatMissionSchema,
  finishChatMission,
  getChatMission,
  getMissionTaskWorkItemId,
  linkMissionTaskDispatch,
  listChatMissionEvents,
  listChatMissions,
  listActiveChatMissions,
  listSchedulableMissionTasks,
  missionRootMessage,
  refreshMissionProjection,
  settleMissionTaskForRun,
  updateChatMissionTask,
  type MissionProjectionUpdate,
  type MissionWake,
} from './server/chat-missions.js';
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
import { ensureManagedAgentSchema, getManagedAgentOperatorStatus, getManagedEntitlement, setManagedEntitlement } from './server/managedAgents.js';
import {
  backfillChatNoteBacklinks,
  buildAgentMemoryInjection,
  createAgentMemoryNote,
  distillChatToNote,
  ensureAgentMemoryFolders,
  ensureAgentNamedMemoryFolders,
  ensureEvolutionSchema,
  indexChatMessageBacklinks,
  isAgentMemoryEnabled,
  listChatNoteBacklinks,
  reresolveChatBacklinksForNote,
  setAgentMemoryEnabled,
  tombstoneChatMessageBacklinks,
} from './server/evolution.js';
import { searchWithQmd } from './server/qmd-search.js';
import { collectLocalAgents } from './server/localAgents.js';
import {
  isAgentApiRequestAllowed,
  redactPrivateBlocks,
  redactPrivatePreview,
  restorePrivateBlocks,
  sanitizeAgentJson,
} from './server/privacy.js';
import {
  appendJournalEntry,
  buildScratchpadInjection,
  closeOpenThread,
  createSkillNote,
  deleteNoteStats,
  ensureScratchpadPolicies,
  ensureScratchpadSchema,
  getNoteStatsForVault,
  listJournalEntries,
  listOpenThreads,
  listSkillNotes,
  markJournalConsolidated,
  openThread,
  promoteNote,
  recallScratchpad,
  recordNoteOutcome,
  scratchpadStatus,
} from './server/scratchpad.js';

const PORT = Number(process.env.API_PORT || 3000);
// Budget for explicit semantic scratchpad recall (0 disables it). Chat run
// startup intentionally stays on the in-process lexical path.
const SCRATCHPAD_QMD_TIMEOUT_MS = Math.max(0, Number(process.env.SCRATCHPAD_QMD_TIMEOUT_MS ?? 4000));
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
const CLIENT_DIST_DIR = process.env.CASCADE_CLIENT_DIST_DIR || path.join(process.cwd(), 'client', 'dist');
const CLIENT_APP_HTML = path.join(CLIENT_DIST_DIR, 'app.html');
const LANDING_HTML = path.join(CLIENT_DIST_DIR, 'landing.html');
// Sideload "Cascade Dev" APK is NOT baked into the Docker image (30MB+ blobs
// break deploy SSH mid-build). Prefer, in order:
//   1) client/dist (local `npm run android:apk`)
//   2) CASCADE_DATA_DIR volume (production: Actions scp → /var/lib/cascade)
//   3) downloads dir
// Repo is private — do not redirect to GitHub Releases for anonymous phones.
function resolveAndroidApkPath(): string | null {
  const candidates = [
    path.join(CLIENT_DIST_DIR, 'cascade-android.apk'),
    path.join(DATA_DIR, 'cascade-android.apk'),
    path.join(DATA_DIR, 'downloads', 'cascade-android.apk'),
    path.join(process.env.CASCADE_DOWNLOADS_DIR || path.join(CLIENT_DIST_DIR, 'downloads'), 'cascade-android.apk'),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}
// Desktop installers live in the persistent data volume, not client/dist: a
// routine web deploy must not discard a working beta installer. The desktop
// release workflow copies its verified native packages here.
const DOWNLOADS_DIR = process.env.CASCADE_DOWNLOADS_DIR || path.join(DATA_DIR, 'downloads');
const DESKTOP_BUILDS: Record<string, string> = {
  'mac-arm64': 'Fizzer-mac-arm64.dmg',
  'mac-x64': 'Fizzer-mac-x64.dmg',
  windows: 'Fizzer-Setup.exe',
  'linux-deb': 'Fizzer-linux-x64.deb',
  'linux-rpm': 'Fizzer-linux-x64.rpm',
};

function desktopChooser(title: string, options: Array<{ label: string; href: string; detail: string }>) {
  const choices = options.map(({ label, href, detail }) => `<a href="${href}"><strong>${label}</strong><span>${detail}</span></a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Fizzer</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12100e;color:#f1ede7;font:16px system-ui,sans-serif}.box{width:min(460px,calc(100% - 40px));padding:28px;border:1px solid #3c3328;border-radius:14px;background:#1a1714}h1{margin:0 0 8px;font-size:24px}p{margin:0 0 20px;color:#bcb4aa;line-height:1.45}a{display:block;margin:10px 0;padding:14px;border:1px solid #514432;border-radius:9px;color:inherit;text-decoration:none}a:hover{border-color:#d99a3e;background:#241d15}a span{display:block;margin-top:4px;color:#bcb4aa;font-size:13px}</style></head><body><main class="box"><h1>${title}</h1><p>Choose the package for this computer.</p>${choices}</main></body></html>`;
}

type User = { id: number; username: string; display_name: string; avatar_url: string; auth_version: number; password_hash: string; created_at: string };
type AuthAccess = 'user' | 'agent';
type AuthedRequest = Request & {
  user?: { id: number; username: string; access: AuthAccess };
  authSource?: 'bearer' | 'cookie';
};
type ChatInviteToken = {
  type: 'chat-invite';
  sourceVaultId: string;
  sourceChannelId: string;
};
/** Share link that adds its redeemer to a vault's member list at `role`. */
type VaultInviteToken = {
  type: 'vault-invite';
  vaultId: string;
  role: VaultRole;
};

// A fixed valid hash keeps unknown-account login work comparable to a real
// password check without storing or accepting a usable credential.
const LOGIN_DUMMY_HASH = '$2b$12$0xQSnejvHHJfgQrY0lUZHODbknE0RkbCdLGD3WCpFE4mctENcqNFW';

// ── Database ───────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    auth_version INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS registration_invites_used (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    is_listed INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
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

const userColumns = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
if (!userColumns.some((column) => column.name === 'display_name')) {
  db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.some((column) => column.name === 'avatar_url')) {
  db.exec("ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''");
}
if (!userColumns.some((column) => column.name === 'auth_version')) {
  db.exec("ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0");
}

// Existing installations predate unlisted notes. SQLite has no portable
// ADD COLUMN IF NOT EXISTS, so inspect the schema before applying the migration.
if (!(db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).some((column) => column.name === 'is_listed')) {
  db.exec('ALTER TABLE notes ADD COLUMN is_listed INTEGER NOT NULL DEFAULT 1');
}

// Sidebar order predates note positions. Preserve the order people were
// already seeing on first migration, then let drag-and-drop own it from there.
if (!(db.prepare("PRAGMA table_info(notes)").all() as { name: string }[]).some((column) => column.name === 'position')) {
  db.exec('ALTER TABLE notes ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  const rows = db.prepare(`
    SELECT id, vault_id, folder_id
    FROM notes
    WHERE is_listed = 1
    ORDER BY vault_id, folder_id, is_pinned DESC, updated_at DESC, id
  `).all() as Array<{ id: string; vault_id: string; folder_id: string | null }>;
  const positions = new Map<string, number>();
  const update = db.prepare('UPDATE notes SET position = ? WHERE id = ?');
  const backfill = db.transaction(() => {
    for (const row of rows) {
      const key = `${row.vault_id}:${row.folder_id ?? ''}`;
      const position = positions.get(key) ?? 0;
      update.run(position, row.id);
      positions.set(key, position + 1);
    }
  });
  backfill();
}

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

/** Rebuild FTS5 indexes when triggers/getters drift after bulk deletes. */
function rebuildSearchIndexes(db: Database.Database): void {
  for (const table of ['notes_fts', 'chat_messages_fts'] as const) {
    try {
      db.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`);
    } catch (error) {
      console.warn(`[db] ${table} rebuild skipped:`, error instanceof Error ? error.message : error);
    }
  }
}

ensureRunnerSchema(db);
// In-memory desktop sockets die with the process, but local agents often keep
// running. Defer orphan settle so reconnecting desktops can reclaim mid-flight
// runs (see scheduleOrphanReclaimAfterRestart + activeRunIds on register).
ensureChatSchema(db);
ensureChatDispatchSchema(db);
ensureChatMissionSchema(db);
ensureVaultMembersSchema(db);
ensurePublicVaultSchema(db);
ensureCommunityModerationSchema(db);
ensureDirectMessageSchema(db);
ensureCommunityActivitySchema(db);
ensureAndroidBatterySchema(db);
ensureManagedAgentSchema(db);
// Hard boundary: rehome any vaults still sharing an on-disk root (legacy leak path).
try {
  const isolation = enforceVaultStorageIsolation(db);
  if (isolation.rehomed > 0) {
    console.warn(`[vault-isolation] rehomed ${isolation.rehomed} vault(s) off shared roots at boot`);
  }
} catch (err) {
  console.error('[vault-isolation] boot enforce failed:', err);
}
ensureWorkItemSchema(db);
try { reapExpiredWorkItemLeases(db); } catch { /* best-effort on boot */ }
db.exec(`
  CREATE TABLE IF NOT EXISTS chat_note_grants (
    message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    granted_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (message_id, note_id)
  );
  CREATE INDEX IF NOT EXISTS chat_note_grants_channel_idx ON chat_note_grants(channel_id, message_id);
`);
// Snapshots freeze what was shared at embed time — guests never get live vault content.
try { db.exec('ALTER TABLE chat_note_grants ADD COLUMN title_snapshot TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE chat_note_grants ADD COLUMN content_snapshot TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE chat_note_grants ADD COLUMN preview_snapshot TEXT'); } catch { /* exists */ }
ensurePublishSchema(db);
ensureEvolutionSchema(db);
ensureScratchpadSchema(db);
rebuildSearchIndexes(db);

// ── Express & Socket.io setup ──────────────────────────────────────

const app = express();
const corsOriginOption = corsOrigin();
const trustProxyHops = resolveTrustProxyHops();
app.disable('x-powered-by');
if (trustProxyHops > 0) app.set('trust proxy', trustProxyHops);
// The production nginx layer proxies application responses as-is. Compress at
// this boundary so text bundles and JSON do not cross the network byte-for-byte.
app.use(securityHeaders());
app.use(compression());
app.use(cors({ origin: corsOriginOption, credentials: true }));
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof Error && error.message === 'Origin is not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  next(error);
});
// Bound hostile request streams before JSON parsing allocates their bodies.
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: 'Too many authentication attempts. Please try again later.',
}));
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 1200 }));
// A SameSite=None cookie is required by the Capacitor app's https://localhost
// origin. Require a non-simple browser header on authenticated mutations so a
// third-party form cannot ride that cookie; CORS then gates the preflight.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!sessionTokenFromCookie(req.headers.cookie)) return next();
  if (req.headers.authorization?.startsWith('Bearer ')) return next();
  if (req.headers['x-cascade-browser'] === '1') return next();
  return res.status(403).json({ error: 'Authenticated browser request was missing CSRF protection' });
});
// Media attachments are base64 in JSON; 8MB files expand to ~10.7MB.
app.use(express.json({ limit: '12mb' }));
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

function disconnectUserSockets(userId: number) {
  for (const namespace of [runsNamespace, vaultNamespace]) {
    for (const socket of namespace.sockets.values()) {
      if ((socket.data.user as { id?: number } | undefined)?.id === userId) socket.disconnect(true);
    }
  }
}

// ── Auth helpers ───────────────────────────────────────────────────

function tokenIdentity(user: { id: number; username: string; auth_version?: number }) {
  const authVersion = user.auth_version ?? (db.prepare('SELECT auth_version FROM users WHERE id = ?').get(user.id) as { auth_version?: number } | undefined)?.auth_version ?? 0;
  return { id: user.id, username: user.username, authVersion };
}

function signToken(user: { id: number; username: string; auth_version?: number }) {
  return jwt.sign(
    { ...tokenIdentity(user), access: 'user' satisfies AuthAccess },
    JWT_SECRET,
    { expiresIn: USER_SESSION_MAX_AGE_SECONDS },
  );
}

function signAgentToken(user: { id: number; username: string; auth_version?: number }) {
  return jwt.sign(
    { ...tokenIdentity(user), access: 'agent' satisfies AuthAccess },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

type SessionClaims = {
  id: number;
  username: string;
  authVersion?: number;
  access?: AuthAccess;
  iat?: number;
};

function verifiedSessionClaims(token: string): SessionClaims | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as SessionClaims;
    if (!sessionIssuedAtIsCurrent(decoded.iat)) return null;
    const current = db.prepare('SELECT username, auth_version FROM users WHERE id = ?').get(decoded.id) as {
      username: string;
      auth_version: number;
    } | undefined;
    if (!current || current.username !== decoded.username || current.auth_version !== (decoded.authVersion ?? 0)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function verifiedRequestSession(req: Request) {
  const header = req.headers.authorization;
  const bearerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  const cookieToken = sessionTokenFromCookie(req.headers.cookie);
  const candidates = [
    ...(bearerToken ? [{ source: 'bearer' as const, token: bearerToken }] : []),
    ...(cookieToken && cookieToken !== bearerToken ? [{ source: 'cookie' as const, token: cookieToken }] : []),
  ];
  return candidates
    .map((candidate) => ({ ...candidate, decoded: verifiedSessionClaims(candidate.token) }))
    .find((candidate) => candidate.decoded !== null) ?? null;
}

function publicUser(user: { id: number; username: string; display_name?: string; avatar_url?: string }) {
  return {
    id: user.id,
    username: user.username,
    displayName: String(user.display_name || user.username),
    avatarUrl: String(user.avatar_url || ''),
  };
}

/** The server owner is the first-registered account (lowest user id). */
function isOwner(userId: number): boolean {
  const row = db.prepare('SELECT MIN(id) AS ownerId FROM users').get() as { ownerId: number | null };
  return row.ownerId != null && row.ownerId === userId;
}

function signChatInvite(sourceVaultId: string, sourceChannelId: string) {
  return jwt.sign(
    { type: 'chat-invite', sourceVaultId, sourceChannelId } satisfies ChatInviteToken,
    JWT_SECRET,
    { expiresIn: '7d' },
  );
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

function signVaultInvite(vaultId: string, role: VaultRole) {
  return jwt.sign(
    { type: 'vault-invite', vaultId, role } satisfies VaultInviteToken,
    JWT_SECRET,
    { expiresIn: '7d' },
  );
}

function verifyVaultInvite(token: string): VaultInviteToken {
  const decoded = jwt.verify(token, JWT_SECRET) as Partial<VaultInviteToken>;
  if (decoded.type !== 'vault-invite' || typeof decoded.vaultId !== 'string' || !isVaultRole(decoded.role)) {
    throw new Error('Invalid invite link');
  }
  // An invite can never mint another owner, whatever the token claims.
  if (decoded.role === 'owner') throw new Error('Invalid invite link');
  return { type: 'vault-invite', vaultId: decoded.vaultId, role: decoded.role };
}

function validRegistrationInviteHash(rawToken: unknown): string | null {
  const token = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (db.prepare('SELECT 1 FROM registration_invites_used WHERE token_hash = ?').get(tokenHash)) return null;
  try {
    const invite = verifyChatInvite(token);
    const source = db.prepare(`
      SELECT note.id
      FROM notes note JOIN vaults vault ON vault.id = note.vault_id
      WHERE note.id = ? AND vault.id = ?
    `).get(invite.sourceChannelId, invite.sourceVaultId);
    if (source) return tokenHash;
  } catch {
    // It may be a vault invite instead.
  }
  try {
    const invite = verifyVaultInvite(token);
    return db.prepare('SELECT id FROM vaults WHERE id = ?').get(invite.vaultId) ? tokenHash : null;
  } catch {
    return null;
  }
}

function setUserSession(res: Response, user: { id: number; username: string; auth_version?: number }): string {
  const token = signToken(user);
  res.append('Set-Cookie', userSessionCookie(token));
  return token;
}

/** Browser callers receive only an HttpOnly cookie; CLI callers retain bearer compatibility. */
function authResponse(req: Request, res: Response, user: User | { id: number; username: string }) {
  const token = setUserSession(res, user);
  return {
    user: publicUser(user),
    ...(req.headers['x-cascade-browser'] === '1' ? {} : { token }),
    owner: isOwner(user.id),
  };
}

function agentRouteAllowed(method: string, pathname: string): boolean {
  return isAgentApiRequestAllowed(method, pathname);
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const verified = verifiedRequestSession(req);
  if (!verified?.decoded) return res.status(401).json({ error: 'Invalid or expired token' });

  try {
    const { decoded } = verified;
    req.user = {
      id: decoded.id,
      username: decoded.username,
      access: decoded.access === 'agent' ? 'agent' : 'user',
    };
    req.authSource = verified.source;
    // One-release migration: a valid legacy browser bearer can trade itself
    // for an HttpOnly cookie, after which the renderer deletes localStorage.
    if (
      req.authSource === 'bearer'
      && req.user.access === 'user'
      && req.headers['x-cascade-session-migrate'] === '1'
    ) {
      res.append('Set-Cookie', userSessionCookie(verified.token));
    }
    if (req.user.access === 'agent' && !agentRouteAllowed(req.method, req.path)) {
      return res.status(403).json({ error: 'This operation requires user access' });
    }
    if (req.user.access === 'agent') {
      const json = res.json.bind(res);
      res.json = ((body: unknown) => json(sanitizeAgentJson(body))) as Response['json'];
    }
    if (isReadOnlyVaultMutation(db, req.user.id, req.method, req.path)) {
      return res.status(403).json({ error: 'Viewer role cannot modify this vault' });
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function isAgentRequest(req: AuthedRequest): boolean {
  return req.user?.access === 'agent';
}

/** Never expose host filesystem paths to clients or agents. */
function stripNoteHostPath<T extends { file_path?: string }>(note: T | null | undefined): Omit<T, 'file_path'> | null | undefined {
  if (!note) return note;
  const { file_path: _omit, ...rest } = note as T & { file_path?: string };
  void _omit;
  return rest as Omit<T, 'file_path'>;
}

function redactNoteForAgent<T extends { content?: string; content_preview?: string; file_path?: string }>(
  req: AuthedRequest,
  note: T | null | undefined,
): Omit<T, 'file_path'> | null | undefined {
  const stripped = stripNoteHostPath(note);
  if (!stripped || !isAgentRequest(req)) return stripped;
  return {
    ...stripped,
    ...(typeof stripped.content === 'string' ? { content: redactPrivateBlocks(stripped.content) } : {}),
    ...(typeof stripped.content_preview === 'string'
      ? { content_preview: redactPrivatePreview(stripped.content_preview) }
      : {}),
  };
}

function requireUserAccess(req: AuthedRequest, res: Response, next: NextFunction) {
  if (isAgentRequest(req)) {
    return res.status(403).json({ error: 'This operation requires user access' });
  }
  next();
}

// ── Socket.io auth & namespaces ────────────────────────────────────

function socketAuth(socket: { handshake: { auth: { token?: unknown } }; data: Record<string, unknown> }, next: (err?: Error) => void) {
  const handshake = socket.handshake as typeof socket.handshake & { headers?: { cookie?: string } };
  const authToken = typeof socket.handshake.auth.token === 'string' ? socket.handshake.auth.token : null;
  const cookieToken = sessionTokenFromCookie(handshake.headers?.cookie);
  const decoded = [authToken, cookieToken]
    .filter((token, index, all): token is string => Boolean(token) && all.indexOf(token) === index)
    .map(verifiedSessionClaims)
    .find((claims) => claims !== null);
  if (!decoded) return next(new Error(authToken || cookieToken ? 'Invalid or expired token' : 'Authentication required'));
  try {
    if (decoded.access === 'agent') return next(new Error('This operation requires user access'));
    socket.data.user = { id: decoded.id, username: decoded.username };
    next();
  } catch {
    next(new Error('Invalid or expired token'));
  }
}

runsNamespace.use(socketAuth);
vaultNamespace.use(socketAuth);

vaultNamespace.on('connection', (socket) => {
  const connectedUser = socket.data.user as { id: number };
  socket.join(`user:${connectedUser.id}`);
  // Presence means the person has Cascade open, not that a particular chat
  // tab happens to be visible. Refresh each channel they participate in.
  void emitUserChatPresence(connectedUser.id);
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
      const participants = listChatChannelParticipantUsernames(db, route.sourceVaultId, route.sourceChannelId);
      const online = await getOnlineUsernamesForChannel(participants);
      const owner = db.prepare(`
        SELECT u.username FROM vaults v JOIN users u ON u.id = v.created_by WHERE v.id = ?
      `).get(route.sourceVaultId) as { username: string } | undefined;
      const profiles = buildChatPresenceProfiles(participants);
      socket.emit('vault:chatPresence', {
        vaultId: route.localVaultId,
        channelId: localChannelId,
        online,
        participants,
        owner: owner?.username || '',
        profiles,
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
    if (tracked?.size) {
      for (const [sourceChannelId, sourceVaultId] of tracked.entries()) {
        await emitChatPresence(sourceVaultId, sourceChannelId);
      }
      tracked.clear();
    }
    // A user may have several Cascade windows. Only publish offline after the
    // final app socket is gone.
    const remaining = await vaultNamespace.in(`user:${connectedUser.id}`).fetchSockets();
    if (remaining.length === 0) await emitUserChatPresence(connectedUser.id);
  });
});

runsNamespace.on('connection', (socket) => {
  socket.on('joinRun', async (runId: number) => {
    const user = socket.data.user as { id: number };
    const id = Number(runId);
    if (!Number.isFinite(id)) return;
    if (!getOwnedRun(db, id, user.id)) return;
    await socket.join(`run:${id}`);
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
  if (event === 'vault:noteDeleted' || event === 'vault:membersChanged') {
    emitCommunityChangedForVault(vaultId);
  }
}

function emitCommunityChangedForUsers(userIds: Iterable<number>): void {
  for (const userId of new Set(userIds)) {
    vaultNamespace.to(`user:${userId}`).emit('community:changed', {});
  }
}

function emitCommunityChangedForVault(vaultId: string): void {
  const users = db.prepare('SELECT user_id AS userId FROM vault_members WHERE vault_id = ?')
    .all(vaultId) as Array<{ userId: number }>;
  emitCommunityChangedForUsers(users.map((row) => row.userId));
}

function emitCommunityChangedForChannel(sourceVaultId: string, sourceChannelId: string): void {
  const users = db.prepare(`
    SELECT user_id AS userId FROM vault_members WHERE vault_id = ?
    UNION
    SELECT membership.user_id AS userId
    FROM chat_channel_links link
    JOIN vault_members membership ON membership.vault_id = link.local_vault_id
    WHERE link.source_channel_id = ?
  `).all(sourceVaultId, sourceChannelId) as Array<{ userId: number }>;
  emitCommunityChangedForUsers(users.map((row) => row.userId));
}

/** Profile changes are visible only to accounts sharing a vault or chat route. */
function emitUserProfileUpdated(userId: number, profile: ReturnType<typeof publicUser>): void {
  const audience = db.prepare(`
    WITH my_sources(sourceChannelId) AS (
      SELECT DISTINCT COALESCE(link.source_channel_id, local.id)
      FROM notes local
      JOIN vault_members membership
        ON membership.vault_id = local.vault_id AND membership.user_id = ?
      LEFT JOIN chat_channel_links link ON link.local_channel_id = local.id
      WHERE local.content_preview LIKE 'cascade://chat-channel%'
         OR local.content LIKE 'cascade://chat-channel%'
    ),
    audience_vaults(vaultId) AS (
      SELECT vault_id FROM vault_members WHERE user_id = ?
      UNION
      SELECT source.vault_id
      FROM notes source JOIN my_sources mine ON mine.sourceChannelId = source.id
      UNION
      SELECT link.local_vault_id
      FROM chat_channel_links link JOIN my_sources mine ON mine.sourceChannelId = link.source_channel_id
    )
    SELECT DISTINCT member.user_id AS userId
    FROM audience_vaults audience
    JOIN vault_members member ON member.vault_id = audience.vaultId
    UNION SELECT ? AS userId
  `).all(userId, userId, userId) as Array<{ userId: number }>;
  for (const recipient of audience) {
    vaultNamespace.to(`user:${recipient.userId}`).emit('vault:userProfileUpdated', profile);
  }
}

setNoteMutationSink((database, noteId, actorUserId) => {
  recordCommunityNoteChange(database, noteId, actorUserId);
  const note = database.prepare('SELECT vault_id AS vaultId FROM notes WHERE id = ?')
    .get(noteId) as { vaultId: string } | undefined;
  if (note) emitCommunityChangedForVault(note.vaultId);
});

function emitChatMessageEvent(
  sourceVaultId: string,
  sourceChannelId: string,
  event: 'vault:chatMessageCreated' | 'vault:chatMessageUpdated',
  message: ChatMessage,
  dispatches: ChatAgentDispatch[] = [],
) {
  const countable = !message.agentId
    || (!['sending', 'running'].includes(message.status || '')
      && message.body.trim() !== ''
      && message.body.trim() !== 'Thinking...');
  if (countable) emitCommunityChangedForChannel(sourceVaultId, sourceChannelId);
  for (const route of listChatChannelRoutes(db, sourceVaultId, sourceChannelId)) {
    const localOwner = db.prepare('SELECT created_by FROM vaults WHERE id = ?')
      .get(route.localVaultId) as { created_by: number } | undefined;
    const routeDispatches = dispatches.filter((dispatch) => (
      dispatch.registration.ownerUserId === localOwner?.created_by
      || dispatch.registration.pingableByOthers
    ));
    emitVaultEvent(route.localVaultId, event, {
      vaultId: route.localVaultId,
      channelId: route.localChannelId,
      message: { ...message, channelId: route.localChannelId },
      ...(routeDispatches.length > 0 ? {
        dispatches: routeDispatches.map((dispatch) => ({
          ...dispatch,
          channelId: route.localChannelId,
          message: { ...dispatch.message, channelId: route.localChannelId },
        })),
      } : {}),
    });
  }
}

function emitMissionProjection(update: MissionProjectionUpdate) {
  const message = missionRootMessage(db, update);
  if (message) {
    emitChatMessageEvent(update.vaultId, update.channelId, 'vault:chatMessageUpdated', message);
  }
}

/** Materialize every dependency-ready task into the durable chat dispatch outbox. */
function scheduleMissionWork(missionId?: string) {
  const result = db.transaction(() => {
    const scheduled = listSchedulableMissionTasks(db, missionId);
    const dispatches: Array<{
      message: ChatMessage;
      dispatch: ChatAgentDispatch;
      update: MissionProjectionUpdate;
    }> = [];
    for (const candidate of scheduled.candidates) {
      const message = createChatMessage(db, candidate.createdBy, candidate.vaultId, candidate.channelId, {
        id: candidate.attempt > 0
          ? `mission-task-${candidate.taskId}-${candidate.attempt}`
          : `mission-task-${candidate.taskId}`,
        channelId: candidate.channelId,
        author: '',
        body: `@${listChatAgentMembers(db, candidate.channelId, candidate.createdBy)
          .find((member) => member.id === candidate.assigneeRegistrationId)?.mention || 'agent'} ${candidate.prompt}`,
        createdAt: new Date().toISOString(),
        registrationId: candidate.coordinatorRegistrationId,
        missionTaskId: candidate.taskId,
      });
      const dispatch = createChatAgentDispatchForRegistration(
        db,
        candidate.createdBy,
        candidate.channelId,
        message,
        candidate.assigneeRegistrationId,
        { reasoningEffort: candidate.reasoningEffort },
      );
      const update = linkMissionTaskDispatch(db, candidate.taskId, dispatch.id);
      dispatches.push({ message, dispatch, update });
    }
    const affectedMissionIds = new Set([
      ...scheduled.updates.map((update) => update.mission.id),
      ...scheduled.candidates.map((candidate) => candidate.missionId),
      ...(missionId ? [missionId] : []),
    ]);
    const wakes = Array.from(affectedMissionIds)
      .map((id) => claimMissionCoordinatorWake(db, id))
      .filter((wake): wake is MissionWake => Boolean(wake));
    const finalUpdate = missionId ? refreshMissionProjection(db, missionId) : undefined;
    return { ...scheduled, dispatches, wakes, finalUpdate };
  })();
  for (const update of result.updates) emitMissionProjection(update);
  for (const item of result.dispatches) {
    emitChatMessageEvent(item.update.vaultId, item.update.channelId, 'vault:chatMessageCreated', item.message, [item.dispatch]);
    emitMissionProjection(item.update);
  }
  for (const wake of result.wakes) enqueueMissionCoordinatorWake(wake);
  if (result.finalUpdate) emitMissionProjection(result.finalUpdate);
  return result;
}

/**
 * A mission worker dispatch is durable work, not a one-shot supervisor hint.
 * Re-broadcast unclaimed task dispatches so a renderer that missed the original
 * socket event (or had an orphaned local session queue) can claim them without
 * waiting for a coordinator turn, tab change, or reconnect.
 */
function reannouncePendingMissionDispatches() {
  const pending = db.prepare(`
    SELECT t.dispatch_id AS dispatchId, m.created_by AS createdBy,
      m.vault_id AS vaultId, m.channel_id AS channelId
    FROM chat_mission_tasks t
    JOIN chat_missions m ON m.id = t.mission_id
    JOIN chat_agent_dispatches d ON d.id = t.dispatch_id
    WHERE t.status = 'pending' AND t.run_id IS NULL
      AND d.run_id IS NULL AND t.dispatch_id IS NOT NULL
  `).all() as Array<{ dispatchId: string; createdBy: number; vaultId: string; channelId: string }>;
  for (const item of pending) {
    const dispatch = getChatAgentDispatch(db, item.createdBy, item.channelId, item.dispatchId);
    if (!dispatch) continue;
    emitChatMessageEvent(item.vaultId, item.channelId, 'vault:chatMessageUpdated', dispatch.message, [dispatch]);
  }
}

function emitChatMessageDeleted(sourceVaultId: string, sourceChannelId: string, messageId: string) {
  emitCommunityChangedForChannel(sourceVaultId, sourceChannelId);
  for (const route of listChatChannelRoutes(db, sourceVaultId, sourceChannelId)) {
    emitVaultEvent(route.localVaultId, 'vault:chatMessageDeleted', {
      vaultId: route.localVaultId,
      channelId: route.localChannelId,
      messageId,
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

async function getOnlineUsernamesForChannel(participants: string[]): Promise<string[]> {
  const sockets = await vaultNamespace.fetchSockets();
  const allowed = new Set(participants);
  const names = new Set<string>();
  for (const socket of sockets) {
    const user = socket.data.user as { username?: string } | undefined;
    if (user?.username && allowed.has(user.username)) names.add(user.username);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function listChatPresenceChannelsForUser(userId: number): Array<{ sourceVaultId: string; sourceChannelId: string }> {
  const rows = db.prepare(`
    SELECT n.vault_id AS sourceVaultId, n.id AS sourceChannelId
    FROM notes n JOIN vaults v ON v.id = n.vault_id
    WHERE v.created_by = ? AND n.content LIKE ?
    UNION
    SELECT l.source_vault_id AS sourceVaultId, l.source_channel_id AS sourceChannelId
    FROM chat_channel_links l JOIN vaults v ON v.id = l.local_vault_id
    WHERE v.created_by = ?
  `).all(userId, `${CHAT_NOTE_MARKER}%`, userId) as Array<{ sourceVaultId: string; sourceChannelId: string }>;
  return rows;
}

async function emitUserChatPresence(userId: number): Promise<void> {
  for (const { sourceVaultId, sourceChannelId } of listChatPresenceChannelsForUser(userId)) {
    await emitChatPresence(sourceVaultId, sourceChannelId);
  }
}

function buildChatPresenceProfiles(participantUsernames: string[]) {
  if (!participantUsernames.length) return {} as Record<string, ReturnType<typeof publicUser>>;
  const profileRows = db.prepare(
    `SELECT id, username, display_name, avatar_url FROM users WHERE username IN (${participantUsernames.map(() => '?').join(',')})`,
  ).all(...participantUsernames) as User[];
  return Object.fromEntries(profileRows.map((user) => [user.username, publicUser(user)]));
}

async function emitChatPresence(sourceVaultId: string, sourceChannelId: string) {
  const participants = listChatChannelParticipantUsernames(db, sourceVaultId, sourceChannelId);
  const online = await getOnlineUsernamesForChannel(participants);
  const owner = db.prepare(`
    SELECT u.username FROM vaults v JOIN users u ON u.id = v.created_by WHERE v.id = ?
  `).get(sourceVaultId) as { username: string } | undefined;
  const profiles = buildChatPresenceProfiles(participants);
  for (const route of listChatChannelRoutes(db, sourceVaultId, sourceChannelId)) {
    emitVaultEvent(route.localVaultId, 'vault:chatPresence', {
      vaultId: route.localVaultId,
      channelId: route.localChannelId,
      online,
      participants,
      owner: owner?.username || '',
      profiles,
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
const chatRunContent = new Map<number, {
  lastSeq: number;
  state: AgentChatContentAccumulator;
}>();
const CHAT_RUN_THROTTLE_MS = 250;

function enqueueMissionCoordinatorWake(wake: MissionWake) {
  const taskLines = wake.mission.tasks.map((task) => (
    `- ${task.title} — @${task.assigneeMention || task.assignee}: ${task.status}`
      + (task.summary ? ` — ${task.summary.slice(0, 600)}` : '')
  ));
  const reviewState = wake.mission.status === 'attention'
    ? 'one or more tasks need attention; the mission remains open'
    : wake.mission.status;
  const body = [
    `@${wake.mission.coordinatorMention} Mission ${wake.mission.id} (“${wake.mission.title}”) is ready for your review (${reviewState}).`,
    ...taskLines,
    '',
    'Review the evidence, resolve or explain failures, perform any integration and verification still needed, then reply to the user with the outcome. Keep the mission state accurate.',
  ].join('\n');
  try {
    const wakeSuffix = crypto.randomUUID().slice(0, 8);
    // A workflow trace must live under an agent row, never directly under the
    // human message that happened to complete the mission. Persist a real,
    // intentionally empty coordinator shell before the system wake; the
    // renderer recognizes this narrow id form and nests the trace inside it.
    const carrier = createChatMessage(db, wake.createdBy, wake.vaultId, wake.channelId, {
      id: `agent-trace-${wake.mission.id}-${wakeSuffix}`,
      channelId: wake.channelId,
      author: '',
      body: '',
      createdAt: new Date().toISOString(),
      registrationId: wake.coordinatorRegistrationId,
    });
    const message = createChatMessage(db, wake.createdBy, wake.vaultId, wake.channelId, {
      id: `sys-mission-${wake.mission.id}-${wakeSuffix}`,
      channelId: wake.channelId,
      // A coordinator wake is agent work, not ambient system chatter. Keeping
      // its registration makes the renderer host the trace in the coordinator
      // row even before the desktop has claimed its dispatch.
      author: '',
      body,
      createdAt: new Date().toISOString(),
      registrationId: wake.coordinatorRegistrationId,
    });
    const dispatch = createChatAgentDispatchForRegistration(
      db,
      wake.createdBy,
      wake.channelId,
      message,
      wake.coordinatorRegistrationId,
    );
    emitChatMessageEvent(wake.vaultId, wake.channelId, 'vault:chatMessageCreated', carrier);
    emitChatMessageEvent(wake.vaultId, wake.channelId, 'vault:chatMessageCreated', message, [dispatch]);
  } catch (error) {
    // The mission remains durably completed/blocked and visible. A missing
    // coordinator can be repaired by the user without losing worker evidence.
    console.warn('mission coordinator wake skipped:', error instanceof Error ? error.message : error);
  }
}

function syncRunToChatMessage(runId: number) {
  const target = chatRunTargets.get(runId);
  const cached = chatRunContent.get(runId);
  const events = listRunEvents(db, runId, cached?.lastSeq ?? 0);
  const state = appendAgentChatRunEvents(
    cached?.state ?? createAgentChatContentAccumulator(),
    events,
  );
  const lastSeq = events.length > 0
    ? events[events.length - 1].seq
    : cached?.lastSeq ?? 0;
  chatRunContent.set(runId, { lastSeq, state });
  const content = agentChatContentFromAccumulator(state);
  if (target) try {
    // Suppressed terminal lifecycle events (dual-post completion or automatic
    // cleanup) drop the Thinking placeholder instead of leaving a ghost row.
    const dropShell = content.done && !String(content.body || '').trim();
    if (dropShell) {
      // Broadcast empty first so clients that only listen for updates can prune,
      // then hard-delete so reloads don't keep a ghost row either.
      const emptied = updateChatMessage(db, target.userId, target.vaultId, target.channelId, target.messageId, {
        body: '',
        blocks: content.blocks.length ? content.blocks : undefined,
        harnessLog: content.harnessLog || undefined,
        status: undefined,
        runId,
      });
      if (emptied) {
        const { route } = assertChatChannel(db, target.channelId, target.userId);
        emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', emptied);
      }
      try {
        deleteChatMessage(db, target.userId, target.vaultId, target.channelId, target.messageId);
      } catch { /* best-effort */ }
    } else {
      // Update only — the initiating client creates the placeholder message; if it
      // hasn't landed yet this no-ops and a later status event retries.
      const updated = updateChatMessage(db, target.userId, target.vaultId, target.channelId, target.messageId, {
        body: content.body,
        blocks: content.blocks.length ? content.blocks : undefined,
        harnessLog: content.harnessLog || undefined,
        status: content.status,
        runId,
      });
      if (updated) {
        const { route } = assertChatChannel(db, target.channelId, target.userId);
        const dispatches = content.done
          ? createChatAgentDispatches(db, target.userId, target.channelId, updated)
            .filter((dispatch) => dispatch.runId == null)
          : [];
        emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', updated, dispatches);
      }
    }
  } catch {
    // Channel/message vanished (e.g. deleted mid-run) — drop the target below.
  }
  if (content.done) {
    const settled = settleMissionTaskForRun(
      db,
      runId,
      content.status === 'failed' ? 'failed' : content.status === 'canceled' ? 'canceled' : 'completed',
      content.body || getRun(db, runId)?.summary || '',
    );
    if (settled) {
      emitMissionProjection(settled.update);
      const scheduled = scheduleMissionWork(settled.update.mission.id);
      if (settled.wake && scheduled.dispatches.length === 0) enqueueMissionCoordinatorWake(settled.wake);
    }
    // Contract drive: accumulate rough token use and auto-stop at budget.
    const bodyLen = (content.body || '').length;
    const tokenEstimate = Math.max(800, Math.ceil(bodyLen / 4) + 400);
    for (const workItemId of listWorkItemsForRun(db, runId)) {
      try {
        const row = db.prepare('SELECT created_by FROM work_items WHERE id = ?').get(workItemId) as { created_by: number } | undefined;
        if (!row) continue;
        const { item, budgetExceeded } = addWorkItemTokenUsage(db, row.created_by, workItemId, tokenEstimate);
        if (budgetExceeded || item.stopReason === 'token_budget') {
          for (const linkedRun of item.runIds) {
            if (linkedRun === runId) continue;
            const open = getRun(db, linkedRun);
            if (open && (open.status === 'running' || open.status === 'queued')) {
              void cancelRun(db, linkedRun).catch(() => {});
            }
          }
        }
      } catch {
        /* non-fatal dual-write */
      }
    }
    chatRunTargets.delete(runId);
    chatRunContent.delete(runId);
    const timer = chatRunFlushTimers.get(runId);
    if (timer) clearTimeout(timer);
    chatRunFlushTimers.delete(runId);
  }
}

setChatSyncSink((runId, eventType) => {
  // Mission settlement is independent of a renderer/chat placeholder. A run
  // can fail before its shell is linked or after the shell is deleted, and its
  // durable task must still reach a terminal state.
  if (!chatRunTargets.has(runId) && eventType !== 'status') return;
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
initDesktopRunners(io, db, {
  publishRunEvent,
  finishDelegatedRun,
  onRunsFailedForOwner: (_ownerUserId, runIds) => {
    for (const runId of runIds) {
      // Stream-fold into any linked chat messages, then settle from run row.
      syncRunToChatMessage(runId);
      for (const update of settleChatMessagesForRun(db, runId)) {
        emitChatMessageEvent(update.vaultId, update.channelId, 'vault:chatMessageUpdated', update.message);
      }
    }
  },
});

// Restore chat stream targets for open delegated runs so mid-flight agents keep
// updating chat after a model-server restart (targets are in-memory only).
{
  const open = listOpenDelegatedRuns(db);
  let restored = 0;
  for (const { run_id, owner_user_id } of open) {
    const rows = db.prepare(`
      SELECT id, vault_id, channel_id FROM chat_messages
      WHERE run_id = ? AND status = 'running'
      ORDER BY created_at DESC LIMIT 1
    `).all(run_id) as Array<{ id: string; vault_id: string; channel_id: string }>;
    for (const row of rows) {
      chatRunTargets.set(run_id, {
        userId: owner_user_id,
        vaultId: row.vault_id,
        channelId: row.channel_id,
        messageId: row.id,
      });
      restored += 1;
    }
  }
  if (restored > 0) {
    console.log(`[runner] Restored ${restored} chat run target(s) after restart.`);
  }
  scheduleOrphanReclaimAfterRestart(db, {
    publishRunEvent,
    finishDelegatedRun,
    onRunsFailedForOwner: (_ownerUserId, runIds) => {
      for (const runId of runIds) {
        syncRunToChatMessage(runId);
        for (const update of settleChatMessagesForRun(db, runId)) {
          emitChatMessageEvent(update.vaultId, update.channelId, 'vault:chatMessageUpdated', update.message);
        }
      }
    },
  });
}

// ── Health ──────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Local agent graph for the Orbit canvas: running Claude Code / Codex instances
// and their subagents. Only populated when the server shares a host with them.
// Map an Orbit node to the Cascade activity view it belongs to, if any. Only
// sessions Cascade itself spawned (recorded in the `runs` table) resolve; a
// stray terminal Claude/Codex session returns null and stays non-clickable.
function resolveCascadeActivity(nodeId: string): { sessionId: string; title: string } | null {
  try {
    const firstColon = nodeId.indexOf(':');
    if (firstColon < 0) return null;
    const sessionId = nodeId.slice(firstColon + 1).split(':')[0];
    if (!sessionId) return null;
    const run = db
      .prepare(
        `SELECT r.note_id AS noteId, r.id AS runId,
                (SELECT channel_id FROM chat_agent_dispatches WHERE run_id = r.id ORDER BY created_at DESC LIMIT 1) AS channelId
         FROM runs r WHERE r.session_id = ? ORDER BY r.started_at DESC, r.id DESC LIMIT 1`,
      )
      .get(sessionId) as { noteId: string | null; runId: number; channelId: string | null } | undefined;
    if (!run) return null; // not a Cascade-spawned session
    const targetId = run.channelId || run.noteId;
    const noteRow = targetId
      ? (db.prepare('SELECT title FROM notes WHERE id = ?').get(targetId) as { title?: string } | undefined)
      : undefined;
    return { sessionId, title: noteRow?.title || 'Activity' };
  } catch {
    return null; // missing table / malformed id — treat as a non-Cascade node
  }
}

app.post('/api/local-agents', requireAuth, (req, res) => {
  try {
    // Caption template comes from the client (the user-editable "prompt" note);
    // fall back to reading that note here if the client didn't send one.
    let template = typeof req.body?.template === 'string' ? req.body.template : '';
    if (!template.trim()) {
      const row = db
        .prepare("SELECT content FROM notes WHERE title = 'prompt' AND is_archived = 0 ORDER BY updated_at DESC LIMIT 1")
        .get() as { content?: string } | undefined;
      template = row?.content ?? '';
    }
    const graph = collectLocalAgents(template);
    for (const node of graph.nodes) {
      const activity = resolveCascadeActivity(node.id);
      if (activity) node.activity = activity;
    }
    res.json(graph);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Could not scan agents' });
  }
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
const REQUIRE_INVITE_REGISTRATION = process.env.CASCADE_REQUIRE_INVITE_REGISTRATION == null
  ? NETWORK_MODE
  : /^(1|true|yes|on)$/i.test(process.env.CASCADE_REQUIRE_INVITE_REGISTRATION);

/**
 * Bound on the routes that take a bare username: opening a DM, blocking, and
 * pushing a chat into someone's vault. Each one writes into another account's
 * space or answers a question about it, so it is the natural probe for both
 * spam and account discovery. Keyed on the caller's account rather than the
 * address, which a signed-in prober can change at will.
 */
const usernameActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  key: (req) => String((req as AuthedRequest).user?.id ?? req.ip ?? 'unknown'),
  message: 'Too many direct message attempts. Please try again shortly.',
});

app.post('/api/auth/register', authRateLimit, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (!/^[a-z0-9_]{3,32}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3-32 lowercase letters, numbers, or underscores' });
  }
  const passwordError = passwordPolicyError(password);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const user = db.transaction(() => {
      const accountCount = (db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count;
      const inviteHash = REQUIRE_INVITE_REGISTRATION && accountCount > 0
        ? validRegistrationInviteHash(req.body?.inviteToken)
        : null;
      if (REQUIRE_INVITE_REGISTRATION && accountCount > 0 && !inviteHash) {
        throw new Error('REGISTRATION_INVITE_REQUIRED');
      }
      const result = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, passwordHash);
      const created = { id: Number(result.lastInsertRowid), username };
      if (inviteHash) {
        db.prepare('INSERT INTO registration_invites_used (token_hash, user_id) VALUES (?, ?)')
          .run(inviteHash, created.id);
      }
      return created;
    })();
    res.status(201).json(authResponse(req, res, user));
  } catch (error) {
    if (error instanceof Error && error.message === 'REGISTRATION_INVITE_REQUIRED') {
      return res.status(403).json({ error: 'A valid unused invitation is required to create an account' });
    }
    res.status(409).json({ error: 'Username is already taken' });
  }
});

app.post('/api/auth/login', authRateLimit, async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;

  // Existing installations may contain a historical password over bcrypt's
  // 72-byte boundary, so login remains compatible while rejecting absurd JSON
  // inputs before any password work.
  const passwordMatches = Buffer.byteLength(password, 'utf8') <= 4096
    && await bcrypt.compare(password, user?.password_hash || LOGIN_DUMMY_HASH);
  if (!user || !passwordMatches) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  res.json(authResponse(req, res, user));
});

app.post('/api/auth/password', requireAuth, authRateLimit, async (req: AuthedRequest, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');
  const passwordError = passwordPolicyError(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as User | undefined;
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const changed = db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND password_hash = ?')
    .run(passwordHash, user.id, user.password_hash);
  if (changed.changes !== 1) return res.status(409).json({ error: 'Password changed in another session; please try again' });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as User;
  const token = setUserSession(res, updated);
  res.json({ ok: true, ...(req.headers['x-cascade-browser'] === '1' ? {} : { token }) });
  disconnectUserSockets(user.id);
});

app.put('/api/me/profile', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const displayName = String(req.body?.displayName || '').trim();
  const avatarUrl = String(req.body?.avatarUrl || '').trim();
  if (displayName.length < 1 || displayName.length > 48 || /[\u0000-\u001f\u007f]/.test(displayName)) {
    return res.status(400).json({ error: 'Display name must be 1-48 characters without control characters' });
  }
  if (avatarUrl.length > 2_800_000) {
    return res.status(400).json({ error: 'Profile picture must be smaller than 2 MB' });
  }
  if (avatarUrl && !/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(avatarUrl)) {
    return res.status(400).json({ error: 'Profile picture must be a PNG, JPEG, WebP, or GIF image' });
  }
  db.prepare("UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?")
    .run(displayName, avatarUrl, req.user!.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as User;
  const profile = publicUser(updated);
  emitUserProfileUpdated(req.user!.id, profile);
  res.json({ user: profile });
});

// The server owner (first-registered account) issues a single-use, 1-hour
// password-reset token for a locked-out user. No email infra: the owner hands
// the token over out-of-band. The token is signed with the user's *current*
// password hash, so it self-invalidates the moment the password changes
// (single use) — no reset-token table to maintain.
app.post('/api/auth/reset/issue', requireAuth, authRateLimit, (req: AuthedRequest, res) => {
  if (!isOwner(req.user!.id)) {
    return res.status(403).json({ error: 'Only the server owner can issue password resets' });
  }
  const username = String(req.body.username || '').trim().toLowerCase();
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  if (!target) return res.status(404).json({ error: 'No account with that username' });
  const token = jwt.sign({ type: 'pw-reset', userId: target.id }, JWT_SECRET + target.password_hash, { expiresIn: '1h' });
  res.json({ token, username: target.username, expiresInMinutes: 60 });
});

// Redeem a reset token to set a new password (typically the user is locked out,
// so this is unauthenticated). Verified against the user's current password
// hash, so a token stops working once used or after it expires.
app.post('/api/auth/reset', authRateLimit, async (req, res) => {
  const token = String(req.body.token || '').trim();
  const newPassword = String(req.body.newPassword || '');
  const passwordError = passwordPolicyError(newPassword);
  if (passwordError) return res.status(400).json({ error: passwordError });
  const decoded = (() => {
    try { return jwt.decode(token) as { type?: string; userId?: number } | null; } catch { return null; }
  })();
  if (!decoded || decoded.type !== 'pw-reset' || typeof decoded.userId !== 'number') {
    return res.status(400).json({ error: 'This reset link is invalid' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.userId) as User | undefined;
  if (!user) return res.status(400).json({ error: 'This reset link is invalid' });
  try {
    jwt.verify(token, JWT_SECRET + user.password_hash);
  } catch {
    return res.status(400).json({ error: 'This reset link is invalid or has expired' });
  }
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const changed = db.prepare('UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ? AND password_hash = ?')
    .run(passwordHash, user.id, user.password_hash);
  if (changed.changes !== 1) return res.status(400).json({ error: 'This reset link has already been used' });
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) as User;
  const replacementToken = setUserSession(res, updated);
  res.json({
    ok: true,
    user: publicUser(updated),
    ...(req.headers['x-cascade-browser'] === '1' ? {} : { token: replacementToken }),
    owner: isOwner(updated.id),
  });
  disconnectUserSockets(user.id);
});

app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as User;
  res.json({ user: publicUser(user), owner: isOwner(req.user!.id) });
});

app.get('/api/session', (req, res) => {
  const verified = verifiedRequestSession(req);
  if (!verified?.decoded || verified.decoded.access === 'agent') {
    return res.json({ authenticated: false });
  }
  if (verified.source === 'bearer' && req.headers['x-cascade-session-migrate'] === '1') {
    res.append('Set-Cookie', userSessionCookie(verified.token));
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(verified.decoded.id) as User;
  res.json({ authenticated: true, user: publicUser(user), owner: isOwner(user.id) });
});

app.post('/api/auth/logout', (_req, res) => {
  res.append('Set-Cookie', clearUserSessionCookies());
  res.json({ ok: true });
});

app.post('/api/diagnostics/android-battery', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  try {
    recordAndroidBatterySample(db, req.user!.id, parseAndroidBatterySample(req.body || {}));
    res.status(202).json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid battery sample' });
  }
});

app.get('/api/diagnostics/android-battery', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const allUsers = req.query.all === '1';
  if (allUsers && !isOwner(req.user!.id)) return res.status(403).json({ error: 'Owner only' });
  res.json({ samples: listAndroidBatterySamples(db, allUsers ? null : req.user!.id, Number(req.query.days)) });
});

// ── Community updates ─────────────────────────────────────────────

app.get('/api/community/updates', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const requestedLimit = Number(req.query.limit);
  const includeAgentMemory = req.query.includeAgentMemory === '1';
  res.json(listCommunityUpdates(
    db,
    req.user!,
    Number.isFinite(requestedLimit) ? requestedLimit : undefined,
    includeAgentMemory,
  ));
});

app.post('/api/community/updates/read', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const targetId = String(req.body?.targetId || '').trim();
  if (!targetId) return res.status(400).json({ error: 'targetId is required' });
  if (!markCommunityTargetRead(db, req.user!.id, targetId)) {
    return res.status(404).json({ error: 'Update source not found' });
  }
  emitCommunityChangedForUsers([req.user!.id]);
  res.json({ ok: true });
});

app.post('/api/community/updates/read-all', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  markAllCommunityUpdatesRead(db, req.user!.id);
  emitCommunityChangedForUsers([req.user!.id]);
  res.json({ ok: true });
});

// The desktop runner gives child agents this short-lived, restricted token
// instead of the user's full session credential.
app.post('/api/auth/agent-token', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  res.json({ token: signAgentToken(req.user!) });
});

// Owner-only: list accounts for the admin panel (no secrets).
app.get('/api/admin/users', requireAuth, (req: AuthedRequest, res) => {
  if (!isOwner(req.user!.id)) return res.status(403).json({ error: 'Owner only' });
  const users = db.prepare('SELECT id, username, display_name, avatar_url, created_at FROM users ORDER BY id ASC').all() as User[];
  res.json({ users: users.map((user) => ({ ...publicUser(user), created_at: user.created_at })) });
});

app.get('/api/admin/reports', requireAuth, (req: AuthedRequest, res) => {
  if (!isOwner(req.user!.id)) return res.status(403).json({ error: 'Owner only' });
  const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'open';
  if (rawStatus !== 'all' && !isReportStatus(rawStatus)) return res.status(400).json({ error: 'Invalid report status' });
  res.json({ reports: listGlobalReports(db, req.user!.id, rawStatus) });
});

app.patch('/api/admin/reports/:reportId', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  if (!isOwner(req.user!.id)) return res.status(403).json({ error: 'Owner only' });
  const reportId = Number(req.params.reportId);
  if (!Number.isSafeInteger(reportId) || reportId < 1) return res.status(400).json({ error: 'Invalid report id' });
  try {
    res.json(reviewGlobalReport(db, reportId, req.user!.id, req.body?.action));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review report';
    res.status(message === 'Report not found' ? 404 : 400).json({ error: message });
  }
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
  res.json({ vault, role: getVaultRole(db, vault.id, req.user!.id) });
});

app.patch('/api/vaults/:id', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  if (getVaultRole(db, vault.id, req.user!.id) !== 'owner') {
    return res.status(403).json({ error: 'Only the vault owner can rename this vault' });
  }
  try {
    const renamed = renameVault(db, vault.id, String(req.body?.name ?? ''));
    // Everyone in the vault sees the label, so push it rather than waiting for a reload.
    emitVaultEvent(vault.id, 'vault:renamed', { vaultId: vault.id, name: renamed.name });
    res.json({ vault: renamed });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not rename vault' });
  }
});

app.delete('/api/vaults/:id', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  try {
    if (!deleteVault(db, req.params.id, req.user!.id)) {
      return res.status(404).json({ error: 'Vault not found or you are not its owner' });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not delete vault' });
  }
});

app.get('/api/vaults/:id/members', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({
    members: listVaultMembers(db, vault.id),
    role: getVaultRole(db, vault.id, req.user!.id),
  });
});

app.post('/api/vaults/:id/members', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  if (getVaultRole(db, vault.id, req.user!.id) !== 'owner') {
    return res.status(403).json({ error: 'Only the vault owner can invite members' });
  }
  if (vaultHoldsDirectMessages(db, vault.id)) {
    return res.status(400).json({ error: 'A vault containing direct messages cannot be shared' });
  }
  try {
    const username = String(req.body?.username || '').trim().replace(/^@+/, '').toLowerCase();
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const roleRaw = String(req.body?.role || 'editor').trim().toLowerCase();
    if (!isVaultRole(roleRaw) || roleRaw === 'owner') {
      return res.status(400).json({ error: 'Role must be editor or viewer' });
    }
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
    if (!user) return res.status(404).json({ error: 'User not found' });
    const member = addVaultMember(db, vault.id, req.user!.id, user.id, roleRaw as VaultRole);
    res.status(201).json({ member });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add member' });
  }
});

app.patch('/api/vaults/:id/members/:userId', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  if (getVaultRole(db, vault.id, req.user!.id) !== 'owner') {
    return res.status(403).json({ error: 'Only the vault owner can change roles' });
  }
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: 'Invalid user id' });
    const roleRaw = String(req.body?.role || '').trim().toLowerCase();
    if (!isVaultRole(roleRaw) || roleRaw === 'owner') {
      return res.status(400).json({ error: 'Role must be editor or viewer' });
    }
    const member = setVaultMemberRole(db, vault.id, req.user!.id, targetUserId, roleRaw as VaultRole);
    res.json({ member });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update member' });
  }
});

app.delete('/api/vaults/:id/members/:userId', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const targetUserId = Number(req.params.userId);
    if (!Number.isInteger(targetUserId)) return res.status(400).json({ error: 'Invalid user id' });
    if (targetUserId !== req.user!.id && getVaultRole(db, vault.id, req.user!.id) !== 'owner') {
      return res.status(403).json({ error: 'Only the vault owner can remove members' });
    }
    removeVaultMember(db, vault.id, req.user!.id, targetUserId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not remove member' });
  }
});

app.get('/api/vaults/:id/bans', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    res.json({ bans: listVaultBans(db, vault.id, req.user!.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not list bans';
    res.status(message.startsWith('Only the vault owner') ? 403 : 400).json({ error: message });
  }
});

app.post('/api/vaults/:id/bans', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const targetUserId = Number(req.body?.userId);
    const ban = banVaultMember(db, vault.id, req.user!.id, targetUserId, req.body?.reason);
    emitVaultEvent(vault.id, 'vault:membersChanged', { vaultId: vault.id });
    res.status(201).json({ ban });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not ban member';
    res.status(message.startsWith('Only the vault owner') ? 403 : 400).json({ error: message });
  }
});

app.delete('/api/vaults/:id/bans/:userId', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    unbanVaultMember(db, vault.id, req.user!.id, Number(req.params.userId));
    res.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not unban member';
    res.status(message.startsWith('Only the vault owner') ? 403 : 400).json({ error: message });
  }
});

// A share link is how you invite someone who has no account yet, or whose
// username you don't know — the by-username route above needs both.
app.post('/api/vaults/:id/invite-link', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  if (getVaultRole(db, vault.id, req.user!.id) !== 'owner') {
    return res.status(403).json({ error: 'Only the vault owner can create invite links' });
  }
  if (vaultHoldsDirectMessages(db, vault.id)) {
    return res.status(400).json({ error: 'A vault containing direct messages cannot be shared' });
  }
  const roleRaw = String(req.body?.role || 'editor').trim().toLowerCase();
  if (!isVaultRole(roleRaw) || roleRaw === 'owner') {
    return res.status(400).json({ error: 'Role must be editor or viewer' });
  }
  const token = signVaultInvite(vault.id, roleRaw as VaultRole);
  res.json({ token, role: roleRaw, url: `${publicBaseUrl(req)}/vault-invite/${encodeURIComponent(token)}` });
});

app.get('/api/vault-invites/:token', (req, res) => {
  try {
    const invite = verifyVaultInvite(req.params.token);
    const vault = db.prepare('SELECT id, name, created_by FROM vaults WHERE id = ?')
      .get(invite.vaultId) as { id: string; name: string; created_by: number } | undefined;
    // Re-checked on preview as well as accept: the vault may have started
    // holding direct messages after this link was minted.
    if (!vault || vaultHoldsDirectMessages(db, vault.id)) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const owner = db.prepare('SELECT username FROM users WHERE id = ?')
      .get(vault.created_by) as { username: string } | undefined;
    res.json({ invite: { vaultName: vault.name, role: invite.role, owner: owner?.username || 'unknown' } });
  } catch {
    res.status(404).json({ error: 'Invite not found' });
  }
});

app.post('/api/vault-invites/:token/accept', requireAuth, (req: AuthedRequest, res) => {
  try {
    const invite = verifyVaultInvite(req.params.token);
    const vault = db.prepare('SELECT id, name, created_by FROM vaults WHERE id = ?')
      .get(invite.vaultId) as { id: string; name: string; created_by: number } | undefined;
    if (!vault) return res.status(404).json({ error: 'Invite not found' });
    // A seven-day token outlives the check made when it was created, so the
    // DM restriction is enforced again here rather than trusted from then.
    if (vaultHoldsDirectMessages(db, vault.id)) {
      return res.status(404).json({ error: 'Invite not found' });
    }
    const current = getVaultRole(db, vault.id, req.user!.id);
    // Redeeming twice, or as the owner, is a no-op rather than a demotion.
    if (current) return res.json({ vaultId: vault.id, name: vault.name, role: current, alreadyMember: true });
    addVaultMember(db, vault.id, vault.created_by, req.user!.id, invite.role);
    res.status(201).json({ vaultId: vault.id, name: vault.name, role: invite.role });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not accept invite' });
  }
});

// ── Public vaults ──────────────────────────────────────────────────
// Visibility is owner-only; browse and join are open to any signed-in user.

app.get('/api/vaults/:id/visibility', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const settings = getVaultVisibility(db, vault.id);
  if (!settings) return res.status(404).json({ error: 'Vault not found' });
  res.json({ ...settings, role: getVaultRole(db, vault.id, req.user!.id) });
});

app.put('/api/vaults/:id/visibility', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const current = getVaultVisibility(db, vault.id);
    if (req.body?.visibility === 'public' && current?.visibility !== 'public'
      && !Array.isArray(req.body?.topics) && !current?.topics.length) {
      return res.status(400).json({ error: 'Choose at least 1 topic before publishing' });
    }
    const settings = setVaultVisibility(db, vault.id, req.user!.id, {
      visibility: req.body?.visibility,
      summary: req.body?.summary,
      topics: req.body?.topics,
      guidelines: req.body?.guidelines,
      homeNoteId: req.body?.homeNoteId,
      joinPolicy: req.body?.joinPolicy,
    });
    emitVaultEvent(vault.id, 'vault:visibilityChanged', { vaultId: vault.id, ...settings });
    res.json(settings);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not update visibility';
    res.status(message.startsWith('Only the vault owner') ? 403 : 400).json({ error: message });
  }
});

app.get('/api/vaults/:id/public-home-notes', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    res.json({ notes: listPublicHomeNoteChoices(db, vault.id, req.user!.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not list home notes';
    res.status(message.startsWith('Only the vault owner') ? 403 : 400).json({ error: message });
  }
});

app.get('/api/vaults/:id/join-requests', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    res.json({ requests: listPublicVaultJoinRequests(db, vault.id, req.user!.id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not list join requests';
    res.status(message.startsWith('Only the vault owner') ? 403 : 400).json({ error: message });
  }
});

app.patch('/api/vaults/:id/join-requests/:requestId', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const requestId = Number(req.params.requestId);
    if (!Number.isSafeInteger(requestId) || requestId < 1) return res.status(400).json({ error: 'Invalid join request id' });
    const result = reviewPublicVaultJoinRequest(db, vault.id, requestId, req.user!.id, req.body?.action);
    if (result.role) emitVaultEvent(vault.id, 'vault:membersChanged', { vaultId: vault.id });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review join request';
    if (message.startsWith('Only the vault owner')) return res.status(403).json({ error: message });
    res.status(message === 'Join request not found' ? 404 : 400).json({ error: message });
  }
});

app.get('/api/public-vaults', requireAuth, (req: AuthedRequest, res) => {
  const vaults = listPublicVaults(db, {
    userId: req.user!.id,
    query: typeof req.query.q === 'string' ? req.query.q : '',
    limit: Number(req.query.limit) || undefined,
    offset: Number(req.query.offset) || undefined,
  });
  res.json({ vaults });
});

app.get('/api/public-vaults/:id', requireAuth, (req: AuthedRequest, res) => {
  const vault = getPublicVaultDetail(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ vault });
});

app.post('/api/public-vaults/:id/join', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  try {
    const result = joinPublicVault(db, req.params.id, req.user!.id);
    res.status(result.alreadyMember ? 200 : 201).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not join vault';
    res.status(message === 'Vault not found' ? 404 : 400).json({ error: message });
  }
});

// Reports are intentionally nested under a vault so target routing is always
// explicit. POST is the sole viewer-safe mutation in the API-wide write guard.
app.post('/api/vaults/:id/reports', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  try {
    const report = createContentReport(db, {
      vaultId: req.params.id,
      reporterUserId: req.user!.id,
      targetType: req.body?.targetType,
      targetId: req.body?.targetId,
      reason: req.body?.reason,
      detail: req.body?.detail,
    });
    res.status(201).json({ report });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not create report';
    res.status(message === 'Vault not found' ? 404 : 400).json({ error: message });
  }
});

app.get('/api/vaults/:id/reports', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const rawStatus = typeof req.query.status === 'string' ? req.query.status : 'open';
  if (rawStatus !== 'all' && !isReportStatus(rawStatus)) return res.status(400).json({ error: 'Invalid report status' });
  try {
    res.json({ reports: listVaultReports(db, vault.id, req.user!.id, rawStatus) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not list reports';
    res.status(message.startsWith('Only the vault owner') ? 403 : 400).json({ error: message });
  }
});

app.patch('/api/vaults/:id/reports/:reportId', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const reportId = Number(req.params.reportId);
  if (!Number.isSafeInteger(reportId) || reportId < 1) return res.status(400).json({ error: 'Invalid report id' });
  try {
    res.json({ report: reviewVaultReport(db, vault.id, reportId, req.user!.id, req.body?.action) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not review report';
    if (message.startsWith('Only the vault owner')) return res.status(403).json({ error: message });
    res.status(message === 'Report not found' ? 404 : 400).json({ error: message });
  }
});

// ── Managed-agent entitlement (control-plane only; no provider secrets) ───
app.get('/api/vaults/:id/managed-agent/entitlement', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({
    entitlement: getManagedEntitlement(db, vault.id),
    admin: getVaultRole(db, vault.id, req.user!.id) === 'owner',
    operator: getManagedAgentOperatorStatus(db, vault.id),
  });
});

app.put('/api/vaults/:id/managed-agent/entitlement', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  if (getVaultRole(db, vault.id, req.user!.id) !== 'owner') return res.status(403).json({ error: 'Only the vault owner can manage managed-agent budgets' });
  try {
    const entitlement = setManagedEntitlement(db, vault.id, req.body || {});
    res.json({ entitlement });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update managed entitlement' });
  }
});

// ── Work items (durable task workspaces) ───────────────────────────

app.get('/api/vaults/:id/work-items', requireAuth, (req: AuthedRequest, res) => {
  try {
    const items = listWorkItems(db, req.user!.id, req.params.id, {
      channelId: typeof req.query.channelId === 'string' ? req.query.channelId : undefined,
      status: typeof req.query.status === 'string' ? req.query.status : undefined,
    });
    res.json({ items });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Vault not found' });
  }
});

app.post('/api/vaults/:id/work-items', requireAuth, (req: AuthedRequest, res) => {
  try {
    const item = createWorkItem(db, req.user!.id, req.params.id, {
      title: String(req.body?.title || ''),
      brief: String(req.body?.brief || ''),
      contract: String(req.body?.contract || ''),
      channelId: req.body?.channelId != null ? String(req.body.channelId) : null,
      priority: Number(req.body?.priority) || 0,
      sourceKind: String(req.body?.sourceKind || 'manual'),
      sourceId: String(req.body?.sourceId || ''),
      dependsOn: Array.isArray(req.body?.dependsOn) ? req.body.dependsOn.map(String) : [],
      repository: String(req.body?.repository || ''),
      baseCommit: String(req.body?.baseCommit || ''),
      branch: String(req.body?.branch || ''),
      workspaceMode: String(req.body?.workspaceMode || 'shared'),
      worktreePath: String(req.body?.worktreePath || ''),
      assigneeRegistrationId: req.body?.assigneeRegistrationId != null
        ? String(req.body.assigneeRegistrationId)
        : null,
      tokenBudget: req.body?.tokenBudget != null ? Number(req.body.tokenBudget) : 0,
      verification: String(req.body?.verification || ''),
    });
    res.status(201).json({ item });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create work item' });
  }
});

app.get('/api/work-items/:id', requireAuth, (req: AuthedRequest, res) => {
  try {
    const item = getWorkItem(db, req.user!.id, req.params.id);
    const reviews = listWorkItemReviews(db, req.user!.id, item.id);
    const siblings = listSiblingWorkItems(db, req.user!.id, item.id);
    res.json({ item, reviews, siblings });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Work item not found' });
  }
});

app.patch('/api/work-items/:id', requireAuth, (req: AuthedRequest, res) => {
  try {
    const item = updateWorkItem(db, req.user!.id, req.params.id, {
      title: req.body?.title != null ? String(req.body.title) : undefined,
      brief: req.body?.brief != null ? String(req.body.brief) : undefined,
      status: req.body?.status != null ? String(req.body.status) as WorkItemStatus : undefined,
      priority: req.body?.priority != null ? Number(req.body.priority) : undefined,
      assigneeRegistrationId: req.body?.assigneeRegistrationId !== undefined
        ? (req.body.assigneeRegistrationId == null ? null : String(req.body.assigneeRegistrationId))
        : undefined,
      repository: req.body?.repository != null ? String(req.body.repository) : undefined,
      baseCommit: req.body?.baseCommit != null ? String(req.body.baseCommit) : undefined,
      branch: req.body?.branch != null ? String(req.body.branch) : undefined,
      workspaceMode: req.body?.workspaceMode != null ? String(req.body.workspaceMode) as WorkspaceMode : undefined,
      worktreePath: req.body?.worktreePath != null ? String(req.body.worktreePath) : undefined,
      prNumber: req.body?.prNumber !== undefined
        ? (req.body.prNumber == null ? null : Number(req.body.prNumber))
        : undefined,
      prUrl: req.body?.prUrl != null ? String(req.body.prUrl) : undefined,
      prState: req.body?.prState != null ? String(req.body.prState) : undefined,
      summary: req.body?.summary != null ? String(req.body.summary) : undefined,
      verification: req.body?.verification != null ? String(req.body.verification) : undefined,
      dependsOn: Array.isArray(req.body?.dependsOn) ? req.body.dependsOn.map(String) : undefined,
    });
    res.json({ item });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update work item' });
  }
});

/** Desktop workspaces publish base-relative Git evidence; readiness stays server-derived. */
app.put('/api/work-items/:id/git-state', requireAuth, (req: AuthedRequest, res) => {
  try {
    const item = reportWorkItemGitState(db, req.user!.id, req.params.id, {
      baseCommit: String(req.body?.baseCommit || ''),
      branch: String(req.body?.branch || ''),
      state: req.body?.state,
    });
    res.json({ item });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not report Git state' });
  }
});

app.post('/api/work-items/:id/lease', requireAuth, (req: AuthedRequest, res) => {
  try {
    const item = acquireWorkItemLease(
      db,
      req.user!.id,
      req.params.id,
      String(req.body?.holder || req.user!.username || req.user!.id),
      Number(req.body?.ttlMs) || undefined,
    );
    res.json({ item });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not acquire lease' });
  }
});

app.post('/api/work-items/:id/release', requireAuth, (req: AuthedRequest, res) => {
  try {
    const item = releaseWorkItemLease(
      db,
      req.user!.id,
      req.params.id,
      req.body?.holder != null ? String(req.body.holder) : undefined,
    );
    res.json({ item });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not release lease' });
  }
});

app.post('/api/work-items/:id/runs', requireAuth, (req: AuthedRequest, res) => {
  try {
    const item = linkWorkItemRun(db, req.user!.id, req.params.id, Number(req.body?.runId));
    res.json({ item });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not link run' });
  }
});

app.post('/api/work-items/:id/handoff', requireAuth, (req: AuthedRequest, res) => {
  try {
    const result = createWorkItemHandoff(db, req.user!.id, req.params.id, {
      toRegistrationId: String(req.body?.toRegistrationId || ''),
      fromRegistrationId: req.body?.fromRegistrationId != null ? String(req.body.fromRegistrationId) : undefined,
      note: String(req.body?.note || ''),
    });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not hand off work item' });
  }
});

app.post('/api/work-items/:id/reviews', requireAuth, (req: AuthedRequest, res) => {
  try {
    const review = createWorkItemReview(db, req.user!.id, req.params.id, {
      kind: String(req.body?.kind || '') as 'comment' | 'change_request',
      note: String(req.body?.note || ''),
      filePath: req.body?.filePath != null ? String(req.body.filePath) : undefined,
      line: req.body?.line != null ? Number(req.body.line) : undefined,
      baseCommit: String(req.body?.baseCommit || ''),
      headCommit: String(req.body?.headCommit || ''),
    });
    res.status(201).json({ review });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save review comment' });
  }
});

/** Manually stop agent drive on a contract/work-item (or mark completed). */
app.post('/api/work-items/:id/stop', requireAuth, (req: AuthedRequest, res) => {
  try {
    const reasonRaw = String(req.body?.reason || 'manual');
    const reason = reasonRaw === 'completed' || reasonRaw === 'token_budget' || reasonRaw === 'failed'
      ? reasonRaw
      : 'manual';
    const item = stopWorkItem(db, req.user!.id, req.params.id, reason, String(req.body?.summary || ''));
    // Best-effort cancel of open linked runs.
    for (const runId of item.runIds) {
      const run = getRun(db, runId);
      if (run && (run.status === 'running' || run.status === 'queued')) {
        void cancelRun(db, runId).catch(() => {});
      }
    }
    res.json({ item });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not stop work item' });
  }
});

// ── Folder routes ──────────────────────────────────────────────────

app.get('/api/vaults/:id/folders', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ folders: listFolders(db, vault.id) });
});

app.post('/api/vaults/:id/folders', requireAuth, (req: AuthedRequest, res) => {
  const vault = getWritableVault(db, req.params.id, req.user!.id);
  if (!vault) {
    if (getVault(db, req.params.id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Vault not found' });
  }
  try {
    const folder = createFolder(db, vault.id, req.body || {});
    res.status(201).json({ folder });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create folder' });
  }
});

app.patch('/api/folders/:id', requireAuth, (req: AuthedRequest, res) => {
  const owned = db.prepare(`
    SELECT f.id FROM folders f
    JOIN vault_members m ON m.vault_id = f.vault_id
    WHERE f.id = ? AND m.user_id = ? AND m.role IN ('owner','editor')
  `).get(req.params.id, req.user!.id);
  if (!owned) {
    const readable = db.prepare(`
      SELECT f.id FROM folders f
      JOIN vault_members m ON m.vault_id = f.vault_id
      WHERE f.id = ? AND m.user_id = ?
    `).get(req.params.id, req.user!.id);
    if (readable) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Folder not found' });
  }
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
  const owned = db.prepare(`
    SELECT f.id FROM folders f
    JOIN vault_members m ON m.vault_id = f.vault_id
    WHERE f.id = ? AND m.user_id = ? AND m.role IN ('owner','editor')
  `).get(req.params.id, req.user!.id);
  if (!owned) {
    const readable = db.prepare(`
      SELECT f.id FROM folders f
      JOIN vault_members m ON m.vault_id = f.vault_id
      WHERE f.id = ? AND m.user_id = ?
    `).get(req.params.id, req.user!.id);
    if (readable) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Folder not found' });
  }
  try {
    deleteFolder(db, req.params.id, req.user!.id);
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

  const opts: { folder_id?: string; is_archived?: boolean; tag?: string; title?: string; title_contains?: string } = {};
  if (typeof req.query.folder_id === 'string') opts.folder_id = req.query.folder_id;
  if (req.query.is_archived === 'true') opts.is_archived = true;
  if (req.query.is_archived === 'false') opts.is_archived = false;
  if (typeof req.query.tag === 'string') opts.tag = req.query.tag;
  if (typeof req.query.title === 'string') opts.title = req.query.title;
  if (typeof req.query.title_contains === 'string') opts.title_contains = req.query.title_contains;

  const notes = listNotes(db, vault.id, opts);
  res.json({
    notes: notes.map((note) => redactNoteForAgent(req, note as { file_path?: string })),
  });
});

app.post('/api/vaults/:id/notes', requireAuth, (req: AuthedRequest, res) => {
  const vault = getWritableVault(db, req.params.id, req.user!.id);
  if (!vault) {
    if (getVault(db, req.params.id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Vault not found' });
  }
  try {
    const note = createNote(db, vault.id, req.user!.id, req.body || {});
    createNoteVersion(db, note.id, note.content, 'created');
    try { reresolveChatBacklinksForNote(db, vault.id, note.id, note.title); } catch { /* ignore */ }
    emitVaultEvent(vault.id, 'vault:noteCreated', { noteId: note.id, vaultId: vault.id, title: note.title });
    res.status(201).json({ note: redactNoteForAgent(req, note) });
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
  res.json({ note: redactNoteForAgent(req, note) });
});

app.put('/api/notes/:id', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getWritableVault(db, existing.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, existing.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Note not found' });
  }

  try {
    const proposed = String(req.body.content ?? existing.content);
    const content = isAgentRequest(req)
      ? restorePrivateBlocks(proposed, existing.content)
      : proposed;
    const note = updateNote(db, req.params.id, content, req.user!.id);
    createNoteVersion(db, note.id, content, 'auto');
    emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: note.id, vaultId: vault.id, title: note.title });
    res.json({ note: redactNoteForAgent(req, note) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update note' });
  }
});

app.post('/api/notes/:id/rename', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getWritableVault(db, existing.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, existing.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Note not found' });
  }

  try {
    const note = renameNote(db, req.params.id, String(req.body.title ?? ''), req.user!.id);
    try { reresolveChatBacklinksForNote(db, vault.id, note.id, note.title); } catch { /* ignore */ }
    emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: note.id, vaultId: vault.id });
    res.json({ note: redactNoteForAgent(req, note) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not rename note' });
  }
});

app.delete('/api/notes/:id', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getWritableVault(db, existing.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, existing.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Note not found' });
  }

  try {
    deleteNoteAssets(db, req.params.id);
    deleteNoteStats(db, req.params.id);
    deleteNote(db, req.params.id);
    emitVaultEvent(vault.id, 'vault:noteDeleted', { noteId: req.params.id, vaultId: vault.id, title: existing.title });
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not delete note' });
  }
});

app.post('/api/notes/:id/move', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getWritableVault(db, existing.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, existing.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Note not found' });
  }

  try {
    const folderId = req.body.folder_id !== undefined ? (req.body.folder_id || null) : null;
    const position = Number.isInteger(req.body.position) ? Number(req.body.position) : undefined;
    moveNote(db, req.params.id, folderId, position, req.user!.id);
    const note = getNote(db, req.params.id);
    emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, vaultId: vault.id, title: note?.title ?? existing.title });
    res.json({ note: redactNoteForAgent(req, note) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not move note' });
  }
});

app.post('/api/notes/:id/unlist', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getWritableVault(db, existing.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, existing.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Note not found' });
  }

  try {
    unlistNote(db, req.params.id, req.user!.id);
    const note = getNote(db, req.params.id);
    emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, vaultId: vault.id, title: note?.title ?? existing.title });
    res.json({ note: redactNoteForAgent(req, note) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not unlink note' });
  }
});

app.post('/api/notes/:id/pin', requireAuth, (req: AuthedRequest, res) => {
  const existing = getNote(db, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Note not found' });
  const vault = getWritableVault(db, existing.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, existing.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Note not found' });
  }

  togglePin(db, req.params.id, req.user!.id);
  const note = getNote(db, req.params.id);
  emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, vaultId: vault.id, title: note?.title ?? existing.title });
  res.json({ note: redactNoteForAgent(req, note) });
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
  const vault = getWritableVault(db, existing.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, existing.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit this vault' });
    return res.status(404).json({ error: 'Note not found' });
  }

  toggleArchive(db, req.params.id, req.user!.id);
  const note = getNote(db, req.params.id);
  emitVaultEvent(vault.id, 'vault:noteChanged', { noteId: req.params.id, vaultId: vault.id, title: note?.title ?? existing.title });
  res.json({ note: redactNoteForAgent(req, note) });
});

// ── Search routes ──────────────────────────────────────────────────

app.get('/api/vaults/:id/search', requireAuth, async (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ results: [] });

  const scopeRaw = String(req.query.scope || 'notes').trim().toLowerCase();
  const scope = (scopeRaw === 'chat' || scopeRaw === 'all' || scopeRaw === 'notes')
    ? scopeRaw
    : 'notes';

  try {
    const results = await searchWithQmd(db, vault.id, query, {
      scope,
      limit: Number(req.query.limit || 40),
      redactPrivate: isAgentRequest(req),
    });
    res.json({ results });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Search failed' });
  }
});

// ── Scratchpad (agent journal) routes ──────────────────────────────

app.post('/api/vaults/:id/scratchpad/journal', requireAuth, (req: AuthedRequest, res) => {
  try {
    const entry = appendJournalEntry(db, req.user!.id, req.params.id, {
      body: String(req.body?.body || ''),
      kind: req.body?.kind,
      agentKey: req.body?.agentKey,
      runId: req.body?.runId,
    });
    res.status(201).json({ entry });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not append journal entry' });
  }
});

app.get('/api/vaults/:id/scratchpad/journal', requireAuth, (req: AuthedRequest, res) => {
  try {
    const entries = listJournalEntries(db, req.user!.id, req.params.id, {
      agentKey: typeof req.query.agent === 'string' ? req.query.agent : undefined,
      unconsolidatedOnly: req.query.unconsolidated === '1' || req.query.unconsolidated === 'true',
      sinceId: req.query.since ? Number(req.query.since) : undefined,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ entries });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not list journal' });
  }
});

app.post('/api/vaults/:id/scratchpad/consolidate', requireAuth, (req: AuthedRequest, res) => {
  try {
    const marked = markJournalConsolidated(db, req.user!.id, req.params.id, {
      throughId: Number(req.body?.throughId),
      agentKey: req.body?.agentKey,
    });
    res.json({ ok: true, marked });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not mark consolidated' });
  }
});

app.get('/api/vaults/:id/scratchpad/status', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const agentKey = typeof req.query.agent === 'string' ? req.query.agent : undefined;
  res.json({ status: scratchpadStatus(db, vault.id, agentKey) });
});

// Open threads: thin intentional trail of unfinished work (not a journal dump).
app.get('/api/vaults/:id/scratchpad/threads', requireAuth, (req: AuthedRequest, res) => {
  try {
    const threads = listOpenThreads(db, req.user!.id, req.params.id, {
      agentKey: typeof req.query.agent === 'string' ? req.query.agent : undefined,
      includeClosed: req.query.closed === '1' || req.query.closed === 'true',
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ threads });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not list open threads' });
  }
});

app.post('/api/vaults/:id/scratchpad/threads', requireAuth, (req: AuthedRequest, res) => {
  try {
    const thread = openThread(db, req.user!.id, req.params.id, {
      intent: String(req.body?.intent || ''),
      blockedOn: req.body?.blockedOn,
      nextTry: req.body?.nextTry,
      pointer: req.body?.pointer,
      agentKey: req.body?.agentKey,
      runId: req.body?.runId,
    });
    res.status(201).json({ thread });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not open thread' });
  }
});

app.post('/api/vaults/:id/scratchpad/threads/:threadId/close', requireAuth, (req: AuthedRequest, res) => {
  try {
    const thread = closeOpenThread(db, req.user!.id, req.params.id, {
      threadId: Number(req.params.threadId),
      agentKey: req.body?.agentKey,
      reason: req.body?.reason,
    });
    res.json({ thread });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not close thread' });
  }
});

app.post('/api/vaults/:id/scratchpad/skills', requireAuth, (req: AuthedRequest, res) => {
  try {
    const note = createSkillNote(db, req.user!.id, req.params.id, {
      title: String(req.body?.title || ''),
      body: String(req.body?.body || ''),
      agentKey: req.body?.agentKey,
    });
    res.status(201).json({ note: { id: note.id, title: note.title } });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not save skill' });
  }
});

app.get('/api/vaults/:id/scratchpad/skills', requireAuth, (req: AuthedRequest, res) => {
  try {
    const agentKey = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    res.json({ skills: listSkillNotes(db, req.user!.id, req.params.id, agentKey) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not list skills' });
  }
});

app.post('/api/vaults/:id/scratchpad/outcome', requireAuth, (req: AuthedRequest, res) => {
  try {
    const outcome = recordNoteOutcome(db, req.user!.id, req.params.id, {
      noteRef: String(req.body?.noteRef || ''),
      result: req.body?.result,
      agentKey: req.body?.agentKey,
    });
    res.json({ outcome });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not record outcome' });
  }
});

app.post('/api/vaults/:id/scratchpad/promote', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { note, kind } = promoteNote(db, req.user!.id, req.params.id, {
      noteRef: String(req.body?.noteRef || ''),
      agentKey: req.body?.agentKey,
    });
    res.json({ note: { id: note.id, title: note.title }, kind });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not promote note' });
  }
});

// Mid-task, on-demand recall over the agent's memory + skills (own + shared).
// Semantic ranking via QMD (bounded, same as boot); lexical fallback lives in
// recallScratchpad so a cold/slow index still returns matches.
app.get('/api/vaults/:id/scratchpad/recall', requireAuth, async (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const query = String(req.query.q || '').trim();
  if (!query) return res.json({ hits: [] });
  const agentKey = typeof req.query.agent === 'string' ? req.query.agent : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;

  let rankedIds: string[] | undefined;
  if (SCRATCHPAD_QMD_TIMEOUT_MS > 0) {
    try {
      const hits = await Promise.race([
        searchWithQmd(db, vault.id, query, { scope: 'notes', limit: 40 }),
        new Promise<Awaited<ReturnType<typeof searchWithQmd>>>((resolve) => {
          setTimeout(() => resolve([]), SCRATCHPAD_QMD_TIMEOUT_MS);
        }),
      ]);
      const ids = hits.filter((hit) => hit.type === 'note').map((hit) => hit.id);
      if (ids.length) rankedIds = ids;
    } catch { /* lexical fallback inside recallScratchpad */ }
  }
  try {
    res.json({ hits: recallScratchpad(db, req.user!.id, vault.id, { query, agentKey, limit, rankedIds }) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Recall failed' });
  }
});

// ── Backlinks routes ───────────────────────────────────────────────

app.get('/api/notes/:id/backlinks', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const vault = getVault(db, note.vault_id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Note not found' });

  reresolveChatBacklinksForNote(db, note.vault_id, note.id, note.title);
  const chatBacklinks = listChatNoteBacklinks(db, note.id, {
    limit: Number(req.query.limit || 50),
    offset: Number(req.query.offset || 0),
    includeDeleted: req.query.include_deleted === '1' || req.query.include_deleted === 'true',
  });
  res.json({
    backlinks: getBacklinks(db, req.params.id),
    chatBacklinks,
  });
});

// Chat → note backlink backfill (idempotent, resumable)
app.post('/api/vaults/:id/chat-backlinks/backfill', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const result = backfillChatNoteBacklinks(db, vault.id, {
      afterRowid: Number(req.body?.afterRowid || 0),
      limit: Number(req.body?.limit || 500),
    });
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Backfill failed' });
  }
});

// Distill chat range → note
app.post('/api/vaults/:vaultId/channels/:channelId/distill', requireAuth, (req: AuthedRequest, res) => {
  try {
    const mode = String(req.body?.mode || 'create') as 'create' | 'append' | 'merge';
    const result = distillChatToNote(db, req.user!.id, req.params.vaultId, req.params.channelId, {
      mode,
      fromMessageId: typeof req.body?.fromMessageId === 'string' ? req.body.fromMessageId : undefined,
      toMessageId: typeof req.body?.toMessageId === 'string' ? req.body.toMessageId : undefined,
      lastN: req.body?.lastN != null ? Number(req.body.lastN) : undefined,
      noteRef: typeof req.body?.note === 'string' ? req.body.note
        : typeof req.body?.noteId === 'string' ? req.body.noteId
          : typeof req.body?.noteRef === 'string' ? req.body.noteRef : undefined,
      title: typeof req.body?.title === 'string' ? req.body.title : undefined,
      confirm: req.body?.confirm === true,
      by: req.user!.username,
    });
    if (result.note) {
      emitVaultEvent(req.params.vaultId, 'vault:noteChanged', {
        noteId: result.note.id,
        vaultId: req.params.vaultId,
        title: result.note.title,
      });
    }
    res.status(result.status === 'needs_confirm' ? 202 : 200).json(result);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Distill failed' });
  }
});

// Agent memory controls
app.get('/api/vaults/:id/agent-memory', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  try {
    const agentKey = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    ensureAgentMemoryFolders(db, vault.id, req.user!.id);
    const injection = buildAgentMemoryInjection(db, vault.id, {
      channelTopic: typeof req.query.topic === 'string' ? req.query.topic : undefined,
      agentKey,
    });
    res.json({
      enabled: isAgentMemoryEnabled(db, vault.id),
      injection,
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Agent memory failed' });
  }
});

app.put('/api/vaults/:id/agent-memory', requireAuth, (req: AuthedRequest, res) => {
  const vault = getWritableVault(db, req.params.id, req.user!.id);
  if (!vault) {
    if (getVault(db, req.params.id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit agent memory' });
    return res.status(404).json({ error: 'Vault not found' });
  }
  try {
    if (typeof req.body?.enabled === 'boolean') {
      setAgentMemoryEnabled(db, vault.id, req.body.enabled);
    }
    if (req.body?.remember || req.body?.body) {
      const note = createAgentMemoryNote(db, req.user!.id, vault.id, {
        title: typeof req.body.title === 'string' ? req.body.title : undefined,
        body: String(req.body.remember || req.body.body || ''),
        agentKey: typeof req.body.agent === 'string' ? req.body.agent
          : typeof req.body.agentKey === 'string' ? req.body.agentKey : undefined,
        listed: req.body.listed === true,
      });
      emitVaultEvent(vault.id, 'vault:noteCreated', { noteId: note.id, vaultId: vault.id, title: note.title });
      res.status(201).json({ enabled: isAgentMemoryEnabled(db, vault.id), note });
      return;
    }
    ensureAgentMemoryFolders(db, vault.id, req.user!.id);
    res.json({ enabled: isAgentMemoryEnabled(db, vault.id) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Agent memory update failed' });
  }
});

// Vault-level persistent agents (identity shared across channels)
app.get('/api/vaults/:vaultId/vault-agents', requireAuth, (req: AuthedRequest, res) => {
  try {
    const agents = listVaultAgents(db, req.user!.id, req.params.vaultId);
    res.json({ agents });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Re-exported implementation lives in server/chat.ts — keeps sibling-channel
// projection and ownership fallbacks unit-testable without the Express layer.

app.put('/api/vaults/:vaultId/vault-agents', requireAuth, (req: AuthedRequest, res) => {
  try {
    const agent = upsertVaultAgent(db, req.user!.id, req.params.vaultId, req.body || {});
    // Each persistent agent gets its own memory folder: _agent/<mention>/memory/
    try {
      ensureAgentNamedMemoryFolders(db, req.params.vaultId, req.user!.id, agent.mention);
    } catch (error) {
      console.warn('agent memory folder ensure skipped:', error instanceof Error ? error.message : error);
    }
    const channels = db.prepare(`
      SELECT id FROM notes WHERE vault_id = ? AND trim(content) LIKE ?
    `).all(req.params.vaultId, `${CHAT_NOTE_MARKER}%`) as Array<{ id: string }>;
    for (const channel of channels) ensureVaultWideAgents(db, req.params.vaultId, channel.id, req.user!.id);
    emitVaultEvent(req.params.vaultId, 'vault:vaultAgentUpserted', { agent });
    res.json({ agent });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/vaults/:vaultId/vault-agents/:agentId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const agent = getVaultAgent(db, req.user!.id, req.params.vaultId, req.params.agentId);
    if (!agent) return res.status(404).json({ error: 'Vault agent not found' });
    res.json({ agent });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/vaults/:vaultId/vault-agents/:agentId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const removed = removeVaultAgentFromVault(db, req.user!.id, req.params.vaultId, req.params.agentId);
    if (!removed) return res.status(404).json({ error: 'Vault agent not found' });
    emitVaultEvent(req.params.vaultId, 'vault:vaultAgentRemoved', { agentId: req.params.agentId });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/vaults/:vaultId/vault-agents/:agentId/profile', requireAuth, (req: AuthedRequest, res) => {
  try {
    const removed = deleteVaultAgent(db, req.user!.id, req.params.vaultId, req.params.agentId);
    if (!removed) return res.status(404).json({ error: 'Vault agent not found' });
    emitVaultEvent(req.params.vaultId, 'vault:vaultAgentDeleted', { agentId: req.params.agentId });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/agents/from-vault', requireAuth, (req: AuthedRequest, res) => {
  try {
    const vaultAgentId = String(req.body?.vaultAgentId || req.body?.agentId || '').trim();
    if (!vaultAgentId) return res.status(400).json({ error: 'vaultAgentId is required' });
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const registration = addVaultAgentToChannel(
      db,
      req.user!.id,
      req.params.vaultId,
      req.params.channelId,
      vaultAgentId,
      req.body || {},
    );
    emitChatAgentEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatAgentMemberUpserted', { registration });
    res.status(201).json({ registration });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
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
  const vault = getWritableVault(db, note.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, note.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit tags' });
    return res.status(404).json({ error: 'Note not found' });
  }

  try {
    addTag(db, req.params.id, vault.id, String(req.body.name || ''), req.body.color, req.user!.id);
    const updated = getNote(db, req.params.id);
    res.json({ note: redactNoteForAgent(req, updated) });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not add tag' });
  }
});

app.delete('/api/notes/:id/tags/:tagId', requireAuth, (req: AuthedRequest, res) => {
  const note = getNote(db, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  const vault = getWritableVault(db, note.vault_id, req.user!.id);
  if (!vault) {
    if (getVault(db, note.vault_id, req.user!.id)) return res.status(403).json({ error: 'Viewer role cannot edit tags' });
    return res.status(404).json({ error: 'Note not found' });
  }

  removeTag(db, req.params.id, req.params.tagId, req.user!.id);
  const updated = getNote(db, req.params.id);
  res.json({ note: redactNoteForAgent(req, updated) });
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

// ── Agent / Run routes ─────────────────────────────────────────────

app.get('/api/vaults/:id/runs', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ runs: listRuns(db, vault.id, req.user!.id) });
});

app.get('/api/vaults/:id/active-sessions', requireAuth, (req: AuthedRequest, res) => {
  const vault = getVault(db, req.params.id, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  res.json({ sessions: listActiveSessions(db, req.user!.id, vault.id) });
});

app.get('/api/me/active-sessions', requireAuth, (req: AuthedRequest, res) => {
  res.json({ sessions: listActiveSessions(db, req.user!.id) });
});

app.post('/api/vaults/:id/runs', requireAuth, async (req: AuthedRequest, res) => {
  const { prompt, note_id, agent, conversation_id, images, model, cwd, yolo } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  const validAgents = ['claude-code', 'codex', 'grok', 'antigravity', 'copilot', 'hermes', 'akron-grok', 'omp'] as const satisfies readonly AgentId[];
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
  let triggeringMessageId = typeof req.body?.chat?.triggeringMessageId === 'string'
    ? req.body.chat.triggeringMessageId.trim()
    : '';
  const chatWorkspaceNeeded = req.body?.chat?.workspaceNeeded === true
    || req.body?.chat?.workspaceNeeded === 1
    || req.body?.chat?.workspaceNeeded === '1'
    || req.body?.chat?.workspaceNeeded === 'true';
  const chatReplyTo = req.body?.chat?.replyTo as ChatReplyRef | undefined;
  let registrationId = typeof req.body?.registrationId === 'string' ? req.body.registrationId.trim() : '';
  const chatDispatchId = typeof req.body?.chatDispatchId === 'string' ? req.body.chatDispatchId.trim() : '';
  let chatDispatch: ChatAgentDispatch | null = null;
  let chatMissionTaskId = '';
  let chatWorkItemId = '';
  if (chatDispatchId) {
    if (!chatChannelId) return res.status(400).json({ error: 'Chat channel is required for dispatch' });
    chatDispatch = getChatAgentDispatch(db, req.user!.id, chatChannelId, chatDispatchId);
    if (!chatDispatch) return res.status(404).json({ error: 'Chat dispatch not found' });
    const wakeMissionId = /^sys-mission-([0-9a-f-]{36})-/i.exec(chatDispatch.messageId)?.[1];
    if (wakeMissionId) {
      const missionState = db.prepare('SELECT status FROM chat_missions WHERE id = ?')
        .get(wakeMissionId) as { status: string } | undefined;
      if (missionState?.status === 'completed' || missionState?.status === 'canceled') {
        const { route } = assertChatChannel(db, chatChannelId, req.user!.id);
        db.prepare('DELETE FROM chat_messages WHERE id = ? AND channel_id = ?')
          .run(chatDispatch.messageId, route.sourceChannelId);
        emitChatMessageDeleted(route.sourceVaultId, route.sourceChannelId, chatDispatch.messageId);
        return res.status(404).json({ error: 'Chat dispatch not found' });
      }
    }
    registrationId = chatDispatch.registration.id;
    triggeringMessageId = chatDispatch.messageId;
    chatMissionTaskId = chatDispatch.message.missionTaskId || '';
    chatWorkItemId = chatMissionTaskId ? (getMissionTaskWorkItemId(db, chatMissionTaskId) || '') : '';
    if (chatDispatch.runId != null) {
      const existing = getRun(db, chatDispatch.runId);
      if (existing) return res.json({ run: existing, reused: true });
    }
  }

  // Resolve the run's execution context. A chat-agent ping always executes on the
  // *agent owner's* desktop runner using the owner's stored registration — never
  // the pinger's machine or client-supplied cwd/model/yolo. Non-chat runs (note
  // panes) and legacy chat runs execute on the requesting user's own runner.
  let runVault: Vault;
  let runnerUserId: number;
  let selectedAgent: AgentId;
  let selectedModel: string | undefined;
  let selectedReasoningEffort: string | undefined;
  let priorityServiceTier = false;
  let selectedCwd: string | undefined;
  let yoloMode: boolean;
  let targetChannelId = chatChannelId;
  let requesterIsOwner = true;
  let chatAuthor = '';
  let chatRegistrationId = '';
  // Memory isolation key: prefer @handle (unique vault identity), then vault agent id.
  // Never key by displayName alone — that caused shared folders across agents.
  let agentMemoryKey = '';

  if (chatChannelId && registrationId) {
    let resolved: ReturnType<typeof resolveChatAgentRun>;
    try {
      resolved = resolveChatAgentRun(db, req.user!.id, chatChannelId, registrationId);
    } catch {
      return res.status(404).json({ error: 'Agent not found' });
    }
    const { registration, agentVault, route, ownerChannelId, ownerId } = resolved;
    requesterIsOwner = req.user!.id === ownerId;
    if (!requesterIsOwner && !registration.pingableByOthers) {
      return res.status(403).json({ error: "This agent isn't accepting pings from other users." });
    }
    // Owner's registration is authoritative — the pinger's request body can't
    // override the agent, model, cwd, or yolo it runs with on the owner's box.
    runVault = agentVault;
    runnerUserId = ownerId;
    selectedAgent = pickAgent(registration.agentId);
    selectedModel = normalizeRunModel(registration.model);
    // Empty means inherit the user's local Codex CLI config; an explicit value
    // is a per-channel override chosen in this agent's Cascade settings.
    selectedReasoningEffort = selectedAgent === 'codex' || selectedAgent === 'claude-code'
      ? chatDispatch?.reasoningEffort || registration.reasoningEffort || undefined
      : undefined;
    priorityServiceTier = selectedAgent === 'codex' && registration.priorityServiceTier;
    selectedCwd = normalizeRunCwd(registration.cwd);
    // A channel cwd is a path on the channel owner's machine. Never pass that
    // path to somebody else's runner: shared agents keep their owner's own cwd.
    const sourceVault = db.prepare('SELECT created_by FROM vaults WHERE id = ?')
      .get(route.sourceVaultId) as { created_by: number } | undefined;
    if (sourceVault?.created_by === ownerId) {
      const channelCwd = getChannelCwd(db, route.sourceChannelId);
      if (channelCwd) selectedCwd = normalizeRunCwd(channelCwd);
    }
    // A mission task's bound workspace is authoritative for every launch and
    // resume. It must beat a broad channel cwd so parallel task branches never
    // silently execute in the shared checkout.
    if (chatWorkItemId) {
      try {
        const workItem = getWorkItem(db, runnerUserId, chatWorkItemId);
        if (workItem.worktreePath) selectedCwd = workItem.worktreePath;
      } catch { /* a stale/deleted twin falls back to the registered cwd */ }
    }
    // Guests may invoke an explicitly pingable agent, but never with unattended
    // command approval. Only the owner can exercise the registration's yolo flag.
    yoloMode = requesterIsOwner && registration.yolo;
    targetChannelId = ownerChannelId;
    chatAuthor = registration.displayName || registration.agentId;
    chatRegistrationId = registration.id;
    agentMemoryKey = selectedAgent === 'akron-grok'
      ? 'akron'
      : registration.mention || registration.vaultAgentId || registration.agentId || selectedAgent;
  } else {
    const vault = getVault(db, req.params.id, req.user!.id);
    if (!vault) return res.status(404).json({ error: 'Vault not found' });
    runVault = vault;
    runnerUserId = req.user!.id;
    selectedAgent = pickAgent(agent);
    selectedModel = normalizeRunModel(model);
    selectedReasoningEffort = undefined;
    selectedCwd = normalizeRunCwd(cwd);
    yoloMode = yolo === true;
    chatAuthor = typeof req.body?.chat?.author === 'string' ? req.body.chat.author.trim() : '';
    chatRegistrationId = registrationId;
    agentMemoryKey = selectedAgent === 'akron-grok' ? 'akron' : chatAuthor || selectedAgent;
  }

  // Every agent — Claude included — executes on a user's own machine via the
  // desktop runner relay. The server never runs an LLM itself (no API keys / no
  // Claude login on the server); it only relays runs to a connected desktop.
  // Poll briefly rather than checking once: a busy or reconnecting local runner
  // can be absent for a moment (a lapsed heartbeat, a socket.io reconnect) even
  // though it's about to be dispatchable. Hard-failing here is what surfaces the
  // spurious "no runner connected" mid-run.
  if (!(await waitForDesktopRunner(runnerUserId))) {
    const error = requesterIsOwner
      ? 'No desktop agent runner is connected. Open Fizzer on your computer (signed in to the same account) to run agents from chat.'
      : "This agent's owner is offline — their desktop runner isn't connected, so the agent can't run right now.";
    noteDesktopRunnerError(runnerUserId, error);
    return res.status(503).json({ error });
  }

  // A mission-owned isolated workspace is materialized by the owner's desktop,
  // then bound durably before the run record or provider process exists. This
  // makes first launch, retry, renderer reload, and agent handoff use the same
  // task checkout without granting any publication authority.
  if (chatWorkItemId) {
    try {
      const workItem = getWorkItem(db, runnerUserId, chatWorkItemId);
      if (workItem.workspaceMode === 'isolated') {
        const preparationDir = workItem.worktreePath || workItem.repository || selectedCwd;
        if (!preparationDir) {
          return res.status(409).json({
            error: 'Mission task needs a repository cwd before its isolated workspace can be prepared.',
          });
        }
        const prepared = await prepareDesktopWorkspace(runnerUserId, {
          workItemId: workItem.id,
          dir: preparationDir,
          branch: workItem.branch,
          baseBranch: workItem.gitState?.baseBranch || undefined,
          channelId: targetChannelId,
        });
        bindWorkItemWorkspace(db, runnerUserId, workItem.id, {
          repository: prepared.repository,
          baseCommit: prepared.baseCommit,
          branch: prepared.branch,
          worktreePath: prepared.path,
        });
        selectedCwd = prepared.path;
      }
    } catch (error) {
      return res.status(409).json({
        error: error instanceof Error ? error.message : 'Could not prepare the mission task workspace',
      });
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
    // Prompt may still get memory/scratchpad context for cold starts only.
    const preliminaryConversationId =
      typeof conversation_id === 'string' && conversation_id ? conversation_id : undefined;

    // Bound chat sessions by age/run count. A rotation gets the same cold-start
    // recent-channel context below, while avoiding another pass over a multi-day
    // CLI transcript. Non-chat note sessions retain their old unbounded behavior.
    const resumeSessionId = preliminaryConversationId
      ? findConversationSession(db, {
          vaultId: runVault.id,
          noteId: note_id || null,
          agent: selectedAgent,
          conversationId: preliminaryConversationId,
          boundedChat: Boolean(targetChannelId),
        })
      : undefined;
    const willResume = Boolean(resumeSessionId);
    const providerSessionTurn = resumeSessionId && preliminaryConversationId
      ? countConversationSessionRuns(db, {
          vaultId: runVault.id,
          noteId: note_id || null,
          agent: selectedAgent,
          conversationId: preliminaryConversationId,
        }, resumeSessionId) + 1
      : 1;
    // Hermes already loads the cwd rules, native memory/profile, skills, and
    // tool schemas. Re-injecting Cascade's general context on top made the same
    // task materially larger than `hermes -z`. Keep the default path near CLI
    // parity and add only the chat/workspace context the request actually needs.
    const hermesChatParity = selectedAgent === 'hermes' && Boolean(targetChannelId);
    const includeAppContract = !willResume && (!hermesChatParity || chatWorkspaceNeeded);
    const includeWorkspace = Boolean(targetChannelId)
      && !willResume
      && (!hermesChatParity || chatWorkspaceNeeded);
    const includeCascadeMemory = !willResume && !hermesChatParity;

    let effectivePrompt = prompt;
    // The resumed CLI session already holds the stable Cascade capability
    // contract. Re-sending it on every turn wastes context and can make a
    // correctly resumed follow-up look like another cold system boot.
    const contextChunks: string[] = includeAppContract ? [CASCADE_AGENT_APP_CONTEXT] : [];
    if (targetChannelId && !willResume) contextChunks.push(CASCADE_MISSION_DISCRETION_CONTEXT);
    // Provider sessions remember their own prior turns, but not chat posted by
    // other room participants between invocations. Rejoin every chat run with
    // a bounded, current server snapshot; cold rotations also get the agent's
    // own last contributions. The focused renderer-built reply chain remains
    // in `prompt` and therefore takes priority over this shared state.
    if (targetChannelId) {
      try {
        const room = buildAgentRoomContext({
          messages: listChatMessages(db, targetChannelId, runnerUserId, { limit: 64 }),
          registrations: listChatAgentMembers(db, targetChannelId, runnerUserId),
          missions: listActiveChatMissions(db, runnerUserId, targetChannelId, 3),
          targetRegistrationId: chatRegistrationId,
          excludeMessageIds: [chatMessageId, triggeringMessageId],
          includeOwnPrior: !willResume,
          continuation: willResume,
          sessionTurn: providerSessionTurn,
          cursorMessageId: triggeringMessageId,
          maxChars: willResume ? 1_200 : 2_800,
        });
        if (room) contextChunks.push(room);
      } catch { /* best-effort continuity; the focused request still runs */ }
    }
    // A resumed session already has the prior workspace snapshot and can use
    // cascade-note when fresh live state matters. Re-sending up to 4k chars on
    // every steering turn was pure context multiplication.
    if (includeWorkspace) {
      try {
        const workspace = buildAgentChannelWorkspaceContext(
          db,
          targetChannelId,
          4_000,
        );
        if (workspace) contextChunks.push(workspace);
      } catch { /* best-effort context; the request still runs without it */ }
    }
    if (!willResume) {
      if (includeCascadeMemory) {
        try {
          const channelTitle = targetChannelId
            ? (getNote(db, targetChannelId)?.title || '')
            : '';
          try {
            if (agentMemoryKey) {
              ensureAgentNamedMemoryFolders(db, runVault.id, runnerUserId, agentMemoryKey);
            }
          } catch { /* best-effort folder mint */ }
          const topic = `${channelTitle} ${prompt}`.slice(0, 400);
          // Run startup uses the bounded lexical ranking built into memory
          // injection. QMD synchronizes the whole vault corpus before search
          // and could add up to four seconds to a cold conversational turn.
          // Semantic recall remains available explicitly through `recall`,
          // where its cost is requested rather than hidden on every cold boot.
          const mem = buildAgentMemoryInjection(db, runVault.id, {
            channelTopic: topic,
            maxChars: 900,
            agentKey: agentMemoryKey || selectedAgent,
            noteStats: getNoteStatsForVault(db, runVault.id),
          });
          if (mem.enabled && mem.text) contextChunks.push(mem.text);
        } catch (error) {
          console.warn('Agent memory injection skipped:', error instanceof Error ? error.message : error);
        }
        try {
          const scratchpadKey = agentMemoryKey || selectedAgent;
          ensureScratchpadPolicies(db, runVault.id, runnerUserId, scratchpadKey);
          const scratchpad = buildScratchpadInjection(db, runVault.id, {
            agentKey: scratchpadKey,
            userId: runnerUserId,
            maxChars: 1400,
          });
          if (scratchpad) contextChunks.push(scratchpad);
        } catch (error) {
          console.warn('Scratchpad injection skipped:', error instanceof Error ? error.message : error);
        }
      }
    }
    if (contextChunks.length) {
      effectivePrompt = `${prompt}\n\n[Context: ${contextChunks.join('\n\n')}]`;
    }
    // Defense in depth: sanitize after all workspace, memory, scratchpad, and
    // chat context has been assembled, immediately before the model run.
    effectivePrompt = redactPrivateBlocks(effectivePrompt);

    let run;
    if (chatDispatchId && chatRegistrationId) {
      const occupied = findOpenRunForChatRegistration(db, chatRegistrationId, chatDispatchId);
      if (occupied) {
        // A legacy ghost with no durable owner can be released. An offline
        // transport is still reclaimable and must not cancel its local child.
        if (forceCancelUnreclaimableRun(db, occupied.id)) {
          for (const update of settleChatMessagesForRun(db, occupied.id)) {
            emitChatMessageEvent(update.vaultId, update.channelId, 'vault:chatMessageUpdated', update.message);
          }
        } else {
          const occupiedOwner = getDelegatedRunOwner(occupied.id)
            ?? getDelegatedRunOwnerFromDb(db, occupied.id);
          if (occupiedOwner != null && !isDesktopRunnerOnline(occupiedOwner)) {
            return res.status(409).json({
              error: 'Agent session is reconnecting; this turn remains queued.',
              activeRunId: occupied.id,
            });
          }
          // Steering / follow-up turns: try one server-side steering cancel so a
          // hung predecessor cannot permanently 409 the continuation. The cancel
          // path awaits desktop stop then force-settles when steering.
          const steeredAway = await cancelRun(db, occupied.id, { steering: true });
          if (steeredAway) {
            for (const update of settleChatMessagesForRun(db, occupied.id)) {
              emitChatMessageEvent(update.vaultId, update.channelId, 'vault:chatMessageUpdated', update.message);
            }
          } else {
            // Leave this dispatch unclaimed. Another renderer/reconnect can retry
            // after the physical-stop acknowledgement settles the active run.
            return res.status(409).json({
              error: 'Agent session is still stopping; this turn remains queued.',
              activeRunId: occupied.id,
            });
          }
        }
      }
    }
    try {
      run = await startRun(db, runVault, note_id || null, effectivePrompt, selectedAgent, {
        ownerUserId: runnerUserId,
        conversationId: preliminaryConversationId,
        model: selectedModel,
        sessionId: resumeSessionId,
        chatDispatchId: chatDispatchId || undefined,
      });
    } catch (error) {
      // Two renderers may recover the same durable dispatch concurrently. The
      // unique run key makes the first writer authoritative; everyone else
      // joins that run instead of spawning another local model process.
      const existing = chatDispatchId ? findRunByChatDispatch(db, chatDispatchId) : undefined;
      if (existing) {
        attachRunToChatAgentDispatch(db, chatDispatchId, existing.id);
        return res.json({ run: existing, reused: true });
      }
      throw error;
    }
    if (chatDispatchId) {
      attachRunToChatAgentDispatch(db, chatDispatchId, run.id);
      const missionUpdate = attachRunToMissionTaskByDispatch(db, chatDispatchId, run.id);
      if (missionUpdate) emitMissionProjection(missionUpdate);
    }

    // Server single-writer: create/link the running agent message before
    // delegation so stream updates never no-op on a missing placeholder.
    if (targetChannelId && chatMessageId) {
      try {
        const { message: ensured, created } = ensureAgentChatMessage(
          db,
          runnerUserId,
          runVault.id,
          targetChannelId,
          {
            messageId: chatMessageId,
            author: chatAuthor || selectedAgent,
            agentId: selectedAgent,
            registrationId: chatRegistrationId || undefined,
            missionTaskId: chatMissionTaskId || undefined,
            runId: run.id,
            body: 'Thinking...',
            replyTo: chatReplyTo,
          },
        );
        const { route } = assertChatChannel(db, targetChannelId, runnerUserId);
        emitChatMessageEvent(
          route.sourceVaultId,
          route.sourceChannelId,
          created ? 'vault:chatMessageCreated' : 'vault:chatMessageUpdated',
          ensured,
        );
      } catch (error) {
        console.warn('ensureAgentChatMessage failed:', error instanceof Error ? error.message : error);
      }
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
      reasoningEffort: selectedReasoningEffort,
      priorityServiceTier,
      resumeSessionId,
      chatChannelId: targetChannelId,
      chatMessageId,
      chatTriggeringMessageId: triggeringMessageId,
      chatAuthor,
      agentMemoryKey: agentMemoryKey || selectedAgent,
      chatRegistrationId,
      workItemId: chatWorkItemId || undefined,
      images: cleanImages,
      yolo: yoloMode,
    }, db);
    if (!delegated) {
      chatRunTargets.delete(run.id);
      const error = 'Desktop agent runner disconnected before the run could start. Open Fizzer on your computer and try again.';
      noteDesktopRunnerError(runnerUserId, error);
      finishDelegatedRun(db, run.id, { status: 'failed', summary: error });
      publishRunEvent(db, run.id, 'status', { status: 'failed', summary: error });
      return res.status(503).json({ error });
    }

    res.json({ run, reused: false });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/runs/:id', requireAuth, (req: AuthedRequest, res) => {
  const run = getOwnedRun(db, Number(req.params.id), req.user!.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  res.json({ run });
});

app.get('/api/runs/:id/events', requireAuth, (req: AuthedRequest, res) => {
  const run = getOwnedRun(db, Number(req.params.id), req.user!.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  res.json({ events: listRunEvents(db, run.id) });
});

// Whether this user's desktop app is connected and able to host agent runs.
app.get('/api/me/desktop-runner', requireAuth, (req: AuthedRequest, res) => {
  res.json(getDesktopRunnerStatus(req.user!.id, db));
});

app.post('/api/runs/:id/cancel', requireAuth, async (req: AuthedRequest, res) => {
  const run = getOwnedRun(db, Number(req.params.id), req.user!.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  try {
    // An explicit operator stop must settle server state even if the desktop
    // process races its acknowledgement or the runner socket is wedged.
    const success = await cancelRun(db, run.id, {
      steering: req.body?.steering === true,
      force: req.body?.steering !== true,
    });
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
    // Default list is slim (no harness logs, truncated blocks, last N messages).
    // ?detail=full ships everything — avoid on mobile cold load.
    const detail = String(req.query.detail || 'list') === 'full' ? 'full' : 'list';
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const messages = listChatMessages(db, req.params.channelId, req.user!.id, { detail, limit });
    res.json({ messages });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const message = getChatMessage(db, req.params.channelId, req.user!.id, req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    res.json({ message });
  } catch {
    res.status(404).json({ error: 'Message not found' });
  }
});

function refreshChatNoteGrants(userId: number, localVaultId: string, sourceChannelId: string, message: { id: string; body: string }) {
  db.prepare('DELETE FROM chat_note_grants WHERE message_id = ? AND granted_by = ?').run(message.id, userId);
  const titles = new Set<string>();
  const pattern = /!\[\[([^\]\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(message.body)) !== null) {
    // Keep the server-side snapshot lookup in lockstep with the renderer:
    // `![[Plan|short label]]` and `![[Plan#section]]` both embed `Plan`.
    const title = match[1].split('|', 1)[0].split('#', 1)[0].trim();
    if (title) titles.add(title);
  }
  // Snapshot at grant time: channel readers get frozen share content, not a live vault join.
  const findNote = db.prepare(`
    SELECT id, title, content, content_preview FROM notes
    WHERE vault_id = ? AND title = ? COLLATE NOCASE AND is_archived = 0
    ORDER BY updated_at DESC LIMIT 1
  `);
  const grant = db.prepare(`
    INSERT OR IGNORE INTO chat_note_grants
      (message_id, channel_id, note_id, granted_by, title_snapshot, content_snapshot, preview_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const title of titles) {
    const note = findNote.get(localVaultId, title) as {
      id: string; title: string; content: string; content_preview: string;
    } | undefined;
    if (!note) continue;
    // Prefer on-disk body when present (notes.content can lag).
    const full = getNote(db, note.id);
    const content = full?.content ?? note.content ?? '';
    const preview = (full?.content_preview ?? note.content_preview ?? '').slice(0, 400);
    grant.run(
      message.id,
      sourceChannelId,
      note.id,
      userId,
      full?.title ?? note.title,
      content,
      preview,
    );
  }
}

app.get('/api/vaults/:vaultId/channels/:channelId/messages/:messageId/embeds', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    // Prefer frozen snapshots; fall back to live note only for pre-migration rows
    // and only when the reader is a member of the note's vault.
    const rows = db.prepare(`
      SELECT g.note_id AS id,
             COALESCE(g.title_snapshot, n.title) AS title,
             g.content_snapshot AS content,
             COALESCE(g.preview_snapshot, n.content_preview) AS content_preview,
             n.vault_id AS note_vault_id
      FROM chat_note_grants g
      JOIN notes n ON n.id = g.note_id
      WHERE g.channel_id = ? AND g.message_id = ?
      ORDER BY title COLLATE NOCASE
    `).all(route.sourceChannelId, req.params.messageId) as Array<{
      id: string;
      title: string;
      content: string | null;
      content_preview: string;
      note_vault_id: string;
    }>;
    const notes = rows.map((row) => {
      if (row.content != null && row.content !== '') {
        return {
          id: row.id,
          title: row.title,
          content: row.content,
          content_preview: row.content_preview,
        };
      }
      // Legacy grant without snapshot: only vault members get live content.
      if (getVault(db, row.note_vault_id, req.user!.id)) {
        const live = getNote(db, row.id);
        return {
          id: row.id,
          title: live?.title ?? row.title,
          content: live?.content ?? '',
          content_preview: live?.content_preview ?? row.content_preview,
        };
      }
      return {
        id: row.id,
        title: row.title,
        content: row.content_preview || '',
        content_preview: row.content_preview || '',
      };
    });
    res.json({ notes: isAgentRequest(req) ? notes.map((n) => redactNoteForAgent(req, n)) : notes });
  } catch {
    res.status(404).json({ error: 'Message not found' });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/messages', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    ensureVaultWideAgents(db, req.params.vaultId, req.params.channelId, req.user!.id);
    assertDirectMessageSendAllowed(db, route.sourceChannelId, req.user!.id);
    const rawInput = isAgentRequest(req)
      ? req.body
      : { ...req.body, author: req.user!.username, agentId: undefined, registrationId: undefined };
    const agents = listChatAgentMembers(db, req.params.channelId, req.user!.id);
    const input = inferNaturalChatLink(
      rawInput as ChatMessage,
      listChatMessages(db, req.params.channelId, req.user!.id, { limit: 48 }),
      agents,
    );
    const message = createChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, input);
    const dispatches = createChatAgentDispatches(
      db,
      req.user!.id,
      req.params.channelId,
      message,
    );
    refreshChatNoteGrants(req.user!.id, req.params.vaultId, route.sourceChannelId, message);
    try {
      indexChatMessageBacklinks(db, route.sourceVaultId, route.sourceChannelId, {
        id: message.id,
        author: message.author,
        body: message.body,
        createdAt: message.createdAt,
      });
    } catch (error) {
      console.warn('chat backlink index skipped:', error instanceof Error ? error.message : error);
    }
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageCreated', message, dispatches);
    res.status(201).json({ message, agents, dispatches });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/messages/:messageId/collaborate', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    ensureVaultWideAgents(db, req.params.vaultId, req.params.channelId, req.user!.id);
    assertDirectMessageSendAllowed(db, route.sourceChannelId, req.user!.id);
    const result = createChatCollaboration(
      db,
      req.user!.id,
      req.params.vaultId,
      req.params.channelId,
      {
        sourceMessageId: req.params.messageId,
        target: String(req.body?.target || ''),
        relationship: req.body?.relationship,
        instruction: String(req.body?.instruction || ''),
        requestId: String(req.body?.requestId || ''),
        callerRegistrationId: isAgentRequest(req) ? String(req.body?.registrationId || '') : '',
        author: req.user!.username,
      },
      isAgentRequest(req),
    );
    const agents = listChatAgentMembers(db, req.params.channelId, req.user!.id);
    refreshChatNoteGrants(req.user!.id, req.params.vaultId, route.sourceChannelId, result.message);
    try {
      indexChatMessageBacklinks(db, route.sourceVaultId, route.sourceChannelId, {
        id: result.message.id,
        author: result.message.author,
        body: result.message.body,
        createdAt: result.message.createdAt,
      });
    } catch (error) {
      console.warn('chat backlink index skipped:', error instanceof Error ? error.message : error);
    }
    emitChatMessageEvent(
      route.sourceVaultId,
      route.sourceChannelId,
      'vault:chatMessageCreated',
      result.message,
      [result.dispatch],
    );
    res.status(201).json({ message: result.message, agents, dispatches: [result.dispatch] });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/agent-dispatches/pending', requireAuth, (req: AuthedRequest, res) => {
  try {
    const dispatches = listPendingChatAgentDispatches(db, req.user!.id, req.params.channelId);
    res.json({ dispatches });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/missions', requireAuth, (req: AuthedRequest, res) => {
  try {
    let update = createChatMission(db, req.user!.id, req.params.vaultId, req.params.channelId, {
      rootMessageId: String(req.body?.rootMessageId || ''),
      coordinatorRegistrationId: String(req.body?.coordinatorRegistrationId || ''),
      title: String(req.body?.title || ''),
      objective: String(req.body?.objective || ''),
    });
    // When an agent elects to open a mission from inside an active ping, bind
    // that exact run as the primary task. This gives discretionary missions the
    // same terminal reconciliation and review wake as orchestrator missions.
    const runId = Number(req.headers['x-cascade-run-id']);
    if (isAgentRequest(req) && Number.isFinite(runId) && runId > 0) {
      const registrationId = String(req.body?.coordinatorRegistrationId || '');
      const active = db.prepare(`
        SELECT d.id AS dispatch_id
        FROM runs r
        JOIN chat_agent_dispatches d ON d.id = r.chat_dispatch_id
        WHERE r.id = ? AND r.status IN ('queued', 'running')
          AND d.registration_id = ? AND d.channel_id = ?
      `).get(runId, registrationId, update.channelId) as { dispatch_id: string } | undefined;
      if (active) {
        const primary = addChatMissionTask(db, req.user!.id, req.params.channelId, update.mission.id, {
          coordinatorRegistrationId: registrationId,
          title: 'Primary task',
          assignee: registrationId,
          prompt: update.mission.objective,
          primary: true,
        });
        update = linkMissionTaskDispatch(db, primary.task.id, active.dispatch_id);
        update = attachRunToMissionTaskByDispatch(db, active.dispatch_id, runId) || update;
      }
    }
    emitMissionProjection(update);
    res.status(201).json({ mission: update.mission });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create mission' });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/missions', requireAuth, (req: AuthedRequest, res) => {
  try {
    const missions = listChatMissions(
      db,
      req.user!.id,
      req.params.channelId,
      typeof req.query.coordinator === 'string' ? req.query.coordinator : undefined,
    );
    res.json({ missions });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Missions not found' });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/missions/:missionId/history', requireAuth, (req: AuthedRequest, res) => {
  try {
    const events = listChatMissionEvents(
      db,
      req.user!.id,
      req.params.channelId,
      req.params.missionId,
    );
    res.json({ events });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Mission history not found' });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/missions/:missionId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const update = getChatMission(
      db,
      req.user!.id,
      req.params.channelId,
      req.params.missionId,
      typeof req.query.coordinator === 'string' ? req.query.coordinator : undefined,
    );
    res.json({ mission: update.mission });
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Mission not found' });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/missions/:missionId/tasks', requireAuth, (req: AuthedRequest, res) => {
  try {
    const prompt = String(req.body?.prompt || '').trim();
    const added = db.transaction(() => addChatMissionTask(db, req.user!.id, req.params.channelId, req.params.missionId, {
        coordinatorRegistrationId: String(req.body?.coordinatorRegistrationId || ''),
        title: String(req.body?.title || ''),
        assignee: String(req.body?.assignee || ''),
        prompt,
        dependsOn: Array.isArray(req.body?.dependsOn) ? req.body.dependsOn.map(String) : [],
        priority: Number(req.body?.priority) || 0,
        reasoningEffort: String(req.body?.reasoningEffort || ''),
        anonymous: Boolean(req.body?.anonymous),
      }))();
    const scheduled = scheduleMissionWork(added.update.mission.id);
    const latest = getChatMission(db, req.user!.id, req.params.channelId, added.update.mission.id);
    const dispatched = scheduled.dispatches.find((item) => item.message.missionTaskId === added.task.id);
    res.status(201).json({
      mission: latest.mission,
      task: latest.mission.tasks.find((task) => task.id === added.task.id),
      ...(dispatched ? { message: dispatched.message } : {}),
      scheduled: Boolean(dispatched),
    });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not delegate mission task' });
  }
});

app.patch('/api/vaults/:vaultId/channels/:channelId/missions/tasks/:taskId', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const requestedStatus = String(req.body?.status || '') as never;
    const update = updateChatMissionTask(db, req.user!.id, req.params.channelId, req.params.taskId, {
      status: requestedStatus,
      summary: String(req.body?.summary || ''),
    });
    await Promise.all((update.canceledTaskRunIds || []).map((runId) => cancelRun(db, runId)));
    scheduleMissionWork(update.mission.id);
    const latest = getChatMission(db, req.user!.id, req.params.channelId, update.mission.id);
    res.json({ mission: latest.mission });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not update mission task' });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/missions/:missionId/finish', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const status = String(req.body?.status || 'completed') === 'canceled' ? 'canceled' : 'completed';
    const helperRunId = Number(req.header('x-cascade-run-id'));
    const update = finishChatMission(db, req.user!.id, req.params.channelId, req.params.missionId, {
      coordinatorRegistrationId: String(req.body?.coordinatorRegistrationId || ''),
      status,
      summary: String(req.body?.summary || ''),
      ...(Number.isFinite(helperRunId) ? { currentRunId: helperRunId } : {}),
    });
    if (status === 'canceled') {
      await Promise.all(update.mission.tasks
        .filter((task) => task.status === 'canceled' && task.runId != null)
        .map((task) => cancelRun(db, task.runId!, { force: true })));
    }
    emitMissionProjection(update);
    for (const messageId of update.removedWakeMessageIds || []) {
      emitChatMessageDeleted(update.vaultId, update.channelId, messageId);
    }
    await Promise.all((update.canceledWakeRunIds || []).map((runId) => cancelRun(db, runId, {
      force: true,
      summary: 'Mission review wake closed automatically.',
      suppressChatBody: true,
    })));
    res.json({ mission: update.mission });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not finish mission' });
  }
});

app.patch('/api/vaults/:vaultId/channels/:channelId/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const existing = getChatMessage(db, req.params.channelId, req.user!.id, req.params.messageId);
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    if (isAgentRequest(req)) {
      // Agents may only update agent-attributed rows (streaming shells), never human messages.
      if (!existing.registrationId && !existing.agentId) {
        return res.status(403).json({ error: 'Agents cannot edit human messages' });
      }
      if (typeof req.body?.author === 'string' && req.body.author !== existing.author) {
        return res.status(403).json({ error: 'Agents cannot reassign message authors' });
      }
      if (
        typeof req.body?.registrationId === 'string'
        && existing.registrationId
        && req.body.registrationId !== existing.registrationId
      ) {
        return res.status(403).json({ error: 'Agents cannot reassign registration ownership' });
      }
    } else if (existing.author !== req.user!.username) {
      return res.status(403).json({ error: 'You can only edit your own messages' });
    }
    const patch = isAgentRequest(req) ? {
      ...req.body,
      author: existing.author,
      registrationId: existing.registrationId,
      agentId: existing.agentId,
    } : {
      body: typeof req.body?.body === 'string' ? req.body.body : existing.body,
      images: req.body?.images,
      attachments: req.body?.attachments,
      replyTo: req.body?.replyTo,
    };
    const message = updateChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, req.params.messageId, patch);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    const dispatches = createChatAgentDispatches(db, req.user!.id, req.params.channelId, message)
      .filter((dispatch) => dispatch.runId == null);
    refreshChatNoteGrants(req.user!.id, req.params.vaultId, route.sourceChannelId, message);
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', message, dispatches);
    res.json({ message, dispatches });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Delete a chat message. You may remove your own messages; the owner of the
 * channel's source vault (the host of a shared chat) may remove anyone's,
 * including agent posts.
 */
app.delete('/api/vaults/:vaultId/channels/:channelId/messages/:messageId', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const message = getChatMessage(db, req.params.channelId, req.user!.id, req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const host = db.prepare('SELECT created_by AS userId FROM vaults WHERE id = ?')
      .get(route.sourceVaultId) as { userId: number } | undefined;
    const isHost = host?.userId === req.user!.id;
    if (!isHost && message.author !== req.user!.username) {
      return res.status(403).json({ error: 'You can only delete your own messages' });
    }

    if (!deleteChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, req.params.messageId)) {
      return res.status(404).json({ error: 'Message not found' });
    }
    // Note grants cascade via FK; backlinks are tombstoned so the referenced
    // notes stop advertising a message that no longer exists.
    try { tombstoneChatMessageBacklinks(db, req.params.messageId); } catch { /* best-effort */ }
    emitChatMessageDeleted(route.sourceVaultId, route.sourceChannelId, req.params.messageId);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Forward a message into another channel (Discord-style). */
app.post('/api/vaults/:vaultId/channels/:channelId/messages/:messageId/forward', requireAuth, (req: AuthedRequest, res) => {
  try {
    const toChannelId = String(req.body?.targetChannelId || '').trim();
    if (!toChannelId) return res.status(400).json({ error: 'targetChannelId is required' });
    const toVaultId = String(req.body?.targetVaultId || '').trim() || req.params.vaultId;

    const message = forwardChatMessage(db, req.user!.id, req.user!.username, {
      fromVaultId: req.params.vaultId,
      fromChannelId: req.params.channelId,
      messageId: req.params.messageId,
      toVaultId,
      toChannelId,
      comment: typeof req.body?.comment === 'string' ? req.body.comment : undefined,
    });

    const { route } = assertChatChannel(db, toChannelId, req.user!.id);
    refreshChatNoteGrants(req.user!.id, toVaultId, route.sourceChannelId, message);
    try {
      indexChatMessageBacklinks(db, route.sourceVaultId, route.sourceChannelId, {
        id: message.id,
        author: message.author,
        body: message.body,
        createdAt: message.createdAt,
      });
    } catch (error) {
      console.warn('chat backlink index skipped:', error instanceof Error ? error.message : error);
    }
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageCreated', message);
    res.status(201).json({ message });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/messages/:messageId/approve', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const message = approveChatChangeRequest(db, req.user!.id, req.params.channelId, req.params.messageId);
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', message);
    res.json({ message });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/vaults/:vaultId/channels/:channelId/messages/:messageId/merge', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const message = mergeChatChangeRequest(db, req.user!.id, req.params.channelId, req.params.messageId);
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', message);
    res.json({ message });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Save answers on a pending clarification card. */
app.post('/api/vaults/:vaultId/channels/:channelId/messages/:messageId/clarification/answer', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    const message = answerChatClarification(db, req.user!.id, req.params.channelId, req.params.messageId, answers);
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', message);
    res.json({ message });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Accept clarification → work-item contract + mission.
 * Flow: orchestrator asks scope via clarification card → human answers/accepts
 * → kanban contract + mission root open → coordinator is woken to plan/delegate
 * and drive until done, token budget, or manual stop.
 */
app.post('/api/vaults/:vaultId/channels/:channelId/messages/:messageId/clarification/accept', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const result = acceptChatClarification(db, req.user!.id, req.params.channelId, req.params.messageId, {
      tokenBudget: req.body?.tokenBudget != null ? Number(req.body.tokenBudget) : undefined,
      title: req.body?.title != null ? String(req.body.title) : undefined,
    });
    let message = result.message;
    let missionId = message.clarification?.missionId;
    const members = listChatAgentMembers(db, req.params.channelId, req.user!.id);
    const coordinator = (
      (message.registrationId && members.find((m) => m.id === message.registrationId && m.orchestrator))
      || members.find((m) => m.orchestrator)
      || (message.registrationId ? members.find((m) => m.id === message.registrationId) : undefined)
      || (message.clarification?.assigneeRegistrationId
        ? members.find((m) => m.id === message.clarification!.assigneeRegistrationId)
        : undefined)
    );
    if (coordinator && !missionId) {
      try {
        const objective = [
          'Accepted clarification contract — drive this until completed, token budget, or manual stop.',
          result.tokenBudget > 0 ? `Token budget: ${result.tokenBudget}` : 'Token budget: unlimited',
          `Work item: ${result.workItemId}`,
          '',
          'Contract:',
          result.contract,
        ].join('\n');
        const missionUpdate = createChatMission(db, req.user!.id, req.params.vaultId, req.params.channelId, {
          rootMessageId: message.id,
          coordinatorRegistrationId: coordinator.id,
          title: result.title,
          objective,
        });
        missionId = missionUpdate.mission.id;
        message = attachClarificationMission(
          db,
          req.user!.id,
          req.params.channelId,
          message.id,
          missionId,
        );
        emitMissionProjection(missionUpdate);
        // Kick the coordinator to plan/delegate under the accepted contract.
        const wakeBody = [
          `@${coordinator.mention || coordinator.agentId} Contract accepted for “${result.title}”.`,
          `Mission ${missionId} is open. Work item (kanban contract): ${result.workItemId}.`,
          result.tokenBudget > 0 ? `Token budget: ${result.tokenBudget}` : 'Token budget: unlimited',
          '',
          'Plan the work from the contract below, then `mission delegate` tasks (or execute yourself).',
          'Drive until the mission is finished, the token budget is hit, or the user stops you.',
          '',
          'Contract:',
          result.contract,
        ].join('\n');
        const wakeSuffix = crypto.randomUUID().slice(0, 8);
        const carrier = createChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, {
          id: `agent-trace-${missionId}-${wakeSuffix}`,
          channelId: req.params.channelId,
          author: '',
          body: '',
          createdAt: new Date().toISOString(),
          registrationId: coordinator.id,
        });
        const wakeMessage = createChatMessage(db, req.user!.id, req.params.vaultId, req.params.channelId, {
          id: `sys-contract-${missionId.slice(0, 8)}-${wakeSuffix}`,
          channelId: req.params.channelId,
          // This is the coordinator's durable work prompt. Attribute it now
          // so there is an agent shell before its dispatch is claimed.
          author: '',
          body: wakeBody,
          createdAt: new Date().toISOString(),
          registrationId: coordinator.id,
        });
        const dispatch = createChatAgentDispatchForRegistration(
          db,
          req.user!.id,
          req.params.channelId,
          wakeMessage,
          coordinator.id,
        );
        emitChatMessageEvent(
          route.sourceVaultId,
          route.sourceChannelId,
          'vault:chatMessageCreated',
          carrier,
        );
        emitChatMessageEvent(
          route.sourceVaultId,
          route.sourceChannelId,
          'vault:chatMessageCreated',
          wakeMessage,
          [dispatch],
        );
      } catch (error) {
        console.warn(
          'clarification accept: mission open/wake skipped:',
          error instanceof Error ? error.message : error,
        );
      }
    }
    emitChatMessageEvent(route.sourceVaultId, route.sourceChannelId, 'vault:chatMessageUpdated', message);
    res.status(201).json({
      message,
      workItemId: result.workItemId,
      missionId: missionId || null,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/agents', requireAuth, (req: AuthedRequest, res) => {
  try {
    ensureVaultWideAgents(db, req.params.vaultId, req.params.channelId, req.user!.id);
    const agents = listChatAgentMembers(db, req.params.channelId, req.user!.id);
    res.json({ agents });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/settings', requireAuth, (req: AuthedRequest, res) => {
  try {
    res.json({ settings: getChannelSettings(db, req.params.channelId, req.user!.id) });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

app.put('/api/vaults/:vaultId/channels/:channelId/settings', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const source = db.prepare('SELECT created_by FROM vaults WHERE id = ?').get(route.sourceVaultId) as { created_by: number } | undefined;
    if (source?.created_by !== req.user!.id) {
      return res.status(403).json({ error: 'Only the chat owner can change channel settings' });
    }
    let settings = getChannelSettings(db, req.params.channelId, req.user!.id);
    if (req.body?.cwd !== undefined) {
      settings = setChannelCwd(db, req.params.channelId, req.user!.id, String(req.body.cwd ?? ''));
    }
    if (req.body?.kanbanNoteId !== undefined) {
      settings = setChannelKanbanNoteId(
        db,
        req.user!.id,
        req.params.channelId,
        req.body.kanbanNoteId == null || req.body.kanbanNoteId === ''
          ? null
          : String(req.body.kanbanNoteId),
      );
    }
    if (req.body?.createInternalKanban === true) {
      const created = ensureChannelOrchestrationKanban(db, req.user!.id, req.params.channelId, {
        createInternal: true,
      });
      settings = getChannelSettings(db, req.params.channelId, req.user!.id);
      if (!created && !settings.kanbanNoteId) {
        return res.status(400).json({ error: 'Could not create internal board' });
      }
    }
    // Notify other clients on this vault so open channel views pick up the change.
    emitVaultEvent(req.params.vaultId, 'vault:chatChannelSettings', {
      vaultId: req.params.vaultId,
      channelId: req.params.channelId,
      settings,
    });
    res.json({ settings });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Chat channel not found' });
  }
});

app.get('/api/vaults/:vaultId/channels/:channelId/presence', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const participants = listChatChannelParticipants(db, req.params.channelId, req.user!.id);
    const online = await getOnlineUsernamesForChannel(participants);
    const owner = db.prepare(`
      SELECT u.username FROM vaults v JOIN users u ON u.id = v.created_by WHERE v.id = ?
    `).get(route.sourceVaultId) as { username: string } | undefined;
    const profiles = buildChatPresenceProfiles(participants);
    res.json({ participants, online, owner: owner?.username || '', profiles });
  } catch {
    res.status(404).json({ error: 'Chat channel not found' });
  }
});

async function evictUserFromChat(sourceChannelId: string, userId: number) {
  const sockets = await vaultNamespace.in(chatPresenceRoom(sourceChannelId)).fetchSockets();
  for (const socket of sockets) {
    const user = socket.data.user as { id?: number } | undefined;
    if (user?.id !== userId) continue;
    await socket.leave(chatPresenceRoom(sourceChannelId));
    (socket.data.chatPresenceChannels as Map<string, string> | undefined)?.delete(sourceChannelId);
  }
}

app.delete('/api/vaults/:vaultId/channels/:channelId/members/me', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const sourceVault = db.prepare('SELECT created_by FROM vaults WHERE id = ?').get(route.sourceVaultId) as { created_by: number };
    if (sourceVault.created_by === req.user!.id) return res.status(400).json({ error: 'The channel owner cannot leave' });
    deleteNoteAssets(db, route.localChannelId);
    deleteNote(db, route.localChannelId);
    await evictUserFromChat(route.sourceChannelId, req.user!.id);
    emitVaultEvent(route.localVaultId, 'vault:noteDeleted', { noteId: route.localChannelId, vaultId: route.localVaultId });
    await emitChatPresence(route.sourceVaultId, route.sourceChannelId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not leave channel' });
  }
});

app.delete('/api/vaults/:vaultId/channels/:channelId/members/:username', requireAuth, async (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const sourceVault = db.prepare('SELECT created_by FROM vaults WHERE id = ?').get(route.sourceVaultId) as { created_by: number };
    if (sourceVault.created_by !== req.user!.id) return res.status(403).json({ error: 'Only the channel owner can remove participants' });
    const member = db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(req.params.username) as { id: number; username: string } | undefined;
    if (!member || member.id === req.user!.id) return res.status(400).json({ error: 'Participant not found' });
    const link = db.prepare(`
      SELECT l.local_channel_id AS channelId, l.local_vault_id AS vaultId
      FROM chat_channel_links l JOIN vaults v ON v.id = l.local_vault_id
      WHERE l.source_channel_id = ? AND v.created_by = ? LIMIT 1
    `).get(route.sourceChannelId, member.id) as { channelId: string; vaultId: string } | undefined;
    if (!link) return res.status(404).json({ error: 'Participant not found' });
    deleteNoteAssets(db, link.channelId);
    deleteNote(db, link.channelId);
    await evictUserFromChat(route.sourceChannelId, member.id);
    emitVaultEvent(link.vaultId, 'vault:noteDeleted', { noteId: link.channelId, vaultId: link.vaultId });
    await emitChatPresence(route.sourceVaultId, route.sourceChannelId);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Could not remove participant' });
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

// Used by the agent helper. The registration id is supplied by its isolated run
// context, so a running agent can only update the identity it was launched as.
app.put('/api/vaults/:vaultId/channels/:channelId/agents/:registrationId/avatar', requireAuth, (req: AuthedRequest, res) => {
  try {
    const { route } = assertChatChannel(db, req.params.channelId, req.user!.id);
    const registration = setChatAgentAvatar(
      db, req.user!.id, req.params.vaultId, req.params.channelId, req.params.registrationId, req.body?.avatarUrl,
    );
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

/**
 * Landing vault for a chat someone shared with `userId`. Their DM vault is
 * skipped: it is the one vault that must hold nothing but their private
 * conversations, so a shared room never gets filed alongside them.
 */
function firstOwnedVault(userId: number) {
  return db.prepare(`
    SELECT * FROM vaults
    WHERE created_by = ?
      AND id NOT IN (SELECT vault_id FROM user_dm_vaults)
    ORDER BY created_at ASC
    LIMIT 1
  `).get(userId) as ReturnType<typeof createVault> | undefined;
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
  // Central guard for every path that mirrors a channel into another vault.
  // A DM belongs to exactly two accounts and is never mirrored a third time.
  assertShareableChatChannel(db, sourceChannel.id);

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

const removedSharedChannelRoute = (..._args: unknown[]) => undefined;

removedSharedChannelRoute('/api/vaults/:vaultId/channels/:channelId/invites', requireAuth, usernameActionRateLimit, (req: AuthedRequest, res: Response) => {
  const vault = getVault(db, req.params.vaultId, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const channel = getNote(db, req.params.channelId);
  if (!channel || channel.vault_id !== vault.id || !channel.content.trim().startsWith(CHAT_NOTE_MARKER)) {
    return res.status(404).json({ error: 'Chat channel not found' });
  }
  if (vault.created_by !== req.user!.id) {
    return res.status(403).json({ error: 'Only the chat owner can invite users' });
  }
  if (isDirectMessageChannel(db, channel.id)) {
    return res.status(400).json({ error: 'Direct messages cannot be shared' });
  }

  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-32 lowercase letters, numbers, or underscores' });
    }
    const invitedUser = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username) as { id: number; username: string } | undefined;
    // An unknown account and a blocked one refuse identically below, so this
    // route cannot be used to discover which usernames are registered.
    if (!invitedUser) return res.status(403).json({ error: UNREACHABLE_USER_MESSAGE });
    if (invitedUser.id === req.user!.id) return res.status(400).json({ error: 'You already have this chat' });
    // Pushing a channel into someone's vault is a direct interaction; a block
    // in either direction stops it. Existing membership is left alone.
    assertChannelPushAllowed(db, req.user!.id, invitedUser.id);

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
    if (message === UNREACHABLE_USER_MESSAGE) return res.status(403).json({ error: message });
    res.status(400).json({ error: message });
  }
});

removedSharedChannelRoute('/api/vaults/:vaultId/channels/:channelId/invite-link', requireAuth, (req: AuthedRequest, res: Response) => {
  const vault = getVault(db, req.params.vaultId, req.user!.id);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const channel = getNote(db, req.params.channelId);
  if (!channel || channel.vault_id !== vault.id || !channel.content.trim().startsWith(CHAT_NOTE_MARKER)) {
    return res.status(404).json({ error: 'Chat channel not found' });
  }
  if (vault.created_by !== req.user!.id) {
    return res.status(403).json({ error: 'Only the chat owner can create invite links' });
  }
  if (isDirectMessageChannel(db, channel.id)) {
    return res.status(400).json({ error: 'Direct messages cannot be shared' });
  }
  const token = signChatInvite(vault.id, channel.id);
  res.json({ token, url: `${publicBaseUrl(req)}/invite/${encodeURIComponent(token)}` });
});

/**
 * The channel a chat invite token points at, or null when the token is no
 * longer redeemable. Tokens live for seven days, so this is re-checked on
 * every use rather than only when the link is minted: a channel that is now
 * one side of a DM is refused even if the link predates it.
 */
function resolveChatInvite(token: string): { channel: NonNullable<ReturnType<typeof getNote>>; vaultId: string } | null {
  let invite: ChatInviteToken;
  try {
    invite = verifyChatInvite(token);
  } catch {
    return null;
  }
  const channel = getNote(db, invite.sourceChannelId);
  if (!channel || channel.vault_id !== invite.sourceVaultId) return null;
  if (!channel.content.trim().startsWith(CHAT_NOTE_MARKER)) return null;
  if (isDirectMessageChannel(db, channel.id)) return null;
  return { channel, vaultId: invite.sourceVaultId };
}

removedSharedChannelRoute('/api/chat-invites/:token', (req: AuthedRequest, res: Response) => {
  const resolved = resolveChatInvite(req.params.token);
  const vault = resolved
    ? db.prepare('SELECT id, name, created_by FROM vaults WHERE id = ?').get(resolved.vaultId) as { id: string; name: string; created_by: number } | undefined
    : undefined;
  if (!resolved || !vault) return res.status(404).json({ error: 'Invite not found' });

  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(vault.created_by) as { username: string } | undefined;
  res.json({
    invite: {
      title: resolved.channel.title,
      vaultName: vault.name,
      owner: owner?.username || 'unknown',
    },
  });
});

removedSharedChannelRoute('/api/chat-invites/:token/accept', requireAuth, (req: AuthedRequest, res: Response) => {
  try {
    const resolved = resolveChatInvite(req.params.token);
    const vault = resolved
      ? db.prepare('SELECT * FROM vaults WHERE id = ?').get(resolved.vaultId) as ReturnType<typeof createVault> | undefined
      : undefined;
    if (!resolved || !vault) return res.status(404).json({ error: 'Invite not found' });
    const channel = resolved.channel;
    if (vault.created_by === req.user!.id) {
      return res.json({ vaultId: vault.id, channelId: channel.id, title: channel.title, alreadyOwned: true });
    }
    const linked = addLinkedChatToUserVault(vault, channel, req.user!.id, vault.created_by);
    res.status(201).json({ vaultId: linked.vaultId, channelId: linked.channelId, title: linked.title, created: linked.created });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Could not accept invite' });
  }
});

// ── Direct messages, blocks, and DM privacy ────────────────────────
// A DM is a linked chat channel between exactly two accounts; see
// server/directMessages.ts for the reachability rules enforced here.

const directMessageDeps = {
  // Only ever *creates* a vault. Which vault a DM lands in is decided by
  // `user_dm_vaults` inside the module, so no route can steer a conversation
  // into a notebook that is public, shared, or shareable later.
  createVault: (userId: number, name: string): string => createVault(db, userId, { name }).id,
  onChannelCreated: (input: { vaultId: string; channelId: string; title: string }) => {
    emitVaultEvent(input.vaultId, 'vault:noteCreated', {
      noteId: input.channelId,
      vaultId: input.vaultId,
      title: input.title,
    });
  },
};

app.get('/api/me/dm-settings', requireAuth, (req: AuthedRequest, res) => {
  res.json({ allowDirectMessages: allowsDirectMessages(db, req.user!.id) });
});

app.put('/api/me/dm-settings', requireAuth, requireUserAccess, (req: AuthedRequest, res) => {
  if (typeof req.body?.allowDirectMessages !== 'boolean') {
    return res.status(400).json({ error: 'allowDirectMessages must be a boolean' });
  }
  const allowDirectMessages = setAllowDirectMessages(db, req.user!.id, req.body.allowDirectMessages);
  res.json({ allowDirectMessages });
});

app.get('/api/me/blocks', requireAuth, (req: AuthedRequest, res) => {
  res.json({ blocks: listBlockedUsers(db, req.user!.id) });
});

app.post('/api/me/blocks', requireAuth, requireUserAccess, usernameActionRateLimit, (req: AuthedRequest, res) => {
  try {
    const target = resolveUserByUsername(db, req.body?.username);
    const block = blockUser(db, req.user!.id, target.id);
    res.status(201).json({ block });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not block user';
    // Never confirm whether the username exists; 'You cannot block yourself'
    // is about the caller's own account, so it stays as written.
    if (message === 'User not found') return res.status(403).json({ error: UNREACHABLE_USER_MESSAGE });
    res.status(400).json({ error: message });
  }
});

app.delete('/api/me/blocks/:username', requireAuth, requireUserAccess, usernameActionRateLimit, (req: AuthedRequest, res) => {
  try {
    const target = resolveUserByUsername(db, req.params.username);
    unblockUser(db, req.user!.id, target.id);
  } catch {
    // Unblocking someone who does not exist is already a no-op. Reporting it
    // as one keeps the route from confirming which usernames are registered.
  }
  res.json({ ok: true });
});

app.get('/api/me/direct-messages', requireAuth, (req: AuthedRequest, res) => {
  res.json({ conversations: listDirectMessages(db, req.user!.id) });
});

app.post('/api/direct-messages', requireAuth, requireUserAccess, usernameActionRateLimit, (req: AuthedRequest, res) => {
  try {
    const result = openDirectMessage(db, req.user!.id, req.body?.username, directMessageDeps);
    res.status(result.created ? 201 : 200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not open direct message';
    // Unknown account, blocked, or DMs switched off — one refusal for all
    // three, so the status code cannot be used to enumerate usernames.
    if (message.startsWith('Unblock @') || message === UNREACHABLE_USER_MESSAGE) {
      return res.status(403).json({ error: message });
    }
    res.status(400).json({ error: message });
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
  // Shared-channel invites were removed; leave vault and public-note embeds intact.
  return false;
  /* legacy parser retained temporarily for database compatibility
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  const base = publicBaseUrl(req);
  const token = parseInviteUrl(rawUrl, base);
  if (!token) return false;

  try {
    const resolved = resolveChatInvite(token);
    const vault = resolved
      ? db.prepare('SELECT id, name, created_by FROM vaults WHERE id = ?').get(resolved.vaultId) as { id: string; name: string; created_by: number } | undefined
      : undefined;
    if (!resolved || !vault) {
      res.status(404).json({ error: 'Invite not found' });
      return true;
    }
    const channel = resolved.channel;
    const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(vault.created_by) as { username: string } | undefined;
    const inviteUrl = `${base}/invite/${encodeURIComponent(token)}`;
    const title = `Join #${channel.title} on Fizzer`;
    const description = `${owner?.username || 'Someone'} invited you to add this chat to your own vault.`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      version: '1.0',
      type: 'rich',
      provider_name: 'Fizzer',
      provider_url: base,
      title,
      author_name: owner?.username || 'Fizzer',
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
  */
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
  app.get('/download/android', (_req, res) => {
    const apkPath = resolveAndroidApkPath();
    if (!apkPath) {
      return res.status(404).json({
        error: 'Android build is not available',
        hint: 'Sideload APK is published to the host data volume by deploy; rebuild with npm run android:apk',
      });
    }
    return res.download(apkPath, 'cascade-android.apk');
  });
  // Architecture/distribution choices cannot be reliably inferred from every
  // browser user-agent, so macOS and Linux first land on a small chooser.
  app.get('/download/mac', (_req, res) => {
    res.type('html').send(desktopChooser('Download Fizzer for macOS', [
      { label: 'Apple silicon', href: '/download/mac-arm64', detail: 'M1, M2, M3, M4, and later Macs' },
      { label: 'Intel Mac', href: '/download/mac-x64', detail: 'Intel-based Macs' },
    ]));
  });
  app.get('/download/linux', (_req, res) => {
    res.type('html').send(desktopChooser('Download Fizzer for Linux', [
      { label: 'Debian / Ubuntu', href: '/download/linux-deb', detail: 'Install the .deb package' },
      { label: 'Fedora / RHEL / openSUSE', href: '/download/linux-rpm', detail: 'Install the .rpm package' },
    ]));
  });
  // Native desktop installers. A missing release artifact returns a clear 404
  // instead of an empty response or an unrelated browser download.
  app.get('/download/:platform', (req, res) => {
    const file = DESKTOP_BUILDS[req.params.platform];
    if (!file) return res.status(404).json({ error: 'Unknown platform' });
    const filePath = path.join(DOWNLOADS_DIR, file);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: `${req.params.platform} build is not available yet`, platform: req.params.platform });
    }
    res.download(filePath, file);
  });
  // Marketing / download page for new visitors at the root. Signed-in users are
  // bounced to /app by an inline script on the page itself.
  // `/download` is intentionally distinct from `/`: signed-in browser users
  // need to reach the installer chooser instead of being bounced back into the
  // web app by the landing page's returning-user shortcut.
  app.get(['/', '/download'], (_req, res, next) => {
    if (fs.existsSync(LANDING_HTML)) return res.sendFile(LANDING_HTML);
    next();
  });
  // index:false so the SPA's index.html isn't auto-served at '/', letting the
  // landing route above own the root.
  app.use(express.static(CLIENT_DIST_DIR, {
    index: false,
    setHeaders: (res, filePath) => {
      const cacheControl = clientAssetCacheControl(filePath);
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    },
  }));
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
  console.log(`Fizzer API running on http://localhost:${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
  // Tasks may have become ready immediately before a server restart. Rebuild
  // their deterministic dispatch messages from durable dependency state.
  scheduleMissionWork();
  reannouncePendingMissionDispatches();
  // Durable outbox reconciliation makes mission progress independent of a
  // renderer socket event. A transient dispatch/start failure stays pending
  // and is retried until it has a run or is explicitly stopped.
  setInterval(() => {
    try {
      scheduleMissionWork();
      reannouncePendingMissionDispatches();
    } catch (error) {
      console.warn('mission scheduler reconciliation failed:', error instanceof Error ? error.message : error);
    }
  }, 5_000).unref();
});
