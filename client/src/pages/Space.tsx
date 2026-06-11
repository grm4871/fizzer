import { useState, useEffect } from 'react';
import { ContentWithNetdocEmbeds } from '../components/NetdocEmbed';
import { apiFetch } from '../utils/api';
import { Creator } from '../types';
import DocumentButtons from '../components/DocumentButtons';
import '../styles/markdown.css';

interface SpaceMember {
  userId: string;
  role: string;
  profile: Creator;
}

interface SpaceProps {
  space: { id: string; name: string; description?: string; monarchDisplayName?: string; monarchUsername?: string; monarchColor?: string; jacketId?: string; canWrite?: boolean; members?: SpaceMember[]; isProfile?: boolean; isCollection?: boolean } | null;
  error?: string | null;
  onNavigate?: (path: string) => void;
  onPermissions?: () => void;
  onVersions?: () => void;
  onDownload?: () => void;
  canWrite?: boolean;
  hideButtons?: boolean;
  profileId?: string;
}

export default function Space({ space, error, onNavigate, onPermissions, onVersions, onDownload, canWrite = false, hideButtons = false, profileId }: SpaceProps) {
  const [jacketContent, setJacketContent] = useState<string | null>(null);

  useEffect(() => {
    if (!space?.jacketId) { setJacketContent(null); return; }

    const abortController = new AbortController();
    apiFetch(`/api/netdoc/${space.jacketId}`, { signal: abortController.signal })
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data) setJacketContent(data.content || ''); })
      .catch(err => { if (err?.name !== 'AbortError') console.error('[Space] Error fetching jacket:', err); });

    return () => abortController.abort();
  }, [space?.jacketId]);

  if (error) {
    return (
      <div style={{ padding: '2em', textAlign: 'center', color: '#888' }}>
        {error}
      </div>
    );
  }

  if (!space) {
    return (
      <div style={{ padding: '2em', textAlign: 'center', color: '#666' }}>
        Loading space...
      </div>
    );
  }

  const custodians = space.members?.filter(m => m.role === 'custodian') || [];

  return (
    <div style={{ padding: '1.5em', overflow: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75em', marginBottom: '0.5em' }}>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <h1 style={{
            margin: 0,
            fontSize: '1.5rem',
            color: 'var(--main-text)'
          }}>
            {space.name}
          </h1>
          {(space.monarchDisplayName || space.monarchUsername) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.85em', marginTop: '0.2em' }}>
              {space.monarchDisplayName && <span style={{ color: space.monarchColor ? `#${space.monarchColor}` : '#888' }}>{space.monarchDisplayName}</span>}
              {space.monarchUsername && <span style={{ color: '#555' }}>@{space.monarchUsername}</span>}
            </div>
          )}
        </div>
        {!space.isCollection && !hideButtons && (
          <>
            <DocumentButtons
              mode="read"
              isEditor={false}
              isOwner={canWrite}
              docId={space.jacketId || space.id}
              onPermissions={onPermissions}
              onVersions={onVersions}
              onDownload={onDownload}
              canViewHistory={!!space.jacketId}
            />
          </>
        )}
      </div>
      {space.description && (
        <p style={{ margin: '0 0 0.5em 0', color: '#888', fontSize: '0.9em' }}>
          {space.description}
        </p>
      )}
      {custodians.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em', fontSize: '0.8em', marginTop: '0.3em', color: '#777' }}>
          <span style={{ color: '#c1a263' }}>custodians:</span>
          {custodians.map(c => (
            <span key={c.userId} style={{ color: c.profile.color ? `#${c.profile.color}` : '#888' }}>
              {c.profile.displayName}
            </span>
          ))}
        </div>
      )}
      {jacketContent && (
        <div className="markdown-content" style={{ marginTop: '1em', fontSize: '0.95em', lineHeight: '1.6' }}>
          <ContentWithNetdocEmbeds
            content={jacketContent}
            onNavigate={onNavigate || (() => {})}
          />
        </div>
      )}
    </div>
  );
}
