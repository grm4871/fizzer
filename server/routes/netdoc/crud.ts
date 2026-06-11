import express, { Request, Response } from 'express';
import { prisma, checkNetdocPermission, checkSpacePermission } from '../../data-utils.js';
import { getIO } from '../../socket.js';
import { authenticateToken, optionalAuthenticateToken } from '../../middleware/auth.js';
import { generateNotifications } from '../../utils/notifications.js';
import { validateId } from '../utils/permissions.js';
import { createNetdoc } from '../../data/create.js';

const router = express.Router();

const profileSelect = {
  id: true,
  username: true,
  displayName: true,
  color: true
} as const;

/**
 * Create a new netdoc
 *
 * Endpoint: POST /api/netdoc/
 * Body: { userId: string, name: string, content?: string, isDM?: boolean, isUnlisted?: boolean, spaceId?: string }
 */
router.post('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { name, content, isDM, isUnlisted, spaceId } = req.body;
    const userId = req.user!.id; // Guaranteed by authenticateToken

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    // If spaceId is provided, verify user has write permissions for that space
    if (spaceId) {
      const space = await prisma.spaces.findUnique({
        where: { id: spaceId }
      });

      if (!space) {
        return res.status(404).json({ error: 'Space not found' });
      }

      // Check space write permissions (respects perms_mode and permission grants)
      const canWrite = await checkSpacePermission(spaceId, userId, 'write');

      if (!canWrite) {
        return res.status(403).json({ error: 'You do not have permission to add items to this space' });
      }
    }

    // Atomically create netdoc with all setup (genus, netdoc, permissions, space assignment, notifications)
    const newId = await createNetdoc({
      name,
      creatorId: userId,
      content: content || '',
      isDM: isDM === true,
      isUnlisted: isUnlisted === true,
      spaceId: spaceId || null,
    });

    // Emit socket events for non-DM netdocs
    if (!isDM) {
      const io = getIO();
      if (io) {
        // Get the order_key for the socket event
        const spaceItem = await prisma.space_items.findFirst({
          where: { genus_id: newId },
          select: { order_key: true }
        });

        if (spaceItem) {
          io.to(`user:${userId}`).emit('sidebar:subscription-added', {
            netdocId: newId,
            orderKey: spaceItem.order_key
          });
        }

        io.to(`user:${userId}`).emit('notifications:enabled', { netdocId: newId });
      }
    }

    // Fetch the created genus for response
    const genus = await prisma.genus.findUnique({
      where: { id: newId },
      include: {
        profile: { select: profileSelect }
      }
    });

    if (!genus) return res.status(500).json({ error: 'server_error' });

    res.status(201).json({
      id: genus.id.toString(),
      name: genus.name,
      content: content || '',
      creator_id: genus.creator_id,
      is_unlisted: genus.is_unlisted,
      creator: genus.profile ? {
        id: genus.profile.id,
        username: genus.profile.username,
        displayName: genus.profile.displayName,
        color: genus.profile.color
      } : null,
      created_at: genus.created_at instanceof Date ? genus.created_at.toISOString() : genus.created_at,
      updated_at: genus.updated_at instanceof Date ? genus.updated_at.toISOString() : genus.updated_at
    });
  } catch (err) {
    console.error('Create netdoc error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});



/**
 * Get all netdocs by author
 *
 * Endpoint: GET /api/netdoc/author/:authorId
 */
router.get('/author/:authorId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { authorId } = req.params;
    const userId = req.user!.id; // Guaranteed by authenticateToken

    // Authorization: only the author can view their own netdocs
    if (userId !== authorId) {
      return res.status(403).json({ error: 'Forbidden: You can only view your own netdocs' });
    }

    // Fetch all netdocs created by this author
    const genusRecords = await prisma.genus.findMany({
      where: {
        creator_id: authorId,
        netdoc: { isNot: null }
      },
      include: {
        netdoc: true,
        profile: { select: profileSelect }
      },
      orderBy: { updated_at: 'desc' }
    });

    const netdocList = genusRecords.map((g) => ({
      id: g.id.toString(),
      name: g.name,
      content: g.netdoc?.content || '',
      creator_id: g.creator_id,
      created_at: g.created_at instanceof Date ? g.created_at.toISOString() : g.created_at,
      updated_at: g.updated_at instanceof Date ? g.updated_at.toISOString() : g.updated_at,
      creator: g.profile ? {
        id: g.profile.id,
        username: g.profile.username,
        displayName: g.profile.displayName,
        color: g.profile.color || 'd2b34e'
      } : null
    }));

    res.json(netdocList);
  } catch (err) {
    console.error('Get author netdocs error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Get a netdoc by id
 *
 * Endpoint: GET /api/netdoc/:uid
 */
router.get('/:uid', optionalAuthenticateToken, async (req: Request, res: Response) => {
  try {
    const { uid } = req.params;
    const { includeVersions, limit, before, after } = req.query;
    const userId = req.user?.id;

    console.log(`[Netdoc GET /:uid] uid=${uid}, userId=${userId}`);

    const netdocId = validateId(uid, res);
    if (!netdocId) return;

    // Fetch genus + netdoc + profile
    const genus = await prisma.genus.findUnique({
      where: { id: netdocId },
      include: {
        netdoc: true,
        profile: { select: profileSelect }
      }
    });

    if (!genus || !genus.netdoc) {
      return res.status(404).json({ error: 'Netdoc not found' });
    }

    const netdoc = genus.netdoc;

    // Check read permissions
    let hasReadAccess = await checkNetdocPermission(netdocId, userId ? String(userId) : null, 'read');

    // For jackets: apply space permission ceiling
    let canWrite = false;
    if (netdoc.is_jacket && genus.space_id) {
      const spaceReadAccess = userId ? await checkSpacePermission(genus.space_id, String(userId), 'read') : await checkSpacePermission(genus.space_id, null, 'read');
      hasReadAccess = hasReadAccess && spaceReadAccess;

      if (userId) {
        const jacketWrite = await checkNetdocPermission(netdocId, String(userId), 'write');
        const spaceWrite = await checkSpacePermission(genus.space_id, String(userId), 'write');

        canWrite = jacketWrite && spaceWrite;
      }
    } else {
      // Non-jacket netdocs use their own permissions
      canWrite = userId ? await checkNetdocPermission(netdocId, String(userId), 'write') : false;
    }

    if (!hasReadAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Jackets should NOT redirect when accessed via API - they're meant to be editable
    // The redirect logic was for direct navigation, but the editor needs to fetch jacket content
    // Remove the jacket redirect entirely - jackets are just netdocs that can be edited

    // Check if history should be hidden from non-editors
    const hideHistoryFromNonEditors = netdoc.hide_history_from_non_editors === true;
    const canViewHistory = canWrite || !hideHistoryFromNonEditors;

    // Find which space this netdoc belongs to (if any)
    const spaceItem = await prisma.space_items.findFirst({
      where: { genus_id: netdocId },
      include: {
        space: {
          select: {
            id: true,
            name: true,
            is_profile: true,
            is_collection: true
          }
        }
      }
    });
    // Only include space info if it's not a profile/collection space
    const space = spaceItem?.space && !spaceItem.space.is_profile && !spaceItem.space.is_collection ? {
      id: spaceItem.space.id,
      name: spaceItem.space.name
    } : null;

    // Fetch versions if requested
    let versions: any[] | undefined;
    if (includeVersions === 'true' && canViewHistory) {
      const versionRows = await prisma.netdoc_version.findMany({
        where: { netdoc_id: netdocId },
        orderBy: { created_at: 'desc' },
        take: 10,
        include: {
          profile: { select: profileSelect }
        }
      });
      versions = versionRows.map((v: any) => ({
        id: v.id.toString(),
        netdoc_id: v.netdoc_id.toString(),
        content: v.content,
        title: v.title,
        author: v.profile ? {
          id: v.profile.id,
          username: v.profile.username,
          displayName: v.profile.displayName,
          color: v.profile.color || 'd2b34e'
        } : null,
        created_at: v.created_at instanceof Date ? v.created_at.toISOString() : v.created_at
      }));
    }

    res.json({
      id: genus.id.toString(),
      name: genus.name,
      content: netdoc.content,
      creator_id: genus.creator_id,
      is_unlisted: genus.is_unlisted,
      hide_history_from_non_editors: hideHistoryFromNonEditors,
      parent_id: undefined,
      space,
      creator: genus.profile ? {
        id: genus.profile.id,
        username: genus.profile.username,
        displayName: genus.profile.displayName,
        color: genus.profile.color || 'd2b34e'
      } : null,
      created_at: genus.created_at instanceof Date ? genus.created_at.toISOString() : genus.created_at,
      updated_at: genus.updated_at instanceof Date ? genus.updated_at.toISOString() : genus.updated_at,
      canWrite,
      canViewHistory,
      versions
    });
  } catch (err) {
    console.error('Get netdoc error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Edit a netdoc
 *
 * Endpoint: PATCH /api/netdoc/:uid
 * Body: { name: string, content: string }
 */
router.patch('/:uid', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { uid } = req.params;
    const { name, content } = req.body;
    const userId = req.user!.id;

    if (name === undefined) {
      return res.status(400).json({ error: 'name is required' });
    }

    const netdocId = validateId(uid, res);
    if (!netdocId) return;

    // Fetch genus + netdoc to check permissions
    const genusRecord = await prisma.genus.findUnique({
      where: { id: netdocId },
      include: { netdoc: true }
    });

    if (!genusRecord || !genusRecord.netdoc) {
      return res.status(404).json({ error: 'Netdoc not found' });
    }

    // Check edit permissions
    const hasWriteAccess = await checkNetdocPermission(netdocId, userId, 'write');
    if (!hasWriteAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // If this is a jacket netdoc and autoappend is off, validate that all required links are present
    // When autoappend is on, the SQL trigger enforce_jacket_links handles re-appending on save
    if (content !== undefined && genusRecord.netdoc.is_jacket && req.query.autoappend !== 'true') {
      const missing = await prisma.$queryRaw<{ genus_id: string; link: string }[]>`
        SELECT genus_id, link FROM get_missing_jacket_links(${netdocId}, ${content})
      `;

      if (missing.length > 0) {
        return res.status(400).json({
          error: 'missing_jacket_links',
          missingNetdocIds: missing.map(m => m.genus_id),
          missingLinks: missing.map(m => m.link)
        });
      }
    }

    // Version creation is now handled by DB trigger (auto_create_netdoc_version)

    // Update genus fields (name)
    await prisma.genus.update({
      where: { id: netdocId },
      data: { name, updated_at: new Date() }
    });

    // Update netdoc fields (content) if provided
    if (content !== undefined) {
      await prisma.netdoc.update({
        where: { id: netdocId },
        data: { content }
      });
    }

    // Fetch updated data for response
    const updated = await prisma.genus.findUnique({
      where: { id: netdocId },
      include: {
        netdoc: true,
        profile: { select: profileSelect }
      }
    });

    if (!updated || !updated.netdoc) {
      return res.status(500).json({ error: 'server_error' });
    }

    // Emit socket event to subscribers
    const io = getIO();
    if (io) {
      io.to(`netdoc:${netdocId.toString()}`).emit('netdoc:updated', {
        netdocId: netdocId.toString(),
        netdocName: updated.name,
        authorName: updated.profile?.displayName,
        authorId: updated.creator_id?.toString(),
        content: updated.netdoc.content,
        updateType: 'edited',
        timestamp: new Date()
      });
    }

    // Generate notifications for users who have enabled notifications for this netdoc
    await generateNotifications(netdocId, 'write', {
      authorId: userId,
      authorName: updated.profile?.displayName,
      content: updated.netdoc.content
    });

    res.json({
      id: updated.id.toString(),
      name: updated.name,
      content: updated.netdoc.content,
      creator_id: updated.creator_id,
      creator: updated.profile ? {
        id: updated.profile.id,
        username: updated.profile.username,
        displayName: updated.profile.displayName,
        color: updated.profile.color
      } : null,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      canWrite: hasWriteAccess
    });
  } catch (err: any) {
    console.error('Edit netdoc error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
