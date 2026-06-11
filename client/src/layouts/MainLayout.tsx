import React, { useRef, useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useMobile } from '../hooks/useMobile';
import { useHotkeys } from '../hooks/useHotkeys';
import { useHistory } from '../top/useHistory';
import { useLayoutState } from './states';
import { SidebarItem, Notification } from '../types';
import { RouteType } from '../types/routing';
import { LeftSidebar } from '../sidebar';
import RightSidebar from '../sidebar/RightSidebar';
import MainLayoutHeader, { MainLayoutHeaderHandle } from './components/MainLayoutHeader';
import MainLayoutMiddle from './components/MainLayoutMiddle';
import { QueueScreen } from '../pages/QueueScreen';
import { apiFetch } from '../utils/api';
import { socket } from '../services/socket';

export const parseNetdocIdFromPath = (path: string) => {
  const m = path.match(/^\/netdoc\/([^/]+)$/);
  return m ? m[1] : null;
};

import { applySpellcheckSetting } from '../utils/localSettings';
import { showBanner } from '../components/dialogue/BannerDialogue';
import MessageDialogue from '../components/dialogue/MessageDialogue';

interface MainLayoutProps {
  // User Data
  profileId: string;
  username: string;
  displayName: string;
  color: string;
  joinedAt?: string;
  // App Data
  sidebarItems: SidebarItem[];
  fetchSidebarItems: () => void;

  // Socket/Notification Data
  notifications: Notification[];
  unreadNotificationCount: number;
  queuePosition: number;

  // Setters for App State (needed for Login/Settings)
  setUsername: (name: string) => void;
  setDisplayName: (name: string) => void;
  setProfileId: (id: string) => void;
  setColor: (color: string) => void;
  setJoinedAt: (date: string) => void;
  setSidebarItems: (items: SidebarItem[]) => void;

  // Notification handlers
  onMarkNotificationAsRead?: (notificationId: string) => void;
  onMarkAllNotificationsAsRead?: () => void;
  onMarkRouteNotificationsAsRead?: (routeType: 'netdoc', routeId: string) => void;
}

