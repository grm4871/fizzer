/**
 * @file directMessages.ts — one-to-one chats addressed by username.
 *
 * A DM is not a new transport. It is exactly the existing shared-chat shape:
 * a chat-channel note in the initiator's vault (the *source*), mirrored into
 * the recipient's vault through `chat_channel_links`. Every downstream
 * feature — messages, agents, missions, sockets — therefore works unchanged,
 * and `assertChatChannel` already authorizes both sides.
 *
 * What this module adds on top is reachability policy, all of it evaluated
 * when a conversation is opened:
 *   - `user_dm_settings.allow_direct_messages` — the recipient's own toggle.
 *   - `user_blocks` — either direction stops a conversation from opening.
 *
 * A DM channel is still a note in a real vault, so vault membership is what
 * ultimately gates it. Three rules keep that from leaking a conversation:
 *   - every side of a DM lives in that account's *dedicated* DM vault
 *     (`user_dm_vaults`), never in a general notebook that may later be
 *     shared or published — see `ensureDirectMessageVaultId`;
 *   - `vaultHoldsDirectMessages` lets the sharing and visibility routes refuse
 *     to publish, invite into, or hand out an invite link for such a vault;
 *   - `isDirectMessageChannel` lets the chat-sharing routes refuse to mirror a
 *     DM channel into a third party's vault.
 */
import type Database from 'better-sqlite3';
import { CHAT_NOTE_MARKER, linkChatChannel } from './chat.js';
import { createNote, getNote } from './vault.js';

type Db = Database.Database;

export type DirectMessageUser = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
};

export type BlockedUser = DirectMessageUser & { createdAt: string };

export type DirectMessageConversation = {
  user: DirectMessageUser;
  vaultId: string;
  channelId: string;
  title: string;
  createdAt: string;
};

export type OpenDirectMessageResult = DirectMessageConversation & { created: boolean };

export type DirectMessageDeps = {
  /**
   * Creates a brand-new private vault owned by `userId` and returns its id.
   * Only used when that account has no usable DM vault yet — callers cannot
   * nominate an existing vault, which is what keeps DMs out of notebooks.
   */
  createVault: (userId: number, name: string) => string;
  /** Notified for each channel note created, so the owner's clients can refresh. */
  onChannelCreated?: (input: { vaultId: string; channelId: string; title: string; userId: number }) => void;
};

const USERNAME = /^[a-z0-9_]{3,32}$/;

/** Name given to the per-account vault that holds every DM channel. */
export const DIRECT_MESSAGE_VAULT_NAME = 'Direct Messages';

/**
 * The single refusal used whenever a username cannot be acted on: no such
 * account, the account has DMs switched off, or it has blocked the caller.
 * One message for all three keeps these routes from becoming a directory of
 * which usernames are registered.
 */
export const UNREACHABLE_USER_MESSAGE = 'This user is not accepting direct messages';

