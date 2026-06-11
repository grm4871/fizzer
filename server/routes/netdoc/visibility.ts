import express, { Request, Response } from 'express';
import { prisma } from '../../data-utils.js';
import { authenticateToken } from '../../middleware/auth.js';
import { getIO } from '../../socket.js';
import { validateId } from '../utils/permissions.js';
import { getSpaceRoleByGenusId } from '../utils/spaces_and_sidebar.js';

const router = express.Router();

/**
 * Update netdoc visibility settings
 *
 * Endpoint: PATCH /api/netdoc/:uid/visibility
 * Body: { isUnlisted?: boolean, hideHistoryFromNonEditors?: boolean, usersCanChangeTopic?: boolean }
 */
router.patch('/:uid/visibility', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { uid } = req.params;
    const { isUnlisted, hideHistoryFromNonEditors, usersCanChangeTopic } = req.body;
    const userId = req.user!.id;

    if (!validateId(uid, res)) return;

    // Verify creator via genus
    const genus = await prisma.genus.findUnique({
      where: { id: uid },
      select: { creator_id: true }
    });
    if (!genus) {
      return res.status(404).json({ error: 'Netdoc not found' });
    }
    if (genus.creator_id !== userId) {
      const role = await getSpaceRoleByGenusId(uid, userId);
      if (role !== 'monarch' && role !== 'custodian') {
        return res.status(403).json({ error: 'Only the creator or space custodian can change visibility settings' });
      }
    }

    // is_unlisted lives on genus
    if (isUnlisted !== undefined) {
      await prisma.genus.update({
        where: { id: uid },
        data: { is_unlisted: isUnlisted === true }
      });
    }

    // hide_history_from_non_editors lives on netdoc
    if (hideHistoryFromNonEditors !== undefined) {
      await prisma.netdoc.update({
        where: { id: uid },
        data: { hide_history_from_non_editors: hideHistoryFromNonEditors === true }
      });
    }

    // users_can_change_topic lives on chat
    if (usersCanChangeTopic !== undefined) {
      // Check if this genus has a chat record
      const chat = await prisma.chat.findUnique({ where: { id: uid } });
      if (usersCanChangeTopic === true && !chat) {
        return res.status(400).json({ error: 'usersCanChangeTopic can only be enabled for chat netdocs' });
      }
      if (chat) {
        await prisma.chat.update({
          where: { id: uid },
          data: { users_can_change_topic: usersCanChangeTopic === true }
        });
      }
    }

    // Fetch updated values for response
    const updatedGenus = await prisma.genus.findUnique({
      where: { id: uid },
      select: { is_unlisted: true }
    });
    const updatedNetdoc = await prisma.netdoc.findUnique({
      where: { id: uid },
      select: { hide_history_from_non_editors: true }
    });
    const updatedChat = await prisma.chat.findUnique({
      where: { id: uid },
      select: { users_can_change_topic: true }
    });

    res.json({
      success: true,
      is_unlisted: updatedGenus?.is_unlisted ?? false,
      hide_history_from_non_editors: updatedNetdoc?.hide_history_from_non_editors ?? false,
      users_can_change_topic: updatedChat?.users_can_change_topic ?? false
    });

    // Broadcast permission change to all viewers of this netdoc
    const io = getIO();
    if (io) {
      io.to(`netdoc:${uid}`).emit('netdoc:permissions-changed', { netdocId: uid });
    }
  } catch (err) {
    console.error('Update visibility error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
