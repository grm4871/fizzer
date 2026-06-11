import React, { useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { remarkStrikethroughOnly } from '../../utils/remarkStrikethroughOnly';
//import { FolderEmbedLoader } from '../FolderEmbed';
import { NetdocEmbedLoader } from './NetdocEmbed';
import { MediaGallery } from './MediaEmbed';
import { AudioPlayer } from './AudioPlayer';
import {
  getOpenLinkNewTab,
  isSameSite,
  getPathFromUrl,
  isGCSMediaUrl,
  isNetdocUrl,
  isFolderUrl
} from './utils';
import UniversalEmbed, { getEmbedUrl } from '../../components/UniversalEmbed';
import '../../styles/collapsed.css';

interface ContentWithNetdocEmbedsProps {
  content: string;
  onNavigate: (path: string) => void;
  userId?: string;
  parentNetdocId?: string;
  onOpenNetdocInNewTab?: (netdocId: string, netdocName: string) => void;
  onContextMenuOpen?: (e: React.MouseEvent, netdocId: string, netdocName: string) => void;
  onScrollToNetdoc?: (targetNetdocId: string) => boolean;
  isOwnPost?: boolean;
  childNetdocIds?: Set<string>;
  onJumpToComment?: (commentId: string) => void;
  disableBlockquotes?: boolean;
  onNavigateToFolder?: (folderId: string, folderName: string) => void;
}

const plugins = [remarkBreaks, remarkGfm, remarkStrikethroughOnly];

export const ContentWithNetdocEmbeds: React.FC<ContentWithNetdocEmbedsProps> = ({
  content,
  onNavigate,
  userId,
  parentNetdocId,
  onOpenNetdocInNewTab,
  onContextMenuOpen,
  onScrollToNetdoc,
  isOwnPost,
  childNetdocIds,
  onJumpToComment,
  disableBlockquotes = false
}) => {
  // First, separate media URLs from text content
  const { mediaUrls, textContent } = useMemo(() => {
    const lines = content.split('\n');
    const mediaUrls: string[] = [];
    const textLines: string[] = [];

    lines.forEach(line => {
      const trimmedLine = line.trim();
      if (trimmedLine) {
        let url = trimmedLine;
        if (trimmedLine.startsWith('www.')) {
          url = 'https://' + trimmedLine;
        }
        const { isMedia } = isGCSMediaUrl(url);

        if (isMedia && (trimmedLine.match(/^(https?:\/\/|www\.)/i))) {
          mediaUrls.push(url);
        } else {
          textLines.push(line);
        }
      } else {
        textLines.push(line);
      }
    });

    return { mediaUrls, textContent: textLines.join('\n') };
  }, [content]);

  // Convert plain text URLs to markdown links so they'll be recognized by ReactMarkdown
  // BUT preserve existing markdown links and autolinks
  const linkifiedContent = useMemo(() => {
    const regex = /(\[.*?\]\(.*?\)|<[^>]+>|https?:\/\/[^\s]+|www\.[^\s]+|\/netdoc\/[0-9A-HJ-NP-TV-Za-hj-np-tv-z]+|\/folder\/[0-9a-f-]{36})/gi;
    
    return textContent.split(regex).map(part => {
      // If it's a markdown link or autolink, keep as is
      if (part.match(/^\[.*?\]\(.*?\)$/) || part.match(/^<[^>]+>$/)) {
        return part;
      }
      
      // If it's a plain URL or path
      if (part.match(/^(https?:\/\/[^\s]+|www\.[^\s]+|\/netdoc\/[0-9A-HJ-NP-TV-Za-hj-np-tv-z]+|\/folder\/[0-9a-f-]{36})$/i)) {
        let url = part;
        if (part.startsWith('www.')) {
          url = 'https://' + part;
        }
        
        // Check if internal (Netdoc, Folder, or Media) or external embed (YouTube, Spotify, etc.)
        const { isNetdoc } = isNetdocUrl(url);
        const { isFolder } = isFolderUrl(url);
        const { isMedia } = isGCSMediaUrl(url);
        const externalEmbed = getEmbedUrl(url);

        if (isNetdoc || isFolder || isMedia || externalEmbed) {
          // Embeddable: Keep as plain text so detectedEmbeds can find it
          return part;
        } else {
          // Non-embeddable external: Convert to autolink so it renders as a clickable link
          return `<${url}>`;
        }
      }
      
      return part;
    }).join('');
  }, [textContent]);

  // Extract internal embeds (Netdoc/Folder/Media) and external embeds (YouTube, Spotify, etc.) from the text
  const detectedEmbeds = useMemo(() => {
    const regex = /(\[.*?\]\(.*?\)|<[^>]+>|https?:\/\/[^\s]+|www\.[^\s]+|\/netdoc\/[0-9A-HJ-NP-TV-Za-hj-np-tv-z]+|\/folder\/[0-9a-f-]{36})/gi;
    const embeds: { url: string; type: 'netdoc' | 'folder' | 'media' | 'external'; id?: string; index: number }[] = [];

    let match;
    while ((match = regex.exec(linkifiedContent)) !== null) {
      const part = match[0];

      // Ignore markdown links and autolinks
      if (part.match(/^\[.*?\]\(.*?\)$/) || part.match(/^<[^>]+>$/)) {
        continue;
      }

      // Check plain URLs for internal content
      let url = part;
      if (part.startsWith('www.')) {
        url = 'https://' + part;
      }

      const { isNetdoc, netdocId } = isNetdocUrl(url);
      if (isNetdoc && netdocId) {
        embeds.push({ url, type: 'netdoc', id: netdocId, index: match.index });
        continue;
      }

      const { isFolder, folderId } = isFolderUrl(url);
      if (isFolder && folderId) {
        embeds.push({ url, type: 'folder', id: folderId, index: match.index });
        continue;
      }

      const { isMedia } = isGCSMediaUrl(url);
      if (isMedia) {
        embeds.push({ url, type: 'media', index: match.index });
        continue;
      }

      // Check for external embeddable services (YouTube, Spotify, etc.)
      const embedUrl = getEmbedUrl(url);
      if (embedUrl) {
        embeds.push({ url, type: 'external', index: match.index });
      }
    }
    return embeds;
  }, [linkifiedContent]);

  // Custom link component - ONLY handles navigation, NO embedding
  const CustomLink = useCallback(({ href, children, ...props }: any) => {
    if (href) {
      // Check if it's a same-site link
      if (isSameSite(href)) {
        const path = getPathFromUrl(href);
        if (path) {
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(path);
              }}
              style={{
                color: 'var(--dark-accent)',
                textDecoration: 'underline',
                cursor: 'pointer'
              }}
              {...props}
            >
              {children}
            </a>
          );
        }
      }

      // External link - make it clickable
      const openNewTab = getOpenLinkNewTab();
      const target = openNewTab ? '_blank' : '_self';
      return (
        <a
          href={href}
          target={target}
          rel="noopener noreferrer"
          style={{
            color: 'var(--dark-accent)',
            textDecoration: 'underline',
            cursor: 'pointer'
          }}
          {...props}
        >
          {children}
        </a>
      );
    }
    return <a {...props}>{children}</a>;
  }, [onNavigate]);

  // Memoize components object
  const markdownComponents = useMemo(() => ({
    a: CustomLink,
    ol: ({ node, children, ...props }: any) => {
      // Cycle list-style-type based on nesting depth: I → A → 1 → a → i
      const olCycle = ['upper-roman', 'upper-alpha', 'decimal', 'lower-alpha', 'lower-roman'];
      return <ol {...props} ref={(el: HTMLOListElement | null) => {
        if (!el) return;
        let depth = 0;
        let parent = el.parentElement;
        while (parent) {
          if (parent.tagName === 'OL') depth++;
          parent = parent.parentElement;
        }
        el.style.listStyleType = olCycle[depth % olCycle.length];
      }}>{children}</ol>;
    },
    ...(disableBlockquotes ? {
      blockquote: ({ children }: any) => <span>{`> `}{children}</span>,
      p: ({ children }: any) => <>{children}</>
    } : {})
  }), [CustomLink, disableBlockquotes]);

  // If no embeds found, just render markdown
  if (detectedEmbeds.length === 0) {
    return (
      <>
        <MediaGallery urls={mediaUrls} isOwnPost={isOwnPost} />
        <ReactMarkdown
          remarkPlugins={plugins}
          components={markdownComponents}
        >
          {linkifiedContent}
        </ReactMarkdown>
      </>
    );
  }

  // Split content into parts: markdown and embed placeholders
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  detectedEmbeds.forEach((embed, i) => {
    // Add markdown content before this embed
    if (embed.index > lastIndex) {
      const markdownChunk = linkifiedContent.substring(lastIndex, embed.index);
      parts.push(
        <ReactMarkdown
          key={`md-${i}`}
          remarkPlugins={plugins}
          components={markdownComponents}
        >
          {markdownChunk}
        </ReactMarkdown>
      );
    }

    // Add the embed
    if (embed.type === 'netdoc' && embed.id) {
      parts.push(
        <div key={`embed-${i}`} style={{ marginTop: '0.5em', marginBottom: '0.5em' }}>
          <NetdocEmbedLoader
            netdocId={embed.id}
            onNavigate={onNavigate}
            userId={userId}
            parentNetdocId={parentNetdocId}
            onOpenNetdocInNewTab={onOpenNetdocInNewTab}
            onContextMenuOpen={onContextMenuOpen}
            onScrollToNetdoc={onScrollToNetdoc}
            childNetdocIds={childNetdocIds}
            onJumpToComment={onJumpToComment}
          />
        </div>
      );
    // } else if (embed.type === 'folder' && embed.id) {
    //   parts.push(
    //     <div key={`embed-${i}`} style={{ marginTop: '0.5em', marginBottom: '0.5em' }}>
    //       <FolderEmbedLoader
    //         folderId={embed.id}
    //         onNavigate={onNavigateToFolder}
    //       />
    //     </div>
    //   );
    } else if (embed.type === 'media') {
      const { mediaType } = isGCSMediaUrl(embed.url);
      if (mediaType === 'image') {
        parts.push(
          <img
            key={`embed-${i}`}
            src={embed.url}
            alt="Embedded image"
            style={{
              maxWidth: '100%',
              width: 'auto',
              height: 'auto',
              maxHeight: '400px',
              display: 'block',
              marginTop: '0.5em',
              marginBottom: '0.5em'
            }}
          />
        );
      } else if (mediaType === 'video') {
        parts.push(
          <video
            key={`embed-${i}`}
            src={embed.url}
            controls
            style={{
              maxWidth: '100%',
              width: 'auto',
              maxHeight: '400px',
              display: 'block',
              marginTop: '0.5em',
              marginBottom: '0.5em'
            }}
          />
        );
      } else if (mediaType === 'audio') {
        parts.push(
          <AudioPlayer
            key={`embed-${i}`}
            url={embed.url}
            style={{
              marginTop: '0.5em',
              marginBottom: '0.5em'
            }}
          />
        );
      }
    } else if (embed.type === 'external') {
      parts.push(
        <UniversalEmbed
          key={`embed-${i}`}
          url={embed.url}
        />
      );
    }

    lastIndex = embed.index + embed.url.length;
  });

  // Add remaining markdown content
  if (lastIndex < linkifiedContent.length) {
    const remainingMarkdown = linkifiedContent.substring(lastIndex);
    parts.push(
      <ReactMarkdown
        key="md-end"
        remarkPlugins={plugins}
        components={markdownComponents}
      >
        {remainingMarkdown}
      </ReactMarkdown>
    );
  }

  // Split media gallery from text content
  return (
    <>
      <MediaGallery urls={mediaUrls} isOwnPost={isOwnPost} />
      {parts}
    </>
  );
};

export default ContentWithNetdocEmbeds;
