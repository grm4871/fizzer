import express, { Request, Response } from 'express';
import { prisma } from '../data-utils.js';
import { checkNetdocPermission } from '../data/permissions.js';

const router = express.Router();

/**
 * oEmbed endpoint for netdocs
 * 
 * Endpoint: GET /api/oembed?url=...&format=json
 * Query params:
 *  - url: The URL of the netdoc to embed (required)
 *  - format: Response format, only 'json' is supported (optional, defaults to json)
 *  - maxwidth: Maximum width for the embed (optional)
 *  - maxheight: Maximum height for the embed (optional)
 * 
 * Returns oEmbed JSON response per https://oembed.com/ spec
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { url, format, maxwidth, maxheight } = req.query;

    // Validate format (only json supported)
    if (format && format !== 'json') {
      return res.status(501).json({ error: 'Only JSON format is supported' });
    }

    // Validate URL parameter
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url parameter is required' });
    }

    // Parse the URL to extract netdoc ID
    // Expected format: https://netar.is/netdoc/{id} or similar
    let netdocId: string | null = null;
    try {
      const parsedUrl = new URL(url);
      const pathMatch = parsedUrl.pathname.match(/\/netdoc\/([a-zA-Z0-9]+)/);
      if (pathMatch) {
        netdocId = pathMatch[1];
      }
    } catch (e) {
      return res.status(400).json({ error: 'Invalid URL format' });
    }

    if (!netdocId) {
      return res.status(404).json({ error: 'Could not extract netdoc ID from URL' });
    }

    // Fetch the genus + netdoc
    const genus = await prisma.genus.findUnique({
      where: { id: netdocId },
      include: {
        netdoc: true,
        profile: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        }
      }
    });

    if (!genus || !genus.netdoc) {
      return res.status(404).json({ error: 'Netdoc not found' });
    }

    // Check if netdoc is publicly readable (null userId = anonymous)
    const canRead = await checkNetdocPermission(netdocId, null, 'read');
    if (!canRead) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Calculate dimensions
    const width = maxwidth ? Math.min(parseInt(String(maxwidth)), 600) : 600;
    const height = maxheight ? Math.min(parseInt(String(maxheight)), 400) : 400;

    // Determine the base URL for embeds
    // Use the origin from the request URL or fall back to production
    let embedBaseUrl: string;
    try {
      const parsedUrl = new URL(url);
      embedBaseUrl = parsedUrl.origin;
    } catch {
      embedBaseUrl = 'https://netar.is';
    }

    // Build oEmbed response
    const oembedResponse = {
      type: 'rich',
      version: '1.0',
      title: genus.name || 'Untitled Netdoc',
      author_name: genus.profile?.displayName || genus.profile?.username || 'Unknown',
      author_url: genus.profile ? `${embedBaseUrl}/profile/${genus.profile.username}` : undefined,
      provider_name: 'Netaris',
      provider_url: 'https://netar.is',
      cache_age: 3600, // 1 hour cache
      thumbnail_url: `${embedBaseUrl}/favicon.jpeg`,
      thumbnail_width: 256,
      thumbnail_height: 256,
      html: `<iframe src="${embedBaseUrl}/embed/netdoc/${netdocId}" width="${width}" height="${height}" frameborder="0" allowfullscreen></iframe>`,
      width,
      height
    };

    res.json(oembedResponse);
  } catch (err) {
    console.error('oEmbed error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
