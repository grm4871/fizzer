/**
 * @file communityModeration.ts — vault-scoped bans and accountable reports.
 *
 * Reports intentionally store target identifiers, a fixed reason, and the
 * reporter's own bounded detail — never copied note or message content.
 */
import type Database from 'better-sqlite3';
import type { VaultRole } from './vaultMembers.js';
import { isDirectMessageChannel } from './directMessages.js';

type Db = Database.Database;

export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'illegal', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_TARGET_TYPES = ['vault', 'note', 'message', 'member'] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];
export const REPORT_STATUSES = ['open', 'dismissed', 'resolved'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const REPORT_DETAIL_MAX = 500;
export const REPORT_RATE_LIMIT = { windowMinutes: 60, max: 10 } as const;

export type VaultBan = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  reason: string;
  bannedBy: number | null;
  createdAt: string;
};

/** Vault-owner rows deliberately omit reporter identity. */
export type VaultReport = {
  id: number;
  vaultId: string;
  targetType: ReportTargetType;
  targetId: string;
  targetUsername: string | null;
  reason: ReportReason;
  detail: string;
  status: ReportStatus;
  createdAt: string;
  reviewedAt: string | null;
};

export type GlobalReport = VaultReport & {
  vaultName: string;
  vaultVisibility: string;
  vaultOwnerUsername: string;
  reporterUserId: number;
  reporterUsername: string;
};

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);
}

export function isReportStatus(value: unknown): value is ReportStatus {
  return typeof value === 'string' && (REPORT_STATUSES as readonly string[]).includes(value);
}

function isReportTargetType(value: unknown): value is ReportTargetType {
  return typeof value === 'string' && (REPORT_TARGET_TYPES as readonly string[]).includes(value);
}

export function ensureCommunityModerationSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vault_bans (
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      banned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (vault_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_vault_bans_user ON vault_bans(user_id);

    CREATE TABLE IF NOT EXISTS content_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open',
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(vault_id, target_type, target_id, reporter_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_reports_vault
      ON content_reports(vault_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_content_reports_status
      ON content_reports(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_content_reports_reporter
      ON content_reports(reporter_user_id, created_at);
  `);
  db.exec(`
    DELETE FROM vault_bans
    WHERE user_id IN (SELECT created_by FROM vaults WHERE vaults.id = vault_bans.vault_id)
  `);
  db.exec("UPDATE content_reports SET status = 'open' WHERE status NOT IN ('open', 'dismissed', 'resolved')");
}

function roleOf(db: Db, vaultId: string, userId: number): VaultRole | null {
  const row = db.prepare('SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?')
    .get(vaultId, userId) as { role: string } | undefined;
  return row?.role === 'owner' || row?.role === 'editor' || row?.role === 'viewer' ? row.role : null;
}

function vaultRow(db: Db, vaultId: string): {
  id: string; name: string; createdBy: number; visibility: string;
} | undefined {
  return db.prepare(`
    SELECT id, name, created_by AS createdBy, COALESCE(visibility, 'private') AS visibility
    FROM vaults WHERE id = ?
  `).get(vaultId) as { id: string; name: string; createdBy: number; visibility: string } | undefined;
}

export function isServerOwner(db: Db, userId: number): boolean {
  const row = db.prepare('SELECT MIN(id) AS ownerId FROM users').get() as { ownerId: number | null };
  return row.ownerId != null && row.ownerId === userId;
}

export function isVaultBanned(db: Db, vaultId: string, userId: number): boolean {
  return Boolean(db.prepare('SELECT 1 FROM vault_bans WHERE vault_id = ? AND user_id = ?').get(vaultId, userId));
}

/** Shared choke point used by every membership-entry path. */
export function assertNotVaultBanned(db: Db, vaultId: string, userId: number): void {
  if (isVaultBanned(db, vaultId, userId)) throw new Error('This user is banned from this vault');
}

export function listVaultBans(db: Db, vaultId: string, actorUserId: number): VaultBan[] {
  if (roleOf(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can manage bans');
  return db.prepare(`
    SELECT b.user_id AS userId, u.username,
      COALESCE(NULLIF(u.display_name, ''), u.username) AS displayName,
      COALESCE(u.avatar_url, '') AS avatarUrl, b.reason,
      b.banned_by AS bannedBy, b.created_at AS createdAt
    FROM vault_bans b JOIN users u ON u.id = b.user_id
    WHERE b.vault_id = ?
    ORDER BY b.created_at DESC, u.username COLLATE NOCASE
  `).all(vaultId) as VaultBan[];
}

export function banVaultMember(
  db: Db,
  vaultId: string,
  actorUserId: number,
  targetUserId: number,
  reasonInput?: unknown,
): VaultBan {
  const vault = vaultRow(db, vaultId);
  if (!vault) throw new Error('Vault not found');
  if (roleOf(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can ban members');
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) throw new Error('Invalid user id');
  if (targetUserId === vault.createdBy || roleOf(db, vaultId, targetUserId) === 'owner') {
    throw new Error('The vault owner cannot be banned');
  }
  const user = db.prepare(`
    SELECT id, username, COALESCE(NULLIF(display_name, ''), username) AS displayName,
      COALESCE(avatar_url, '') AS avatarUrl FROM users WHERE id = ?
  `).get(targetUserId) as { id: number; username: string; displayName: string; avatarUrl: string } | undefined;
  if (!user) throw new Error('User not found');
  const reason = String(reasonInput ?? '').trim();
  if (reason.length > REPORT_DETAIL_MAX) throw new Error(`Reason must be ${REPORT_DETAIL_MAX} characters or fewer`);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO vault_bans (vault_id, user_id, banned_by, reason)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(vault_id, user_id) DO UPDATE SET
        banned_by = excluded.banned_by, reason = excluded.reason, created_at = datetime('now')
    `).run(vaultId, targetUserId, actorUserId, reason);
    db.prepare('DELETE FROM vault_members WHERE vault_id = ? AND user_id = ?').run(vaultId, targetUserId);
    db.prepare(`
      UPDATE public_vault_join_requests
      SET status = 'rejected', reviewed_by = ?, updated_at = datetime('now')
      WHERE vault_id = ? AND user_id = ? AND status = 'pending'
    `).run(actorUserId, vaultId, targetUserId);
  })();

  const stored = db.prepare('SELECT created_at AS createdAt FROM vault_bans WHERE vault_id = ? AND user_id = ?')
    .get(vaultId, targetUserId) as { createdAt: string };
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    reason,
    bannedBy: actorUserId,
    createdAt: stored.createdAt,
  };
}

