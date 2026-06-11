import express, { Request, Response } from 'express';
import { authenticateToken } from '../../middleware/auth.js';
import { getIO } from '../../socket.js';

type PermsMode = 'whitelist' | 'blacklist';

interface PermsRouterConfig {
  idParam: string;
  socketPrefix: string;
  socketEntityKey: string;
  emitSocketEvents?: boolean;
  getPermsMode: (id: string) => Promise<{ read: PermsMode; comment: PermsMode; write: PermsMode }>;
  setPermsMode: (id: string, modes: { read?: PermsMode; comment?: PermsMode; write?: PermsMode }) => Promise<void>;
  verifyOwner: (id: string, userId: string) => Promise<any>;
  getPermissions: (id: string, userId: string) => Promise<any[]>;
  grantPermission: (id: string, ownerId: string, permType: string, targetUserId: string | null, isBlacklist: boolean) => Promise<any>;
  revokePermission: (id: string, ownerId: string, permType: string, targetUserId: string | null, isBlacklist?: boolean) => Promise<void>;
  revokeAllPermissions: (id: string, ownerId: string, permType: string) => Promise<void>;
  beforeGrant?: (entityId: string, userId: string, body: any) => Promise<any>;
  afterGrant?: (entityId: string, userId: string, permissionType: string, targetUserId: string | null, isBlacklist: boolean, context: any) => Promise<void>;
  serializeGrantResult?: (result: any) => any;
}

/**
 * Normalize targetUserId from query params or body.
 * Handles 'null' string, actual null, and valid uuid strings.
 */
export function resolveTargetUserId(raw: any): string | null {
  if (raw === 'null' || raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw;
  return null;
}

/**
 * Validate crockford base32 ID format. Returns the id or null if invalid.
 */
export function validateId(id: string | undefined, res: Response): string | null {
  // Crockford base32: 0-9, A-Z excluding I, L, O, U
  if (!id || !/^[0-9A-HJ-NP-TV-Za-hj-np-tv-z]+$/.test(id)) {
    res.status(400).json({ error: 'Invalid ID format' });
    return null;
  }
  return id;
}

/**
 * Shared catch handler for permission routes.
 * Checks for "Only creator/owner" (403) and "not found" (404), else 500.
 */
export function handlePermissionError(err: any, res: Response, label: string): void {
  if (err.message?.toLowerCase().includes('only creator') || err.message?.toLowerCase().includes('only owner')) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err.message?.toLowerCase().includes('not found')) {
    res.status(404).json({ error: err.message });
    return;
  }
  console.error(`${label} error:`, err);
  res.status(500).json({ error: 'server_error' });
}

function emitPermChange(config: PermsRouterConfig, id: string) {
  if (config.emitSocketEvents === false) return;
  const io = getIO();
  if (io) io.to(`${config.socketPrefix}:${id}`).emit(`${config.socketPrefix}:permissions-changed`, { [config.socketEntityKey]: id });
}

export function createPermsRouter(config: PermsRouterConfig) {
  const router = express.Router();
  const param = config.idParam;

  router.get(`/:${param}/perms-mode`, authenticateToken, async (req: Request, res: Response) => {
    try {
      const id = validateId(req.params[param], res);
      if (!id) return;
      res.json(await config.getPermsMode(id));
    } catch (err: any) { handlePermissionError(err, res, `Get ${config.socketPrefix} perms mode`); }
  });

  router.patch(`/:${param}/perms-mode`, authenticateToken, async (req: Request, res: Response) => {
    try {
      const id = validateId(req.params[param], res);
      if (!id) return;
      await config.verifyOwner(id, req.user!.id);

      const { read, write } = req.body;
      const changes: { read?: PermsMode; comment?: PermsMode; write?: PermsMode } = {};
      if (read) changes.read = read;
      if (write) changes.write = write;

      // Trigger handles cascade
      await config.setPermsMode(id, changes);
      res.json(await config.getPermsMode(id));
      emitPermChange(config, id);
    } catch (err: any) { handlePermissionError(err, res, `Update ${config.socketPrefix} perms mode`); }
  });

  router.get(`/:${param}/permissions`, authenticateToken, async (req: Request, res: Response) => {
    try {
      const id = validateId(req.params[param], res);
      if (!id) return;
      res.json(await config.getPermissions(id, req.user!.id));
    } catch (err: any) { handlePermissionError(err, res, `Get ${config.socketPrefix} permissions`); }
  });

  router.post(`/:${param}/permissions`, authenticateToken, async (req: Request, res: Response) => {
    try {
      const id = validateId(req.params[param], res);
      if (!id) return;
      const { permissionType, targetUserId, isBlacklist } = req.body;
      const userId = req.user!.id;

      if (!permissionType) return res.status(400).json({ error: 'permissionType is required' });
      if (permissionType === 'comment') return res.status(410).json({ error: 'Comment permissions have been removed' });

      // Creator/Monarch cannot blacklist themselves for read or write (comment is allowed)
      if (isBlacklist && targetUserId === userId && (permissionType === 'read' || permissionType === 'write')) {
        return res.status(403).json({ error: 'Cannot blacklist yourself for read or write permissions' });
      }

      const context = config.beforeGrant ? await config.beforeGrant(id, userId, req.body) : null;

      // Trigger handles cascade
      const result = await config.grantPermission(id, userId, permissionType, targetUserId || null, isBlacklist === true);

      if (config.afterGrant) await config.afterGrant(id, userId, permissionType, targetUserId || null, isBlacklist === true, context);

      res.status(201).json(config.serializeGrantResult ? config.serializeGrantResult(result) : result);
      emitPermChange(config, id);
    } catch (err: any) { handlePermissionError(err, res, `Grant ${config.socketPrefix} permission`); }
  });

  router.delete(`/:${param}/permissions`, authenticateToken, async (req: Request, res: Response) => {
    try {
      const id = validateId(req.params[param], res);
      if (!id) return;
      const { permissionType, targetUserId } = req.query;
      const userId = req.user!.id;

      if (!permissionType || typeof permissionType !== 'string') return res.status(400).json({ error: 'permissionType is required' });
      if (permissionType === 'comment') return res.status(410).json({ error: 'Comment permissions have been removed' });

      const resolved = resolveTargetUserId(targetUserId);

      // Creator/Monarch cannot revoke their own read or write perms, but can revoke comment
      // (also enforced at DB layer via protect_creator_perm trigger)
      if (resolved === userId && (permissionType === 'read' || permissionType === 'write')) {
        return res.status(403).json({ error: 'Cannot revoke your own read or write permissions' });
      }

      // Trigger handles cascade + creator/monarch protection
      if (resolved) await config.revokePermission(id, userId, permissionType, resolved);
      else await config.revokeAllPermissions(id, userId, permissionType);

      res.json({ success: true });
      emitPermChange(config, id);
    } catch (err: any) { handlePermissionError(err, res, `Revoke ${config.socketPrefix} permission`); }
  });

  return router;
}

