/**
 * Canonical per-user activity inbox for shared vault notes and chat channels.
 *
 * Membership is the subscription boundary. Chat mirrors are navigation aliases:
 * unread state is stored against the source channel so reading any local mirror
 * clears the same conversation everywhere.
 */
import type Database from 'better-sqlite3';

type Db = Database.Database;

const CHAT_NOTE_MARKER = 'cascade://chat-channel';
export const COMMUNITY_UPDATES_DEFAULT_LIMIT = 60;
export const COMMUNITY_UPDATES_MAX_LIMIT = 100;
export const COMMUNITY_UPDATES_COUNT_CAP = 99;
const COMMUNITY_TOTAL_COUNT_CAP = 999;
const MAX_SUBSCRIBED_CHANNELS = 200;

export type CommunityUpdateKind = 'mention' | 'reply' | 'message' | 'note';

export type CommunityUpdateItem = {
  id: string;
  kind: CommunityUpdateKind;
  vaultId: string;
  vaultName: string;
  targetId: string;
  targetTitle: string;
  sourceId: string;
  messageId?: string;
  actor: string;
  actorDisplayName: string;
  preview: string;
  timestamp: string;
};

export type CommunityUpdateGroup = {
  vaultId: string;
  vaultName: string;
  unreadCount: number;
  items: CommunityUpdateItem[];
};

export type CommunityUpdateCounts = {
  total: number;
  byVault: Record<string, number>;
  byTarget: Record<string, number>;
};

export type CommunityUpdates = {
  groups: CommunityUpdateGroup[];
  counts: CommunityUpdateCounts;
  truncated: boolean;
};

type ChannelRoute = {
  localChannelId: string;
  localVaultId: string;
  localTitle: string;
  vaultName: string;
  sourceChannelId: string;
  subscribedAt: string;
  memberCount: number;
  linkCount: number;
  localPreview: string;
  localContent: string;
  sourcePreview: string;
  sourceContent: string;
};

type MessageRow = {
  id: string;
  author: string;
  actorDisplayName: string;
  body: string;
  activityAt: string;
  replyToJson: string | null;
};

type NoteActivityRow = {
  noteId: string;
  vaultId: string;
  vaultName: string;
  title: string;
  preview: string;
  actor: string;
  actorDisplayName: string;
  changedAt: string;
  activityId: number;
};

