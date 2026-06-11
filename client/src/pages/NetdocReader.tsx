import { forwardRef, useImperativeHandle, useState, useEffect } from 'react';
import { ContentWithNetdocEmbeds } from '../components/NetdocEmbed';
import DocumentButtons from '../components/DocumentButtons';
import { apiFetch } from '../utils/api';
import '../styles/markdown.css';
import './styles.css';

export interface NetdocReaderState {
  scrollPosition: number;
}

export interface NetdocReaderHandle {
  getState: () => NetdocReaderState | null;
}

interface NetdocReaderProps {
  netdoc: any;
  netdocId?: string;
  profileId: string;
  onNavigateToNetdoc?: (netdocId: string, netdocName: string) => void;
  onOpenNetdocInNewTab?: (netdocId: string, netdocName: string) => void;
  onNetdocLoad?: (netdoc: any) => void;
  onDownload?: () => void;
  onVersions?: () => void;
  onBookmarkChange?: () => void;
  onPermissions?: () => void;
  isBookmarked?: boolean;
  isOwner?: boolean;
  isRemote?: boolean;
  isElectron?: boolean;
  hideButtons?: boolean;
}

const NetdocReader = forwardRef<NetdocReaderHandle, NetdocReaderProps>(({
  netdoc: propNetdoc,
  netdocId,
  profileId,
  onNavigateToNetdoc,
  onOpenNetdocInNewTab,
  onNetdocLoad,
  onDownload,
  onVersions,
  onBookmarkChange,
  onPermissions,
  isBookmarked = false,
  isOwner = false,
  isRemote = true,
  isElectron = false,
  hideButtons = false,
}, ref) => {
  const [localNetdoc, setLocalNetdoc] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Use prop netdoc if available, otherwise use locally fetched
  const netdoc = propNetdoc || localNetdoc;

  // Fetch netdoc if not provided via props
  useEffect(() => {
    if (propNetdoc || !netdocId) return;

    setIsLoading(true);
    const abortController = new AbortController();

    (async () => {
      try {
        const res = await apiFetch(`/api/netdoc/${netdocId}`, {
          signal: abortController.signal
        });
        if (res.ok) {
          const data = await res.json();
          setLocalNetdoc(data);
          onNetdocLoad?.(data);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.error('[NetdocReader] Error fetching netdoc:', err);
        }
      } finally {
        setIsLoading(false);
      }
    })();

    return () => abortController.abort();
  }, [netdocId, propNetdoc, onNetdocLoad]);

  useImperativeHandle(ref, () => ({
    getState: () => ({
      scrollPosition: 0, // TODO: track scroll position
    })
  }));

  if (isLoading) {
    return <div style={{ padding: '1em', color: '#888' }}>Loading...</div>;
  }

  if (!netdoc) {
    return <div style={{ padding: '1em', color: '#888' }}>No document loaded</div>;
  }

  const handleNavigate = (path: string) => {
    // Extract netdoc ID from path like /netdoc/abc123
    const match = path.match(/\/netdoc\/([^/]+)/);
    if (match && onNavigateToNetdoc) {
      onNavigateToNetdoc(match[1], '');
    }
  };

  return (
    <div className="page-container">
      {/* Document buttons toolbar */}


      {/* Scrollable content area */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1em',
        minHeight: 0,
      }}>
              <div style={{
        display: 'flex',
        alignItems: 'center',
        paddingTop: '.5em',
        paddingBottom: '.5em',
        flexShrink: 0,
      }}>
        {!hideButtons && (
          <DocumentButtons
            mode="read"
            isEditor={false}
            isOwner={isOwner}
            isBookmarked={isBookmarked}
            onVersions={onVersions}
            onDownload={onDownload}
            onBookmarkChange={onBookmarkChange}
            onPermissions={onPermissions}
            isRemote={isRemote}
            isElectron={isElectron}
            docId={netdoc.id}
            canViewHistory={netdoc.canViewHistory !== false}
          />
        )}
      </div>
        <div className="markdown-content" style={{
          color: 'inherit',
          fontSize: '0.95em',
          lineHeight: '1.6',
        }}>
          <ContentWithNetdocEmbeds
            content={netdoc.content || ''}
            onNavigate={handleNavigate}
            userId={profileId}
            onOpenNetdocInNewTab={onOpenNetdocInNewTab}
          />
        </div>
      </div>
    </div>
  );
});

NetdocReader.displayName = 'NetdocReader';
export default NetdocReader;
