import { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiFetch } from '../utils/api';
import { socket } from '../services/socket';
import { LayoutMode } from '../types/routing';

const parseNetdocIdFromPath = (path: string) => {
  const m = path.match(/^\/netdoc\/([^/]+)$/);
  return m ? m[1] : null;
};

export function useLayoutState() {
  const location = useLocation();
  const navigate = useNavigate();
  // ===== SIDEBAR STATE =====
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [disableTransitions, setDisableTransitions] = useState(true);
  const [isLeftSidebarCollapsed, setIsLeftSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('leftSidebarCollapsed');
    if (saved !== null) return saved === 'true';
    return window.innerWidth <= 768;
  });
  const [isRightSidebarCollapsed, setIsRightSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem('rightSidebarCollapsed');
    if (saved !== null) return saved === 'true';
    return window.innerWidth <= 768;
  });
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);
  const [sidebarRefreshTrigger, setSidebarRefreshTrigger] = useState(0);

  // Enable transitions after first render to prevent sidebar pop-in
  useEffect(() => {
    requestAnimationFrame(() => setDisableTransitions(false));
  }, []);

  // Persist sidebar collapsed state to localStorage
  useEffect(() => {
    localStorage.setItem('leftSidebarCollapsed', String(isLeftSidebarCollapsed));
  }, [isLeftSidebarCollapsed]);
  useEffect(() => {
    localStorage.setItem('rightSidebarCollapsed', String(isRightSidebarCollapsed));
  }, [isRightSidebarCollapsed]);

  // ===== LAYOUT MODE / EDITOR STATE =====
  const [layoutMode, setLayoutModeInternal] = useState<LayoutMode>('read');
  const [hasUnsavedEditorChanges, setHasUnsavedEditorChanges] = useState(false);
  const [pendingLayoutMode, setPendingLayoutMode] = useState<LayoutMode | null>(null);
  const [showDiscardChangesDialog, setShowDiscardChangesDialog] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);

  // Wrapped setLayoutMode that checks for unsaved changes when leaving edit mode
  const setLayoutMode = (newMode: LayoutMode, force = false) => {
    if (!force && layoutMode === 'write' && newMode !== 'write' && hasUnsavedEditorChanges) {
      const savedSettings = localStorage.getItem('localsettings');
      let shouldConfirm = false;
      if (savedSettings) {
        try {
          const settings = JSON.parse(savedSettings);
          shouldConfirm = settings.confirmDiscardEdits === true;
        } catch (error) {
          console.error('Failed to parse localsettings:', error);
        }
      }

      if (shouldConfirm) {
        setPendingLayoutMode(newMode);
        setShowDiscardChangesDialog(true);
        return;
      }
    }
    setHasUnsavedEditorChanges(false);
    setLayoutModeInternal(newMode);
  };

  // ===== MODALS / MENUS =====
  const [showPermissionsMenu, setShowPermissionsMenu] = useState(false);

  // ===== NOTIFICATIONS =====
  const [notificationsEnabledFor, setNotificationsEnabledFor] = useState<Set<string>>(new Set());

  // ===== CURRENT NETDOC STATE =====
  const [currentNetdoc, setCurrentNetdoc] = useState<any>(null);
  const [currentNetdocError, setCurrentNetdocError] = useState<string>('');
  const currentNetdocRef = useRef<any>(null);
  const layoutModeRef = useRef<LayoutMode>('read');

  // Keep refs in sync with state
  useEffect(() => {
    currentNetdocRef.current = currentNetdoc;
  }, [currentNetdoc]);
  useEffect(() => {
    layoutModeRef.current = layoutMode;
  }, [layoutMode]);

  // Fetch netdoc when route changes to a netdoc route
  const isNetdocRoute = location.pathname.startsWith('/netdoc/');
  const netdocId = isNetdocRoute ? parseNetdocIdFromPath(location.pathname) : null;

  // Helper function to fetch/refresh netdoc data
  const fetchNetdoc = async (id: string, signal?: AbortSignal) => {
    try {
      const res = await apiFetch(`/api/netdoc/${id}`, { signal });
      if (res.status === 301) {
        // Jacket redirect
        const data = await res.json();
        if (data.redirect) {
          navigate(data.redirect, { replace: true });
          return;
        }
      }
      if (!res.ok) {
        if (res.status === 404) {
          setCurrentNetdocError('Netdoc not found');
        } else if (res.status === 403) {
          setCurrentNetdocError('Restricted');
        } else {
          setCurrentNetdocError('Error loading netdoc');
        }
        setCurrentNetdoc(null);
        return;
      }
      const data = await res.json();
      setCurrentNetdoc(data);
      setCurrentNetdocError('');
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.error('[useLayoutState] Error fetching netdoc:', err);
        setCurrentNetdocError('Error loading netdoc');
        setCurrentNetdoc(null);
      }
    }
  };

  useEffect(() => {
    if (!isNetdocRoute || !netdocId) {
      setCurrentNetdoc(null);
      setCurrentNetdocError('');
      return;
    }

    // Skip if we already have this netdoc loaded
    if (currentNetdoc && String(currentNetdoc.id).toLowerCase() === netdocId.toLowerCase()) return;

    const abortController = new AbortController();
    fetchNetdoc(netdocId, abortController.signal);

    return () => abortController.abort();
  }, [isNetdocRoute, netdocId, currentNetdoc?.id]);

  // Subscribe to netdoc room for real-time updates
  useEffect(() => {
    if (!netdocId) return;

    socket.emit('subscribe', netdocId);
    return () => {
      socket.emit('unsubscribe', netdocId);
    };
  }, [netdocId]);

  // Listen for permission changes via socket and re-fetch netdoc
  useEffect(() => {
    if (!netdocId) return;

    const handlePermissionsChanged = async ({ netdocId: changedNetdocId }: { netdocId: string }) => {
      // Only re-fetch if it's the netdoc we're currently viewing
      if (changedNetdocId.toLowerCase() === netdocId.toLowerCase()) {
        console.log('[useLayoutState] Permissions changed for current netdoc, re-fetching...');

        try {
          const res = await apiFetch(`/api/netdoc/${netdocId}`);
          if (!res.ok) {
            if (res.status === 403) {
              // Lost read access - clear and show error
              setCurrentNetdoc(null);
              setCurrentNetdocError('Restricted');
              setLayoutModeInternal('read');
            }
            return;
          }

          const data = await res.json();
          const oldNetdoc = currentNetdocRef.current;
          const currentLayoutMode = layoutModeRef.current;
          setCurrentNetdoc(data);
          setCurrentNetdocError('');

          // Check if we need to switch modes due to lost permissions
          if (currentLayoutMode === 'write' && !data.canWrite && oldNetdoc?.canWrite) {
            setLayoutModeInternal('read');
            console.log('[useLayoutState] Lost edit permission, switching mode');
          }
        } catch (err) {
          console.error('[useLayoutState] Error re-fetching netdoc after permission change:', err);
        }
      }
    };

    socket.on('netdoc:permissions-changed', handlePermissionsChanged);
    return () => {
      socket.off('netdoc:permissions-changed', handlePermissionsChanged);
    };
  }, [netdocId]);

  return {
    // Sidebar
    isSidebarOpen,
    setIsSidebarOpen,
    disableTransitions,
    isLeftSidebarCollapsed,
    setIsLeftSidebarCollapsed,
    isRightSidebarCollapsed,
    setIsRightSidebarCollapsed,
    isRightSidebarOpen,
    setIsRightSidebarOpen,
    sidebarRefreshTrigger,
    setSidebarRefreshTrigger,

    // Layout mode / Editor
    layoutMode,
    setLayoutMode,
    setLayoutModeInternal,
    hasUnsavedEditorChanges,
    setHasUnsavedEditorChanges,
    pendingLayoutMode,
    setPendingLayoutMode,
    showDiscardChangesDialog,
    setShowDiscardChangesDialog,
    pendingNavigation,
    setPendingNavigation,

    // Modals
    showPermissionsMenu,
    setShowPermissionsMenu,

    // Notifications
    notificationsEnabledFor,
    setNotificationsEnabledFor,

    // Current netdoc
    currentNetdoc,
    setCurrentNetdoc,
    currentNetdocError,
    setCurrentNetdocError,

  };
}
