import express, { Request, Response } from 'express';
import {
  getPublicNetdocs,
  getPopularityScores,
  getUserDocumentMatrix,
  computeMatrixScores,
  computeKeywordScores,
  recordDocumentView,
  getViewedNetdocs
} from '../data/recommendations.js';
import { prisma } from '../data-utils.js';
import { getPublicSpaces } from './utils/spaces_and_sidebar.js';

const router = express.Router();

// Weights for combining scores (tunable)
// When keyword is provided, it dominates (60%) so matches rank higher
const WEIGHT_POPULARITY = 0.3;
const WEIGHT_MATRIX = 0.2;
const WEIGHT_RECENCY = 0.5; // New primary signal for feed
const WEIGHT_KEYWORD_SEARCH = 0.6;  // Used when actively searching
const WEIGHT_KEYWORD_PASSIVE = 0.2; // Legacy passive weight

/**
 * Get personalized recommendations for a user
 * 
 * Endpoint: GET /api/recommendations
 * Query params:
 *   - userId (required): The user requesting recommendations
 *   - keyword (optional): Search term for TF-IDF weighting
 *   - limit (optional, default 20): Number of results
 * 
 * Returns: Array of recommended netdocs with scores
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { userId, keyword, limit, sort } = req.query;

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: 'userId is required' });
    }

    const resultLimit = Math.min(parseInt(String(limit)) || 20, 100);
    const sortType = sort === 'latest' ? 'latest' : 'default';

    // 1. Get all public netdocs as candidates
    const publicDocs = await getPublicNetdocs(500); // Get a larger pool to filter from

    // 1b. Get public spaces (non-personal, non-collection)
    const publicSpaces = await getPublicSpaces(50);

    if (publicDocs.length === 0 && publicSpaces.length === 0) {
      return res.json([]);
    }

    const docIds = publicDocs.map(doc => doc.id);

    // 2. Compute each scoring signal in parallel
    const [popularityScores, userDocMatrix, keywordScores, viewedDocs] = await Promise.all([
      getPopularityScores(docIds, 30),
      getUserDocumentMatrix(userId),
      computeKeywordScores(keyword as string || '', docIds),
      getViewedNetdocs(userId)
    ]);

    const viewedSet = new Set(viewedDocs);

    // 3. Compute matrix scores (depends on userDocMatrix)
    const matrixScores = await computeMatrixScores(userDocMatrix, publicDocs);

    // 4. Normalize scores to 0-1 range
    const maxPopularity = Math.max(...Array.from(popularityScores.values()), 1);
    const normalizedPopularity = new Map<string, number>();
    for (const [id, score] of popularityScores) {
      normalizedPopularity.set(id, score / maxPopularity);
    }

    // 5. Combine scores
    const rankedDocs = publicDocs.map(doc => {
      const popScore = normalizedPopularity.get(doc.id) || 0;
      const matrixScore = matrixScores.get(doc.id) || 0;
      const kwScore = keywordScores.get(doc.id) || 0;
      
      // Compute recency score (exponential decay)
      const ageMs = Date.now() - new Date(doc.updated_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      // decay constant 10 means:
      // 0 days = 1.0
      // 7 days = 0.5
      // 30 days = 0.05
      const recencyScore = Math.exp(-ageDays / 10);

      // If keyword is provided, use all three weights
      // If no keyword, redistribute keyword weight to matrix
      let finalScore: number;
      if (keyword && typeof keyword === 'string' && keyword.trim()) {
        // SEARCH MODE: Keyword matches are the primary signal
        // Recency helps break ties
        finalScore = 
          0.1 * popScore +
          0.1 * matrixScore +
          0.2 * recencyScore +
          WEIGHT_KEYWORD_SEARCH * kwScore;
      } else {
        // FEED MODE: No keyword
        // Use defined weights
        finalScore = 
          WEIGHT_POPULARITY * popScore +
          WEIGHT_MATRIX * matrixScore +
          WEIGHT_RECENCY * recencyScore;
      }

      // PENALIZE VIEWED DOCS
      // Instead of filtering them out, we reduce their score significantly (80% penalty)
      if (viewedSet.has(doc.id)) {
        finalScore *= 0.2;
      }

      return {
        id: doc.id,
        name: doc.name,
        content: doc.content.substring(0, 10000) + (doc.content.length > 10000 ? '...' : ''),
        creator_id: doc.creator_id,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
        creator: doc.profile,
        score: finalScore,
        debug: {
          popularity: popScore,
          matrix: matrixScore,
          recency: recencyScore,
          keyword: kwScore,
          viewed: viewedSet.has(doc.id)
        }
      };
    });

    // 6. Fetch space names for netdocs
    const allDocIds = rankedDocs.map(d => d.id);
    const spaceItemsForDocs = allDocIds.length > 0 ? await prisma.space_items.findMany({
      where: { genus_id: { in: allDocIds }, space_id: { not: null } },
      select: { genus_id: true, space: { select: { id: true, name: true, is_profile: true, is_collection: true } } }
    }) : [];

    const netdocSpaceMap = new Map<string, { id: string; name: string }>();
    for (const si of spaceItemsForDocs) {
      if (si.space && !si.space.is_collection && !netdocSpaceMap.has(si.genus_id)) {
        netdocSpaceMap.set(si.genus_id, { id: si.space.id, name: si.space.name });
      }
    }

    // Add type field and space info to netdocs
    const typedDocs = rankedDocs.map(doc => ({
      ...doc,
      type: 'netdoc' as const,
      space: netdocSpaceMap.get(doc.id) || null
    }));

    // 7. Convert spaces to feed items
    const spaceItems = publicSpaces.map((space: any) => {
      const ageMs = Date.now() - new Date(space.created_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const recencyScore = Math.exp(-ageDays / 10);

      return {
        id: space.id,
        name: space.name,
        content: space.description || '',
        creator_id: space.monarch_id,
        created_at: space.created_at,
        updated_at: space.updated_at || space.created_at,
        creator: space.monarch,
        score: recencyScore, // Spaces just use recency for now
        type: 'space' as const
      };
    });

    // 8. Combine and sort
    const combined = [...typedDocs, ...spaceItems];

    if (sortType === 'latest') {
      // Sort by created_at descending (newest first)
      combined.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    } else {
      // Default: sort by recommendation score descending
      combined.sort((a, b) => b.score - a.score);
    }
    const results = combined.slice(0, resultLimit);

    res.json(results);

  } catch (err) {
    console.error('[Recommendations] Error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Record a document view (for popularity tracking)
 * 
 * Endpoint: POST /api/recommendations/view
 * Body: { netdocId, userId }
 */
router.post('/view', async (req: Request, res: Response) => {
  try {
    const { netdocId, userId } = req.body;

    if (!netdocId || !userId) {
      return res.status(400).json({ error: 'netdocId and userId are required' });
    }

    await recordDocumentView(netdocId, userId);
    res.json({ success: true });

  } catch (err) {
    console.error('[Recommendations] View error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
