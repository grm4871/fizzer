import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../utils/api';
import { FeedList, FeedItem, FeedNav } from '../components/Feed';
import profileSvg from '../icons/profile.svg';
import starSvg from '../icons/star.svg';

interface SpaceSubscription {
  id: string;
  name: string;
  orderKey: number;
  monarch: {
    id: string;
    username: string;
    displayName: string;
    color: string;
  };
}

interface SpacesMenuProps {
  profileId: string;
  onProfile?: () => void;
}

export default function SpacesMenu({ profileId, onProfile }: SpacesMenuProps) {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<SpaceSubscription[]>([]);
  const [collectionSpaceId, setCollectionSpaceId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [subsRes, personalRes] = await Promise.all([
          apiFetch('/api/spaces/subscriptions/list'),
          apiFetch(`/api/spaces/personal/${profileId}`)
        ]);
        if (subsRes.ok) {
          setSpaces(await subsRes.json());
        }
        if (personalRes.ok) {
          const personal = await personalRes.json();
          setCollectionSpaceId(personal.collectionsSpace?.id ?? null);
        }
      } catch (err) {
        console.error('[SpacesMenu] Failed to fetch subscriptions:', err);
      } finally {
        setIsLoading(false);
      }
    })();
  }, [profileId]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      background: 'transparent',
      overflow: 'hidden'
    }}>
      <FeedNav items={[
        { icon: profileSvg, label: 'Profile', onClick: () => onProfile?.() },
        { icon: starSvg, label: 'Collection', onClick: () => collectionSpaceId && navigate(`/space/${collectionSpaceId}`) },
      ]} />

      <FeedList isLoading={isLoading} isEmpty={spaces.length === 0} emptyMessage="No subscribed spaces">
        {spaces.map((space) => (
          <FeedItem
            key={space.id}
            onClick={() => navigate(`/space/${space.id}`)}
            subtitle={
              <>
                <span style={{ color: `#${space.monarch.color}`, fontSize: '0.9em' }}>
                  {space.monarch.displayName}
                </span>
                <span style={{ color: '#555', fontSize: '0.85em' }}>
                  @{space.monarch.username}
                </span>
              </>
            }
            title={space.name}
          />
        ))}
      </FeedList>
    </div>
  );
}
