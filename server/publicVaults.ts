/**
 * @file publicVaults.ts — owner-controlled public vault visibility.
 *
 * A vault is private until its owner opts in. A public vault appears in the
 * browse directory for every signed-in user, and any of them may join it,
 * landing at the role the owner chose (`public_join_role`). Nothing here can
 * mint a second owner: joining is capped at editor/viewer exactly like an
 * invite link.
 *
 * Visibility is stored on `vaults` itself so every existing `SELECT v.*` path
 * (the vault switcher, `GET /api/vaults/:id`) carries it without a join.
 */
import type Database from 'better-sqlite3';
import { vaultHoldsDirectMessages } from './directMessages.js';
import { getVaultRole, type VaultRole } from './vaultMembers.js';

type Db = Database.Database;

export const VAULT_VISIBILITIES = ['private', 'public'] as const;
export type VaultVisibility = (typeof VAULT_VISIBILITIES)[number];

/** Roles a stranger may self-assign by joining. Never `owner`. */
export const PUBLIC_JOIN_ROLES = ['editor', 'viewer'] as const;
export type PublicJoinRole = (typeof PUBLIC_JOIN_ROLES)[number];

export type VaultVisibilitySettings = {
  visibility: VaultVisibility;
  joinRole: PublicJoinRole;
};

/** A browse-directory entry. Deliberately free of `root_path` and note counts. */
export type PublicVaultSummary = {
  id: string;
  name: string;
  ownerUserId: number;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerAvatarUrl: string;
  memberCount: number;
  joinRole: PublicJoinRole;
  createdAt: string;
  /** The caller's existing membership, or null when they have never joined. */
  role: VaultRole | null;
};

export function isVaultVisibility(value: unknown): value is VaultVisibility {
  return typeof value === 'string' && (VAULT_VISIBILITIES as readonly string[]).includes(value);
}

export function isPublicJoinRole(value: unknown): value is PublicJoinRole {
  return typeof value === 'string' && (PUBLIC_JOIN_ROLES as readonly string[]).includes(value);
}

