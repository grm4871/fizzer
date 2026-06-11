import express, { Request, Response } from 'express';
import { prisma } from '../data-utils.js';
import { getIO } from '../socket.js';
import { getUserSavedSpaceId } from './utils/spaces_and_sidebar.js';
import { formatSidebarItem, fetchSpaceSidebarData } from './utils/sidebar.js';

const router = express.Router();

/**
 * Fetch sidebar contents for a user's saved space (items only, flat)
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { userId, spaceId } = req.query;

    let targetSpaceId: string | null = null;

    if (spaceId && typeof spaceId === 'string') {
      targetSpaceId = spaceId;
    } else if (userId && typeof userId === 'string') {
      targetSpaceId = await getUserSavedSpaceId(userId);
    }

    if (!targetSpaceId) {
      return res.status(400).json({ error: 'userId or spaceId required' });
    }

    const { items, netdocMap } = await fetchSpaceSidebarData(targetSpaceId, userId as string);

    res.json({
      folders: [],
      items: items.map((i: any) => formatSidebarItem(i, netdocMap)),
      spaceId: targetSpaceId
    });
  } catch (e) {
    console.error('Fetch sidebar error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Reorder items
 * Body: { spaceId, folders: [], items: [{id, orderKey}] }
 * Also accepts userId for backward compatibility (will look up saved space)
 */
router.post('/folder/reorder', async (req: Request, res: Response) => {
  try {
    const { userId, spaceId, folders, items } = req.body;

    let targetSpaceId: string | null = spaceId || null;
    if (!targetSpaceId && userId) {
      targetSpaceId = await getUserSavedSpaceId(userId);
    }

    if (!targetSpaceId) {
      return res.status(400).json({ error: 'spaceId/userId required' });
    }

    const itemIds = items?.map((i: any) => i.id) || [];

    for (const id of itemIds) {
      if (typeof id !== 'string' || id.length === 0) {
        return res.status(400).json({ error: `Invalid ID format: ${id}` });
      }
    }

    await prisma.$transaction(async (tx) => {
      const tempBase = 100000;

      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
           try {
            await tx.space_items.update({
                where: { id: items[i].id },
                data: { order_key: tempBase + i }
            });
           } catch(e) {}
        }

        for (const item of items) {
           try {
            await tx.space_items.update({
                where: { id: item.id },
                data: { order_key: item.orderKey }
            });
           } catch(e) {}
        }
      }
    });

    res.json({ success: true });
  } catch (e) {
    console.error('Reorder error:', e);
    res.status(500).json({ error: 'server_error' });
  }
});

const sidebarRouter = router;
export default sidebarRouter;
