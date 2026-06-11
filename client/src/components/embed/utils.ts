import React from 'react';

/**
 * Get link behavior setting from localStorage
 * Returns true if links should open in new tab, false for same tab (default)
 */
export const getOpenLinkNewTab = (): boolean => {
  try {
    const savedSettings = localStorage.getItem('localsettings');
    if (savedSettings) {
      const settings = JSON.parse(savedSettings);
      return settings.openLinkNewTab ?? false;
    }
  } catch (error) {
    console.error('Failed to parse localsettings:', error);
  }
  return false;
};

/**
 * Check if a URL is on the same domain as the current site
 */
export const isSameSite = (url: string): boolean => {
  try {
    const linkUrl = new URL(url);
    const currentDomain = window.location.hostname;
    return linkUrl.hostname === currentDomain;
  } catch (e) {
    return false;
  }
};

/**
 * Extract path from a same-site URL
 */
export const getPathFromUrl = (url: string): string | null => {
  try {
    const linkUrl = new URL(url);
    return linkUrl.pathname + linkUrl.search + linkUrl.hash;
  } catch (e) {
    return null;
  }
};

/**
 * Convert URLs in text to clickable links
 * - Same-site links use React Router navigation (if onNavigate is provided)
 * - External links open in new tab (_blank) with security attributes
 * - Handles both http(s):// and www. URLs
 */
export const linkify = (text: string, onNavigate?: (path: string) => void) => {
  // URL regex pattern
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const parts = text.split(urlRegex);

  return parts.map((part, index) => {
    if (part.match(urlRegex)) {
      let url = part;
      // Add https:// if it starts with www.
      if (part.startsWith('www.')) {
        url = 'https://' + part;
      }

      // Check if URL is same domain
      const sameSite = isSameSite(url);

      // For same-site links, use React Router navigation if available
      if (sameSite && onNavigate) {
        const path = getPathFromUrl(url);
        if (path) {
          return React.createElement('a', {
            key: index,
            href: url,
            onClick: (e: React.MouseEvent) => {
              e.preventDefault();
              onNavigate(path);
            },
            style: {
              color: 'var(--dark-accent)',
              textDecoration: 'underline',
              cursor: 'pointer'
            }
          }, part);
        }
      }

      // External links or same-site without navigation handler
      const openNewTab = getOpenLinkNewTab();
      const target = sameSite ? '_self' : (openNewTab ? '_blank' : '_self');

      return React.createElement('a', {
        key: index,
        href: url,
        target: target,
        rel: sameSite ? undefined : 'noopener noreferrer',
        style: {
          color: 'var(--dark-accent)',
          textDecoration: 'underline',
          cursor: 'pointer'
        }
      }, part);
    }
    return React.createElement('span', { key: index }, part);
  });
};

/**
 * Format content with line breaks and linkified URLs
 */
export const formatContent = (content: string, onNavigate?: (path: string) => void) => {
  return content.split('\n').map((line, i) =>
    React.createElement('p', {
      key: i,
      style: {
        paddingTop: "0.5em",
        paddingBottom: "0.5em",
        wordWrap: "break-word",
        overflowWrap: "break-word"
      }
    }, linkify(line, onNavigate))
  );
};

/**
 * Create a custom link component for ReactMarkdown that handles same-site navigation
 */
export const createMarkdownLinkComponent = (onNavigate: (path: string) => void) => {
  return ({ node, href, ...props }: any) => {
    if (href && isSameSite(href)) {
      const path = getPathFromUrl(href);
      if (path) {
        return React.createElement('a', {
          href: href,
          onClick: (e: React.MouseEvent) => {
            e.preventDefault();
            onNavigate(path);
          },
          ...props
        });
      }
    }
    const openNewTab = getOpenLinkNewTab();
    const target = openNewTab ? '_blank' : '_self';
    return React.createElement('a', { href, target, rel: 'noopener noreferrer', ...props });
  };
};

/**
 * Check if a URL is a Google Cloud Storage media URL or any external image/video URL
 */