export function ensurePublicVaultSchema(db: Db): void {
  const columns = (db.prepare('PRAGMA table_info(vaults)').all() as Array<{ name: string }>)
    .map((row) => row.name);

  if (!columns.includes('visibility')) {
    db.exec("ALTER TABLE vaults ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
  }
  if (!columns.includes('public_join_role')) {
    db.exec("ALTER TABLE vaults ADD COLUMN public_join_role TEXT NOT NULL DEFAULT 'viewer'");
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_vaults_visibility ON vaults(visibility)');

  // SQLite cannot add a CHECK constraint to an existing table, so the enum is
  // enforced in code and repaired on boot. Both repairs fail closed.
  db.exec("UPDATE vaults SET visibility = 'private' WHERE visibility IS NULL OR visibility NOT IN ('private', 'public')");
  db.exec("UPDATE vaults SET public_join_role = 'viewer' WHERE public_join_role IS NULL OR public_join_role NOT IN ('editor', 'viewer')");
}

export function getVaultVisibility(db: Db, vaultId: string): VaultVisibilitySettings | null {
  const row = db.prepare(
    'SELECT visibility, public_join_role AS joinRole FROM vaults WHERE id = ?',
  ).get(vaultId) as { visibility: string; joinRole: string } | undefined;
  if (!row) return null;
  return {
    visibility: isVaultVisibility(row.visibility) ? row.visibility : 'private',
    joinRole: isPublicJoinRole(row.joinRole) ? row.joinRole : 'viewer',
  };
}

/**
 * Owner-only. `joinRole` is remembered across a private→public→private cycle so
 * re-publishing does not silently widen access.
 */
export function setVaultVisibility(
  db: Db,
  vaultId: string,
  actorUserId: number,
  input: { visibility?: unknown; joinRole?: unknown },
): VaultVisibilitySettings {
  const current = getVaultVisibility(db, vaultId);
  if (!current) throw new Error('Vault not found');
  if (getVaultRole(db, vaultId, actorUserId) !== 'owner') {
    throw new Error('Only the vault owner can change vault visibility');
  }

  let visibility = current.visibility;
  if (input.visibility !== undefined) {
    if (!isVaultVisibility(input.visibility)) throw new Error('Visibility must be public or private');
    visibility = input.visibility;
  }

  let joinRole = current.joinRole;
  if (input.joinRole !== undefined) {
    if (!isPublicJoinRole(input.joinRole)) throw new Error('Join role must be editor or viewer');
    joinRole = input.joinRole;
  }

  // A DM channel is only as private as the vault holding it, and joining is
  // open to strangers. Refuse rather than silently publish the conversation.
  if (visibility === 'public' && vaultHoldsDirectMessages(db, vaultId)) {
    throw new Error('This vault holds direct messages and cannot be made public');
  }

  db.prepare('UPDATE vaults SET visibility = ?, public_join_role = ? WHERE id = ?')
    .run(visibility, joinRole, vaultId);
  return { visibility, joinRole };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function listPublicVaults(
  db: Db,
  opts: { userId: number; query?: string; limit?: number; offset?: number },
): PublicVaultSummary[] {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const query = String(opts.query || '').trim();
  const like = query ? `%${escapeLike(query)}%` : null;

  const rows = db.prepare(`
    SELECT
      v.id AS id,
      v.name AS name,
      v.created_by AS ownerUserId,
      u.username AS ownerUsername,
      COALESCE(NULLIF(u.display_name, ''), u.username) AS ownerDisplayName,
      COALESCE(u.avatar_url, '') AS ownerAvatarUrl,
      v.public_join_role AS joinRole,
      v.created_at AS createdAt,
      (SELECT COUNT(*) FROM vault_members c WHERE c.vault_id = v.id) AS memberCount,
      (SELECT m.role FROM vault_members m WHERE m.vault_id = v.id AND m.user_id = ?) AS role
    FROM vaults v
    JOIN users u ON u.id = v.created_by
    WHERE v.visibility = 'public'
      AND (? IS NULL OR v.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\')
    ORDER BY memberCount DESC, v.created_at DESC
    LIMIT ? OFFSET ?
  `).all(opts.userId, like, like, like, limit, offset) as Array<PublicVaultSummary & { role: string | null }>;

  return rows.map((row) => ({
    ...row,
    joinRole: isPublicJoinRole(row.joinRole) ? row.joinRole : 'viewer',
    role: row.role === 'owner' || row.role === 'editor' || row.role === 'viewer' ? row.role : null,
  }));
}

export type JoinPublicVaultResult = {
  vaultId: string;
  name: string;
  role: VaultRole;
  alreadyMember: boolean;
};

/**
 * Join a public vault. A private vault reports "not found" rather than
 * "forbidden" so this route cannot be used to probe for vault ids.
 */
export function joinPublicVault(db: Db, vaultId: string, userId: number): JoinPublicVaultResult {
  const vault = db.prepare('SELECT id, name, created_by, visibility, public_join_role FROM vaults WHERE id = ?')
    .get(vaultId) as
    | { id: string; name: string; created_by: number; visibility: string; public_join_role: string }
    | undefined;
  if (!vault || vault.visibility !== 'public') throw new Error('Vault not found');

  const existing = getVaultRole(db, vault.id, userId);
  if (existing) {
    return { vaultId: vault.id, name: vault.name, role: existing, alreadyMember: true };
  }

  const role: PublicJoinRole = isPublicJoinRole(vault.public_join_role) ? vault.public_join_role : 'viewer';
  db.prepare(`
    INSERT INTO vault_members (vault_id, user_id, role, invited_by)
    VALUES (?, ?, ?, ?)
  `).run(vault.id, userId, role, vault.created_by);

  return { vaultId: vault.id, name: vault.name, role, alreadyMember: false };
}