export function unbanVaultMember(db: Db, vaultId: string, actorUserId: number, targetUserId: number): void {
  if (roleOf(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can manage bans');
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) throw new Error('Invalid user id');
  const result = db.prepare('DELETE FROM vault_bans WHERE vault_id = ? AND user_id = ?').run(vaultId, targetUserId);
  if (!result.changes) throw new Error('That user is not banned');
}

const CHAT_NOTE_PREFIX = 'cascade://chat-channel';

function assertReportTarget(
  db: Db,
  vault: { id: string; createdBy: number; visibility: string },
  reporterUserId: number,
  targetType: Exclude<ReportTargetType, 'message'>,
  targetId: string,
): void {
  if (targetType === 'vault') {
    if (targetId !== vault.id) throw new Error('Report target does not belong to this vault');
    if (vault.visibility !== 'public') throw new Error('Only a public vault can be reported');
    if (reporterUserId === vault.createdBy) throw new Error('You cannot report your own vault');
    return;
  }
  if (!roleOf(db, vault.id, reporterUserId)) {
    throw new Error('Only a member of this vault can report its content');
  }
  if (targetType === 'note') {
    const note = db.prepare(`
      SELECT 1 FROM notes
      WHERE id = ? AND vault_id = ? AND is_listed = 1 AND is_archived = 0
        AND trim(content) NOT LIKE ? AND trim(content_preview) NOT LIKE ?
    `).get(targetId, vault.id, `${CHAT_NOTE_PREFIX}%`, `${CHAT_NOTE_PREFIX}%`);
    if (!note) throw new Error('Report target does not belong to this vault');
    return;
  }
  const targetUserId = Number(targetId);
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) throw new Error('Invalid user id');
  if (targetUserId === reporterUserId) throw new Error('You cannot report yourself');
  if (!roleOf(db, vault.id, targetUserId)) throw new Error('Report target does not belong to this vault');
}

/** Resolve a message seen through a local mirror to its accountable source vault. */
function resolveMessageReportVault(
  db: Db,
  requestedVaultId: string,
  reporterUserId: number,
  messageId: string,
): { id: string; name: string; createdBy: number; visibility: string } {
  if (!roleOf(db, requestedVaultId, reporterUserId)) {
    throw new Error('Only a member of this vault can report its content');
  }
  const message = db.prepare(`
    SELECT m.vault_id AS sourceVaultId, m.channel_id AS sourceChannelId
    FROM chat_messages m
    WHERE m.id = ? AND (
      (m.vault_id = ? AND EXISTS (
        SELECT 1 FROM notes n WHERE n.id = m.channel_id AND n.vault_id = ?
      ))
      OR EXISTS (
        SELECT 1 FROM chat_channel_links l
        WHERE l.local_vault_id = ?
          AND l.source_vault_id = m.vault_id
          AND l.source_channel_id = m.channel_id
      )
    )
  `).get(messageId, requestedVaultId, requestedVaultId, requestedVaultId) as {
    sourceVaultId: string;
    sourceChannelId: string;
  } | undefined;
  if (!message) throw new Error('Report target does not belong to this vault');
  if (isDirectMessageChannel(db, message.sourceChannelId)) {
    throw new Error('Direct messages are handled with blocking, not reports');
  }
  const sourceVault = vaultRow(db, message.sourceVaultId);
  if (!sourceVault) throw new Error('Vault not found');
  return sourceVault;
}

