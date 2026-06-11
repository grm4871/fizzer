import { useState, useEffect } from 'react';
import UserSplash from '../components/UserSplash';
import { ContentWithNetdocEmbeds } from '../components/NetdocEmbed';
import { apiFetch } from '../utils/api';
import './styles.css';

interface Version {
  id: string;
  content: string;
  title?: string;
  created_at: string;
  author?: {
    displayName: string;
    username: string;
  };
  label?: string;
}

interface NetdocHistoryProps {
  netdoc: {
    id: string;
    versions?: Version[];
  };
  profileId: string;
  onNetdocUpdate?: (updatedNetdoc: any) => void;
  onNavigate?: (path: string) => void;
  onOpenNetdocInNewTab?: (netdocId: string, netdocName: string) => void;
  onClose?: () => void;
}

export default function NetdocHistory({
  netdoc,
  profileId,
  onNetdocUpdate,
  onNavigate,
  onOpenNetdocInNewTab,
  onClose
}: NetdocHistoryProps) {
  const [selectedVersion, setSelectedVersion] = useState<Version | null>(null);
  const [loading, setLoading] = useState(!netdoc.versions);

  const fetchVersions = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/netdoc/${netdoc.id}?userId=${profileId}&includeVersions=true`);
      if (res.ok) {
        const data = await res.json();
        if (data.versions && onNetdocUpdate) {
          onNetdocUpdate({ ...netdoc, versions: data.versions });
        }
      }
    } catch (err) {
      console.error('Error fetching versions:', err);
    } finally {
      setLoading(false);
    }
  };

  // Fetch versions on mount if not already loaded
  useEffect(() => {
    if (!netdoc.versions) {
      fetchVersions();
    }
  }, [netdoc.id]);

  const handleNavigate = (path: string) => {
    if (onNavigate) {
      const match = path.match(/^\/netdoc\/([^/]+)$/);
      if (match) {
        onNavigate(path);
      }
    }
  };

  // If viewing a specific version
  if (selectedVersion) {
    return (
      <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.75em', flex: '1 1 auto', minHeight: 0 }}>
        {/* Version header */}
        <div style={{
          color: '#dec572',
          fontSize: '0.9em',
          fontStyle: 'italic',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5em',
          padding: '0.5em'
        }}>
          <button
            onClick={async () => {
              setSelectedVersion(null);
              await fetchVersions();
            }}
            style={{
              background: 'transparent',
              border: '1px solid #555',
              color: 'inherit',
              padding: '0.25em 0.5em',
              cursor: 'pointer',
              marginRight: '0.5em'
            }}
          >
            Back
          </button>
          <span>Version {selectedVersion.label?.replace('Version ', '') || ''}, {selectedVersion.created_at ? new Date(selectedVersion.created_at).toLocaleString() : ''}</span>
          {selectedVersion.author && (
            <>
              <span>•</span>
              <UserSplash
                displayName={selectedVersion.author.displayName}
                username={selectedVersion.author.username}
              />
            </>
          )}
        </div>
        {/* Version content */}
        <div style={{ color: 'inherit', fontSize: '0.95em', lineHeight: '1.6', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }} className="markdown-content netdoc-editor">
          <ContentWithNetdocEmbeds
            content={selectedVersion.content || ''}
            onNavigate={handleNavigate}
            userId={profileId}
            onOpenNetdocInNewTab={onOpenNetdocInNewTab}
          />
        </div>
      </div>
    );
  }

  // Versions list
  return (
    <div className="page-container" style={{ display: 'flex', flexDirection: 'column', gap: '0.75em', flex: '1 1 auto', minHeight: 0, padding: '0.5em' }}>
      {/* Header with back button */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.5em',
        flexShrink: 0
      }}>
        <button
          onClick={onClose}
          style={{
            background: 'transparent',
            border: '1px solid #555',
            color: 'inherit',
            padding: '0.25em 0.5em',
            cursor: 'pointer'
          }}
        >
          Back
        </button>
        <span style={{ color: '#dec572', fontStyle: 'italic' }}>Version history</span>
      </div>

      {/* Scrollable versions list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75em', overflowY: 'auto', flex: '1 1 auto', minHeight: 0 }} className="netdoc-editor">
      {loading ? (
        <div style={{ color: '#666', textAlign: 'center', padding: '1em' }}>
          Loading versions...
        </div>
      ) : netdoc.versions && Array.isArray(netdoc.versions) && netdoc.versions.length > 0 ? (
        netdoc.versions.map((version: Version, idx: number) => {
          const versionNumber = netdoc.versions!.length - idx;
          return (
            <div
              key={version.id || idx}
              onClick={() => {
                setSelectedVersion({
                  ...version,
                  label: `Version ${versionNumber}`
                });
              }}
              style={{
                padding: '0.75em',
                background: '#1a1a1a',
                border: '1px solid #888',
                borderRadius: '4px',
                fontSize: '0.9em',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                flexShrink: 0
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = '#242424';
                (e.currentTarget as HTMLElement).style.borderColor = '#888';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = '#1a1a1a';
                (e.currentTarget as HTMLElement).style.borderColor = '#888';
              }}
            >
              <div style={{ marginBottom: '0.5em' }}>
                <div style={{ color: 'var(--main-text)', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '0.5em', flexWrap: 'wrap' }}>
                  <span>Version {versionNumber}{idx === 0 ? ' (latest)' : ''} {version.title && `• ${version.title}`}</span>
                  <span>•</span>
                  <span style={{ color: '#888', fontSize: '0.85em', fontWeight: 'normal' }}>
                    {version.created_at ? new Date(version.created_at).toLocaleString() : 'Unknown date'}
                  </span>
                  {version.author && (
                    <>
                      <span>•</span>
                      <UserSplash
                        displayName={version.author.displayName}
                        username={version.author.username}
                        style={{ marginBottom: 0 }}
                      />
                    </>
                  )}
                </div>
              </div>
              <div style={{ color: '#888', whiteSpace: 'pre-wrap', overflow: 'hidden', textOverflow: 'ellipsis', maxHeight: '3em' }}>
                {version.content ? version.content.substring(0, 150) + (version.content.length > 150 ? '...' : '') : '(No content)'}
              </div>
            </div>
          );
        })
      ) : (
        <div style={{ color: '#666', textAlign: 'center', padding: '1em' }}>
          No versions yet
        </div>
      )}
      </div>
    </div>
  );
}
