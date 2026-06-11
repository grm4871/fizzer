import { prisma } from './prisma-client.js';
import { Prisma } from '@prisma/client';
import { getSpaceRoleByGenusId, isSpaceMonarchOrCustodian } from '../routes/utils/spaces_and_sidebar.js';

const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === 'true';

type PermsMode = 'whitelist' | 'blacklist';

// ===== ENTITY CONFIG =====

interface EntityPermConfig {
  entityName: string;
  creatorLabel: string;
  creatorBypassPerms: string[]; // which perm types the creator always has
}

const NETDOC_CONFIG: EntityPermConfig = {
  entityName: 'Netdoc', creatorLabel: 'creator',
  creatorBypassPerms: ['read', 'write'], // comment can be self-revoked
};

// ===== GENERIC PERMISSION FUNCTIONS =====

function resolvePermissions(
  perms: { user_id: string | null; is_blacklist: boolean }[],
  userId: string | null,
  mode: PermsMode
): boolean {
  if (mode === 'blacklist') {
    if (userId && perms.find(p => p.user_id === userId && p.is_blacklist)) return false;
    return true;
  } else {
    if (userId && perms.find(p => p.user_id === userId && !p.is_blacklist)) return true;
    return false;
  }
}

async function _verifyCreator(config: EntityPermConfig, entityId: string, requesterId: string): Promise<any> {
  const result = await prisma.genus.findUnique({ where: { id: entityId } });
  if (!result) throw new Error(`${config.entityName} not found`);
  if (result.creator_id === requesterId) return result;
  // Custodians of parent space can also modify permissions
  const role = result.space_id ? await getSpaceRoleByGenusId(entityId, requesterId) : null;
  if (role === 'monarch' || role === 'custodian') return result;
  throw new Error(`Only ${config.creatorLabel} can modify permissions`);
}

async function _getPermsMode(config: EntityPermConfig, entityId: string): Promise<{ read: PermsMode; comment: PermsMode; write: PermsMode }> {
  const result = await prisma.genus.findUnique({
    where: { id: entityId },
    select: { perms_mode_read: true, perms_mode_comment: true, perms_mode_write: true }
  });
  if (!result) throw new Error(`${config.entityName} not found`);
  return { read: result.perms_mode_read, comment: result.perms_mode_comment, write: result.perms_mode_write };
}

async function _setPermsMode(config: EntityPermConfig, entityId: string, modes: { read?: PermsMode; comment?: PermsMode; write?: PermsMode }): Promise<void> {
  const data: any = {};
  if (modes.read !== undefined) data.perms_mode_read = modes.read;
  if (modes.comment !== undefined) data.perms_mode_comment = modes.comment;
  if (modes.write !== undefined) data.perms_mode_write = modes.write;
  await prisma.genus.update({ where: { id: entityId }, data });
}

async function _checkPermission(config: EntityPermConfig, entityId: string, userId: string | null, permissionType: string): Promise<boolean> {
  const entity = await prisma.genus.findUnique({
    where: { id: entityId },
    select: { creator_id: true, space_id: true, perms_mode_read: true, perms_mode_comment: true, perms_mode_write: true }
  });
  if (!entity) return false;

  // No chat row → no comment permission (regardless of role)
  if (permissionType === 'comment') {
    const hasChat = await prisma.chat.findUnique({ where: { id: entityId }, select: { id: true } });
    if (!hasChat) return false;
  }

  if (userId === entity.creator_id && config.creatorBypassPerms.includes(permissionType)) return true;

  // Custodians and space monarchs always have full access
  if (userId && entity.space_id) {
    const spaceRole = await getSpaceRoleByGenusId(entityId, userId);
    if (spaceRole === 'monarch' || spaceRole === 'custodian') return true;
  }

  const mode: PermsMode = permissionType === 'read' ? entity.perms_mode_read
    : permissionType === 'comment' ? entity.perms_mode_comment
    : entity.perms_mode_write;

  const permissions = await prisma.genus_permission.findMany({
    where: { genus_id: entityId, permission_type: permissionType },
    select: { user_id: true, is_blacklist: true }
  });

  if (DEBUG) console.log(`[PermCheck] ${config.entityName} id=${entityId}, userId=${userId}, type=${permissionType}, mode=${mode}, creator=${entity.creator_id}, perms=${JSON.stringify(permissions)}`);

  const result = resolvePermissions(permissions, userId, mode);
  if (DEBUG && !result) console.log(`[PermCheck] DENIED for ${config.entityName} id=${entityId}, userId=${userId}`);
  return result;
}

