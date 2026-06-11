import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { remarkStrikethroughOnly } from '../../utils/remarkStrikethroughOnly';
import { apiFetch } from '../../utils/api';
import UserSplash from '../../components/UserSplash';
import { getOpenLinkNewTab, createMarkdownLinkComponent } from './utils';

/**
 * Component that loads and displays a netdoc embed
 */
interface NetdocEmbedLoaderProps {
  netdocId: string;
  onNavigate: (path: string) => void;
  userId?: string;
  parentNetdocId?: string;
  onOpenNetdocInNewTab?: (netdocId: string, netdocName: string) => void;
  onContextMenuOpen?: (e: React.MouseEvent, netdocId: string, netdocName: string) => void;
  onScrollToNetdoc?: (targetNetdocId: string) => boolean;
  childNetdocIds?: Set<string>;
  onJumpToComment?: (commentId: string) => void;
}

export const NetdocEmbedLoader: React.FC<NetdocEmbedLoaderProps> = ({ 
  netdocId, 
  onNavigate, 
  userId, 
  parentNetdocId, 
  onOpenNetdocInNewTab, 
  onContextMenuOpen, 
  onScrollToNetdoc, 
  childNetdocIds, 
  onJumpToComment 
}) => {
  const [netdoc, setNetdoc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchNetdoc = async () => {
      try {
        const params = new URLSearchParams();
        if (userId) params.append('userId', userId);
        if (parentNetdocId) params.append('parentNetdocId', parentNetdocId);

        const res = await apiFetch(`/api/netdoc/${netdocId}?${params.toString()}`);

        if (!res.ok) {
          if (res.status === 404) {
            setError('Netdoc not found');
          } else if (res.status === 403) {
            setError('Not permitted');
          } else {
            setError('Failed to load netdoc');
          }
          setLoading(false);
          return;
        }

        const data = await res.json();
        setNetdoc(data);
        setLoading(false);
      } catch (err) {
        setError('Failed to load netdoc');
        setLoading(false);
      }
    };

    fetchNetdoc();
  }, [netdocId, userId, parentNetdocId]);

  if (loading) {
    return (
      <div style={{ padding: '1em', color: '#888', fontStyle: 'italic' }}>
        Loading netdoc...
      </div>
    );
  }

  if (error || !netdoc) {
    return (
      <div style={{ padding: '1em', color: '#888', fontStyle: 'italic' }}>
        {error || 'Failed to load netdoc'}
      </div>
    );
  }

  return (
    <NetdocEmbed 
      netdoc={netdoc} 
      onNavigate={onNavigate} 
      onOpenNetdocInNewTab={onOpenNetdocInNewTab} 
      onContextMenuOpen={onContextMenuOpen} 
      onScrollToNetdoc={onScrollToNetdoc} 
      childNetdocIds={childNetdocIds} 
      onJumpToComment={onJumpToComment} 
      parentNetdocId={parentNetdocId} 
    />
  );
};

interface NetdocEmbedProps {
  netdoc: {
    id: string;
    name: string;
    content: string;
    creator_id?: string;
    created_at?: string;
    updated_at?: string;
    creator?: {
      id: string;
      username: string;
      displayName: string;
      color?: string;
    };
    space?: {
      id: string;
      name: string;
    } | null;
  };
  onNavigate: (path: string) => void;
  onOpenNetdocInNewTab?: (netdocId: string, netdocName: string) => void;
  onContextMenuOpen?: (e: React.MouseEvent, netdocId: string, netdocName: string) => void;
  onScrollToNetdoc?: (targetNetdocId: string) => boolean;
  childNetdocIds?: Set<string>;
  onJumpToComment?: (commentId: string) => void;
  parentNetdocId?: string;
}

export default function NetdocEmbed({ 
  netdoc, 
  onNavigate, 
  onOpenNetdocInNewTab, 
  onContextMenuOpen, 
  onScrollToNetdoc, 
  onJumpToComment, 
  parentNetdocId 
}: NetdocEmbedProps) {
  return (
    <div
      onMouseDown={(e) => {
        // Middle mouse button (button 1) opens in new tab
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          if (onOpenNetdocInNewTab) {
            onOpenNetdocInNewTab(netdoc.id, netdoc.name || 'Netdoc');
          } else {
            onNavigate(`/netdoc/${netdoc.id}`);
          }
        }
      }}
      onClick={(e) => {
        e.stopPropagation();

        // META key (cmd on Mac, ctrl on Windows/Linux) opens in new tab
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          if (onOpenNetdocInNewTab) {
            onOpenNetdocInNewTab(netdoc.id, netdoc.name || 'Netdoc');
          } else {
            const netdocParentId = (netdoc as any).parent_id || (netdoc as any).parentId;

            if (onJumpToComment && parentNetdocId && netdocParentId && String(netdocParentId) === String(parentNetdocId)) {
              onJumpToComment(netdoc.id);
            } else {
              onNavigate(`/netdoc/${netdoc.id}`);
            }
          }
          return;
        }

        // Single click: try to scroll to the netdoc if it's in the current thread
        if (onScrollToNetdoc) {
          const scrolled = onScrollToNetdoc(netdoc.id);
          if (scrolled) {
            return;
          }
        }

        const netdocParentId = (netdoc as any).parent_id || (netdoc as any).parentId;

        if (onJumpToComment && parentNetdocId && netdocParentId && String(netdocParentId) === String(parentNetdocId)) {
          onJumpToComment(netdoc.id);
          return;
        }

        // Respect openLinkNewTab setting
        const openNewTab = getOpenLinkNewTab();
        if (openNewTab && onOpenNetdocInNewTab) {
          onOpenNetdocInNewTab(netdoc.id, netdoc.name || 'Netdoc');
        } else {
          onNavigate(`/netdoc/${netdoc.id}`);
        }
      }}
      onContextMenu={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (onContextMenuOpen) {
          onContextMenuOpen(e, netdoc.id, netdoc.name || 'Netdoc');
        }
      }}
      style={{
        background: '#111',
        border: '1px solid #474336',
        borderRadius: '0',
        padding: '0.75em',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: '1em',
        transition: 'background 0.2s ease'
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = '#1a1a1a')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '#111')}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25em', minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
          <strong>{netdoc.name}</strong>
          {netdoc.space && (
            <>
              <span style={{ color: '#666' }}>•</span>
              <span style={{ color: '#888', fontSize: '0.85em' }}>{netdoc.space.name}</span>
            </>
          )}
          {netdoc.creator && (
            <>
              <span style={{ color: '#666' }}>•</span>
              <UserSplash
                displayName={netdoc.creator.displayName}
                username={netdoc.creator.username}
                style={{ marginBottom: 0 }}
              />
            </>
          )}
        </div>
        {netdoc.content && netdoc.content.trim().length > 0 && (
          <div
            style={{
              color: '#888',
              fontSize: '0.9em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxHeight: '3.5em',
            }}
          >
            <ReactMarkdown
              remarkPlugins={[remarkBreaks, remarkGfm, remarkStrikethroughOnly]}
              components={{
                a: createMarkdownLinkComponent(onNavigate),
                p: ({ children }) => <p style={{ marginBottom: '0.5em' }}>{children}</p>
              }}
            >
              {netdoc.content.substring(0, 2000)}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
