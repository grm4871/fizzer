import express, { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../data-utils.js';
import { formatSidebarItem, fetchSpaceSidebarData } from '../utils/sidebar.js';
import { getUserProfileSpaceId, getUserSavedSpaceId, getPublicSpaces, isSpaceMonarchOrCustodian } from '../utils/spaces_and_sidebar.js';
import { handlePermissionError } from '../utils/permissions.js';
import { authenticateToken } from '../../middleware/auth.js';
import { filterReadableNetdocIds, checkNetdocPermission } from '../../data/permissions.js';


const router = express.Router();

/**
 * Get all public spaces (for explore/discovery)
 * NOTE: This route must come BEFORE /:id to avoid being caught by the param route
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const spaces = await getPublicSpaces(Number(limit), Number(offset));

    res.json(spaces.map((s: any) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      avatarUrl: s.avatar_url,
      isPersonal: s.is_profile,
      monarch: s.monarch,
      memberCount: s._count.members,
      itemCount: s._count.items,
      createdAt: s.created_at
    })));
  } catch (e) {
    console.error('List spaces error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Get spaces a user is a member of (excludes personal spaces like profile/saved)
 * NOTE: Must come before /:id route
 */
router.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const memberships = await prisma.space_members.findMany({
      where: {
        user_id: userId,
        space: { is_profile: false, is_collection: false }
      },
      include: {
        space: {
          include: {
            monarch: {
              select: {
                id: true,
                username: true,
                displayName: true,
                color: true
              }
            },
            _count: {
              select: {
                members: true,
                items: true
              }
            }
          }
        }
      }
    });

    res.json(memberships.map((m: any) => ({
      id: m.space.id,
      name: m.space.name,
      description: m.space.description,
      avatarUrl: m.space.avatar_url,
      isPersonal: m.space.is_profile,
      monarch: m.space.monarch,
      memberCount: m.space._count.members,
      itemCount: m.space._count.items,
      role: m.role,
      isMonarch: m.space.monarch_id === userId
    })));
  } catch (e) {
    console.error('Get user spaces error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Get user's personal spaces (profile and collections)
 * NOTE: Must come before /:id route
 */
router.get('/personal/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const [profileSpaceId, savedSpaceId] = await Promise.all([
      getUserProfileSpaceId(userId),
      getUserSavedSpaceId(userId)
    ]);

    if (!profileSpaceId && !savedSpaceId) {
      return res.status(404).json({ error: 'Personal spaces not found' });
    }

    const ownerSelect = { monarch: { select: { id: true, username: true, displayName: true, color: true } } };
    const [profileSpace, collectionsSpace] = await Promise.all([
      profileSpaceId ? prisma.spaces.findUnique({ where: { id: profileSpaceId }, include: ownerSelect }) : null,
      savedSpaceId ? prisma.spaces.findUnique({ where: { id: savedSpaceId }, include: ownerSelect }) : null
    ]);

    const formatSpace = (space: any) => space ? {
      id: space.id,
      name: space.name,
      description: space.description,
      avatarUrl: space.avatar_url,
      isPersonal: space.is_profile,
      jacket: space.jacket,
      monarch: space.monarch
    } : null;

    res.json({
      profileSpace: formatSpace(profileSpace),
      collectionsSpace: formatSpace(collectionsSpace)
    });
  } catch (e) {
    console.error('Get personal spaces error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Create a new space
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { userId, name, description, avatarUrl } = req.body;

    if (!userId || !name) {
      return res.status(400).json({ error: 'userId and name are required' });
    }

    const [result] = await prisma.$queryRaw<{ create_space: string }[]>`
      SELECT create_space(${name}, ${userId}::uuid, ${description || ''})
    `;
    const newId = result.create_space;

    if (avatarUrl) {
      await prisma.$executeRaw`UPDATE spaces SET avatar_url = ${avatarUrl} WHERE id = ${newId}`;
    }

    const monarch = await prisma.profile.findUnique({
      where: { id: userId },
      select: { id: true, username: true, displayName: true, color: true }
    });

    res.json({
      id: newId,
      name,
      description: description || '',
      avatarUrl: avatarUrl || null,
      isPersonal: false,
      monarch
    });
  } catch (e) {
    console.error('Create space error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Get a space's sidebar structure (folders and items)
 * NOTE: Must come before /:id route
 */
router.get('/:id/sidebar', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    const space = await prisma.spaces.findUnique({ where: { id } });

    if (!space) {
      return res.status(404).json({ error: 'Space not found' });
    }

    if (space.is_collection && space.monarch_id !== (userId as string || null)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { items, netdocMap } = await fetchSpaceSidebarData(id, userId as string);
    const genusIds = items.map((i: any) => i.genus_id);

    // For profile spaces, find the monarch's gallery so we can exclude it from the sidebar
    let galleryId: string | null = null;
    if (space.is_profile && space.monarch_id) {
      const monarch = await prisma.profile.findUnique({ where: { id: space.monarch_id }, select: { gallery: true } });
      galleryId = monarch?.gallery ?? null;
    }

    let extraItems: any[] = [];
    if (space.is_profile && space.jacket) {
      const jacketRows = await prisma.$queryRaw<any[]>`
        SELECT content FROM netdoc WHERE id = ${space.jacket}
      `;

      if (jacketRows[0]?.content) {
        const jacketIds = [...jacketRows[0].content.matchAll(/\/netdoc\/([^\s\n]+)/g)]
          .map((m: any) => m[1])
          .filter((id: string) => !genusIds.includes(id));

        if (jacketIds.length > 0) {
          // Fetch genus + netdoc data for jacket-linked items
          const jacketNetdocs = await prisma.$queryRaw<any[]>`
            SELECT g.id, g.name, n.is_jacket
            FROM genus g
            JOIN netdoc n ON n.id = g.id
            WHERE g.id = ANY(${jacketIds}::text[]) AND n.is_jacket = FALSE
          `;

          const maxOrder = items.length > 0
            ? Math.max(...items.map((i: any) => i.order_key ?? 0))
            : 0;

          extraItems = jacketNetdocs.map((nd: any, idx: number) => ({
            id: `profile-extra-${nd.id}`,
            genus_id: nd.id,
            folder_id: null,
            order_key: maxOrder + idx + 1
          }));

          for (const nd of jacketNetdocs) {
            netdocMap.set(nd.id, nd);
          }
        }
      }
    }

    // Filter items by genus-level read permissions for the viewing user
    // Also exclude the monarch's gallery from profile space sidebars
    const allItems = [...items, ...extraItems].filter((i: any) => !galleryId || i.genus_id !== galleryId);
    const allGenusIds = allItems.map((i: any) => i.genus_id).filter(Boolean);
    const visibleNetdocIds = await filterReadableNetdocIds(allGenusIds, userId as string || null);
    const filteredItems = allItems.filter((i: any) => visibleNetdocIds.has(i.genus_id));

    res.json({
      name: space.name,
      folders: [],
      items: filteredItems.map((i: any) => formatSidebarItem(i, netdocMap))
    });
  } catch (e) {
    console.error('Get space sidebar error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Get a space by ID with full details
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    const space = await prisma.spaces.findUnique({
      where: { id },
      include: {
        monarch: {
          select: {
            id: true,
            username: true,
            displayName: true,
            color: true
          }
        },
        members: {
          include: {
            profile: {
              select: {
                id: true,
                username: true,
                displayName: true,
                color: true
              }
            }
          }
        }
      }
    });

    if (!space) {
      return res.status(404).json({ error: 'Space not found' });
    }

    if (space.is_collection && space.monarch_id !== (userId as string || null)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const userIdStr = userId as string || null;
    const canWrite = userIdStr ? await isSpaceMonarchOrCustodian(id, userIdStr) : false;

    // Check jacket permissions (mode switcher uses jacket's canWrite, not space's)
    let jacketCanWrite = false;
    if (space.jacket && userIdStr) {
      jacketCanWrite = await checkNetdocPermission(space.jacket, userIdStr, 'write');
    }

    // Fetch space-level perms_mode via raw SQL (not in Prisma schema)
    const [spacePerms] = await prisma.$queryRaw<any[]>`
      SELECT perms_mode_read, perms_mode_write, perms_mode_comment, deleted_creator
      FROM spaces WHERE id = ${id}
    `;

    res.json({
      id: space.id,
      name: space.name,
      description: space.description,
      avatarUrl: space.avatar_url,
      isPersonal: space.is_profile,
      jacket: space.jacket || null,
      canWrite,
      jacketCanWrite,
      deletedCreator: spacePerms?.deleted_creator || false,
      permsModeRead: spacePerms?.perms_mode_read || 'blacklist',
      permsModeWrite: spacePerms?.perms_mode_write || 'whitelist',
      monarch: space.monarch,
      members: space.members.map((m: any) => ({
        userId: m.user_id,
        role: m.role,
        joinedAt: m.joined_at,
        profile: m.profile
      }))
    });
  } catch (e) {
    console.error('Get space error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Update a space
 */
router.patch('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { name, description, avatarUrl } = req.body;

    const space = await prisma.spaces.findUnique({ where: { id } });
    if (!space) return res.status(404).json({ error: 'Space not found' });
    if (!await isSpaceMonarchOrCustodian(id, userId)) {
      return res.status(403).json({ error: 'Only monarch or custodian can modify space' });
    }

    const updated = await prisma.spaces.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
        ...(avatarUrl !== undefined && { avatar_url: avatarUrl }),
        updated_at: new Date()
      }
    });

    res.json({
      id: updated.id,
      name: updated.name,
      description: updated.description,
      avatarUrl: updated.avatar_url,
      isPersonal: updated.is_profile
    });
  } catch (e: any) {
    handlePermissionError(e, res, 'Update space');
  }
});

/**
 * Delete a space
 */
router.delete('/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;

    const space = await prisma.spaces.findUnique({ where: { id } });
    if (!space) return res.status(404).json({ error: 'Space not found' });
    if (!await isSpaceMonarchOrCustodian(id, userId)) {
      return res.status(403).json({ error: 'Only monarch or custodian can delete space' });
    }

    // Don't allow deleting profile or collection spaces
    if (space.is_profile || space.is_collection) {
      return res.status(400).json({ error: 'Cannot delete profile or collection spaces' });
    }

    const jacketGenusId = (space as any).jacket;

    await prisma.spaces.delete({ where: { id } });

    // Delete the jacket genus after the space is gone (cascades to netdoc via FK)
    if (jacketGenusId) {
      await prisma.$executeRaw`DELETE FROM genus WHERE id = ${jacketGenusId}`;
    }

    res.json({ success: true });
  } catch (e: any) {
    handlePermissionError(e, res, 'Delete space');
  }
});

// ============================================================================
// SPACE MEMBER MANAGEMENT
// ============================================================================

router.post('/:id/members', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const userId = req.user!.id;
    const { targetUserId, role } = req.body;

    if (!targetUserId) return res.status(400).json({ error: 'targetUserId is required' });

    const space = await prisma.spaces.findUnique({ where: { id } });
    if (!space) return res.status(404).json({ error: 'Space not found' });
    if (!await isSpaceMonarchOrCustodian(id, userId)) {
      return res.status(403).json({ error: 'Only monarch or custodian can add members' });
    }

    // Only monarch can add custodians
    const memberRole = role || 'member';
    if (memberRole === 'custodian' && space.monarch_id !== userId) {
      return res.status(403).json({ error: 'Only the monarch can appoint custodians' });
    }

    // Trigger enforces custodian limit (max 2)
    const member = await prisma.space_members.create({
      data: { space_id: id, user_id: targetUserId, role: memberRole },
      include: { profile: { select: { id: true, username: true, displayName: true, color: true } } }
    });

    res.status(201).json({
      userId: member.user_id,
      role: member.role,
      joinedAt: member.joined_at,
      profile: member.profile
    });
  } catch (e: any) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return res.status(409).json({ error: 'User is already a member' });
    }
    handlePermissionError(e, res, 'Add space member');
  }
});

