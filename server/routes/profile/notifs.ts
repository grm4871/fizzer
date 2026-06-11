// server/routes/profile/notifs.ts - Notification preference management
import express, { Request, Response } from 'express';
import { prisma } from '../../data-utils.js';
import { getIO } from '../../socket.js';

const router = express.Router({ mergeParams: true });

/**
 * POST /:userId/notifs/enable
 * Enable notifications for a specific netdoc/genus
 */
router.post('/:userId/notifs/enable', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;
    const { netdocId } = req.body;

    if (!netdocId || typeof netdocId !== 'string') {
      return res.status(400).json({ error: 'netdocId is required' });
    }

    let wasCreated = false;
    try {
      await prisma.genus_notifications.create({
        data: { user_id: userId, genus_id: netdocId }
      });
      wasCreated = true;
    } catch (e: any) {
      // P2002 = unique constraint violation (already exists)
      if (e.code !== 'P2002') throw e;
    }

    // Emit socket event
    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('notifications:enabled', { netdocId });
    }

    res.status(wasCreated ? 201 : 200).json({
      success: true,
      message: wasCreated ? undefined : 'Notifications already enabled',
      userId,
      netdocId
    });
  } catch (err) {
    console.error('Enable notifications error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * DELETE /:userId/notifs/:netdocId
 * Disable notifications for a specific netdoc/genus
 */
router.delete('/:userId/notifs/:netdocId', async (req: Request, res: Response) => {
  try {
    const { userId, netdocId } = req.params;

    if (!netdocId || typeof netdocId !== 'string') {
      return res.status(400).json({ error: 'Invalid netdocId' });
    }

    const { count: deleted } = await prisma.genus_notifications.deleteMany({
      where: { user_id: userId, genus_id: netdocId }
    });

    // Emit socket event
    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('notifications:disabled', { netdocId });
    }

    res.status(200).json({
      success: true,
      userId,
      netdocId,
      deletedCount: deleted
    });
  } catch (err) {
    console.error('Disable notifications error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /:userId/notifs
 * Get all netdocs with notifications enabled for a user
 */
router.get('/:userId/notifs', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const notifications = await prisma.genus_notifications.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' }
    });

    res.status(200).json({
      notifications: notifications.map((n: any) => ({
        netdocId: n.genus_id,
        createdAt: n.created_at
      }))
    });
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * GET /:userId/notifications/feed
 * Get notification messages for a user
 */
router.get('/:userId/notifications/feed', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    const notifications = await prisma.notifications.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      include: {
        genus: { select: { name: true } }
      }
    });

    res.status(200).json({
      notifications: notifications.map((n: any) => ({
        id: n.id.toString(),
        type: n.type,
        message: n.message,
        createdAt: n.created_at,
        read: n.read,
        netdocId: n.genus_id,
        netdocName: n.genus?.name
      }))
    });
  } catch (err) {
    console.error('Get notification feed error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * PATCH /:userId/notifications/:notificationId/read
 * Delete a notification (mark as read = delete)
 */
router.patch('/:userId/notifications/:notificationId/read', async (req: Request, res: Response) => {
  try {
    const { userId, notificationId } = req.params;

    await prisma.notifications.deleteMany({
      where: { id: BigInt(notificationId), user_id: userId }
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete notification error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /:userId/notifications/read-all
 * Delete all notifications for a user (mark all as read = delete all)
 */
router.post('/:userId/notifications/read-all', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params;

    await prisma.notifications.deleteMany({
      where: { user_id: userId }
    });

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Delete all notifications error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
