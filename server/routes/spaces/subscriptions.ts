import express, { Request, Response } from 'express';
import { prisma, getUserSpaceSubscriptions, subscribeToSpace, unsubscribeFromSpace, reorderSpaceSubscriptions } from '../../data-utils.js';
import { authenticateToken } from '../../middleware/auth.js';

const router = express.Router();

// ============================================================================
// SUBSCRIPTIONS
// ============================================================================

router.get('/subscriptions/list', authenticateToken, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const subscriptions = await getUserSpaceSubscriptions(userId);
    res.json(subscriptions.map(s => ({
      id: s.space_id,
      name: s.name,
      orderKey: s.order_key,
      isProfile: s.is_profile,
      isCollection: s.is_collection,
      monarch: {
        id: s.monarch_id,
        username: s.monarch_username,
        displayName: s.monarch_display_name,
        color: s.monarch_color
      }
    })));
  } catch (err) {
    console.error('Get space subscriptions error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/subscriptions/:spaceId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { spaceId } = req.params;
    const userId = req.user!.id;

    const space = await prisma.spaces.findUnique({ where: { id: spaceId } });
    if (!space) {
      return res.status(404).json({ error: 'Space not found' });
    }
    if (space.is_profile || space.is_collection) {
      return res.status(400).json({ error: 'Cannot subscribe to profile or collection spaces' });
    }

    await subscribeToSpace(userId, spaceId);
    res.json({ success: true });
  } catch (err) {
    console.error('Subscribe to space error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.delete('/subscriptions/:spaceId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { spaceId } = req.params;
    const userId = req.user!.id;

    await unsubscribeFromSpace(userId, spaceId);
    res.json({ success: true });
  } catch (err: any) {
    // Catch DB trigger exception (MONARCH_CANNOT_UNSUBSCRIBE)
    if (err?.message?.includes('MONARCH_CANNOT_UNSUBSCRIBE') || err?.code === 'P2010') {
      return res.status(400).json({ error: 'Cannot unsubscribe from a space you reign over' });
    }
    console.error('Unsubscribe from space error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.post('/subscriptions/reorder', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { spaces } = req.body;
    const userId = req.user!.id;

    if (!Array.isArray(spaces)) {
      return res.status(400).json({ error: 'spaces array required' });
    }

    await reorderSpaceSubscriptions(userId, spaces);
    res.json({ success: true });
  } catch (err) {
    console.error('Reorder space subscriptions error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
