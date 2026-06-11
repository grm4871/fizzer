import { prisma } from './prisma-client.js';
import { getUserSavedSpaceId } from '../routes/utils/spaces_and_sidebar.js';

/**
 * Get all public netdocs (those with perms_mode_read = 'blacklist', meaning public)
 * Excludes user gallery docs and System Root
 */
export async function getPublicNetdocs(limit: number = 100): Promise<any[]> {
  const publicDocs = await prisma.genus.findMany({
    where: {
      perms_mode_read: 'blacklist',
      is_unlisted: false,
      NOT: { name: { endsWith: "'s Homepage" } },
      netdoc: { is: { is_jacket: false, status_message: false } }
    },
    include: {
      netdoc: { select: { content: true } },
      profile: { select: { id: true, username: true, displayName: true, color: true } }
    },
    orderBy: { updated_at: 'desc' },
    take: limit
  });

  return publicDocs.map(doc => ({
    id: doc.id,
    name: doc.name,
    content: doc.netdoc?.content || '',
    creator_id: doc.creator_id,
    is_unlisted: doc.is_unlisted,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    profile: doc.profile ? {
      id: doc.profile.id,
      username: doc.profile.username,
      displayName: doc.profile.displayName,
      color: doc.profile.color
    } : null
  }));
}

/**
 * Get popularity scores (unique view counts) for a list of netdoc IDs
 * @param netdocIds - Array of netdoc IDs to get scores for
 * @param days - Number of days to look back (default 30)
 */
export async function getPopularityScores(
  netdocIds: string[],
  days: number = 30
): Promise<Map<string, number>> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const viewCounts = await prisma.netdoc_view.groupBy({
    by: ['netdoc_id'],
    where: {
      netdoc_id: { in: netdocIds },
      viewed_at: { gte: cutoffDate }
    },
    _count: { viewer_id: true }
  });

  const scores = new Map<string, number>();
  for (const vc of viewCounts) {
    // Use log scale for popularity to avoid extreme skew
    scores.set(vc.netdoc_id, Math.log(1 + vc._count.viewer_id));
  }

  // Set 0 for docs with no views
  for (const id of netdocIds) {
    if (!scores.has(id)) {
      scores.set(id, 0);
    }
  }

  return scores;
}

/**
 * Get user's document matrix (items in their saved space)
 * @param userId - The user's ID
 */
export async function getUserDocumentMatrix(userId: string): Promise<string[]> {
  const savedSpaceId = await getUserSavedSpaceId(userId);
  if (!savedSpaceId) return [];

  const spaceItems = await prisma.space_items.findMany({
    where: { space_id: savedSpaceId },
    select: { genus_id: true }
  });

  return spaceItems.map(item => item.genus_id);
}

/**
 * Compute document matrix connection scores using Jaccard similarity
 * @param userDocIds - User's sidebar document IDs
 * @param candidateDocs - Candidate documents to score
 */
export async function computeMatrixScores(
  userDocIds: string[],
  candidateDocs: any[]
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const userDocSet = new Set(userDocIds);

  if (userDocIds.length === 0) {
    // No user docs → all scores are 0
    for (const doc of candidateDocs) {
      scores.set(doc.id, 0);
    }
    return scores;
  }

  // Calculate scores for each candidate
  for (const doc of candidateDocs) {
    let score = 0;

    // Direct match: doc is in user's sidebar
    if (userDocSet.has(doc.id)) {
      score = 1.0;
    }
    // Same creator as a doc in user's sidebar
    else if (userDocIds.length > 0) {
      // Check if candidate doc's creator has any docs in user's sidebar
      const creatorDocs = await prisma.genus.findFirst({
        where: {
          creator_id: doc.creator_id,
          id: { in: userDocIds }
        }
      });
      if (creatorDocs) {
        score = 0.3;
      }
    }

    scores.set(doc.id, score);
  }

  return scores;
}

/**
 * Compute keyword relevance scores using PostgreSQL full-text search
 * @param keyword - The search keyword
 * @param netdocIds - Array of netdoc IDs to score
 */
export async function computeKeywordScores(
  keyword: string,
  netdocIds: string[]
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();

  if (!keyword || keyword.trim() === '') {
    // No keyword → all scores are 1.0 (neutral)
    for (const id of netdocIds) {
      scores.set(id, 1.0);
    }
    return scores;
  }

  // Sanitize keyword for tsquery
  const sanitizedKeyword = keyword.replace(/[^a-zA-Z0-9\s]/g, '').trim();
  if (!sanitizedKeyword) {
    for (const id of netdocIds) {
      scores.set(id, 1.0);
    }
    return scores;
  }

  // Use raw SQL for full-text search ranking (name on genus, content on netdoc)
  const results = await prisma.$queryRaw<{ id: string; rank: number }[]>`
    SELECT
      g.id,
      ts_rank(
        to_tsvector('english', COALESCE(g.name, '') || ' ' || COALESCE(n.content, '')),
        plainto_tsquery('english', ${sanitizedKeyword})
      ) as rank
    FROM genus g
    JOIN netdoc n ON n.id = g.id
    WHERE g.id = ANY(${netdocIds}::text[])
  `;

  for (const result of results) {
    // Normalize rank to 0-1 range (ts_rank typically returns 0-1 but can exceed)
    // We boost the rank by 10x because raw ts_rank for short text/queries is often very small (e.g. 0.05)
    // This allows the keyword signal to actually compete with popularity (which is normalized 0-1)
    scores.set(result.id, Math.min(1.0, result.rank * 10));
  }

  // Set 0 for docs not in results
  for (const id of netdocIds) {
    if (!scores.has(id)) {
      scores.set(id, 0);
    }
  }

  return scores;
}

/**
 * Record a document view for popularity tracking
 * @param netdocId - The netdoc being viewed
 * @param viewerId - The user viewing the netdoc
 */
export async function recordDocumentView(
  netdocId: string,
  viewerId: string
): Promise<void> {
  try {
    // Upsert to update viewed_at if already exists
    await prisma.netdoc_view.upsert({
      where: {
        netdoc_id_viewer_id: {
          netdoc_id: netdocId,
          viewer_id: viewerId
        }
      },
      update: {
        viewed_at: new Date()
      },
      create: {
        netdoc_id: netdocId,
        viewer_id: viewerId
      }
    });
  } catch (err) {
    console.error('[Recommendations] Failed to record view:', err);
  }
}

/**
 * Get IDs of netdocs viewed by a user
 * @param userId - The user's ID
 */
export async function getViewedNetdocs(userId: string): Promise<string[]> {
  const views = await prisma.netdoc_view.findMany({
    where: { viewer_id: userId },
    select: { netdoc_id: true }
  });
  
  return views.map(v => v.netdoc_id);
}
