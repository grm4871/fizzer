import { prisma } from '../../data-utils.js';

type SpaceRole = 'monarch' | 'custodian' | 'member' | null;

/**
 * Get a user's role in a space. Returns 'monarch', 'custodian', 'member', or null.
 */
export async function getSpaceRole(spaceId: string, userId: string): Promise<SpaceRole> {
  const space = await prisma.spaces.findUnique({ where: { id: spaceId }, select: { monarch_id: true } });
  if (!space) return null;
  if (space.monarch_id === userId) return 'monarch';
  const membership = await prisma.space_members.findUnique({
    where: { space_id_user_id: { space_id: spaceId, user_id: userId } },
    select: { role: true }
  });
  if (!membership) return null;
  return membership.role as SpaceRole;
}

/**
 * Check if a user is a member of a space (any role).
 */
export async function isSpaceMember(spaceId: string, userId: string): Promise<boolean> {
  const role = await getSpaceRole(spaceId, userId);
  return role !== null;
}

/**
 * Check if a user is the monarch or custodian of a space.
 */
export async function isSpaceMonarchOrCustodian(spaceId: string, userId: string): Promise<boolean> {
  const role = await getSpaceRole(spaceId, userId);
  return role === 'monarch' || role === 'custodian';
}

/**
 * Get the space role for a user by genus_id (looks up the genus's parent space).
 */
export async function getSpaceRoleByGenusId(genusId: string, userId: string): Promise<SpaceRole> {
  const genus = await prisma.genus.findUnique({ where: { id: genusId }, select: { space_id: true } });
  if (!genus?.space_id) return null;
  return getSpaceRole(genus.space_id, userId);
}

export async function getPublicSpaces(limit: number = 50, offset: number = 0) {
  return prisma.spaces.findMany({
    where: {
      is_profile: false,
      is_collection: false
    },
    include: {
      monarch: { select: { id: true, username: true, displayName: true, color: true } },
      _count: { select: { members: true, items: true } }
    },
    orderBy: { created_at: 'desc' },
    take: limit,
    skip: offset
  });
}

export async function getUserProfileSpaceId(userId: string): Promise<string | null> {
  const space = await prisma.spaces.findFirst({
    where: { monarch_id: userId, is_profile: true },
    select: { id: true }
  });
  return space?.id ?? null;
}

export async function getUserSavedSpaceId(userId: string): Promise<string | null> {
  const space = await prisma.spaces.findFirst({
    where: { monarch_id: userId, is_collection: true },
    select: { id: true }
  });
  return space?.id ?? null;
}