export function ensureDirectMessageSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_dm_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      allow_direct_messages INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blocker_user_id, blocked_user_id),
      CHECK (blocker_user_id != blocked_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_user_id);

    -- One row per unordered pair, so "open a DM with @x" is idempotent no
    -- matter which side asks. user_a_id < user_b_id is the normal form.
    CREATE TABLE IF NOT EXISTS direct_message_channels (
      user_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      source_channel_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_a_id, user_b_id),
      CHECK (user_a_id < user_b_id)
    );
    CREATE INDEX IF NOT EXISTS idx_dm_channels_source ON direct_message_channels(source_channel_id);

    -- The vault each account keeps its DM channels in. One vault per user and
    -- one user per vault, so a DM vault can never double as a shared notebook.
    CREATE TABLE IF NOT EXISTS user_dm_vaults (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_dm_vaults_vault ON user_dm_vaults(vault_id);
  `);

  backfillDirectMessageVaults(db);
}

/** True when the column exists; `visibility` arrives with ensurePublicVaultSchema. */
function hasVaultColumn(db: Db, column: string): boolean {
  return (db.prepare('PRAGMA table_info(vaults)').all() as Array<{ name: string }>)
    .some((row) => row.name === column);
}

/**
 * Adopt vaults that already serve as somebody's DM vault.
 *
 * Before dedicated DM vaults existed, a conversation landed in the oldest
 * private solo vault the account owned — sometimes a purpose-made
 * "Direct Messages" vault, sometimes their main notebook. Only the former is
 * adopted here: a vault is claimed just when *every* note it holds is a DM
 * channel. A mixed notebook is deliberately left unmapped, so the next DM
 * moves to a fresh dedicated vault while the conversations already in it keep
 * resolving through their own note and link rows.
 */
function backfillDirectMessageVaults(db: Db): void {
  const privateOnly = hasVaultColumn(db, 'visibility')
    ? "AND COALESCE(v.visibility, 'private') = 'private'"
    : '';
  try {
    db.prepare(`
      INSERT OR IGNORE INTO user_dm_vaults (user_id, vault_id)
      SELECT userId, vaultId FROM (
        SELECT v.created_by AS userId, v.id AS vaultId, v.created_at AS createdAt
        FROM vaults v
        WHERE (SELECT COUNT(*) FROM vault_members m WHERE m.vault_id = v.id) <= 1
          ${privateOnly}
          AND EXISTS (SELECT 1 FROM notes n WHERE n.vault_id = v.id)
          AND NOT EXISTS (
            SELECT 1 FROM notes n
            WHERE n.vault_id = v.id
              AND n.id NOT IN (SELECT source_channel_id FROM direct_message_channels)
              AND n.id NOT IN (
                SELECT l.local_channel_id
                FROM chat_channel_links l
                JOIN direct_message_channels d ON d.source_channel_id = l.source_channel_id
              )
          )
      )
      ORDER BY createdAt ASC, vaultId ASC
    `).run();
  } catch {
    // chat_channel_links may not exist yet on a partially migrated database;
    // the mapping is rebuilt on the next boot once the chat schema is in place.
  }
}

/** The vault currently recorded for this account's DMs, or null. */
export function getDirectMessageVaultId(db: Db, userId: number): string | null {
  const row = db.prepare('SELECT vault_id AS vaultId FROM user_dm_vaults WHERE user_id = ?')
    .get(userId) as { vaultId: string } | undefined;
  return row?.vaultId ?? null;
}

/** True when this vault is the registered DM vault of any account. */
export function isDirectMessageVault(db: Db, vaultId: string): boolean {
  return Boolean(db.prepare('SELECT 1 AS hit FROM user_dm_vaults WHERE vault_id = ?').get(vaultId));
}

/**
 * A DM vault stays usable only while it is still the account's own, still
 * private, and still has no second member. Anything else means the vault has
 * been shared since — future conversations must not follow it there.
 */
function dmVaultIsUsable(db: Db, vaultId: string, userId: number): boolean {
  const privateOnly = hasVaultColumn(db, 'visibility')
    ? "AND COALESCE(v.visibility, 'private') = 'private'"
    : '';
  const row = db.prepare(`
    SELECT 1 AS hit
    FROM vaults v
    WHERE v.id = ? AND v.created_by = ?
      ${privateOnly}
      AND (SELECT COUNT(*) FROM vault_members m WHERE m.vault_id = v.id) <= 1
  `).get(vaultId, userId) as { hit: number } | undefined;
  return Boolean(row);
}

/**
 * The vault this account's DM channels belong in, created on first use.
 *
 * Never returns a vault the caller nominated and never reuses a general
 * notebook: the mapping in `user_dm_vaults` is the only source, and a mapped
 * vault that has since been shared is replaced rather than trusted.
 */
export function ensureDirectMessageVaultId(db: Db, userId: number, deps: DirectMessageDeps): string {
  const mapped = getDirectMessageVaultId(db, userId);
  if (mapped && dmVaultIsUsable(db, mapped, userId)) return mapped;

  const vaultId = deps.createVault(userId, DIRECT_MESSAGE_VAULT_NAME);
  if (!dmVaultIsUsable(db, vaultId, userId)) {
    throw new Error('Could not create a private vault for direct messages');
  }
  db.prepare(`
    INSERT INTO user_dm_vaults (user_id, vault_id) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET vault_id = excluded.vault_id, created_at = datetime('now')
  `).run(userId, vaultId);
  return vaultId;
}

/**
 * True when this vault holds either side of a DM — the source channel or a
 * linked mirror — or is registered as somebody's DM vault. Publishing or
 * sharing such a vault would expose the whole conversation, including the ones
 * opened after the invite link was minted.
 */
export function vaultHoldsDirectMessages(db: Db, vaultId: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS hit FROM direct_message_channels WHERE source_vault_id = ?
    UNION ALL
    SELECT 1 AS hit
    FROM chat_channel_links l
    JOIN direct_message_channels d ON d.source_channel_id = l.source_channel_id
    WHERE l.local_vault_id = ?
    UNION ALL
    SELECT 1 AS hit FROM user_dm_vaults WHERE vault_id = ?
    LIMIT 1
  `).get(vaultId, vaultId, vaultId) as { hit: number } | undefined;
  return Boolean(row);
}