// ===== SPACE PERMISSION HELPERS =====

import { prisma } from '../../data-utils.js';
import { Prisma } from '@prisma/client';
import { isSpaceMonarchOrCustodian } from './spaces_and_sidebar.js';

export async function verifySpaceMonarch(spaceId: string, requesterId: string): Promise<any> {
  if (!await isSpaceMonarchOrCustodian(spaceId, requesterId)) {
    throw new Error('Only space monarch or custodian can modify permissions');
  }
  return prisma.spaces.findUnique({ where: { id: spaceId } });
}

export async function getSpacePermsMode(spaceId: string): Promise<{ read: PermsMode; comment: PermsMode; write: PermsMode }> {
  const [row] = await prisma.$queryRaw<any[]>`
    SELECT perms_mode_read AS read, perms_mode_write AS write, perms_mode_comment AS comment
    FROM spaces WHERE id = ${spaceId}
  `;
  if (!row) throw new Error('Space not found');
  return row;
}

export async function setSpacePermsMode(spaceId: string, modes: { read?: PermsMode; comment?: PermsMode; write?: PermsMode }): Promise<void> {
  const sets: string[] = [];
  const vals: any[] = [];
  if (modes.read) { sets.push('perms_mode_read'); vals.push(modes.read); }
  if (modes.comment) { sets.push('perms_mode_comment'); vals.push(modes.comment); }
  if (modes.write) { sets.push('perms_mode_write'); vals.push(modes.write); }
  for (let i = 0; i < sets.length; i++) {
    await prisma.$executeRawUnsafe(
      `UPDATE spaces SET ${sets[i]} = $1::perms_mode WHERE id = $2`,
      vals[i], spaceId
    );
  }
}

export async function getSpacePermissions(spaceId: string, requesterId: string): Promise<any[]> {
  await verifySpaceMonarch(spaceId, requesterId);
  return await prisma.$queryRaw<any[]>`
    SELECT id::text, space_id, permission_type, user_id, is_blacklist, created_at
    FROM space_permission WHERE space_id = ${spaceId}
  `;
}

export async function grantSpacePermission(spaceId: string, monarchId: string, permissionType: string, targetUserId: string | null, isBlacklist: boolean = false): Promise<any> {
  await verifySpaceMonarch(spaceId, monarchId);
  const result = await prisma.$queryRaw<any[]>`
    INSERT INTO space_permission (space_id, permission_type, user_id, is_blacklist)
    VALUES (${spaceId}, ${permissionType}, ${targetUserId || null}::uuid, ${isBlacklist})
    ON CONFLICT DO NOTHING
    RETURNING id::text, space_id, permission_type, user_id, is_blacklist, created_at
  `;
  return result[0] || null;
}

export async function revokeSpacePermission(spaceId: string, monarchId: string, permissionType: string, targetUserId: string | null, isBlacklist: boolean = false): Promise<void> {
  await verifySpaceMonarch(spaceId, monarchId);
  if (targetUserId) {
    await prisma.$executeRaw`
      DELETE FROM space_permission
      WHERE space_id = ${spaceId} AND permission_type = ${permissionType}
        AND user_id = ${targetUserId}::uuid AND is_blacklist = ${isBlacklist}
    `;
  } else {
    await prisma.$executeRaw`
      DELETE FROM space_permission
      WHERE space_id = ${spaceId} AND permission_type = ${permissionType}
        AND user_id IS NULL AND is_blacklist = ${isBlacklist}
    `;
  }
}

export async function revokeAllSpacePermissions(spaceId: string, monarchId: string, permissionType: string): Promise<void> {
  await verifySpaceMonarch(spaceId, monarchId);
  await prisma.$executeRaw`
    DELETE FROM space_permission
    WHERE space_id = ${spaceId} AND permission_type = ${permissionType}
  `;
}
