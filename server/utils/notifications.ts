// server/utils/notifications.ts - Notification generation utility
import { prisma } from '../data-utils.js';
import { getIO } from '../socket.js';

interface NotificationEventData {
  authorId: string;
  authorName?: string;
  authorColor?: string;
  content?: string;
  [key: string]: any;
}

/**
 * Generate notifications for users who have enabled notifications for a specific netdoc
 *
 * @param netdocId - The netdoc/genus that triggered the event
 * @param eventType - Type of event: 'comment', 'write', 'created'
 * @param eventData - Additional data about the event (authorId, authorName, content, etc.)
 * @returns Array of created notification records
 */
export async function generateNotifications(
  netdocId: string,
  eventType: 'comment' | 'write' | 'created',
  eventData: NotificationEventData
): Promise<any[]> {
  try {
    const { authorId, authorName, authorColor: providedColor, content } = eventData;

    // Get genus name for notification message
    const genus = await prisma.genus.findUnique({
      where: { id: netdocId },
      select: { name: true }
    });

    // Get author's color if not provided
    let authorColor = providedColor;
    if (!authorColor && authorId) {
      const author = await prisma.profile.findUnique({
        where: { id: authorId },
        select: { color: true }
      });
      authorColor = author?.color || undefined;
    }

    if (!genus) {
      console.error(`[Notifications] Genus ${netdocId} not found`);
      return [];
    }

    const genusName = genus.name;

    // Find all users who have notifications enabled for this genus
    const notificationPreferences = await prisma.genus_notifications.findMany({
      where: { genus_id: netdocId },
      select: { user_id: true }
    });

    // Filter out the author (don't notify them about their own actions)
    const recipientUserIds = notificationPreferences
      .map((pref: any) => pref.user_id)
      .filter((userId: string) => userId !== authorId);

    if (recipientUserIds.length === 0) {
      console.log(`[Notifications] No recipients for netdoc ${netdocId}`);
      return [];
    }

    // Generate notification message based on event type
    let message = '';
    switch (eventType) {
      case 'comment':
        message = authorName
          ? `${authorName} commented on "${genusName}"`
          : `New comment on "${genusName}"`;
        break;
      case 'write':
        message = authorName
          ? `${authorName} edited "${genusName}"`
          : `"${genusName}" was edited`;
        break;
      case 'created':
        message = authorName
          ? `${authorName} created "${genusName}"`
          : `New netdoc "${genusName}" was created`;
        break;
    }

    // Check which users are currently viewing the netdoc (in the room)
    const io = getIO();
    let usersViewingNetdoc = new Set<string>();

    if (io) {
      const roomSockets = await io.in(`netdoc:${netdocId}`).fetchSockets();
      for (const s of roomSockets) {
        // Find which user this socket belongs to by checking user rooms
        for (const userId of recipientUserIds) {
          if (s.rooms.has(`user:${userId}`)) {
            usersViewingNetdoc.add(userId);
          }
        }
      }
    }

    // Filter out users who are currently viewing the netdoc
    const usersToNotify = recipientUserIds.filter((userId: string) => !usersViewingNetdoc.has(userId));

    if (usersToNotify.length === 0) {
      console.log(`[Notifications] All recipients are viewing netdoc ${netdocId}, skipping notifications`);
      return [];
    }

    // Create notification records only for users not viewing the netdoc
    const notifications = await Promise.all(
      usersToNotify.map(async (userId: string) => {
        const notification = await prisma.notifications.create({
          data: {
            user_id: userId,
            genus_id: netdocId,
            type: eventType,
            message,
            content: content || null,
            read: false
          }
        });
        return notification;
      })
    );

    // Emit socket events to users not viewing the netdoc
    if (io) {
      notifications.forEach(notification => {
        io.to(`user:${notification.user_id}`).emit('notification:new', {
          id: notification.id.toString(),
          type: notification.type,
          message: notification.message,
          timestamp: notification.created_at,
          read: notification.read,
          netdocId: notification.genus_id,
          netdocName: genusName,
          authorName,
          authorColor,
          updateType: eventType,
          content: content?.substring(0, 150)
        });
      });
    }

    console.log(`[Notifications] Generated ${notifications.length} notifications for netdoc ${netdocId} (${eventType})`);
    return notifications;
  } catch (err) {
    console.error('[Notifications] Error generating notifications:', err);
    return [];
  }
}