export const isGCSMediaUrl = (url: string): { isMedia: boolean; mediaType?: 'image' | 'video' | 'audio' } => {
  try {
    let urlObj: URL;
    try {
      urlObj = new URL(url);
    } catch (e) {
      // Try encoding spaces for the URL parsing
      urlObj = new URL(url.replace(/ /g, '%20'));
    }
    const path = urlObj.pathname.toLowerCase();

    // Check for image extensions (any domain)
    if (/\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(path)) {
      return { isMedia: true, mediaType: 'image' };
    }

    // Check for audio extensions (any domain)
    // VOICE NOTE SPECIAL CASE: .webm files containing 'voice-note' are audio
    if (/\.(mp3|wav|ogg|m4a|aac)$/i.test(path) || (/\.webm$/i.test(path) && path.includes('voice-note'))) {
      return { isMedia: true, mediaType: 'audio' };
    }

    // Check for video extensions (any domain)
    if (/\.(mp4|webm|ogg|mov|avi|mkv|flv)$/i.test(path)) {
      return { isMedia: true, mediaType: 'video' };
    }

    return { isMedia: false };
  } catch (e) {
    return { isMedia: false };
  }
};

/**
 * Check if a URL is a netdoc URL and extract the netdoc ID
 */
export const isNetdocUrl = (url: string): { isNetdoc: boolean; netdocId?: string } => {
  let pathname = url;

  try {
    // Check if it's a full URL
    const urlObj = new URL(url);

    // If full URL, check if it's same site
    if (urlObj.hostname !== window.location.hostname) {
      return { isNetdoc: false };
    }

    pathname = urlObj.pathname;
  } catch (e) {
    // Not a full URL, assume relative path if it starts with /
    if (!url.startsWith('/')) {
      return { isNetdoc: false };
    }
  }

  // Normalize pathname (remove trailing slash)
  if (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  if (pathname.startsWith('/netdoc/')) {
    const id = pathname.substring('/netdoc/'.length).split(/[?#]/)[0];
    // Crockford base32: 0-9, A-Z excluding I, L, O, U
    if (/^[0-9A-HJ-NP-TV-Za-hj-np-tv-z]+$/.test(id)) {
      return { isNetdoc: true, netdocId: id };
    }
  }

  return { isNetdoc: false };
};

/**
 * Check if a URL is a folder URL and extract the folder ID
 */
export const isFolderUrl = (url: string): { isFolder: boolean; folderId?: string } => {
  let pathname = url;

  try {
    const urlObj = new URL(url);
    if (urlObj.hostname !== window.location.hostname) {
      return { isFolder: false };
    }
    pathname = urlObj.pathname;
  } catch (e) {
    if (!url.startsWith('/')) {
      return { isFolder: false };
    }
  }

  if (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  if (pathname.startsWith('/folder/')) {
    const id = pathname.substring('/folder/'.length).split(/[?#]/)[0];
    // UUID format for shared folders
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return { isFolder: true, folderId: id };
    }
  }

  return { isFolder: false };
};

/**
 * Render a URL as a non-clickable pseudolink (teal span)
 */
export const renderAsPseudolink = (text: string, key?: number) => {
  return React.createElement('span', { key, className: 'pseudolink' }, text);
};

/**
 * Format content with all links rendered as pseudolinks (for collapsed contexts)
 */
export const formatContentWithPseudolinks = (content: string) => {
  const urlRegex = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;

  return content.split('\n').map((line, lineIndex) => {
    const parts = line.split(urlRegex);

    return React.createElement('p', {
      key: lineIndex,
      style: {
        paddingTop: "0.5em",
        paddingBottom: "0.5em",
        wordWrap: "break-word",
        overflowWrap: "break-word"
      }
    }, parts.map((part, partIndex) => {
      if (part.match(urlRegex)) {
        return renderAsPseudolink(part, partIndex);
      }
      return React.createElement('span', { key: partIndex }, part);
    }));
  });
};