export function ensureCommunityActivitySchema(db: Db): void {
  const readStateAlreadyExists = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'community_read_state'
  `).get());
  db.exec(`
    CREATE TABLE IF NOT EXISTS community_read_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL CHECK(source_type IN ('channel', 'note')),
      source_id TEXT NOT NULL,
      read_at TEXT NOT NULL,
      PRIMARY KEY (user_id, source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS community_read_state_source_idx
      ON community_read_state(source_type, source_id);

    CREATE TABLE IF NOT EXISTS community_note_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS community_note_activity_note_idx
      ON community_note_activity(note_id, changed_at DESC, id DESC);
  `);

  // An upgraded installation already has chat history. Treat that history as
  // read when the inbox is introduced so the first launch is useful rather
  // than a wall of every message the account has ever received.
  if (!readStateAlreadyExists) {
    const seededAt = new Date().toISOString();
    const users = db.prepare('SELECT id FROM users').all() as Array<{ id: number }>;
    db.transaction(() => {
      for (const user of users) {
        for (const route of listAccessibleChannelRoutes(db, user.id)) {
          writeReadState(db, user.id, 'channel', route.sourceChannelId, seededAt);
        }
      }
    })();
  }
}

/** Record an attributed note mutation after the underlying write succeeds. */
export function recordCommunityNoteChange(
  db: Db,
  noteId: string,
  actorUserId: number,
  changedAt = new Date().toISOString(),
): void {
  db.prepare(`
    INSERT INTO community_note_activity (note_id, actor_user_id, changed_at)
    VALUES (?, ?, ?)
  `).run(noteId, actorUserId, changedAt);
}

function isChatMarker(preview: string, content: string): boolean {
  return preview.trim().startsWith(CHAT_NOTE_MARKER) || content.trim().startsWith(CHAT_NOTE_MARKER);
}

function listAccessibleChannelRoutes(db: Db, userId: number, canonicalOnly = true): ChannelRoute[] {
  const rows = db.prepare(`
    SELECT
      local.id AS localChannelId,
      local.vault_id AS localVaultId,
      local.title AS localTitle,
      local_vault.name AS vaultName,
      COALESCE(link.source_channel_id, local.id) AS sourceChannelId,
      CASE
        WHEN julianday(COALESCE(link.created_at, membership.created_at)) > julianday(membership.created_at)
          THEN link.created_at
        ELSE membership.created_at
      END AS subscribedAt,
      (SELECT COUNT(*) FROM vault_members source_members
        WHERE source_members.vault_id = COALESCE(link.source_vault_id, local.vault_id)) AS memberCount,
      (SELECT COUNT(*) FROM chat_channel_links siblings
        WHERE siblings.source_channel_id = COALESCE(link.source_channel_id, local.id)) AS linkCount,
      local.content_preview AS localPreview,
      local.content AS localContent,
      source.content_preview AS sourcePreview,
      source.content AS sourceContent
    FROM notes local
    JOIN vaults local_vault ON local_vault.id = local.vault_id
    JOIN vault_members membership
      ON membership.vault_id = local.vault_id AND membership.user_id = ?
    LEFT JOIN chat_channel_links link ON link.local_channel_id = local.id
    JOIN notes source ON source.id = COALESCE(link.source_channel_id, local.id)
    WHERE local.is_archived = 0 AND source.is_archived = 0
      AND (local.content_preview LIKE 'cascade://chat-channel%' OR local.content LIKE 'cascade://chat-channel%')
      AND (source.content_preview LIKE 'cascade://chat-channel%' OR source.content LIKE 'cascade://chat-channel%')
    ORDER BY (local.id = COALESCE(link.source_channel_id, local.id)) DESC,
             julianday(COALESCE(link.created_at, membership.created_at)) ASC,
             local.id ASC
    LIMIT ?
  `).all(userId, MAX_SUBSCRIBED_CHANNELS * 4) as ChannelRoute[];

  const canonical = new Map<string, ChannelRoute>();
  const accessible: ChannelRoute[] = [];
  for (const row of rows) {
    if (!isChatMarker(row.localPreview, row.localContent)) continue;
    if (!isChatMarker(row.sourcePreview, row.sourceContent)) continue;
    // A solo private channel is not a community subscription. Shared mirrors
    // and DMs have links even when the local navigation vault is private.
    if (row.memberCount <= 1 && row.linkCount <= 0) continue;
    accessible.push(row);
    if (!canonical.has(row.sourceChannelId)) canonical.set(row.sourceChannelId, row);
    if (canonical.size >= MAX_SUBSCRIBED_CHANNELS) break;
  }
  return canonicalOnly ? [...canonical.values()] : accessible;
}

function readAt(db: Db, userId: number, type: 'channel' | 'note', sourceId: string, fallback: string): string {
  const row = db.prepare(`
    SELECT read_at AS readAt FROM community_read_state
    WHERE user_id = ? AND source_type = ? AND source_id = ?
  `).get(userId, type, sourceId) as { readAt: string } | undefined;
  return row?.readAt || fallback;
}

function safeJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try { return JSON.parse(value) as T; } catch { return undefined; }
}

function mentionsUsername(body: string, username: string): boolean {
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])@${escaped}(?![a-z0-9_])`, 'i').test(body);
}

function compactPreview(value: string, fallback: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return (compact || fallback).slice(0, 180);
}

function addBoundedCount(record: Record<string, number>, key: string, amount: number): void {
  record[key] = Math.min(COMMUNITY_UPDATES_COUNT_CAP, (record[key] || 0) + amount);
}

