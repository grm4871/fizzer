/**
 * @file publicVaults.ts — owner-curated public vault discovery.
 *
 * Directory and detail responses are deliberately narrower than a vault or
 * note response: no root/file paths and no full note content ever cross this
 * boundary. Public membership is viewer-only; editors are promoted through
 * the normal owner-controlled member flow.
 */
import type Database from 'better-sqlite3';
import { vaultHoldsDirectMessages } from './directMessages.js';
import { redactPrivatePreview } from './privacy.js';
import { getVaultRole, type VaultRole } from './vaultMembers.js';

type Db = Database.Database;

export const VAULT_VISIBILITIES = ['private', 'public'] as const;
export type VaultVisibility = (typeof VAULT_VISIBILITIES)[number];
export const PUBLIC_JOIN_POLICIES = ['open', 'request', 'invite'] as const;
export type PublicJoinPolicy = (typeof PUBLIC_JOIN_POLICIES)[number];
export type JoinRequestStatus = 'pending' | 'approved' | 'rejected';

export type VaultVisibilitySettings = {
  visibility: VaultVisibility;
  summary: string;
  topics: string[];
  guidelines: string;
  homeNoteId: string | null;
  joinPolicy: PublicJoinPolicy;
};

export type PublicVaultSummary = {
  id: string;
  name: string;
  ownerUserId: number;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerAvatarUrl: string;
  memberCount: number;
  summary: string;
  topics: string[];
  joinPolicy: PublicJoinPolicy;
  lastActivity: string;
  createdAt: string;
  role: VaultRole | null;
  requestStatus: JoinRequestStatus | null;
};

export type PublicVaultDetail = PublicVaultSummary & {
  guidelines: string;
  homeNote: { title: string; preview: string; updatedAt: string } | null;
};

export type PublicJoinRequest = {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  status: JoinRequestStatus;
  createdAt: string;
};

export function isVaultVisibility(value: unknown): value is VaultVisibility {
  return typeof value === 'string' && (VAULT_VISIBILITIES as readonly string[]).includes(value);
}

export function isPublicJoinPolicy(value: unknown): value is PublicJoinPolicy {
  return typeof value === 'string' && (PUBLIC_JOIN_POLICIES as readonly string[]).includes(value);
}

function normalizeTopic(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ')
    : '';
}

export function normalizePublicTopics(value: unknown, requireOne = true): string[] {
  if (!Array.isArray(value)) throw new Error('Topics must be a list');
  const topics: string[] = [];
  for (const raw of value) {
    const topic = normalizeTopic(raw);
    if (!topic) continue;
    if (topic.length > 32) throw new Error('Each topic must be 32 characters or fewer');
    if (!topics.includes(topic)) topics.push(topic);
  }
  if (topics.length > 5) throw new Error('Choose no more than 5 topics');
  if (requireOne && topics.length < 1) throw new Error('Choose at least 1 topic');
  return topics;
}

function parseStoredTopics(value: unknown): string[] {
  try {
    return normalizePublicTopics(JSON.parse(String(value || '[]')), false);
  } catch {
    return [];
  }
}

