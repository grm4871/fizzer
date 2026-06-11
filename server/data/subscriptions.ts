import { Prisma } from '@prisma/client';
import { prisma } from './prisma-client.js';

export async function getUserSpaceSubscriptions(userId: string): Promise<any[]> {
  const subs = await prisma.user_space_subscriptions.findMany({
    where: { user_id: userId },
    include: {
      space: {
        select: {
          id: true,
          name: true,
          monarch_id: true,
          is_profile: true,
          is_collection: true,
          monarch: { select: { username: true, displayName: true, color: true } }
        }
      }
    },
    orderBy: { order_key: 'asc' }
  });

  return subs.map(s => ({
    space_id: s.space_id,
    order_key: s.order_key,
    name: s.space.name,
    monarch_id: s.space.monarch_id,
    is_profile: s.space.is_profile,
    is_collection: s.space.is_collection,
    monarch_username: s.space.monarch?.username ?? '',
    monarch_display_name: s.space.monarch?.displayName ?? '',
    monarch_color: s.space.monarch?.color ?? null
  }));
}

export async function subscribeToSpace(userId: string, spaceId: string): Promise<void> {
  const maxOrder = await prisma.user_space_subscriptions.aggregate({
    where: { user_id: userId },
    _max: { order_key: true }
  });
  const newOrderKey = (maxOrder._max.order_key ?? -1) + 1;

  try {
    await prisma.user_space_subscriptions.create({
      data: { user_id: userId, space_id: spaceId, order_key: newOrderKey }
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      // Already subscribed, ignore
    } else {
      throw e;
    }
  }
}

export async function unsubscribeFromSpace(userId: string, spaceId: string): Promise<void> {
  // Monarch check is enforced by DB trigger - no pre-check needed
  await prisma.user_space_subscriptions.deleteMany({
    where: { user_id: userId, space_id: spaceId }
  });
}

export async function reorderSpaceSubscriptions(
  userId: string,
  orderedSpaceIds: { spaceId: string; orderKey: number }[]
): Promise<void> {
  for (const { spaceId, orderKey } of orderedSpaceIds) {
    await prisma.user_space_subscriptions.updateMany({
      where: { user_id: userId, space_id: spaceId },
      data: { order_key: orderKey }
    });
  }
}