function latestExternalNoteActivities(db: Db, userId: number): NoteActivityRow[] {
  return db.prepare(`
    SELECT
      n.id AS noteId,
      n.vault_id AS vaultId,
      v.name AS vaultName,
      n.title AS title,
      n.content_preview AS preview,
      u.username AS actor,
      COALESCE(NULLIF(u.display_name, ''), u.username) AS actorDisplayName,
      activity.changed_at AS changedAt,
      activity.id AS activityId
    FROM community_note_activity activity
    JOIN notes n ON n.id = activity.note_id
    JOIN vaults v ON v.id = n.vault_id
    JOIN vault_members membership ON membership.vault_id = n.vault_id AND membership.user_id = ?
    JOIN users u ON u.id = activity.actor_user_id
    LEFT JOIN community_read_state state
      ON state.user_id = ? AND state.source_type = 'note' AND state.source_id = n.id
    WHERE activity.actor_user_id != ?
      AND n.is_archived = 0
      AND n.is_listed = 1
      AND (SELECT COUNT(*) FROM vault_members members WHERE members.vault_id = n.vault_id) > 1
      AND activity.id = (
        SELECT newer.id FROM community_note_activity newer
        WHERE newer.note_id = n.id AND newer.actor_user_id != ?
        ORDER BY julianday(newer.changed_at) DESC, newer.id DESC LIMIT 1
      )
      AND julianday(activity.changed_at) > julianday(COALESCE(state.read_at, membership.created_at))
      AND n.content_preview NOT LIKE 'cascade://chat-channel%'
      AND n.content NOT LIKE 'cascade://chat-channel%'
    ORDER BY julianday(activity.changed_at) DESC, activity.id DESC
    LIMIT ?
  `).all(userId, userId, userId, userId, COMMUNITY_UPDATES_MAX_LIMIT + 1) as NoteActivityRow[];
}