async function _grantPermission(config: EntityPermConfig, entityId: string, creatorId: string, permissionType: string, targetUserId: string | null, isBlacklist: boolean = false): Promise<any> {
  await _verifyCreator(config, entityId, creatorId);

  try {
    const result = await prisma.genus_permission.create({
      data: {
        genus_id: entityId,
        permission_type: permissionType,
        user_id: targetUserId,
        is_blacklist: isBlacklist
      }
    });
    return result;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return null;
    }
    throw err;
  }
}

async function _revokePermission(config: EntityPermConfig, entityId: string, creatorId: string, permissionType: string, targetUserId: string | null, isBlacklist: boolean = false): Promise<void> {
  await _verifyCreator(config, entityId, creatorId);
  if (targetUserId) {
    await prisma.genus_permission.deleteMany({
      where: { genus_id: entityId, permission_type: permissionType, user_id: targetUserId, is_blacklist: isBlacklist }
    });
  } else {
    await prisma.genus_permission.deleteMany({
      where: { genus_id: entityId, permission_type: permissionType, user_id: null, is_blacklist: isBlacklist }
    });
  }
}

async function _revokeAllPermissions(config: EntityPermConfig, entityId: string, creatorId: string, permissionType: string): Promise<void> {
  await _verifyCreator(config, entityId, creatorId);
  await prisma.genus_permission.deleteMany({
    where: { genus_id: entityId, permission_type: permissionType }
  });
}

async function _getPermissions(config: EntityPermConfig, entityId: string, requesterId: string): Promise<any[]> {
  await _verifyCreator(config, entityId, requesterId);
  const permissions = await prisma.genus_permission.findMany({
    where: { genus_id: entityId },
    select: { id: true, genus_id: true, permission_type: true, user_id: true, is_blacklist: true, created_at: true }
  });
  return permissions.map(p => ({ ...p, id: p.id.toString() }));
}

// ===== NETDOC WRAPPERS =====

export const verifyNetdocCreator = (netdocId: string, requesterId: string) =>
  _verifyCreator(NETDOC_CONFIG, netdocId, requesterId);

export const checkNetdocPermission = (netdocId: string, userId: string | null, permissionType: string) =>
  _checkPermission(NETDOC_CONFIG, netdocId, userId, permissionType);

export const getNetdocPermsMode = (netdocId: string) => _getPermsMode(NETDOC_CONFIG, netdocId);
export const setNetdocPermsMode = (netdocId: string, modes: { read?: PermsMode; comment?: PermsMode; write?: PermsMode }) => _setPermsMode(NETDOC_CONFIG, netdocId, modes);

export const grantNetdocPermission = (netdocId: string, creatorId: string, permissionType: string, targetUserId: string | null, isBlacklist: boolean = false) =>
  _grantPermission(NETDOC_CONFIG, netdocId, creatorId, permissionType, targetUserId, isBlacklist);

export const revokeNetdocPermission = (netdocId: string, creatorId: string, permissionType: string, targetUserId: string | null, isBlacklist: boolean = false) =>
  _revokePermission(NETDOC_CONFIG, netdocId, creatorId, permissionType, targetUserId, isBlacklist);

export const revokeAllNetdocPermissions = (netdocId: string, creatorId: string, permissionType: string) =>
  _revokeAllPermissions(NETDOC_CONFIG, netdocId, creatorId, permissionType);

export const getNetdocPermissions = (netdocId: string, requesterId: string) =>
  _getPermissions(NETDOC_CONFIG, netdocId, requesterId);

// ===== NETDOC-SPECIFIC FUNCTIONS =====

