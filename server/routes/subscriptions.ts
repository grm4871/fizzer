// server/routes/subscriptions.ts - User subscription management routes
import express, { Request, Response } from 'express';
import { prisma } from '../data-utils.js';
import { getIO } from '../socket.js';
import { getUserSavedSpaceId } from './utils/spaces_and_sidebar.js';

const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === 'true';

const router = express.Router();

/**
 * POST /:userId/subscribe
 * Subscribe user to a netdoc by adding it to their saved space
 */
router.post('/:userId/subscribe', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { netdocId } = req.body;
    if (DEBUG) console.log('[subscriptions] subscribe called with netdocId:', netdocId);

    if (!netdocId) {
      return res.status(400).json({ error: 'netdocId is required' });
    }

    // Validate netdocId format
    if (!netdocId || typeof netdocId !== 'string') {
      return res.status(400).json({ error: 'Invalid netdocId' });
    }
    const netdocIdString = netdocId;

    // Get user's saved space
    const savedSpaceId = await getUserSavedSpaceId(userId);
    if (!savedSpaceId) {
      return res.status(404).json({ error: 'User saved space not found' });
    }

    // Check if already subscribed in saved space
    const existing = await prisma.space_items.findFirst({
      where: {
        space_id: savedSpaceId,
        genus_id: netdocIdString
      }
    });

    if (existing) {
      if (DEBUG) console.log('[subscriptions] Already subscribed, skipping');
      return res.status(200).json({ success: true, message: 'Already subscribed', userId, netdocId });
    }
    if (DEBUG) console.log('[subscriptions] Not already subscribed, proceeding');

    // Get max order_key for this space
    const maxItem = await prisma.space_items.findFirst({
      where: { space_id: savedSpaceId },
      orderBy: { order_key: 'desc' },
      select: { order_key: true }
    });
    const newOrderKey = (maxItem?.order_key ?? -1) + 1;

    const item = await prisma.space_items.create({
      data: {
        space_id: savedSpaceId,
        genus_id: netdocIdString,
        order_key: newOrderKey,
        folder_id: null
      }
    });
    if (DEBUG) console.log('[subscriptions] Created space_item:', item.id);

    // Emit socket event to notify user that their sidebar was updated
    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('sidebar:subscription-added', {
        netdocId: netdocId,
        orderKey: item.order_key
      });
    }

    res.status(201).json({
      success: true,
      userId,
      netdocId,
      orderKey: item.order_key
    });
  } catch (err) {
    if (DEBUG) console.error('Subscribe error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * DELETE /:userId/subscriptions/:netdocId
 * Unsubscribe user from a netdoc by removing from their saved space
 */
router.delete('/:userId/subscriptions/:netdocId', async (req: Request, res: Response) => {
  try {
    const { userId, netdocId } = req.params;

    // Validate netdocId format
    if (!netdocId || typeof netdocId !== 'string') {
      return res.status(400).json({ error: 'Invalid netdocId' });
    }
    const netdocIdString = netdocId;

    // Get user's saved space
    const savedSpaceId = await getUserSavedSpaceId(userId);
    if (!savedSpaceId) {
      return res.status(404).json({ error: 'User saved space not found' });
    }

    // Delete space item
    const deleted = await prisma.space_items.deleteMany({
      where: {
        space_id: savedSpaceId,
        genus_id: netdocIdString
      }
    });

    // Emit socket event to notify user that their sidebar was updated
    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('sidebar:subscription-removed', {
        netdocId: netdocId
      });
    }

    res.status(200).json({
      success: true,
      userId,
      netdocId,
      deletedCount: deleted.count
    });
  } catch (err) {
    if (DEBUG) console.error('Unsubscribe error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});



/**
 * GET /:userId/subscriptions
 * Get all subscriptions for a user (items in their saved space)
 */
router.get('/:userId/subscriptions', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    // Get user's saved space
    const savedSpaceId = await getUserSavedSpaceId(userId);
    if (!savedSpaceId) {
      return res.status(200).json({ subscriptions: [] });
    }

    // Get all space items for this user's saved space
    const items = await prisma.space_items.findMany({
      where: { space_id: savedSpaceId },
      orderBy: { order_key: 'asc' }
    });

    res.status(200).json({
      subscriptions: items.map((item) => ({
        netdocId: item.genus_id.toString(),
        orderKey: item.order_key
      }))
    });
  } catch (err) {
    if (DEBUG) console.error('Get subscriptions error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
