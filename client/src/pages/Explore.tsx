import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../utils/api';
import { FeedList, FeedItem, formatTimeAgo } from '../components/Feed';

interface ExploreProps {
  onReplaceTab?: (netdocId: string, netdocName: string) => void;
  userId?: string;
}

interface FeedItem {
  id: string;
  name: string;
  content: string;
  creator_id: string;
  created_at: string;
  updated_at: string;
  creator: {
    id: string;
    username: string;
    displayName: string;
    color: string;
  };
  score: number;
  type: 'netdoc' | 'space';
  space?: { id: string; name: string } | null;
}


export default function Explore({ onReplaceTab, userId }: ExploreProps) {
  const navigate = useNavigate();
  const [recommendations, setRecommendations] = useState<FeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [debouncedQuery] = useState('');
  const [sortType] = useState<'default' | 'latest'>('latest');

  // Fetch recommendations
  const fetchRecommendations = useCallback(async () => {
    if (!userId) return;
    
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ userId, limit: '50' });
      if (debouncedQuery.trim()) {
        params.set('keyword', debouncedQuery.trim());
      }
      if (sortType === 'latest') {
        params.set('sort', 'latest');
      }
      
      const response = await apiFetch(`/api/recommendations?${params}`);
      if (response.ok) {
        const data = await response.json();
        setRecommendations(data);
      }
    } catch (err) {
      console.error('[Explore] Failed to fetch recommendations:', err);
    } finally {
      setIsLoading(false);
    }
  }, [userId, debouncedQuery, sortType]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  const handleItemClick = (item: FeedItem) => {
    if (!item.id) {
      console.error('[Explore] Item has no id:', item);
      return;
    }
    if (item.type === 'space') {
      navigate(`/space/${item.id}`);
    } else {
      if (onReplaceTab) {
        onReplaceTab(item.id, item.name);
      } else {
        navigate(`/netdoc/${item.id}`);
      }
    }
  };

  return (
    <div className="feed-root" style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'transparent',
      overflow: 'hidden'
    }}>
      {/* Feed area */}
      <FeedList isLoading={isLoading} isEmpty={recommendations.length === 0} emptyMessage="No recommendations found">
        {recommendations.filter(item => item.creator).map((item, idx) => (
          <FeedItem
            key={`${item.id}-${idx}`}
            onClick={() => 'score' in item ? handleItemClick(item as FeedItem) : undefined}
            badge={item.type === 'space' ? 'SPACE' : undefined}
            subtitle={
              <>
                {item.type === 'netdoc' && item.space && (
                  <>
                    <span style={{ color: '#888', fontSize: '0.85em' }}>
                      {item.space.name}
                    </span>
                    <span style={{ color: '#444', fontSize: '0.85em' }}>·</span>
                  </>
                )}
                <span style={{ color: `#${item.creator.color}`, fontSize: '0.9em' }}>
                  {item.creator.displayName}
                </span>
                <span style={{ color: '#555', fontSize: '0.85em' }}>
                  @{item.creator.username}
                </span>
                <span style={{ color: '#444', fontSize: '0.85em' }}>
                  · {formatTimeAgo(item.created_at)}
                </span>
              </>
            }
            title={item.name}
            preview={item.content}
          />
        ))}
      </FeedList>
    </div>
  );
}