export default function MainLayout({
  profileId,
  username,
  displayName,
  color,
  joinedAt,
  sidebarItems,
  fetchSidebarItems,
  notifications,
  unreadNotificationCount,
  queuePosition,
  setUsername,
  setDisplayName,
  setProfileId,
  setColor,
  setJoinedAt,
  setSidebarItems,
  onMarkNotificationAsRead,
  onMarkAllNotificationsAsRead,
  onMarkRouteNotificationsAsRead
}: MainLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { pushHistory, goBack, goForward, canGoBack, canGoForward } = useHistory();

  // Refs for state saving
  const mainLayoutHeaderRef = useRef<MainLayoutHeaderHandle>(null);

  // Local UI State
  const isMobile = useMobile();
  // Cross-cutting layout state from hook
  const {
    isSidebarOpen, setIsSidebarOpen,
    disableTransitions,
    isLeftSidebarCollapsed, setIsLeftSidebarCollapsed,
    isRightSidebarCollapsed, setIsRightSidebarCollapsed,
    isRightSidebarOpen, setIsRightSidebarOpen,
    sidebarRefreshTrigger, setSidebarRefreshTrigger,
    layoutMode, setLayoutMode, setLayoutModeInternal,
    hasUnsavedEditorChanges, setHasUnsavedEditorChanges,
    pendingLayoutMode, setPendingLayoutMode,
    showDiscardChangesDialog, setShowDiscardChangesDialog,
    pendingNavigation, setPendingNavigation,
    showPermissionsMenu, setShowPermissionsMenu,
    notificationsEnabledFor, setNotificationsEnabledFor,
    currentNetdoc, setCurrentNetdoc,
    currentNetdocError, setCurrentNetdocError,
  } = useLayoutState();

  // Local layout state
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const headerRef = useRef<HTMLDivElement>(null);
  const [isCreatingNewNetdoc, setIsCreatingNewNetdoc] = useState(false);
  const [newNetdocTitle, setNewNetdocTitle] = useState('');
  const [sidebarViewingSpace, setSidebarViewingSpace] = useState<{ id: string; name: string; description?: string; monarchDisplayName?: string; monarchUsername?: string; monarchColor?: string; jacketId?: string; canWrite?: boolean; jacketCanWrite?: boolean; members?: { userId: string; role: string; profile: { id: string; username: string; displayName: string; color?: string } }[] } | null>(null);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [pseudoWindowReturnPath, setSettingsReturnPath] = useState<string | null>(null);
  const [savedSpaceId, setSavedSpaceId] = useState<string | null>(null);

  // Measure header height for sidebar border cutout
  useEffect(() => {
    if (!headerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setHeaderHeight(entry.contentRect.height);
      }
    });
    observer.observe(headerRef.current);
    return () => observer.disconnect();
  }, []);

  // Check if running in Electron
  const isElectron = /electron/i.test(navigator.userAgent);

  // ===== ROUTE TYPE DETERMINATION =====
  const getRouteType = (pathname: string): RouteType => {
    if (pathname === '/login' || pathname === '/register') return 'login';
    if (pathname === '/settings') return 'settings';
    if (pathname === '/tos') return 'tos';
    if (pathname === '/privacy') return 'privacy';
    if (pathname === '/netdoc' || pathname.startsWith('/netdoc/')) return 'netdoc';
    if (pathname === '/explore' || pathname === '/') return 'explore';
    if (pathname === '/notifications') return 'notifications';
    if (pathname.startsWith('/id/')) return 'profile';
    if (pathname === '/admin') return 'admin';
    if (pathname === '/space') return 'spaces';
    if (pathname.startsWith('/space/')) return 'space';

    return 'explore';
  };

  const routeType = getRouteType(location.pathname);

  // Get space ID from sidebar's viewing space (when sidebar is showing a space in isolation mode)
  const currentSpaceId = sidebarViewingSpace?.id;

  // Fetch full space info when on a space or profile route
  useEffect(() => {
    if (routeType !== 'space' && routeType !== 'profile') return;

    const fetchFullSpaceData = async (spaceId: string) => {
      const res = await apiFetch(`/api/spaces/${spaceId}?userId=${profileId || ''}`);
      if (!res.ok) return null;
      return res.json();
    };

    const setSpaceFromData = (data: any) => {
      setSidebarViewingSpace({ id: data.id, name: data.name, description: data.description, monarchDisplayName: data.monarch?.displayName, monarchUsername: data.monarch?.username, monarchColor: data.monarch?.color, jacketId: data.jacket, canWrite: data.canWrite, jacketCanWrite: data.jacketCanWrite, members: data.members });
    };

    if (routeType === 'space') {
      const spaceId = location.pathname.split('/space/')[1];
      if (!spaceId) return;
      setSpaceError(null);
      fetchFullSpaceData(spaceId)
        .then(data => {
          if (data) setSpaceFromData(data);
          else setSpaceError('Failed to load space');
        })
        .catch(err => console.error('Failed to fetch space:', err));
    } else if (routeType === 'profile') {
      const profileUsername = location.pathname.split('/id/')[1];
      if (!profileUsername) return;
      (async () => {
        try {
          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(profileUsername);
          const endpoint = isUuid ? `/api/profile/id/${profileUsername}` : `/api/profile/${profileUsername}`;
          const profileRes = await apiFetch(endpoint);
          if (!profileRes.ok) return;
          const { profile: p } = await profileRes.json();
          const spacesRes = await apiFetch(`/api/spaces/personal/${p.id}`);
          if (!spacesRes.ok) return;
          const { profileSpace } = await spacesRes.json();
          if (!profileSpace) return;
          const data = await fetchFullSpaceData(profileSpace.id);
          if (data) setSpaceFromData(data);
        } catch (err) {
          console.error('Failed to fetch profile space:', err);
        }
      })();
    }
  }, [routeType, location.pathname, profileId]);

  // ===== AUTO-MARK NOTIFICATIONS AS READ WHEN VIEWING ROUTE =====
  useEffect(() => {
    if (!onMarkRouteNotificationsAsRead) return;

    const pathname = location.pathname;

    // Mark netdoc notifications as read when viewing that netdoc
    if (pathname.startsWith('/netdoc/')) {
      const netdocId = pathname.split('/netdoc/')[1];
      if (netdocId) {
        onMarkRouteNotificationsAsRead('netdoc', netdocId);
      }
    }

  }, [location.pathname, onMarkRouteNotificationsAsRead]);

  // ===== MOBILE KEYBOARD VIEWPORT ADJUSTMENT =====
  useEffect(() => {
    if (!isMobile) return;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

    let scrollLockInterval: ReturnType<typeof setInterval> | null = null;

    const updateViewportHeight = () => {
      if (window.visualViewport) {
        const vh = window.visualViewport.height;
        const windowHeight = window.innerHeight;
        const keyboardThreshold = 150;
        const keyboardIsUp = windowHeight - vh > keyboardThreshold;

        if (keyboardIsUp && isIOS) {
          document.documentElement.style.removeProperty('--viewport-height');
          document.body.style.position = 'fixed';
          document.body.style.top = '0';
          document.body.style.left = '0';
          document.body.style.right = '0';
          const keyboardHeight = windowHeight - vh;
          document.body.style.overflow = 'hidden';
          window.scrollTo(0, 0);

          document.documentElement.style.setProperty('--ios-keyboard-up', '1');
          document.documentElement.style.setProperty('--ios-keyboard-height', `${keyboardHeight}px`);
          document.documentElement.style.setProperty('--ios-available-height', `${vh}px`);
          document.documentElement.style.setProperty('--viewport-height', `${vh}px`);
          document.body.style.height = `${vh}px`;

          if (!scrollLockInterval) {
            scrollLockInterval = setInterval(() => {
              window.scrollTo(0, 0);
            }, 20);
          }
        } else {
          document.documentElement.style.setProperty('--viewport-height', `${vh}px`);
          if (isIOS) {
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.left = '';
            document.body.style.right = '';
            document.body.style.height = '';
            document.body.style.overflow = '';

            document.documentElement.style.removeProperty('--ios-keyboard-up');
            document.documentElement.style.removeProperty('--ios-keyboard-height');
            document.documentElement.style.removeProperty('--ios-available-height');

            if (scrollLockInterval) {
              clearInterval(scrollLockInterval);
              scrollLockInterval = null;
            }
          }
        }
      }
    };

    updateViewportHeight();

    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportHeight);
      if (!isIOS) {
        window.visualViewport.addEventListener('scroll', updateViewportHeight);
      }

      return () => {
        window.visualViewport?.removeEventListener('resize', updateViewportHeight);
        if (!isIOS) {
          window.visualViewport?.removeEventListener('scroll', updateViewportHeight);
        }
        if (scrollLockInterval) {
          clearInterval(scrollLockInterval);
        }
        document.documentElement.style.removeProperty('--viewport-height');
        document.documentElement.style.removeProperty('--ios-keyboard-up');
        document.documentElement.style.removeProperty('--ios-keyboard-height');
        document.documentElement.style.removeProperty('--ios-available-height');

        document.body.style.position = '';
        document.body.style.top = '';
        document.body.style.left = '';
        document.body.style.right = '';
        document.body.style.height = '';
        document.body.style.overflow = '';
      };
    }
  }, [isMobile]);

  // ===== RESPONSIVE =====
  useEffect(() => {
    if (!isMobile) setIsSidebarOpen(false);
    // Collapse both sidebars when transitioning to mobile
    if (isMobile) {
      setIsLeftSidebarCollapsed(true);
      setIsRightSidebarCollapsed(true);
    }
  }, [isMobile]);

  // On mobile, only one sidebar can be open at a time
  const toggleLeftSidebar = () => {
    const willOpen = isLeftSidebarCollapsed;
    setIsLeftSidebarCollapsed(prev => !prev);
    if (isMobile && willOpen) {
      setIsRightSidebarCollapsed(true);
    }
  };

  const toggleRightSidebar = () => {
    const willOpen = isRightSidebarCollapsed;
    setIsRightSidebarCollapsed(prev => !prev);
    if (isMobile && willOpen) {
      setIsLeftSidebarCollapsed(true);
    }
  };

  // ===== MOBILE SWIPE GESTURES =====
  useEffect(() => {
    if (!isMobile) return;

    let touchStartX = 0;
    let touchStartY = 0;
    const edgeThreshold = 30;
    const swipeThreshold = 50;

    const handleTouchStart = (e: TouchEvent) => {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    };

    const handleTouchEnd = (e: TouchEvent) => {
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - touchStartX;
      const deltaY = touchEndY - touchStartY;

      if (Math.abs(deltaX) < swipeThreshold || Math.abs(deltaY) > Math.abs(deltaX)) {
        return;
      }

      if (deltaX > 0 && touchStartX < edgeThreshold) {
        setIsLeftSidebarCollapsed(false);
        setIsRightSidebarCollapsed(true);
      }
      else if (deltaX < 0 && touchStartX > window.innerWidth - edgeThreshold) {
        setIsRightSidebarCollapsed(false);
        setIsLeftSidebarCollapsed(true);
      }
      else if (deltaX < 0 && !isLeftSidebarCollapsed) {
        setIsLeftSidebarCollapsed(true);
      }
      else if (deltaX > 0 && !isRightSidebarCollapsed) {
        setIsRightSidebarCollapsed(true);
      }
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isMobile, isLeftSidebarCollapsed, isRightSidebarCollapsed]);

  // Derived auth state
  const isAuthenticated = !!profileId;

  // Close permissions menu when navigating to a different page or netdoc
  useEffect(() => {
    setShowPermissionsMenu(false);
  }, [location.pathname]);

  // Handle navigation to /netdoc - check for type in location state
  useEffect(() => {
    if (location.pathname === '/netdoc' && !isCreatingNewNetdoc) {
      setIsCreatingNewNetdoc(true);
    }
  }, [location.pathname, isCreatingNewNetdoc]);

  // Clear creating state when navigating away from /netdoc
  useEffect(() => {
    if (location.pathname !== '/netdoc' && isCreatingNewNetdoc) {
      setIsCreatingNewNetdoc(false);
      setNewNetdocTitle('');
    }
  }, [location.pathname, isCreatingNewNetdoc]);

  const isTabbedRoute = routeType !== 'login';

  // Handle Subscription Change
  const handleSubscriptionChange = async (id: string, shouldSubscribe: boolean) => {
    try {
      const endpoint = shouldSubscribe
        ? `/api/subscriptions/${profileId}/subscribe`
        : `/api/subscriptions/${profileId}/subscriptions/${id}`;
      const method = shouldSubscribe ? 'POST' : 'DELETE';

      const res = await apiFetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: shouldSubscribe ? JSON.stringify({ netdocId: id }) : undefined
      });

      if (res.ok) {
        fetchSidebarItems();
        setSidebarRefreshTrigger(prev => prev + 1);
        // DB cascades delete of notifs on unsub, sync frontend state
        if (!shouldSubscribe) {
          setNotificationsEnabledFor(prev => {
            const newSet = new Set(prev);
            newSet.delete(id);
            return newSet;
          });
        }
      }
    } catch (err) {
      console.error('Failed to change subscription:', err);
    }
  };

  // Check sidebar subscriptions
  const isSubscribedToCurrent = useMemo(() => {
    const id = currentNetdoc?.id;
    if (!id) return false;
    return sidebarItems.some(item => item.type === 'netdoc' && item.netdocId === id);
  }, [currentNetdoc, sidebarItems]);

  // Track subscribed spaces (single fetch, shared with Explorer)
  const [subscribedSpaces, setSubscribedSpaces] = useState<{ id: string; name: string; orderKey?: number; monarch?: { id: string; username: string; displayName: string } }[]>([]);

  useEffect(() => {
    if (!profileId) return;
    apiFetch('/api/spaces/subscriptions/list')
      .then(res => res.ok ? res.json() : [])
      .then(data => setSubscribedSpaces(data.map((s: any) => ({ id: s.id, name: s.name, orderKey: s.orderKey, monarch: s.monarch }))))
      .catch(err => console.error('Failed to fetch space subscriptions:', err));
  }, [profileId]);

  // Fetch saved (collections) space ID
  useEffect(() => {
    if (!profileId) return;
    apiFetch(`/api/spaces/personal/${profileId}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.collectionsSpace?.id) setSavedSpaceId(data.collectionsSpace.id); })
      .catch(err => console.error('Failed to fetch saved space:', err));
  }, [profileId]);

  const isSpaceSubscribed = useMemo(() => {
    if (!sidebarViewingSpace) return false;
    return subscribedSpaces.some(s => s.id === sidebarViewingSpace.id);
  }, [sidebarViewingSpace, subscribedSpaces]);

  const handleSpaceSubscriptionChange = async (spaceId: string, shouldSubscribe: boolean) => {
    try {
      const method = shouldSubscribe ? 'POST' : 'DELETE';
      const res = await apiFetch(`/api/spaces/subscriptions/${spaceId}`, { method });
      if (res.ok) {
        if (shouldSubscribe) {
          // Re-fetch to get full space data
          const listRes = await apiFetch('/api/spaces/subscriptions/list');
          if (listRes.ok) {
            const data = await listRes.json();
            setSubscribedSpaces(data.map((s: any) => ({ id: s.id, name: s.name, orderKey: s.orderKey, monarch: s.monarch })));
          }
        } else {
          setSubscribedSpaces(prev => prev.filter(s => s.id !== spaceId));
        }
      }
    } catch (err) {
      console.error('Failed to change space subscription:', err);
    }
  };

  // Fetch notification preferences
  useEffect(() => {
    if (!profileId) return;
    apiFetch(`/api/profile/${profileId}/notifs`)
      .then(res => res.ok ? res.json() : null)
      .then(data => data && setNotificationsEnabledFor(new Set(data.notifications.map((n: any) => n.netdocId))))
      .catch(err => console.error('Failed to fetch notif prefs:', err));
  }, [profileId]);

  // Listen for socket events for notifications enabled/disabled
  useEffect(() => {
    const handleEnabled = ({ netdocId }: { netdocId: string }) => {
      setNotificationsEnabledFor(prev => {
        const newSet = new Set(prev);
        newSet.add(netdocId);
        return newSet;
      });
    };
    const handleDisabled = ({ netdocId }: { netdocId: string }) => {
      setNotificationsEnabledFor(prev => {
        const newSet = new Set(prev);
        newSet.delete(netdocId);
        return newSet;
      });
    };
    socket.on('notifications:enabled', handleEnabled);
    socket.on('notifications:disabled', handleDisabled);
    return () => {
      socket.off('notifications:enabled', handleEnabled);
      socket.off('notifications:disabled', handleDisabled);
    };
  }, []);

  // Notification toggle handler
  const handleNotificationsChange = async (id: string, shouldEnable: boolean) => {
    try {
      const endpoint = shouldEnable ? `/api/profile/${profileId}/notifs/enable` : `/api/profile/${profileId}/notifs/${id}`;
      const res = await apiFetch(endpoint, {
        method: shouldEnable ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: shouldEnable ? JSON.stringify({ netdocId: id }) : undefined
      });
      if (res.ok) {
        setNotificationsEnabledFor(prev => {
          const newSet = new Set(prev);
          shouldEnable ? newSet.add(id) : newSet.delete(id);
          return newSet;
        });
      }
    } catch (err) { console.error('Failed to change notif pref:', err); }
  };

  // Notifications object
  const notifs = {
    isEnabledForCurrent: currentNetdoc ? notificationsEnabledFor.has(currentNetdoc.id) : false,
    toggle: handleNotificationsChange
  };

  // Reset layout mode when navigating to a new netdoc (uses internal setter to bypass guard)
  const resetLayoutModeForNavigation = () => {
    if (layoutMode === 'write') {
      setLayoutModeInternal('read');
    }
  };

  // Navigation guard - checks for unsaved changes before allowing navigation
  const guardNavigation = (navigationAction: () => void): boolean => {
    if (layoutMode === 'write' && hasUnsavedEditorChanges) {
      const savedSettings = localStorage.getItem('localsettings');
      let shouldConfirm = false;
      if (savedSettings) {
        try {
          const settings = JSON.parse(savedSettings);
          shouldConfirm = settings.confirmDiscardEdits === true;
        } catch (error) { /* ignore */ }
      }
      if (shouldConfirm) {
        setPendingNavigation(() => navigationAction);
        setShowDiscardChangesDialog(true);
        return true; // blocked
      }
    }
    return false; // allowed
  };

  // Navigation functions
  const nav = {
    to: (path: string) => {
      if (guardNavigation(() => pushHistory(path))) return;
      pushHistory(path);
    },
    netdoc: async (netdocId: string, _netdocName?: string) => {
      const doNavigate = async () => {
        try {
          const res = await apiFetch(`/api/netdoc/${netdocId}`);
          if (res.status === 404) { showBanner('404: Netdoc does not exist!', false); return; }
          if (res.status === 403) { showBanner(`403: You do not have read permissions for netdoc ${netdocId}!`, false); return; }
          if (res.ok) { resetLayoutModeForNavigation(); pushHistory(`/netdoc/${netdocId}`); }
        } catch (err) { showBanner(`Error loading netdoc ${netdocId}`, false); }
      };
      if (guardNavigation(doNavigate)) return;
      await doNavigate();
    },
    profile: (username: string) => {
      if (guardNavigation(() => { resetLayoutModeForNavigation(); pushHistory(`/id/${username}`); })) return;
      resetLayoutModeForNavigation();
      pushHistory(`/id/${username}`);
    },
    explore: () => {
      if (guardNavigation(() => pushHistory('/explore'))) return;
      pushHistory('/explore');
    },
    newNetdoc: () => {
      const doAction = () => {
        setIsCreatingNewNetdoc(true);
        // Pass spaceId in state so it persists through the navigation
        pushHistory('/netdoc', { type: 'netdoc', spaceId: currentSpaceId });
      };
      if (guardNavigation(doAction)) return;
      doAction();
    },
    notifications: () => {
      if (guardNavigation(() => pushHistory('/notifications'))) return;
      pushHistory('/notifications');
    },
    openPermissions: () => setShowPermissionsMenu(true),
    closePermissions: () => setShowPermissionsMenu(false),
    settings: () => {
      if (routeType !== 'settings') {
        const doAction = () => { setSettingsReturnPath(location.pathname); navigate('/settings'); };
        if (guardNavigation(doAction)) return;
        doAction();
      }
    },
    closeSettings: () => { if (pseudoWindowReturnPath) { navigate(pseudoWindowReturnPath, { replace: true }); setSettingsReturnPath(null); } else { pushHistory('/'); } },
    closeAdmin: () => { navigate(-1); },
  };

  // Guarded back/forward handlers
  const guardedGoBack = () => {
    if (guardNavigation(() => goBack())) return;
    goBack();
  };
  const guardedGoForward = () => {
    if (guardNavigation(() => goForward())) return;
    goForward();
  };

  // Global hotkeys
  useHotkeys({
    onToggleLeftSidebar: toggleLeftSidebar,
    onToggleRightSidebar: toggleRightSidebar,
    onBack: guardedGoBack,
    onForward: guardedGoForward,
    onNewNetdoc: () => nav.newNetdoc(),
    onSearch: () => mainLayoutHeaderRef.current?.activateUrlBar(),
    onCycleMode: () => mainLayoutHeaderRef.current?.cycleMode(),
    onCycleModeReverse: () => mainLayoutHeaderRef.current?.cycleModeReverse(),
    onSetEditMode: () => handleSetLayoutMode('write'),
    onSetViewMode: () => handleSetLayoutMode('read'),
  });

  // Clear space context when navigating to routes that shouldn't keep it
  useEffect(() => {
    const keepSpaceRoutes: RouteType[] = ['netdoc', 'space', 'profile'];
    if (!keepSpaceRoutes.includes(routeType) && sidebarViewingSpace) {
      setSidebarViewingSpace(null);
    }
  }, [routeType]);

  const handleSetLayoutMode = (mode: LayoutMode, force?: boolean) => {
    setLayoutMode(mode, force);
  };

  const headerDocForTitle = routeType === 'netdoc' ? currentNetdoc : null;

  return (
    <>
      <div id="container" className={disableTransitions ? 'no-transition' : ''}>
        {/* Global SVG filter for icon colorization */}
        <svg style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          <defs>
            <filter id="iconColorFilter" colorInterpolationFilters="sRGB">
              <feFlood floodColor="var(--main-text)" result="flood"/>
              <feComposite in="flood" in2="SourceAlpha" operator="in"/>
            </filter>
            <filter id="iconAccentColorFilter" colorInterpolationFilters="sRGB">
              <feFlood floodColor="var(--dark-accent)" result="flood"/>
              <feComposite in="flood" in2="SourceAlpha" operator="in"/>
            </filter>
            {/* SVG filter for strikethrough: invert + reduce by 64/256 */}
            <filter id="strikethrough-invert">
              <feComponentTransfer in="BackgroundImage">
                <feFuncR type="linear" slope="-1" intercept="0.75"/>
                <feFuncG type="linear" slope="-1" intercept="0.75"/>
                <feFuncB type="linear" slope="-1" intercept="0.75"/>
              </feComponentTransfer>
            </filter>
          </defs>
        </svg>
        <div className="corner-chip tl" />
        <div className="corner-chip br" />

        <QueueScreen position={queuePosition} />

        {/* Left Sidebar - hidden on login page and when not authenticated */}
        {routeType !== 'login' && isAuthenticated && (
          <LeftSidebar
            routeType={routeType}
            displayName={displayName}
            onProfile={() => nav.profile(username)}
            onSettings={() => routeType === 'settings' ? nav.closeSettings() : nav.settings()}
            isAuthenticated={isAuthenticated}
            onLogin={() => navigate('/login')}
            isCollapsed={isLeftSidebarCollapsed}
            onToggleCollapse={toggleLeftSidebar}
            headerHeight={headerHeight}
            footerHeight={footerHeight}
            sidebarItems={sidebarItems}
            profileId={profileId}
            isMobile={isMobile}
            setIsOpen={() => setIsLeftSidebarCollapsed(false)}
            onOpenNetdocInCurrentTab={nav.netdoc}
            onNew={nav.newNetdoc}
            onExplore={() => nav.to('/')}
            onSubscriptionChange={handleSubscriptionChange}
            onNetdocCreated={(netdocId, netdocName) => {
              nav.netdoc(netdocId, netdocName);
              setLayoutMode('write');
            }}
            onNetdocRenamed={(netdocId, newName) => {
              if (currentNetdoc?.id === netdocId) {
                setCurrentNetdoc({ ...currentNetdoc, name: newName });
              }
            }}
            setSidebarItems={setSidebarItems}
            fetchSidebarItems={fetchSidebarItems}
            navigateTo={nav.to}
            onViewingSpaceChange={setSidebarViewingSpace}
            externalViewingSpace={sidebarViewingSpace}
            isOwnProfile={!!sidebarViewingSpace?.monarchUsername && sidebarViewingSpace.monarchUsername === username}
            subscribedSpaces={subscribedSpaces}
            setSubscribedSpaces={setSubscribedSpaces}
            onSaved={savedSpaceId ? () => nav.to(`/space/${savedSpaceId}`) : undefined}
          />
        )}

        {/* Right Sidebar - Notifications */}
        {routeType !== 'login' && isAuthenticated && (
          <RightSidebar
            notifications={notifications}
            unreadCount={unreadNotificationCount}
            onNavigateToNetdoc={nav.netdoc}
            onMarkAsRead={onMarkNotificationAsRead}
            onMarkAllAsRead={onMarkAllNotificationsAsRead}
            isOpen={isRightSidebarOpen}
            setIsOpen={setIsRightSidebarOpen}
            isMobile={isMobile}
            isCollapsed={isRightSidebarCollapsed}
            onToggleCollapse={toggleRightSidebar}
            headerHeight={headerHeight}
            footerHeight={footerHeight}
          />
        )}

        <div id="main-panel" style={{
          gridArea: 'content',
          display: queuePosition > 0 ? 'none' : 'flex',
          flexDirection: 'column',
          height: isMobile ? 'var(--viewport-height, 100vh)' : '100%',
          minHeight: 0,
          width: '100%',
          minWidth: 0,
          position: isMobile ? 'absolute' : 'relative',
          inset: isMobile ? 0 : undefined,
          isolation: 'isolate',
          zIndex: isMobile ? 0 : 999,
          overflow: 'hidden'
        }}>
          <div ref={headerRef}>
            <MainLayoutHeader
              ref={mainLayoutHeaderRef}
              isTabbedRoute={isTabbedRoute}
              routeType={routeType}
              isMobile={isMobile}
              isRightSidebarCollapsed={isRightSidebarCollapsed}
              setIsRightSidebarCollapsed={setIsRightSidebarCollapsed}
              isLeftSidebarCollapsed={isLeftSidebarCollapsed}
              setIsLeftSidebarCollapsed={setIsLeftSidebarCollapsed}
              handleBack={guardedGoBack}
              handleForward={guardedGoForward}
              canGoBack={canGoBack}
              canGoForward={canGoForward}
              username={username}
              navigateToNetdoc={nav.netdoc}
              navigateToProfile={nav.profile}
              navigateTo={nav.to}
              layoutMode={layoutMode}
              setLayoutMode={handleSetLayoutMode}
              canWrite={currentNetdoc?.canWrite ?? false}
              isSubscribed={isSubscribedToCurrent}
              onSubscriptionChange={handleSubscriptionChange}
              isNotificationsEnabled={notifs.isEnabledForCurrent}
              onNotificationsChange={notifs.toggle}
              currentNetdocId={routeType === 'netdoc' ? (parseNetdocIdFromPath(location.pathname) ?? undefined) : undefined}
              currentNetdoc={headerDocForTitle}
              currentSpace={sidebarViewingSpace}
              isSpaceSubscribed={isSpaceSubscribed}
              onSpaceSubscriptionChange={handleSpaceSubscriptionChange}
              menuTitle={isCreatingNewNetdoc ? ((newNetdocTitle.trim() || 'New Netdoc') + (sidebarViewingSpace ? ` in ${sidebarViewingSpace.name}` : '')) : routeType === 'settings' ? 'Settings' : routeType === 'admin' ? 'Admin Panel' : routeType === 'spaces' ? 'Spaces Menu' : routeType === 'explore' ? 'Explore' : showPermissionsMenu ? `Permissions • ${(currentNetdoc?.name || 'Untitled')}` : undefined}
              onMenuClose={isCreatingNewNetdoc ? () => { setIsCreatingNewNetdoc(false); setNewNetdocTitle(''); } : showPermissionsMenu ? nav.closePermissions : routeType === 'settings' ? nav.closeSettings : routeType === 'admin' ? nav.closeAdmin : undefined}
              isCreatingNewNetdoc={isCreatingNewNetdoc}
              isOwner={currentNetdoc?.creator_id === profileId}
              isAuthenticated={isAuthenticated}
            />
          </div>

          <main style={{
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minHeight: 0,
          }}>
            <MainLayoutMiddle
              applySpellcheckSetting={applySpellcheckSetting}
              color={color}
              displayName={displayName}
              fetchSidebarItems={fetchSidebarItems}
              isAuthenticated={isAuthenticated}
              isElectron={isElectron}
              joinedAt={joinedAt || ''}
              navigateToNetdoc={nav.netdoc}
              navigateToNewNetdoc={nav.newNetdoc}
              navigateTo={nav.to}
              profileId={profileId}
              routeType={routeType}
              setCurrentNetdoc={setCurrentNetdoc}
              setCurrentNetdocError={setCurrentNetdocError}
              setDisplayName={setDisplayName}
              setProfileId={setProfileId}
              setUsername={setUsername}
              setColor={setColor}
              setJoinedAt={setJoinedAt}
              setSidebarItems={setSidebarItems}
              sidebarItems={sidebarItems}
              username={username}
              layoutMode={layoutMode}
              setLayoutMode={handleSetLayoutMode}
              currentNetdoc={currentNetdoc}
              setHasUnsavedEditorChanges={setHasUnsavedEditorChanges}
              isCreatingNewNetdoc={isCreatingNewNetdoc}
              setIsCreatingNewNetdoc={setIsCreatingNewNetdoc}
              newNetdocTitle={newNetdocTitle}
              setNewNetdocTitle={setNewNetdocTitle}
              openPermissionsMenu={nav.openPermissions}
              closePermissionsMenu={nav.closePermissions}
              showPermissionsMenu={showPermissionsMenu}
              goBack={goBack}
              currentSpaceId={currentSpaceId}
              currentSpace={sidebarViewingSpace}
              spaceError={spaceError}
            />
          </main>
        </div>
      </div>

      {/* Discard changes confirmation dialog */}
      {showDiscardChangesDialog && (
        <MessageDialogue
          title="Discard unsaved changes?"
          message="You have unsaved changes. Are you sure you want to discard them?"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          onConfirm={() => {
            setShowDiscardChangesDialog(false);
            setHasUnsavedEditorChanges(false);
            if (pendingLayoutMode) {
              setLayoutModeInternal(pendingLayoutMode);
              setPendingLayoutMode(null);
            }
            if (pendingNavigation) {
              pendingNavigation();
              setPendingNavigation(null);
            }
          }}
          onCancel={() => {
            setShowDiscardChangesDialog(false);
            setPendingLayoutMode(null);
            setPendingNavigation(null);
          }}
        />
      )}
    </>
  );
}