function usernameFor(db: Db, userId: number): string | null {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(userId) as { username: string } | undefined;
  return row?.username ?? null;
}

export function createContentReport(db: Db, input: {
  vaultId: string;
  reporterUserId: number;
  targetType: unknown;
  targetId: unknown;
  reason: unknown;
  detail?: unknown;
}): VaultReport {
  const requestedVault = vaultRow(db, input.vaultId);
  if (!requestedVault) throw new Error('Vault not found');
  if (!isReportTargetType(input.targetType)) throw new Error('Report target must be a vault, note, message, or member');
  if (!isReportReason(input.reason)) throw new Error(`Reason must be one of: ${REPORT_REASONS.join(', ')}`);
  const targetId = String(input.targetId ?? '').trim();
  if (!targetId) throw new Error('Report target is required');
  const detail = String(input.detail ?? '').trim();
  if (detail.length > REPORT_DETAIL_MAX) throw new Error(`Details must be ${REPORT_DETAIL_MAX} characters or fewer`);

  const vault = input.targetType === 'message'
    ? resolveMessageReportVault(db, requestedVault.id, input.reporterUserId, targetId)
    : requestedVault;
  if (input.targetType !== 'message') {
    assertReportTarget(db, vault, input.reporterUserId, input.targetType, targetId);
  }
  const duplicate = db.prepare(`
    SELECT 1 FROM content_reports
    WHERE vault_id = ? AND target_type = ? AND target_id = ? AND reporter_user_id = ?
  `).get(vault.id, input.targetType, targetId, input.reporterUserId);
  if (duplicate) throw new Error('You have already reported this');
  const recent = db.prepare(`
    SELECT COUNT(*) AS count FROM content_reports
    WHERE reporter_user_id = ? AND created_at > datetime('now', ?)
  `).get(input.reporterUserId, `-${REPORT_RATE_LIMIT.windowMinutes} minutes`) as { count: number };
  if (recent.count >= REPORT_RATE_LIMIT.max) {
    throw new Error('You have sent too many reports recently. Please try again later.');
  }
  const result = db.prepare(`
    INSERT INTO content_reports (vault_id, target_type, target_id, reporter_user_id, reason, detail)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(vault.id, input.targetType, targetId, input.reporterUserId, input.reason, detail);
  const row = reportById(db, Number(result.lastInsertRowid));
  return mapReport(row);
}

type ReportRow = {
  id: number; vaultId: string; targetType: string; targetId: string; targetUsername: string | null;
  reason: string; detail: string; status: string; createdAt: string; reviewedAt: string | null;
};

function reportById(db: Db, reportId: number): ReportRow {
  return db.prepare(`
    SELECT r.id, r.vault_id AS vaultId, r.target_type AS targetType, r.target_id AS targetId,
      (SELECT u.username FROM users u
       WHERE r.target_type = 'member' AND u.id = CAST(r.target_id AS INTEGER)) AS targetUsername,
      r.reason, r.detail, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt
    FROM content_reports r WHERE r.id = ?
  `).get(reportId) as ReportRow;
}

function mapReport(row: ReportRow): VaultReport {
  return {
    id: row.id,
    vaultId: row.vaultId,
    targetType: isReportTargetType(row.targetType) ? row.targetType : 'vault',
    targetId: row.targetId,
    targetUsername: row.targetUsername,
    reason: isReportReason(row.reason) ? row.reason : 'other',
    detail: row.detail,
    status: isReportStatus(row.status) ? row.status : 'open',
    createdAt: row.createdAt,
    reviewedAt: row.reviewedAt,
  };
}

export function listVaultReports(
  db: Db,
  vaultId: string,
  actorUserId: number,
  status: ReportStatus | 'all' = 'open',
): VaultReport[] {
  const vault = vaultRow(db, vaultId);
  if (!vault) throw new Error('Vault not found');
  if (roleOf(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can review reports');
  const rows = db.prepare(`
    SELECT r.id, r.vault_id AS vaultId, r.target_type AS targetType, r.target_id AS targetId,
      (SELECT u.username FROM users u
       WHERE r.target_type = 'member' AND u.id = CAST(r.target_id AS INTEGER)) AS targetUsername,
      r.reason, r.detail, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt
    FROM content_reports r
    WHERE r.vault_id = ? AND r.target_type != 'vault'
      AND NOT (r.target_type = 'member' AND CAST(r.target_id AS INTEGER) = ?)
      AND (? = 'all' OR r.status = ?)
    ORDER BY r.created_at DESC, r.id DESC LIMIT 200
  `).all(vaultId, vault.createdBy, status, status) as ReportRow[];
  return rows.map(mapReport);
}

function applyReportReview(db: Db, reportId: number, actorUserId: number, status: ReportStatus): VaultReport {
  db.prepare(`
    UPDATE content_reports SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?
  `).run(status, actorUserId, reportId);
  return mapReport(reportById(db, reportId));
}

export function reviewVaultReport(
  db: Db,
  vaultId: string,
  reportId: number,
  actorUserId: number,
  action: unknown,
): VaultReport {
  const vault = vaultRow(db, vaultId);
  if (!vault) throw new Error('Vault not found');
  if (roleOf(db, vaultId, actorUserId) !== 'owner') throw new Error('Only the vault owner can review reports');
  if (action !== 'dismiss' && action !== 'resolve') throw new Error('Action must be dismiss or resolve');
  const report = db.prepare(`
    SELECT id FROM content_reports
    WHERE id = ? AND vault_id = ? AND target_type != 'vault'
      AND NOT (target_type = 'member' AND CAST(target_id AS INTEGER) = ?)
  `).get(reportId, vaultId, vault.createdBy) as { id: number } | undefined;
  if (!report) throw new Error('Report not found');
  return applyReportReview(db, report.id, actorUserId, action === 'dismiss' ? 'dismissed' : 'resolved');
}

export function listGlobalReports(
  db: Db,
  actorUserId: number,
  status: ReportStatus | 'all' = 'open',
): GlobalReport[] {
  if (!isServerOwner(db, actorUserId)) throw new Error('Owner only');
  const rows = db.prepare(`
    SELECT r.id, r.vault_id AS vaultId, r.target_type AS targetType, r.target_id AS targetId,
      (SELECT u.username FROM users u
       WHERE r.target_type = 'member' AND u.id = CAST(r.target_id AS INTEGER)) AS targetUsername,
      r.reason, r.detail, r.status, r.created_at AS createdAt, r.reviewed_at AS reviewedAt,
      v.name AS vaultName, COALESCE(v.visibility, 'private') AS vaultVisibility,
      owner.username AS vaultOwnerUsername, r.reporter_user_id AS reporterUserId,
      reporter.username AS reporterUsername
    FROM content_reports r
    JOIN vaults v ON v.id = r.vault_id
    JOIN users owner ON owner.id = v.created_by
    JOIN users reporter ON reporter.id = r.reporter_user_id
    WHERE (? = 'all' OR r.status = ?)
    ORDER BY r.created_at DESC, r.id DESC LIMIT 200
  `).all(status, status) as Array<ReportRow & {
    vaultName: string; vaultVisibility: string; vaultOwnerUsername: string;
    reporterUserId: number; reporterUsername: string;
  }>;
  return rows.map((row) => ({
    ...mapReport(row),
    vaultName: row.vaultName,
    vaultVisibility: row.vaultVisibility,
    vaultOwnerUsername: row.vaultOwnerUsername,
    reporterUserId: row.reporterUserId,
    reporterUsername: row.reporterUsername,
  }));
}

export function reviewGlobalReport(
  db: Db,
  reportId: number,
  actorUserId: number,
  action: unknown,
): { report: VaultReport; unlistedVaultId: string | null } {
  if (!isServerOwner(db, actorUserId)) throw new Error('Owner only');
  if (action !== 'dismiss' && action !== 'resolve' && action !== 'unlist') {
    throw new Error('Action must be dismiss, resolve, or unlist');
  }
  const report = db.prepare('SELECT id, vault_id AS vaultId FROM content_reports WHERE id = ?')
    .get(reportId) as { id: number; vaultId: string } | undefined;
  if (!report) throw new Error('Report not found');
  if (action !== 'unlist') {
    return {
      report: applyReportReview(db, report.id, actorUserId, action === 'dismiss' ? 'dismissed' : 'resolved'),
      unlistedVaultId: null,
    };
  }
  const vault = vaultRow(db, report.vaultId);
  if (!vault) throw new Error('Vault not found');
  if (vault.visibility !== 'public') throw new Error('That vault is not publicly listed');
  db.transaction(() => {
    db.prepare("UPDATE vaults SET visibility = 'private' WHERE id = ?").run(vault.id);
    db.prepare(`
      UPDATE public_vault_join_requests
      SET status = 'rejected', reviewed_by = ?, updated_at = datetime('now')
      WHERE vault_id = ? AND status = 'pending'
    `).run(actorUserId, vault.id);
    db.prepare(`
      UPDATE content_reports SET status = 'resolved', reviewed_by = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).run(actorUserId, report.id);
  })();
  return { report: mapReport(reportById(db, report.id)), unlistedVaultId: vault.id };
}
