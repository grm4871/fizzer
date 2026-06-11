import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../utils/api';
import { applySpellcheckSetting } from '../utils/localSettings';
import { SidebarItem } from '../types';
import { showBanner } from '../components/dialogue/BannerDialogue';

export function useAppData() {
  const [profileId, setProfileId] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [color, setColor] = useState('d2b34e');
  const [joinedAt, setJoinedAt] = useState<string | undefined>(undefined);
  const [isProfileInitialized, setIsProfileInitialized] = useState(false);
  
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);

  const profileInitRef = useRef(false);

  // ===== PROFILE INITIALIZATION =====
  useEffect(() => {
    if (profileInitRef.current) return;
    profileInitRef.current = true;
    const initializeProfile = async () => {
      const storedUsername = localStorage.getItem('username');
      const storedDisplayName = localStorage.getItem('displayName');
      const storedProfileId = localStorage.getItem('profileId');
      const storedColor = localStorage.getItem('color');
      const storedToken = localStorage.getItem('token');

      if (storedUsername && storedDisplayName && storedToken) {
        try {
          const res = await apiFetch('/api/profile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: storedProfileId || undefined,
              username: storedUsername,
              displayName: storedDisplayName,
              color: storedColor || undefined
            })
          });

          if (res.ok) {
            const profile = await res.json();
            if (!profile.id || typeof profile.id !== 'string') {
              throw new Error('Invalid profile response');
            }
            setProfileId(profile.id);
            setUsername(profile.username);
            setDisplayName(profile.displayName);
            setColor(profile.color || 'd2b34e');
            setJoinedAt(profile.joinedAt);
            localStorage.setItem('profileId', profile.id);
            localStorage.setItem('username', profile.username);
            localStorage.setItem('displayName', profile.displayName);
            localStorage.setItem('color', profile.color || 'd2b34e');

            if (profile.settings) {
              localStorage.setItem('localsettings', JSON.stringify(profile.settings));
              applySpellcheckSetting();
            }
            
            if (profile.token) {
              localStorage.setItem('token', profile.token);
            }

            if (profile.folder_dialogue === 1) {
              showBanner(
                'Saved folders are temporarily unavailable! But don\'t worry, they will come back soon with all your previous data!',
                true,
                {
                  mode: 'button',
                  buttonLabel: 'ok',
                  color: '#4444ff',
                  onDismiss: async () => {
                    try {
                      await apiFetch('/api/profile/folder-dialogue', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ userId: profile.id })
                      });
                    } catch (err) {
                      console.error('[Profile] Failed to dismiss folder dialogue:', err);
                    }
                  }
                }
              );
            }
          } else {
            clearProfile();
          }
        } catch (err) {
          console.error('[Profile] Failed to initialize:', err);
          clearProfile();
        }
      }

      setIsProfileInitialized(true);
    };

    initializeProfile();
  }, []);

  const clearProfile = () => {
    localStorage.removeItem('profileId');
    localStorage.removeItem('username');
    localStorage.removeItem('displayName');
    localStorage.removeItem('color');
    localStorage.removeItem('token');
    setProfileId('');
    setUsername('');
    setDisplayName('');
    setColor('d2b34e');
  };

  // ===== FETCH SIDEBAR =====
  const fetchSidebarItems = useCallback(async () => {
    if (!profileId) return;

    try {
      const res = await apiFetch(`/api/sidebar?userId=${profileId}`);
      if (res.ok) {
        const data = await res.json();

        const netdocItems: SidebarItem[] = (data.items || []).filter((item: any) => !item.isJacket).map((item: any) => ({
          ...item,
          parentId: null
        }));

        netdocItems.sort((a, b) => (a.orderKey || 0) - (b.orderKey || 0));
        setSidebarItems(netdocItems);
      }
    } catch (err) {
      console.error('Failed to fetch sidebar items:', err);
    }
  }, [profileId]);

  useEffect(() => {
    fetchSidebarItems();
  }, [fetchSidebarItems]);

  // ===== SYNC COLOR TO CSS VARIABLE =====
  useEffect(() => {
    document.documentElement.style.setProperty('--current-user-color', `#${color}`);
  }, [color]);

  return {
    profileId,
    setProfileId,
    username,
    setUsername,
    displayName,
    setDisplayName,
    color,
    setColor,
    joinedAt,
    setJoinedAt,
    isProfileInitialized,
    sidebarItems,
    setSidebarItems,
    fetchSidebarItems
  };
}
