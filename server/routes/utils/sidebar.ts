import { prisma, checkSpacePermission } from '../../data-utils.js';

/**
 * Formatting helpers and shared data-fetching for sidebar.
 * Both spaces/:id/sidebar and sidebar/ routes share this shape.
 */

export async function fetchSpaceSidebarData(spaceId: string, userId?: string | null) {
  // Fetch space_items for this space
  const items = await prisma.space_items.findMany({
    where: { space_id: spaceId },
    orderBy: { order_key: 'asc' }
  });

  const genusIds = items.map((i: any) => i.genus_id);

  // Fetch genus + netdoc data for all items (include space_id for permission check)
  const genera = genusIds.length > 0 ? await prisma.genus.findMany({
    where: { id: { in: genusIds } },
    select: {
      id: true,
      name: true,
      space_id: true,
      netdoc: { select: { is_jacket: true } }
    }
  }) : [];

  // Filter genera by space read permissions
  const accessibleGenera: typeof genera = [];
  for (const genus of genera) {
    // If genus has a parent space, check if user has read access to that space
    if (genus.space_id && userId) {
      const hasSpaceAccess = await checkSpacePermission(genus.space_id, userId, 'read');
      if (!hasSpaceAccess) {
        continue; // Skip this genus - user lacks space read permission
      }
    }
    accessibleGenera.push(genus);
  }

  const netdocMap = buildNetdocMap(accessibleGenera);

  // Filter items to only include accessible genera
  const accessibleGenusIds = new Set(accessibleGenera.map(g => g.id));
  const filteredItems = items.filter(item => accessibleGenusIds.has(item.genus_id));

  return { items: filteredItems, netdocMap };
}

export function formatSidebarItem(item: any, netdocMap: Map<string, any>) {
  const genus = netdocMap.get(item.genus_id);
  return {
    id: item.id,
    type: 'netdoc' as const,
    netdocId: item.genus_id,
    parentId: null,
    folderId: null,
    orderKey: item.order_key,
    title: genus?.name || 'Untitled',
    isJacket: genus?.netdoc?.is_jacket || false
  };
}

export function buildNetdocMap(genera: any[]): Map<string, any> {
  return new Map(genera.map(g => [g.id, g]));
}