/**
 * True when this note is either side of a DM: the initiator's source channel
 * or a participant's mirror. Such a channel is only ever shared with the two
 * accounts in the pair, so no sharing route may mirror it anywhere else.
 */
export function isDirectMessageChannel(db: Db, channelId: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS hit FROM direct_message_channels WHERE source_channel_id = ?
    UNION ALL
    SELECT 1 AS hit
    FROM chat_channel_links l
    JOIN direct_message_channels d ON d.source_channel_id = l.source_channel_id
    WHERE l.local_channel_id = ?
    LIMIT 1
  `).get(channelId, channelId) as { hit: number } | undefined;
  return Boolean(row);
}

/**
 * Guard for every route that copies a chat channel into another vault —
 * by-username invites, invite links, and redemption of links minted before the
 * channel became a DM.
 */
export function assertShareableChatChannel(db: Db, channelId: string): void {
  if (isDirectMessageChannel(db, channelId)) {
    throw new Error('Direct messages cannot be shared');
  }
}

function toDirectMessageUser(row: {
  id: number;
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
}): DirectMessageUser {
  return {
    id: row.id,
    username: row.username,
    displayName: String(row.display_name || row.username),
    avatarUrl: String(row.avatar_url || ''),
  };
}

/** Accepts `bob`, `@bob`, or `  @Bob `. Throws when no such account exists. */
export function resolveUserByUsername(db: Db, usernameRaw: unknown): DirectMessageUser {
  const username = String(usernameRaw || '').trim().replace(/^@+/, '').toLowerCase();
  if (!USERNAME.test(username)) throw new Error('User not found');
  const row = db.prepare(
    'SELECT id, username, display_name, avatar_url FROM users WHERE username = ?',
  ).get(username) as { id: number; username: string; display_name: string; avatar_url: string } | undefined;
  if (!row) throw new Error('User not found');
  return toDirectMessageUser(row);
}

// ── Privacy toggle ─────────────────────────────────────────────────

export function allowsDirectMessages(db: Db, userId: number): boolean {
  const row = db.prepare(
    'SELECT allow_direct_messages AS allow FROM user_dm_settings WHERE user_id = ?',
  ).get(userId) as { allow: number } | undefined;
  // Absent row means the account has never touched the setting: open by default.
  return row ? row.allow !== 0 : true;
}

export function setAllowDirectMessages(db: Db, userId: number, allow: boolean): boolean {
  db.prepare(`
    INSERT INTO user_dm_settings (user_id, allow_direct_messages, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      allow_direct_messages = excluded.allow_direct_messages,
      updated_at = excluded.updated_at
  `).run(userId, allow ? 1 : 0);
  return allow;
}

// ── Blocks ─────────────────────────────────────────────────────────

export function isBlocked(db: Db, blockerUserId: number, blockedUserId: number): boolean {
  const row = db.prepare(
    'SELECT 1 AS hit FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?',
  ).get(blockerUserId, blockedUserId) as { hit: number } | undefined;
  return Boolean(row);
}

export function listBlockedUsers(db: Db, blockerUserId: number): BlockedUser[] {
  const rows = db.prepare(`
    SELECT u.id AS id, u.username AS username, u.display_name AS display_name,
           u.avatar_url AS avatar_url, b.created_at AS createdAt
    FROM user_blocks b
    JOIN users u ON u.id = b.blocked_user_id
    WHERE b.blocker_user_id = ?
    ORDER BY u.username COLLATE NOCASE
  `).all(blockerUserId) as Array<{
    id: number; username: string; display_name: string; avatar_url: string; createdAt: string;
  }>;
  return rows.map((row) => ({ ...toDirectMessageUser(row), createdAt: row.createdAt }));
}

export function blockUser(db: Db, blockerUserId: number, blockedUserId: number): BlockedUser {
  if (blockerUserId === blockedUserId) throw new Error('You cannot block yourself');
  const user = db.prepare(
    'SELECT id, username, display_name, avatar_url FROM users WHERE id = ?',
  ).get(blockedUserId) as { id: number; username: string; display_name: string; avatar_url: string } | undefined;
  if (!user) throw new Error('User not found');

  // Blocking twice is a no-op, not an error — the client only knows the button state.
  db.prepare(`
    INSERT OR IGNORE INTO user_blocks (blocker_user_id, blocked_user_id) VALUES (?, ?)
  `).run(blockerUserId, blockedUserId);

  const row = db.prepare(
    'SELECT created_at AS createdAt FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?',
  ).get(blockerUserId, blockedUserId) as { createdAt: string };
  return { ...toDirectMessageUser(user), createdAt: row.createdAt };
}

export function unblockUser(db: Db, blockerUserId: number, blockedUserId: number): void {
  db.prepare('DELETE FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?')
    .run(blockerUserId, blockedUserId);
}

export type DirectMessagePermission = { allowed: true } | { allowed: false; reason: string };

/**
 * Being blocked, having DMs switched off, and not existing at all return the
 * *same* message on purpose (see `UNREACHABLE_USER_MESSAGE`): otherwise the
 * toggle becomes an oracle for "did they block me?" and the endpoint becomes
 * an oracle for "is this username taken?". The blocker's own side is told
 * plainly, since they already know.
 */
export function directMessagePermission(
  db: Db,
  fromUserId: number,
  toUser: DirectMessageUser,
): DirectMessagePermission {
  if (isBlocked(db, fromUserId, toUser.id)) {
    return { allowed: false, reason: `Unblock @${toUser.username} to start a direct message` };
  }
  if (isBlocked(db, toUser.id, fromUserId) || !allowsDirectMessages(db, toUser.id)) {
    return { allowed: false, reason: UNREACHABLE_USER_MESSAGE };
  }
  return { allowed: true };
}

/**
 * Pushing a chat channel into someone's vault by username is a direct
 * interaction, so a block in either direction stops it. Shared-room membership
 * is untouched: a blocked user who already holds the channel keeps it, and
 * either party may still redeem a public invite link for a shared chat.
 *
 * The refusal is the standard unreachable message so this route cannot be used
 * to test whether a username exists.
 */
export function assertChannelPushAllowed(db: Db, actorUserId: number, targetUserId: number): void {
  if (isBlocked(db, actorUserId, targetUserId) || isBlocked(db, targetUserId, actorUserId)) {
    throw new Error(UNREACHABLE_USER_MESSAGE);
  }
}

/** Refuse new messages in an existing DM when either participant has blocked the other. */
export function assertDirectMessageSendAllowed(db: Db, sourceChannelId: string, actorUserId: number): void {
  const pair = db.prepare(`
    SELECT user_a_id AS userAId, user_b_id AS userBId
    FROM direct_message_channels WHERE source_channel_id = ?
  `).get(sourceChannelId) as { userAId: number; userBId: number } | undefined;
  if (!pair) return;
  if (actorUserId !== pair.userAId && actorUserId !== pair.userBId) throw new Error('Direct message unavailable');
  const otherUserId = actorUserId === pair.userAId ? pair.userBId : pair.userAId;
  if (isBlocked(db, actorUserId, otherUserId) || isBlocked(db, otherUserId, actorUserId)) {
    throw new Error('Direct message unavailable');
  }
}

// ── Conversations ──────────────────────────────────────────────────

type PairRow = {
  user_a_id: number;
  user_b_id: number;
  source_vault_id: string;
  source_channel_id: string;
  created_at: string;
};

function normalizePair(a: number, b: number): [number, number] {
  return a < b ? [a, b] : [b, a];
}

function findPair(db: Db, userId: number, otherUserId: number): PairRow | undefined {
  const [a, b] = normalizePair(userId, otherUserId);
  return db.prepare(
    'SELECT * FROM direct_message_channels WHERE user_a_id = ? AND user_b_id = ?',
  ).get(a, b) as PairRow | undefined;
}

/**
 * Where `userId` reads this conversation: the source channel when they own the
 * source vault, otherwise their linked mirror. Null when their side is gone
 * (they deleted the note), which `openDirectMessage` repairs.
 */
function channelForUser(
  db: Db,
  pair: PairRow,
  userId: number,
): { vaultId: string; channelId: string; title: string } | null {
  const sourceOwner = db.prepare('SELECT created_by FROM vaults WHERE id = ?')
    .get(pair.source_vault_id) as { created_by: number } | undefined;
  if (sourceOwner?.created_by === userId) {
    const note = getNote(db, pair.source_channel_id);
    if (!note) return null;
    return { vaultId: pair.source_vault_id, channelId: pair.source_channel_id, title: note.title };
  }

  const link = db.prepare(`
    SELECT l.local_vault_id AS vaultId, l.local_channel_id AS channelId, n.title AS title
    FROM chat_channel_links l
    JOIN notes n ON n.id = l.local_channel_id
    WHERE l.source_channel_id = ?
      AND l.local_vault_id IN (SELECT id FROM vaults WHERE created_by = ?)
    ORDER BY l.created_at ASC
    LIMIT 1
  `).get(pair.source_channel_id, userId) as { vaultId: string; channelId: string; title: string } | undefined;
  return link ?? null;
}

function dmChannelTitle(username: string): string {
  return `DM — @${username}`;
}

function createMirror(
  db: Db,
  deps: DirectMessageDeps,
  pair: { sourceVaultId: string; sourceChannelId: string; createdBy: number },
  forUser: DirectMessageUser,
  counterpartUsername: string,
): { vaultId: string; channelId: string; title: string } {
  const vaultId = ensureDirectMessageVaultId(db, forUser.id, deps);
  const note = createNote(db, vaultId, forUser.id, {
    title: dmChannelTitle(counterpartUsername),
    content: `${CHAT_NOTE_MARKER}\nshared_from=${pair.sourceChannelId}\ndm_with=${counterpartUsername}`,
  });
  linkChatChannel(db, {
    localVaultId: vaultId,
    localChannelId: note.id,
    sourceVaultId: pair.sourceVaultId,
    sourceChannelId: pair.sourceChannelId,
    createdBy: pair.createdBy,
  });
  deps.onChannelCreated?.({ vaultId, channelId: note.id, title: note.title, userId: forUser.id });
  return { vaultId, channelId: note.id, title: note.title };
}

/**
 * Open (or reuse) the DM between `actorUserId` and `username`.
 *
 * Policy is checked before the existing conversation is handed back, so a
 * block takes effect on the next attempt to open the thread rather than only
 * on the very first one.
 */
export function openDirectMessage(
  db: Db,
  actorUserId: number,
  username: unknown,
  deps: DirectMessageDeps,
): OpenDirectMessageResult {
  // An unknown username is refused exactly like an unreachable one, so this
  // route cannot be walked to discover which accounts exist.
  let target: DirectMessageUser;
  try {
    target = resolveUserByUsername(db, username);
  } catch {
    throw new Error(UNREACHABLE_USER_MESSAGE);
  }
  if (target.id === actorUserId) throw new Error('You cannot direct message yourself');

  const permission = directMessagePermission(db, actorUserId, target);
  if (!permission.allowed) throw new Error(permission.reason);

  const actor = db.prepare(
    'SELECT id, username, display_name, avatar_url FROM users WHERE id = ?',
  ).get(actorUserId) as { id: number; username: string; display_name: string; avatar_url: string } | undefined;
  if (!actor) throw new Error('User not found');

  const existing = findPair(db, actorUserId, target.id);
  if (existing) {
    const mine = channelForUser(db, existing, actorUserId)
      // The actor deleted their copy; re-link them to the same source channel
      // so the history survives instead of forking a second conversation.
      ?? createMirror(
        db,
        deps,
        {
          sourceVaultId: existing.source_vault_id,
          sourceChannelId: existing.source_channel_id,
          createdBy: actorUserId,
        },
        toDirectMessageUser(actor),
        target.username,
      );
    return { user: target, ...mine, createdAt: existing.created_at, created: false };
  }

  const sourceVaultId = ensureDirectMessageVaultId(db, actorUserId, deps);
  const source = createNote(db, sourceVaultId, actorUserId, {
    title: dmChannelTitle(target.username),
    content: `${CHAT_NOTE_MARKER}\ndm_with=${target.username}`,
  });
  deps.onChannelCreated?.({
    vaultId: sourceVaultId,
    channelId: source.id,
    title: source.title,
    userId: actorUserId,
  });

  createMirror(
    db,
    deps,
    { sourceVaultId, sourceChannelId: source.id, createdBy: actorUserId },
    target,
    actor.username,
  );

  const [a, b] = normalizePair(actorUserId, target.id);
  db.prepare(`
    INSERT INTO direct_message_channels (user_a_id, user_b_id, source_vault_id, source_channel_id, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(a, b, sourceVaultId, source.id, actorUserId);
  const created = db.prepare(
    'SELECT created_at AS createdAt FROM direct_message_channels WHERE user_a_id = ? AND user_b_id = ?',
  ).get(a, b) as { createdAt: string };

  return {
    user: target,
    vaultId: sourceVaultId,
    channelId: source.id,
    title: source.title,
    createdAt: created.createdAt,
    created: true,
  };
}

/** Conversations `userId` still has a channel for, newest first. */
export function listDirectMessages(db: Db, userId: number): DirectMessageConversation[] {
  const pairs = db.prepare(`
    SELECT * FROM direct_message_channels
    WHERE user_a_id = ? OR user_b_id = ?
    ORDER BY created_at DESC
  `).all(userId, userId) as PairRow[];

  const conversations: DirectMessageConversation[] = [];
  for (const pair of pairs) {
    const otherId = pair.user_a_id === userId ? pair.user_b_id : pair.user_a_id;
    const other = db.prepare(
      'SELECT id, username, display_name, avatar_url FROM users WHERE id = ?',
    ).get(otherId) as { id: number; username: string; display_name: string; avatar_url: string } | undefined;
    if (!other) continue;
    const mine = channelForUser(db, pair, userId);
    if (!mine) continue;
    conversations.push({ user: toDirectMessageUser(other), ...mine, createdAt: pair.created_at });
  }
  return conversations;
}