export function listCommunityUpdates(
  db: Db,
  user: { id: number; username: string },
  requestedLimit = COMMUNITY_UPDATES_DEFAULT_LIMIT,
): CommunityUpdates {
  const limit = Math.max(1, Math.min(
    COMMUNITY_UPDATES_MAX_LIMIT,
    Math.floor(requestedLimit) || COMMUNITY_UPDATES_DEFAULT_LIMIT,
  ));
  const items: CommunityUpdateItem[] = [];
  const counts: CommunityUpdateCounts = { total: 0, byVault: {}, byTarget: {} };

  for (const route of listAccessibleChannelRoutes(db, user.id)) {
    const watermark = readAt(db, user.id, 'channel', route.sourceChannelId, route.subscribedAt);
    const unread = db.prepare(`
      SELECT
        message.id,
        message.author,
        COALESCE(NULLIF(author_user.display_name, ''), message.author) AS actorDisplayName,
        message.body,
        COALESCE(message.activity_at, message.created_at) AS activityAt,
        message.reply_to_json AS replyToJson
      FROM chat_messages message
      LEFT JOIN users author_user ON author_user.username = message.author COLLATE NOCASE
      LEFT JOIN chat_agent_members member ON member.id = message.registration_id
      LEFT JOIN vault_agents agent ON agent.id = member.vault_agent_id
      WHERE message.channel_id = ?
        AND julianday(COALESCE(message.activity_at, message.created_at)) > julianday(?)
        AND message.author != ? COLLATE NOCASE
        AND COALESCE(message.actor_user_id, agent.owner_user_id, -1) != ?
        AND NOT (COALESCE(message.agent_id, '') != '' AND COALESCE(message.status, '') IN ('sending', 'running'))
        AND NOT (COALESCE(message.agent_id, '') != '' AND trim(message.body) IN ('', 'Thinking...'))
      ORDER BY julianday(COALESCE(message.activity_at, message.created_at)) DESC, message.rowid DESC
      LIMIT ?
    `).all(
      route.sourceChannelId,
      watermark,
      user.username,
      user.id,
      COMMUNITY_UPDATES_COUNT_CAP + 1,
    ) as MessageRow[];

    const unreadCount = Math.min(unread.length, COMMUNITY_UPDATES_COUNT_CAP);
    if (unreadCount === 0) continue;
    counts.total = Math.min(COMMUNITY_TOTAL_COUNT_CAP, counts.total + unreadCount);
    addBoundedCount(counts.byVault, route.localVaultId, unreadCount);
    counts.byTarget[route.localChannelId] = unreadCount;

    for (const message of unread.slice(0, COMMUNITY_UPDATES_MAX_LIMIT)) {
      const reply = safeJson<{ author?: string; mention?: string }>(message.replyToJson);
      const isMention = mentionsUsername(message.body, user.username);
      const isReply = Boolean(reply && (
        String(reply.author || '').toLowerCase() === user.username.toLowerCase()
        || String(reply.mention || '').replace(/^@/, '').toLowerCase() === user.username.toLowerCase()
      ));
      items.push({
        id: `message:${message.id}`,
        kind: isMention ? 'mention' : isReply ? 'reply' : 'message',
        vaultId: route.localVaultId,
        vaultName: route.vaultName,
        targetId: route.localChannelId,
        targetTitle: route.localTitle,
        sourceId: route.sourceChannelId,
        messageId: message.id,
        actor: message.author,
        actorDisplayName: message.actorDisplayName || message.author,
        preview: compactPreview(message.body, 'Shared an update'),
        timestamp: message.activityAt,
      });
    }
  }

  for (const note of latestExternalNoteActivities(db, user.id)) {
    counts.total = Math.min(COMMUNITY_TOTAL_COUNT_CAP, counts.total + 1);
    addBoundedCount(counts.byVault, note.vaultId, 1);
    counts.byTarget[note.noteId] = 1;
    items.push({
      id: `note:${note.noteId}:${note.activityId}`,
      kind: 'note',
      vaultId: note.vaultId,
      vaultName: note.vaultName,
      targetId: note.noteId,
      targetTitle: note.title,
      sourceId: note.noteId,
      actor: note.actor,
      actorDisplayName: note.actorDisplayName,
      preview: compactPreview(note.preview, 'Note changed'),
      timestamp: note.changedAt,
    });
  }

  const timestampMillis = (value: string) => {
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:/.test(value)
      ? `${value.replace(' ', 'T')}Z`
      : value;
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  items.sort((a, b) => timestampMillis(b.timestamp) - timestampMillis(a.timestamp) || b.id.localeCompare(a.id));
  const visible = items.slice(0, limit);
  const groupsByVault = new Map<string, CommunityUpdateGroup>();
  for (const item of visible) {
    let group = groupsByVault.get(item.vaultId);
    if (!group) {
      group = {
        vaultId: item.vaultId,
        vaultName: item.vaultName,
        unreadCount: counts.byVault[item.vaultId] || 0,
        items: [],
      };
      groupsByVault.set(item.vaultId, group);
    }
    group.items.push(item);
  }
  return {
    groups: [...groupsByVault.values()],
    counts,
    truncated: items.length > visible.length || items.length >= COMMUNITY_UPDATES_MAX_LIMIT,
  };
}

function writeReadState(db: Db, userId: number, type: 'channel' | 'note', sourceId: string, at: string): void {
  db.prepare(`
    INSERT INTO community_read_state (user_id, source_type, source_id, read_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, source_type, source_id) DO UPDATE SET
      read_at = CASE
        WHEN julianday(excluded.read_at) > julianday(read_at) THEN excluded.read_at
        ELSE read_at
      END
  `).run(userId, type, sourceId, at);
}

/** Mark a local channel mirror or ordinary note read. False means inaccessible/deleted. */
export function markCommunityTargetRead(
  db: Db,
  userId: number,
  targetId: string,
  at = new Date().toISOString(),
): boolean {
  const channel = listAccessibleChannelRoutes(db, userId, false)
    .find((route) => route.localChannelId === targetId || route.sourceChannelId === targetId);
  if (channel) {
    writeReadState(db, userId, 'channel', channel.sourceChannelId, at);
    return true;
  }
  const note = db.prepare(`
    SELECT n.content_preview AS preview, n.content
    FROM notes n
    JOIN vault_members membership ON membership.vault_id = n.vault_id AND membership.user_id = ?
    WHERE n.id = ? AND n.is_archived = 0 AND n.is_listed = 1
  `).get(userId, targetId) as { preview: string; content: string } | undefined;
  if (!note || isChatMarker(note.preview, note.content)) return false;
  writeReadState(db, userId, 'note', targetId, at);
  return true;
}

export function markAllCommunityUpdatesRead(
  db: Db,
  userId: number,
  at = new Date().toISOString(),
): void {
  db.transaction(() => {
    for (const route of listAccessibleChannelRoutes(db, userId)) {
      writeReadState(db, userId, 'channel', route.sourceChannelId, at);
    }
    const notes = db.prepare(`
      SELECT n.id
      FROM notes n
      JOIN vault_members membership ON membership.vault_id = n.vault_id AND membership.user_id = ?
      WHERE n.is_archived = 0 AND n.is_listed = 1
        AND (SELECT COUNT(*) FROM vault_members members WHERE members.vault_id = n.vault_id) > 1
        AND n.content_preview NOT LIKE 'cascade://chat-channel%'
        AND n.content NOT LIKE 'cascade://chat-channel%'
    `).all(userId) as Array<{ id: string }>;
    for (const note of notes) writeReadState(db, userId, 'note', note.id, at);
  })();
}
