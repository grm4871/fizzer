import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';

// Configure marked for GFM (tables, strikethrough, etc.)
marked.setOptions({
  gfm: true,
  breaks: true
});
import { prisma } from '../data-utils.js';
import { checkNetdocPermission, getNetdocPermsMode } from '../data/permissions.js';

const router = express.Router();

/**
 * Extract the first image URL from content
 * Supports common image formats: jpg, jpeg, png, gif, webp, svg
 */
const extractFirstImageUrl = (content: string): string | null => {
  // Match URLs ending in common image extensions
  const imageUrlRegex = /https?:\/\/[^\s<>"']+\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s<>"']*)?/i;
  const match = content.match(imageUrlRegex);
  return match ? match[0] : null;
};

// Helper to read the index.html template
const getTemplate = () => {
  try {
    // Try to find the built index.html
    // Assuming running from project root or server directory
    const possiblePaths = [
      path.resolve('client/dist/index.html'),
      path.resolve('../client/dist/index.html'),
      path.join(process.cwd(), 'client/dist/index.html')
    ];

    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        return fs.readFileSync(p, 'utf-8');
      }
    }
    return null;
  } catch (err) {
    console.error('Error reading index.html template:', err);
    return null;
  }
};

/**
 * GET /netdoc/:uid
 * Serve the netdoc content embedded in the HTML template
 */
router.get('/netdoc/:uid', async (req: Request, res: Response) => {
  try {
    const { uid } = req.params;
    const userAgent = req.get('user-agent')?.toLowerCase() || '';

    // Check for ?source=html to force bot-style HTML response
    const forceHtml = req.query.source === 'html';

    // Define User-Agents that should receive SSR content
    // CLI tools and LLM agents get JSON
    const isCLI = !forceHtml && /curl|wget|lynx|links|httpie|chatgpt|gptbot|claude|anthropic|perplexity|openai|cohere|ai2bot|ccbot|amazonbot/i.test(userAgent);
    // Social/search bots get HTML with meta tags for link previews
    const isBot = forceHtml || /googlebot|bingbot|baiduspider|duckduckbot|twitterbot|facebookexternalhit|discordbot|slackbot|telegrambot|whatsapp/i.test(userAgent);

    // If it's a regular browser (not a bot/CLI), serve the app immediately
    // The client-side React app will handle fetching and rendering
    if (!isCLI && !isBot) {
      return serveApp(res);
    }

    // Validate uid
    if (!uid || !/^[a-zA-Z0-9]+$/.test(uid)) {
      // If invalid uid, just serve the app (client will handle 404)
      return serveApp(res);
    }

    const netdocId = uid;

    // Fetch genus + netdoc
    const genus = await prisma.genus.findUnique({
      where: { id: netdocId },
      include: {
        netdoc: true,
        profile: {
          select: { displayName: true, username: true }
        }
      }
    });

    if (!genus || !genus.netdoc) {
      if (isCLI) {
        res.status(404).json({ error: 'Netdoc not found' });
        return;
      }
      return serveApp(res);
    }

    // Check if netdoc is publicly readable (anonymous user = null)
    const canRead = await checkNetdocPermission(netdocId, null, 'read');
    if (!canRead) {
      if (isCLI) {
        res.status(403).json({ error: 'This netdoc is not publicly accessible' });
        return;
      }
      return serveApp(res);
    }

    // Build permissions object from mode columns
    const modes = await getNetdocPermsMode(netdocId);
    const perms = {
      read: modes.read === 'blacklist',
      edit: modes.write === 'blacklist',
      comment: modes.comment === 'blacklist'
    };

    const netdoc = genus.netdoc;

    // For CLI tools (curl, wget), return JSON
    if (isCLI) {
      res.json({
        id: genus.id.toString(),
        name: genus.name,
        content: netdoc.content,
        createdAt: genus.created_at,
        updatedAt: genus.updated_at,
        author: genus.profile ? {
          displayName: genus.profile.displayName,
          username: genus.profile.username
        } : null,
        permissions: perms
      });
      return;
    }

    // For bots, continue with HTML + meta tags for link previews
    // Get template
    let template = getTemplate();
    
    if (!template) {
      // If no template (e.g. dev mode without build), return a basic fallback or redirect
      // For now, just send a basic HTML string
      template = `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>Netaris</title>
          </head>
          <body>
            <div id="root"></div>
          </body>
        </html>
      `;
    }

    // Prepare content for injection
    const title = `${genus.name} by ${genus.profile?.displayName || 'Unknown'}`;
    const description = 'netdoc on Netaris - ' + netdoc.content.substring(0, 200).replace(/\n/g, ' ') + '...';

    // Extract first image URL from content for embed preview
    const imageUrl = extractFirstImageUrl(netdoc.content);

    // Inject Meta Tags (Open Graph / Twitter)
    const metaTags = `
      <meta property="og:title" content="${escapeHtml(title)}" />
      <meta property="og:description" content="${escapeHtml(description)}" />
      <meta property="og:type" content="article" />
      <meta property="og:url" content="https://netar.is/netdoc/${genus.id}" />
      <meta property="og:site_name" content="Netaris" />
      ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}" />` : ''}
      <meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}" />
      <meta name="twitter:title" content="${escapeHtml(title)}" />
      <meta name="twitter:description" content="${escapeHtml(description)}" />
      ${imageUrl ? `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />` : ''}
    `;

    // Inject Content into #root for No-JS / SEO
    // We wrap it in a way that React might blow away, but it's visible initially
    const renderedContent = marked.parse(netdoc.content);
    const contentHtml = `
      <div style="max-width: 1200px;">
        <h1 id="title" style="font-size: 3em;">${escapeHtml(genus.name)}</h1>
        <div class="content">
          ${renderedContent}
        </div>
      </div>
    `;

    // Inject into template
    // 1. Inject Meta tags before </head>
    let html = template.replace('</head>', `${metaTags}</head>`);
    
    // 2. Inject Content into <div id="root"></div>
    // Note: This assumes <div id="root"></div> is empty in the template
    html = html.replace('<div id="root"></div>', `<div id="root">${contentHtml}</div>`);

    res.send(html);

  } catch (err) {
    console.error('Error serving fallback netdoc:', err);
    serveApp(res);
  }
});

// Helper to serve the unmodified app
const serveApp = (res: Response) => {
  const template = getTemplate();
  if (template) {
    res.send(template);
  } else {
    res.status(404).send('Not found');
  }
};

// Basic HTML escaper
const escapeHtml = (unsafe: string) => {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
};

export default router;