function columnsFor(db: Db, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

export function ensurePublicVaultSchema(db: Db): void {
  const columns = columnsFor(db, 'vaults');
  if (!columns.includes('visibility')) db.exec("ALTER TABLE vaults ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
  // Retained for upgraded databases. It is repaired to viewer and never read
  // as authority, preventing a legacy public editor setting from minting one.
  if (!columns.includes('public_join_role')) db.exec("ALTER TABLE vaults ADD COLUMN public_join_role TEXT NOT NULL DEFAULT 'viewer'");
  if (!columns.includes('public_summary')) db.exec("ALTER TABLE vaults ADD COLUMN public_summary TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('public_topics')) db.exec("ALTER TABLE vaults ADD COLUMN public_topics TEXT NOT NULL DEFAULT '[]'");
  if (!columns.includes('public_guidelines')) db.exec("ALTER TABLE vaults ADD COLUMN public_guidelines TEXT NOT NULL DEFAULT ''");
  if (!columns.includes('public_home_note_id')) db.exec('ALTER TABLE vaults ADD COLUMN public_home_note_id TEXT');
  if (!columns.includes('public_join_policy')) db.exec("ALTER TABLE vaults ADD COLUMN public_join_policy TEXT NOT NULL DEFAULT 'open'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vaults_visibility ON vaults(visibility);
    CREATE TABLE IF NOT EXISTS public_vault_join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vault_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_public_join_requests_owner
      ON public_vault_join_requests(vault_id, status, created_at);
  `);

  db.exec("UPDATE vaults SET visibility = 'private' WHERE visibility IS NULL OR visibility NOT IN ('private', 'public')");
  db.exec("UPDATE vaults SET public_join_role = 'viewer' WHERE public_join_role IS NULL OR public_join_role != 'viewer'");
  db.exec("UPDATE vaults SET public_join_policy = 'invite' WHERE public_join_policy IS NULL OR public_join_policy NOT IN ('open', 'request', 'invite')");
  db.exec("UPDATE public_vault_join_requests SET status = 'rejected' WHERE status NOT IN ('pending', 'approved', 'rejected')");

  const topicRows = db.prepare('SELECT id, public_topics AS topics FROM vaults').all() as Array<{ id: string; topics: string }>;
  const repairTopics = db.prepare('UPDATE vaults SET public_topics = ? WHERE id = ?');
  const repair = db.transaction(() => {
    for (const row of topicRows) {
      const normalized = JSON.stringify(parseStoredTopics(row.topics));
      if (normalized !== String(row.topics || '')) repairTopics.run(normalized, row.id);
    }
  });
  repair();
}

export function getVaultVisibility(db: Db, vaultId: string): VaultVisibilitySettings | null {
  const row = db.prepare(`
    SELECT visibility, public_summary AS summary, public_topics AS topics,
           public_guidelines AS guidelines, public_home_note_id AS homeNoteId,
           public_join_policy AS joinPolicy
    FROM vaults WHERE id = ?
  `).get(vaultId) as {
    visibility: string; summary: string; topics: string; guidelines: string;
    homeNoteId: string | null; joinPolicy: string;
  } | undefined;
  if (!row) return null;
  return {
    visibility: isVaultVisibility(row.visibility) ? row.visibility : 'private',
    summary: String(row.summary || ''),
    topics: parseStoredTopics(row.topics),
    guidelines: String(row.guidelines || ''),
    homeNoteId: row.homeNoteId || null,
    joinPolicy: isPublicJoinPolicy(row.joinPolicy) ? row.joinPolicy : 'invite',
  };
}

function publicHomeNoteRow(db: Db, vaultId: string, noteId: string): {
  id: string; title: string; content: string; content_preview: string; updated_at: string;
} | undefined {
  return db.prepare(`
    SELECT id, title, content, content_preview, updated_at
    FROM notes
    WHERE id = ? AND vault_id = ? AND is_listed = 1 AND is_archived = 0
      AND trim(content) NOT LIKE 'cascade://chat-channel%'
      AND trim(content_preview) NOT LIKE 'cascade://chat-channel%'
  `).get(noteId, vaultId) as {
    id: string; title: string; content: string; content_preview: string; updated_at: string;
  } | undefined;
}

export function listPublicHomeNoteChoices(db: Db, vaultId: string, actorUserId: number): Array<{ id: string; title: string }> {
  if (getVaultRole(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can curate public discovery');
  return db.prepare(`
    SELECT id, title FROM notes
    WHERE vault_id = ? AND is_listed = 1 AND is_archived = 0
      AND trim(content) NOT LIKE 'cascade://chat-channel%'
      AND trim(content_preview) NOT LIKE 'cascade://chat-channel%'
    ORDER BY title COLLATE NOCASE ASC
  `).all(vaultId) as Array<{ id: string; title: string }>;
}

/** Owner-only. Partial updates preserve fields that were not sent. */
export function setVaultVisibility(
  db: Db,
  vaultId: string,
  actorUserId: number,
  input: {
    visibility?: unknown; summary?: unknown; topics?: unknown; guidelines?: unknown;
    homeNoteId?: unknown; joinPolicy?: unknown;
  },
): VaultVisibilitySettings {
  const current = getVaultVisibility(db, vaultId);
  if (!current) throw new Error('Vault not found');
  if (getVaultRole(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can change public discovery');

  const visibility = input.visibility === undefined
    ? current.visibility
    : isVaultVisibility(input.visibility) ? input.visibility : (() => { throw new Error('Visibility must be public or private'); })();
  const summary = input.summary === undefined ? current.summary : String(input.summary || '').trim();
  if (summary.length > 240) throw new Error('Summary must be 240 characters or fewer');
  const topics = input.topics === undefined ? current.topics : normalizePublicTopics(input.topics, visibility === 'public');
  const guidelines = input.guidelines === undefined ? current.guidelines : String(input.guidelines || '').trim();
  if (guidelines.length > 2000) throw new Error('Guidelines must be 2000 characters or fewer');
  const joinPolicy = input.joinPolicy === undefined
    ? current.joinPolicy
    : isPublicJoinPolicy(input.joinPolicy) ? input.joinPolicy : (() => { throw new Error('Join policy must be open, request, or invite'); })();

  let homeNoteId = current.homeNoteId;
  if (input.homeNoteId !== undefined) {
    if (input.homeNoteId !== null && typeof input.homeNoteId !== 'string') throw new Error('Home note must be a note id or null');
    homeNoteId = typeof input.homeNoteId === 'string' && input.homeNoteId.trim() ? input.homeNoteId.trim() : null;
  }
  if (homeNoteId && !publicHomeNoteRow(db, vaultId, homeNoteId)) {
    throw new Error('Home note must be a listed non-chat note in this vault');
  }
  // Existing public vaults remain discoverable after migration even before
  // their owner curates topics. Any new publish or explicit topic edit must
  // satisfy the new 1-5 topic contract.
  if (visibility === 'public' && input.topics !== undefined && topics.length < 1) {
    throw new Error('Choose at least 1 topic before publishing');
  }
  if (visibility === 'public' && vaultHoldsDirectMessages(db, vaultId)) {
    throw new Error('This vault holds direct messages and cannot be made public');
  }

  const update = db.transaction(() => {
    db.prepare(`
      UPDATE vaults
      SET visibility = ?, public_join_role = 'viewer', public_summary = ?, public_topics = ?,
          public_guidelines = ?, public_home_note_id = ?, public_join_policy = ?
      WHERE id = ?
    `).run(visibility, summary, JSON.stringify(topics), guidelines, homeNoteId, joinPolicy, vaultId);
    if (visibility !== 'public' || joinPolicy !== 'request') {
      db.prepare(`
        UPDATE public_vault_join_requests
        SET status = 'rejected', reviewed_by = ?, updated_at = datetime('now')
        WHERE vault_id = ? AND status = 'pending'
      `).run(actorUserId, vaultId);
    }
  });
  update();
  return { visibility, summary, topics, guidelines, homeNoteId, joinPolicy };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function validRole(value: unknown): VaultRole | null {
  return value === 'owner' || value === 'editor' || value === 'viewer' ? value : null;
}

function validRequestStatus(value: unknown): JoinRequestStatus | null {
  return value === 'pending' || value === 'approved' || value === 'rejected' ? value : null;
}

type PublicVaultRow = Omit<PublicVaultSummary, 'topics' | 'role' | 'requestStatus' | 'joinPolicy'> & {
  topics: string; role: string | null; requestStatus: string | null; joinPolicy: string;
};

function mapPublicVaultRow(row: PublicVaultRow): PublicVaultSummary {
  return {
    ...row,
    topics: parseStoredTopics(row.topics),
    role: validRole(row.role),
    requestStatus: validRequestStatus(row.requestStatus),
    joinPolicy: isPublicJoinPolicy(row.joinPolicy) ? row.joinPolicy : 'invite',
  };
}

export function listPublicVaults(
  db: Db,
  opts: { userId: number; query?: string; limit?: number; offset?: number; id?: string },
): PublicVaultSummary[] {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const query = String(opts.query || '').trim();
  const like = query ? `%${escapeLike(query)}%` : null;
  const rows = db.prepare(`
    SELECT
      v.id, v.name, v.created_by AS ownerUserId, u.username AS ownerUsername,
      COALESCE(NULLIF(u.display_name, ''), u.username) AS ownerDisplayName,
      COALESCE(u.avatar_url, '') AS ownerAvatarUrl,
      (SELECT COUNT(*) FROM vault_members c WHERE c.vault_id = v.id) AS memberCount,
      v.public_summary AS summary, v.public_topics AS topics,
      v.public_join_policy AS joinPolicy, v.created_at AS createdAt,
      COALESCE((
        SELECT MAX(n.updated_at) FROM notes n
        WHERE n.vault_id = v.id AND n.is_listed = 1 AND n.is_archived = 0
          AND trim(n.content) NOT LIKE 'cascade://chat-channel%'
          AND trim(n.content_preview) NOT LIKE 'cascade://chat-channel%'
      ), v.created_at) AS lastActivity,
      (SELECT m.role FROM vault_members m WHERE m.vault_id = v.id AND m.user_id = ?) AS role,
      (SELECT r.status FROM public_vault_join_requests r WHERE r.vault_id = v.id AND r.user_id = ?) AS requestStatus
    FROM vaults v
    JOIN users u ON u.id = v.created_by
    WHERE v.visibility = 'public'
      AND (? IS NULL OR v.id = ?)
      AND (? IS NULL
        OR v.name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR u.username LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR v.public_summary LIKE ? ESCAPE '\\' COLLATE NOCASE
        OR v.public_topics LIKE ? ESCAPE '\\' COLLATE NOCASE)
    ORDER BY
      CASE
        WHEN ? IS NULL THEN 0
        WHEN v.name = ? COLLATE NOCASE THEN 0
        WHEN v.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
        WHEN u.username LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 2
        WHEN v.public_summary LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 3
        ELSE 4
      END,
      datetime(lastActivity) DESC, v.name COLLATE NOCASE ASC
    LIMIT ? OFFSET ?
  `).all(
    opts.userId, opts.userId,
    opts.id || null, opts.id || null,
    like, like, like, like, like, like,
    like, query, like, like, like, like,
    limit, offset,
  ) as PublicVaultRow[];
  return rows.map(mapPublicVaultRow);
}

function sanitizeHomePreview(value: string): string {
  return redactPrivatePreview(String(value || ''))
    .replace(/\bfile:\/\/\S+/gi, '[path omitted]')
    .replace(/\b[A-Za-z]:\\[^\s]+/g, '[path omitted]')
    .replace(/(^|\s)\/(?:home|Users|var|etc|tmp|opt|srv)\/\S+/g, '$1[path omitted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

export function getPublicVaultDetail(db: Db, vaultId: string, userId: number): PublicVaultDetail | null {
  const summary = listPublicVaults(db, { userId, id: vaultId, limit: 1 })[0];
  if (!summary) return null;
  const row = db.prepare(`
    SELECT public_guidelines AS guidelines, public_home_note_id AS homeNoteId
    FROM vaults WHERE id = ? AND visibility = 'public'
  `).get(vaultId) as { guidelines: string; homeNoteId: string | null } | undefined;
  if (!row) return null;
  const note = row.homeNoteId ? publicHomeNoteRow(db, vaultId, row.homeNoteId) : undefined;
  return {
    ...summary,
    guidelines: String(row.guidelines || ''),
    homeNote: note ? {
      title: note.title,
      preview: sanitizeHomePreview(note.content_preview),
      updatedAt: note.updated_at,
    } : null,
  };
}

export type JoinPublicVaultResult = {
  vaultId: string;
  name: string;
  role: VaultRole | null;
  alreadyMember: boolean;
  requestStatus: JoinRequestStatus | null;
};

export function joinPublicVault(db: Db, vaultId: string, userId: number): JoinPublicVaultResult {
  const vault = db.prepare('SELECT id, name, created_by, visibility, public_join_policy FROM vaults WHERE id = ?')
    .get(vaultId) as { id: string; name: string; created_by: number; visibility: string; public_join_policy: string } | undefined;
  if (!vault || vault.visibility !== 'public') throw new Error('Vault not found');
  const existing = getVaultRole(db, vault.id, userId);
  if (existing) return { vaultId: vault.id, name: vault.name, role: existing, alreadyMember: true, requestStatus: null };

  const policy = isPublicJoinPolicy(vault.public_join_policy) ? vault.public_join_policy : 'invite';
  if (policy === 'invite') throw new Error('This vault is invite only');
  if (policy === 'request') {
    db.prepare(`
      INSERT INTO public_vault_join_requests (vault_id, user_id, status)
      VALUES (?, ?, 'pending')
      ON CONFLICT(vault_id, user_id) DO UPDATE SET
        status = 'pending', reviewed_by = NULL, updated_at = datetime('now')
    `).run(vault.id, userId);
    return { vaultId: vault.id, name: vault.name, role: null, alreadyMember: false, requestStatus: 'pending' };
  }

  db.prepare(`INSERT INTO vault_members (vault_id, user_id, role, invited_by) VALUES (?, ?, 'viewer', ?)`)
    .run(vault.id, userId, vault.created_by);
  return { vaultId: vault.id, name: vault.name, role: 'viewer', alreadyMember: false, requestStatus: null };
}

export function listPublicVaultJoinRequests(db: Db, vaultId: string, actorUserId: number): PublicJoinRequest[] {
  if (getVaultRole(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can review join requests');
  return db.prepare(`
    SELECT r.id, r.user_id AS userId, u.username,
      COALESCE(NULLIF(u.display_name, ''), u.username) AS displayName,
      COALESCE(u.avatar_url, '') AS avatarUrl, r.status, r.created_at AS createdAt
    FROM public_vault_join_requests r
    JOIN users u ON u.id = r.user_id
    WHERE r.vault_id = ? AND r.status = 'pending'
    ORDER BY r.created_at ASC, r.id ASC
  `).all(vaultId) as PublicJoinRequest[];
}

export function reviewPublicVaultJoinRequest(
  db: Db,
  vaultId: string,
  requestId: number,
  actorUserId: number,
  action: unknown,
): { requestId: number; status: 'approved' | 'rejected'; userId: number; role: 'viewer' | null } {
  if (getVaultRole(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can review join requests');
  if (action !== 'approve' && action !== 'reject') throw new Error('Action must be approve or reject');
  const request = db.prepare(`
    SELECT r.id, r.user_id AS userId, r.status, v.visibility, v.public_join_policy AS joinPolicy
    FROM public_vault_join_requests r JOIN vaults v ON v.id = r.vault_id
    WHERE r.id = ? AND r.vault_id = ?
  `).get(requestId, vaultId) as {
    id: number; userId: number; status: string; visibility: string; joinPolicy: string;
  } | undefined;
  if (!request || request.status !== 'pending') throw new Error('Join request not found');
  if (action === 'approve' && (request.visibility !== 'public' || request.joinPolicy !== 'request')) {
    throw new Error('This vault is not accepting join requests');
  }
  const status = action === 'approve' ? 'approved' : 'rejected';
  const review = db.transaction(() => {
    if (action === 'approve') {
      db.prepare(`
        INSERT OR IGNORE INTO vault_members (vault_id, user_id, role, invited_by)
        VALUES (?, ?, 'viewer', ?)
      `).run(vaultId, request.userId, actorUserId);
    }
    db.prepare(`
      UPDATE public_vault_join_requests
      SET status = ?, reviewed_by = ?, updated_at = datetime('now') WHERE id = ?
    `).run(status, actorUserId, request.id);
  });
  review();
  return { requestId: request.id, status, userId: request.userId, role: action === 'approve' ? 'viewer' : null };
}