/**
 * Batch filter: return the subset of netdocIds that the viewer can read.
 */
export async function filterReadableNetdocIds(netdocIds: string[], viewerId: string | null): Promise<Set<string>> {
  if (netdocIds.length === 0) return new Set();

  const genusList = await prisma.genus.findMany({
    where: { id: { in: netdocIds } },
    select: { id: true, creator_id: true, space_id: true, perms_mode_read: true }
  });
  const modeMap = new Map(genusList.map(n => [n.id, n]));

  const readPerms = await prisma.genus_permission.findMany({
    where: { genus_id: { in: netdocIds }, permission_type: 'read' },
    select: { genus_id: true, user_id: true, is_blacklist: true }
  });
  const permsMap = new Map<string, typeof readPerms>();
  for (const p of readPerms) {
    if (!permsMap.has(p.genus_id)) permsMap.set(p.genus_id, []);
    permsMap.get(p.genus_id)!.push(p);
  }

  // Batch fetch custodian/monarch status for all unique space_ids
  const spaceIds = [...new Set(genusList.map(n => n.space_id).filter(Boolean))] as string[];
  const custodianSpaces = new Set<string>();
  if (viewerId && spaceIds.length > 0) {
    const memberships = await prisma.space_members.findMany({
      where: { user_id: viewerId, space_id: { in: spaceIds }, role: { in: ['monarch', 'custodian'] } },
      select: { space_id: true }
    });
    for (const m of memberships) custodianSpaces.add(m.space_id);
    // Also check monarch_id directly
    const monarchSpaces = await prisma.spaces.findMany({
      where: { id: { in: spaceIds }, monarch_id: viewerId },
      select: { id: true }
    });
    for (const s of monarchSpaces) custodianSpaces.add(s.id);
  }

  const visible = new Set<string>();
  for (const ndId of netdocIds) {
    const nd = modeMap.get(ndId);
    if (!nd) continue;
    if (viewerId && nd.creator_id === viewerId) { visible.add(ndId); continue; }
    if (viewerId && nd.space_id && custodianSpaces.has(nd.space_id)) { visible.add(ndId); continue; }
    if (resolvePermissions(permsMap.get(ndId) || [], viewerId, nd.perms_mode_read)) visible.add(ndId);
  }
  return visible;
}

export async function checkNetdocPermissionWithInheritance(
  netdocId: string,
  userId: string | null,
  permissionType: string
): Promise<boolean> {
  return checkNetdocPermission(netdocId, userId, permissionType);
}

// ===== SPACE PERMISSION FUNCTIONS =====

/**
 * Check if a user has a specific permission on a space.
 * Similar to checkNetdocPermission but for spaces.
 */
export async function checkSpacePermission(
  spaceId: string,
  userId: string | null,
  permissionType: string
): Promise<boolean> {
  const space = await prisma.spaces.findUnique({
    where: { id: spaceId },
    select: {
      monarch_id: true,
      perms_mode_read: true,
      perms_mode_comment: true,
      perms_mode_write: true
    }
  });

  if (!space) return false;

  // Monarch always has full access
  if (userId && userId === space.monarch_id) return true;

  // Custodians always have full access
  if (userId) {
    const role = await isSpaceMonarchOrCustodian(spaceId, userId);
    if (role) return true;
  }

  const mode: PermsMode = permissionType === 'read' ? space.perms_mode_read
    : permissionType === 'comment' ? space.perms_mode_comment
    : space.perms_mode_write;

  const permissions = await prisma.space_permission.findMany({
    where: { space_id: spaceId, permission_type: permissionType },
    select: { user_id: true, is_blacklist: true }
  });

  if (DEBUG) console.log(`[SpacePermCheck] space=${spaceId}, userId=${userId}, type=${permissionType}, mode=${mode}, monarch=${space.monarch_id}, perms=${JSON.stringify(permissions)}`);

  const result = resolvePermissions(permissions, userId, mode);
  if (DEBUG && !result) console.log(`[SpacePermCheck] DENIED for space=${spaceId}, userId=${userId}`);
  return result;
}
