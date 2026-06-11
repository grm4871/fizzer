import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { apiFetch } from '../utils/api';
import '../styles/embed.css';

interface EmbedNetdoc {
  id: string;
  name: string;
  content: string;
  creator_id: string;
  creator: {
    id: string;
    username: string;
    displayName: string;
    color: string;
  };
  created_at: string;
}

export default function Embed() {
  const { id } = useParams<{ id: string }>();
  const [netdoc, setNetdoc] = useState<EmbedNetdoc | null>(null);
  const [error, setError] = useState<string>('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setError('No netdoc ID provided');
      setIsLoading(false);
      return;
    }

    (async () => {
      try {
        const res = await apiFetch(`/api/netdoc/${id}`);
        if (!res.ok) {
          if (res.status === 404) {
            setError('Netdoc not found');
          } else if (res.status === 403) {
            setError('This netdoc is private');
          } else {
            setError('Failed to load netdoc');
          }
          return;
        }
        const data = await res.json();
        setNetdoc(data);
      } catch (err) {
        console.error('Embed fetch error:', err);
        setError('Failed to load netdoc');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [id]);

  // Truncate content for preview
  const getContentPreview = (content: string, maxLength = 500) => {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength).trim() + '...';
  };

  if (isLoading) {
    return (
      <div className="embed-container">
        <div className="embed-loading">Loading...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="embed-container">
        <div className="embed-error">{error}</div>
      </div>
    );
  }

  if (!netdoc) {
    return (
      <div className="embed-container">
        <div className="embed-error">Netdoc not found</div>
      </div>
    );
  }

  const netdocUrl = `${window.location.origin}/netdoc/${netdoc.id}`;

  return (
    <div className="embed-container">
      <div className="embed-header">
        <h1 className="embed-title">{netdoc.name || 'Untitled'}</h1>
        <div className="embed-author">
          <span 
            className="embed-author-color" 
            style={{ backgroundColor: `#${netdoc.creator.color}` }}
          />
          <span className="embed-author-name">
            {netdoc.creator.displayName || netdoc.creator.username}
          </span>
        </div>
      </div>
      
      <div className="embed-content">
        {getContentPreview(netdoc.content)}
      </div>
      
      <a 
        href={netdocUrl} 
        target="_blank" 
        rel="noopener noreferrer"
        className="embed-link"
      >
        View on Netaris →
      </a>
    </div>
  );
}