router.patch('/:id/members/:targetUserId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id, targetUserId } = req.params;
    const userId = req.user!.id;
    const { role } = req.body;

    if (!role) return res.status(400).json({ error: 'role is required' });

    const space = await prisma.spaces.findUnique({ where: { id } });
    if (!space) return res.status(404).json({ error: 'Space not found' });

    // Only monarch can promote/demote custodians
    if (role === 'custodian' || role === 'member') {
      if (space.monarch_id !== userId) {
        return res.status(403).json({ error: 'Only the monarch can change member roles' });
      }
    }

    // Trigger enforces custodian limit (max 2)
    await prisma.space_members.update({
      where: { space_id_user_id: { space_id: id, user_id: targetUserId } },
      data: { role }
    });

    res.json({ success: true });
  } catch (e: any) { handlePermissionError(e, res, 'Update member role'); }
});

router.delete('/:id/members/:targetUserId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { id, targetUserId } = req.params;
    const userId = req.user!.id;

    const space = await prisma.spaces.findUnique({ where: { id } });
    if (!space) return res.status(404).json({ error: 'Space not found' });

    // Users can remove themselves (leave). Otherwise need monarch/custodian.
    if (targetUserId !== userId) {
      if (!await isSpaceMonarchOrCustodian(id, userId)) {
        return res.status(403).json({ error: 'Only monarch or custodian can remove members' });
      }
      // Custodians can only be removed by the monarch
      const targetMember = await prisma.space_members.findUnique({
        where: { space_id_user_id: { space_id: id, user_id: targetUserId } }
      });
      if (targetMember?.role === 'custodian' && space.monarch_id !== userId) {
        return res.status(403).json({ error: 'Only the monarch can remove custodians' });
      }
    }

    // Cannot remove the monarch
    if (targetUserId === space.monarch_id) {
      return res.status(400).json({ error: 'Cannot remove the space monarch' });
    }

    await prisma.space_members.delete({
      where: { space_id_user_id: { space_id: id, user_id: targetUserId } }
    });

    res.json({ success: true });
  } catch (e: any) { handlePermissionError(e, res, 'Remove space member'); }
});

export default router;
