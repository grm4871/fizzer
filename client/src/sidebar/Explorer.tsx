/**
 * @file Explorer.tsx
 * @description Explorer content component for navigating netdocs.
 * Contains logic for drag-and-drop reordering and netdoc subscriptions.
 * This component is used inside RightSidebar and can be swapped out.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { SidebarItem } from '../types';
import { RouteType } from '../types/routing';
import { socket } from '../services/socket';
import ContextMenu from '../components/ContextMenu';
import SidebarItemRenderer from './SidebarItemRenderer';
import SidebarHeader from './SidebarHeader';
import { useSidebarNetdocs } from './useSidebarNetdocs';
import { useSidebarDragDrop } from './useSidebarDragDrop';
import spaceSvg from '../icons/space.svg';
import globeSvg from '../icons/globe.svg';
import { getOpenLinkNewTab } from '../components/NetdocEmbed';
import { apiFetch } from '../utils/api';

export interface ExplorerProps {
  routeType?: RouteType;
  displayName?: string;
  sidebarItems: SidebarItem[];
  isMobile: boolean;
  setIsOpen: (open: boolean) => void;
  onOpenNetdocInCurrentTab?: (netdocId: string, netdocName: string) => void;
  onOpenNetdocInNewTab?: (netdocId: string, netdocName: string) => void;
  onNew?: () => void;
  onExplore?: () => void;
  onSubscriptionChange?: (netdocId: string, shouldSubscribe: boolean) => Promise<void>;
  onNetdocCreated?: (netdocId: string, netdocName: string) => void;
  onNetdocRenamed?: (netdocId: string, newName: string) => void;
  setSidebarItems?: (items: SidebarItem[] | ((prev: SidebarItem[]) => SidebarItem[])) => void;
  fetchSidebarItems?: () => void;
  navigateTo?: (path: string) => void;
  onViewingSpaceChange?: (space: { id: string; name: string; monarchDisplayName?: string } | null) => void;
  externalViewingSpace?: { id: string; name: string; monarchDisplayName?: string } | null;
  isOwnProfile?: boolean;
  subscribedSpaces?: { id: string; name: string; orderKey?: number; monarch?: { id: string; username: string; displayName: string } }[];
  setSubscribedSpaces?: React.Dispatch<React.SetStateAction<{ id: string; name: string; orderKey?: number; monarch?: { id: string; username: string; displayName: string } }[]>>;
  onProfile?: () => void;
  profileId?: string;
  isAuthenticated?: boolean;
  onSaved?: () => void;
}

const Explorer: React.FC<ExplorerProps> = ({
  routeType,
  displayName,
  sidebarItems,
  isMobile,
  setIsOpen,
  onOpenNetdocInCurrentTab,
  onOpenNetdocInNewTab,
  onNew,
  onExplore,
  onSubscriptionChange,
  onNetdocCreated,
  onNetdocRenamed,
  setSidebarItems,
  fetchSidebarItems,
  navigateTo,
  onViewingSpaceChange,
  externalViewingSpace,
  isOwnProfile = false,
  subscribedSpaces = [],
  setSubscribedSpaces,
  onProfile,
  profileId,
  isAuthenticated = true,
  onSaved,
}) => {
  const navigate = useNavigate();

  const truncateTitle = (title: string | undefined | null, maxLength: number = 30): string => {
    if (!title) return 'Untitled';
    if (title.length <= maxLength) return title;
    return title.substring(0, maxLength - 3) + '...';
  };

  // ============================================================================
  // STATE MANAGEMENT
  // ============================================================================

  const [sidebarTab, setSidebarTab] = useState<'profile' | 'netdocs' | 'spaces'>('netdocs');
  const [viewingSpace, setViewingSpace] = useState<{ id: string; name: string; monarchDisplayName?: string; jacketId?: string } | null>(null);
  const [spaceItems, setSpaceItems] = useState<SidebarItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item?: SidebarItem | null } | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [isReorderMode, setIsReorderMode] = useState(false);
  const [radialMenuOpen, setRadialMenuOpen] = useState(false);
  const [showSpaceInput, setShowSpaceInput] = useState(false);
  const [spaceNameInput, setSpaceNameInput] = useState('');
  const [renamingItem, setRenamingItem] = useState<{ id: string; type: 'netdoc' } | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const currentUserIdRef = useRef<string | null>(null);

  // Wrapper for setSidebarItems
  const setItems = (updater: SidebarItem[] | ((prev: SidebarItem[]) => SidebarItem[])) => {
    if (typeof updater === 'function') {
      setSidebarItems?.(updater(sidebarItems));
    } else {
      setSidebarItems?.(updater);
    }
  };

  // ============================================================================
  // CUSTOM HOOKS
  // ============================================================================

  const {
    showNetdocInput,
    setShowNetdocInput,
    netdocInputTitle,
    setNetdocInputTitle,
    openNetdocInput,
    closeNetdocInput,
    submitNetdocCreate: submitNetdocCreateHandler
  } = useSidebarNetdocs(setItems, onNetdocCreated);

  const sidebarDrag = useSidebarDragDrop(sidebarItems, setItems, () => fetchSidebarItems?.(), currentUserIdRef.current);
  const spaceDrag = useSidebarDragDrop(
    spaceItems,
    setSpaceItems,
    () => viewingSpace ? fetchSpaceContents(viewingSpace.id) : Promise.resolve(),
    currentUserIdRef.current,
    viewingSpace?.id
  );

  // ============================================================================
  // EFFECTS
  // ============================================================================

  useEffect(() => {
    const userId = profileId || localStorage.getItem('profileId');
    currentUserIdRef.current = userId;
  }, [profileId]);

  // Auto-switch sidebar tab based on route
  useEffect(() => {
    if (routeType === 'spaces') {
      setSidebarTab('spaces');
    } else if (sidebarTab === 'spaces' && routeType !== 'spaces') {
      setSidebarTab('netdocs');
    }
  }, [routeType]);

  const viewingSpaceRef = useRef(viewingSpace);
  viewingSpaceRef.current = viewingSpace;

  const fetchSpaceContents = useCallback(async (spaceId: string) => {
    const userId = profileId || localStorage.getItem('profileId');
    try {
      const res = await apiFetch(`/api/spaces/${spaceId}/sidebar?userId=${userId || ''}`);
      if (res.ok) {
        const data = await res.json();
        const jacketItem = (data.items || []).find((item: any) => item.isJacket);
        if (jacketItem) {
          setViewingSpace(prev => prev ? { ...prev, jacketId: jacketItem.netdocId } : prev);
        }
        const netdocItems: SidebarItem[] = (data.items || []).filter((item: any) => !item.isJacket).map((item: any) => ({
          id: item.id,
          type: 'netdoc' as const,
          postId: null,
          userId: userId || '',
          netdocId: item.netdocId,
          parentId: null,
          title: item.title,
          content: null,
          authorId: null,
          createdAt: '',
          orderKey: item.orderKey
        }));
        setSpaceItems(netdocItems);
      }
    } catch (err) {
      console.error('Failed to fetch space contents:', err);
    }
  }, [profileId]);

  useEffect(() => {
    if (externalViewingSpace && externalViewingSpace.id !== viewingSpace?.id) {
      setViewingSpace(externalViewingSpace);
      fetchSpaceContents(externalViewingSpace.id);
    } else if (!externalViewingSpace && viewingSpace) {
      setViewingSpace(null);
      setSpaceItems([]);
    }
  }, [externalViewingSpace?.id, viewingSpace?.id, fetchSpaceContents]);

  const handleSpaceClick = (space: { id: string; name: string; monarch?: { id: string; username: string; displayName: string } }) => {
    if (navigateTo) {
      navigateTo(`/space/${space.id}`);
    } else {
      navigate(`/space/${space.id}`);
    }
    const spaceInfo = { id: space.id, name: space.name, monarchDisplayName: space.monarch?.displayName };
    setViewingSpace(spaceInfo);
    onViewingSpaceChange?.(spaceInfo);
    fetchSpaceContents(space.id);
    if (isMobile) setIsOpen(false);
  };

  const handleExitSpace = () => {
    setViewingSpace(null);
    setSpaceItems([]);
    onViewingSpaceChange?.(null);
    setSidebarTab('spaces');
    setShowSearch(false);
    setSearchQuery('');
  };

  useEffect(() => {
    if (!socket) return;

    const handleSubscriptionChange = () => {
      fetchSidebarItems?.();
      if (viewingSpaceRef.current) fetchSpaceContents(viewingSpaceRef.current.id);
    };

    socket.on('sidebar:subscription-added', handleSubscriptionChange);
    socket.on('sidebar:subscription-removed', handleSubscriptionChange);

    return () => {
      socket.off('sidebar:subscription-added', handleSubscriptionChange);
      socket.off('sidebar:subscription-removed', handleSubscriptionChange);
    };
  }, [socket, fetchSidebarItems, fetchSpaceContents]);

  const prevSidebarItemsRef = useRef(sidebarItems);
  useEffect(() => {
    if (sidebarItems !== prevSidebarItemsRef.current && viewingSpace) {
      fetchSpaceContents(viewingSpace.id);
    }
    prevSidebarItemsRef.current = sidebarItems;
  }, [sidebarItems, viewingSpace, fetchSpaceContents]);

  // ============================================================================
  // CONTEXT MENU
  // ============================================================================

  const handleContextMenu = (e: React.MouseEvent, item?: SidebarItem | null) => {
    e.preventDefault();
    const isSpaceContentView = !!viewingSpace;
    if (sidebarTab === 'spaces' || isSpaceContentView) return;
    setContextMenu({ x: e.clientX, y: e.clientY, item });
  };

  const closeContextMenu = () => setContextMenu(null);

  // ============================================================================
  // NETDOC CREATION
  // ============================================================================

  const handleSubmitNetdocCreate = async () => {
    const uid = currentUserIdRef.current || localStorage.getItem('profileId');
    if (!uid) return;
    await submitNetdocCreateHandler(uid, async () => { fetchSidebarItems?.(); });
  };

  const handleSubmitSpaceCreate = async () => {
    const uid = currentUserIdRef.current || localStorage.getItem('profileId');
    if (!uid || !spaceNameInput.trim()) return;

    try {
      const res = await apiFetch('/api/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: uid,
          name: spaceNameInput.trim()
        })
      });

      if (res.ok) {
        const newSpace = await res.json();
        await apiFetch(`/api/spaces/subscriptions/${newSpace.id}`, { method: 'POST' });
        setSubscribedSpaces?.(prev => [...prev, { id: newSpace.id, name: newSpace.name, monarch: newSpace.monarch }]);
        handleSpaceClick({ id: newSpace.id, name: newSpace.name });
      } else {
        console.error('Failed to create space:', res.status);
      }
    } catch (err) {
      console.error('Failed to create space:', err);
    } finally {
      setSpaceNameInput('');
      setShowSpaceInput(false);
    }
  };

  // ============================================================================
  // ITEM CLICK HANDLING
  // ============================================================================

  const handleItemClick = async (item: SidebarItem, e: React.MouseEvent) => {
    if (item.type !== 'netdoc') return;
    const netdocId = item.netdocId || item.id;
    if (!netdocId) return;

    if (e.metaKey || e.ctrlKey || e.button === 1) {
      e.preventDefault();
      onOpenNetdocInNewTab?.(netdocId, item.title || 'Netdoc');
    } else {
      const openNewTab = getOpenLinkNewTab();
      if (openNewTab && onOpenNetdocInNewTab) {
        onOpenNetdocInNewTab(netdocId, item.title || 'Netdoc');
      } else if (onOpenNetdocInCurrentTab) {
        onOpenNetdocInCurrentTab(netdocId, item.title || 'Netdoc');
      } else {
        navigate(`/netdoc/${netdocId}`);
      }
    }
    if (isMobile) setIsOpen(false);
  };

  const handleItemRename = async (itemId: string, itemType: 'netdoc', newName: string) => {
    if (!newName.trim()) {
      setRenamingItem(null);
      setRenameInput('');
      return;
    }

    try {
      const res = await apiFetch(`/api/netdoc/${itemId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() })
      });

      if (res.ok) {
        const updateItem = (item: SidebarItem) => {
          if (item.netdocId === itemId || item.id === itemId) {
            return { ...item, title: newName.trim() };
          }
          return item;
        };

        setItems(prev => prev.map(updateItem));
        setSidebarItems?.(sidebarItems.map(updateItem));
        onNetdocRenamed?.(itemId, newName.trim());
      }
    } catch (err) {
      console.error('Failed to rename netdoc:', err);
    }

    setRenamingItem(null);
    setRenameInput('');
  };

  const cancelItemRename = () => {
    setRenamingItem(null);
    setRenameInput('');
  };

  // ============================================================================
  // CONTEXT MENU ITEMS
  // ============================================================================

  const item = contextMenu?.item;
  const isNetdoc = item?.type === 'netdoc';

  const contextMenuItems = [
    { label: isReorderMode ? 'Done Reordering' : 'Reorder', show: isMobile, onClick: () => {
      const newMode = !isReorderMode;
      setIsReorderMode(newMode);
      if (!newMode) sidebarDrag.resetDragState();
    }},
    { label: 'New Netdoc', show: true, onClick: () => {
      openNetdocInput();
      closeContextMenu();
    }},
    { label: 'Unsubscribe', show: isNetdoc && (item?.netdocId || item?.id) && !!onSubscriptionChange, onClick: async () => {
      const netdocId = item?.netdocId || item?.id;
      if (netdocId) await onSubscriptionChange?.(netdocId, false);
    }},
    { label: 'Rename', show: isNetdoc, onClick: () => {
      const id = item?.netdocId || item?.id;
      if (id && item?.title) {
        setRenamingItem({ id, type: 'netdoc' });
        setRenameInput(item.title);
      }
      closeContextMenu();
    }},
  ].filter(i => i.show).map(({ label, onClick }) => ({ label, onClick }));

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <>
      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={closeContextMenu}
        />
      )}

      {/* Explore header */}
      <div style={{
        padding: '8px 0.75em 0px 0.75em',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        visibility: radialMenuOpen ? 'hidden' : 'visible'
      }}>
        <button
          onClick={() => onExplore ? onExplore() : navigate('/')}
          style={{
            cursor: 'pointer',
            border: '1px solid rgba(193, 162, 99, 0.3)',
            borderRadius: '4px',
            transition: 'border-color 0.15s ease',
            background: 'none',
            padding: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(193, 162, 99, 0.6)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(193, 162, 99, 0.3)'; }}
        >
          <img src={globeSvg} alt="Explore" width={18} height={18} style={{ filter: 'url(#iconColorFilter)', opacity: 0.85 }} />
        </button>
        <button
          onClick={() => navigateTo ? navigateTo('/space') : navigate('/space')}
          style={{
            cursor: 'pointer',
            border: '1px solid rgba(193, 162, 99, 0.3)',
            borderRadius: '4px',
            transition: 'border-color 0.15s ease',
            background: 'none',
            padding: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 1
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(193, 162, 99, 0.6)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(193, 162, 99, 0.3)'; }}
        >
          <img src={spaceSvg} alt="Spaces" width={18} height={18} style={{ filter: 'url(#iconColorFilter)', opacity: 0.85 }} />
        </button>
      </div>

      {isAuthenticated && (
        <SidebarHeader
          onNew={() => {
            if (onNew) {
              onNew();
              if (isMobile) setIsOpen(false);
            }
          }}
          onNewSpace={() => setShowSpaceInput(true)}
          onToggleSearch={() => setShowSearch(!showSearch)}
          showSearch={showSearch}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onSearchSubmit={(query) => {
            if (onOpenNetdocInCurrentTab) {
              onOpenNetdocInCurrentTab(query, query);
            } else {
              navigate(`/netdoc/${query}`);
            }
            setSearchQuery('');
            setShowSearch(false);
            if (isMobile) setIsOpen(false);
          }}
          currentSpaceName={viewingSpace ? viewingSpace.name : sidebarTab === 'spaces' ? 'Spaces Menu' : sidebarTab === 'netdocs' && displayName ? `${displayName}'s Saved` : undefined}
          onExitSpace={viewingSpace ? handleExitSpace : undefined}
          onSpaceNameClick={viewingSpace ? () => {
            if (navigateTo) {
              navigateTo(`/space/${viewingSpace.id}`);
            } else {
              navigate(`/space/${viewingSpace.id}`);
            }
            if (isMobile) setIsOpen(false);
          } : undefined}
          sidebarTab={sidebarTab}
          onRadialMenuChange={setRadialMenuOpen}
          onSaved={onSaved}
        />
      )}

      {showSpaceInput && (
        <div style={{ padding: '0.5em 0.75em', display: 'flex', gap: '4px' }}>
          <input
            type="text"
            placeholder="Space name..."
            value={spaceNameInput}
            onChange={(e) => setSpaceNameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmitSpaceCreate();
              if (e.key === 'Escape') { setShowSpaceInput(false); setSpaceNameInput(''); }
            }}
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              padding: '4px 8px',
              fontSize: '12px',
              background: '#1a1410',
              color: 'var(--main-text)',
              border: '1px solid #c1a263',
              borderRadius: '4px',
              boxSizing: 'border-box'
            }}
          />
          <button
            onClick={handleSubmitSpaceCreate}
            style={{
              padding: '4px 10px',
              background: '#c1a263',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: 'bold',
              lineHeight: 1
            }}
          >+</button>
        </div>
      )}

      {showNetdocInput && (
        <div style={{ padding: '0.5em 0.75em', display: 'flex', gap: '4px' }}>
          <input
            type="text"
            placeholder="Netdoc title..."
            value={netdocInputTitle}
            onChange={(e) => setNetdocInputTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSubmitNetdocCreate();
              if (e.key === 'Escape') closeNetdocInput();
            }}
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              padding: '4px 8px',
              fontSize: '12px',
              background: '#1a1410',
              color: 'var(--main-text)',
              border: '1px solid #c1a263',
              borderRadius: '4px',
              boxSizing: 'border-box'
            }}
          />
          <button
            onClick={handleSubmitNetdocCreate}
            style={{
              padding: '4px 10px',
              background: '#c1a263',
              color: '#000',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '16px',
              fontWeight: 'bold',
              lineHeight: 1
            }}
          >+</button>
        </div>
      )}

      {/* Sidebar content */}
      {isAuthenticated && (
      <div
        className="sidebar-scroll-container"
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
        onContextMenu={(e) => {
          const target = e.target as HTMLElement;
          if (!target.closest('.sidebar-item')) {
            handleContextMenu(e, null);
          }
        }}
      >
        {/* Spaces list view */}
        {sidebarTab === 'spaces' && !viewingSpace && (
          subscribedSpaces.length === 0 ? (
            <div className="sidebar-empty">No spaces yet</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {subscribedSpaces.map(space => (
                <div
                  key={space.id}
                  className="sidebar-item"
                  onClick={() => handleSpaceClick(space)}
                  style={{
                    padding: '0.5em 0.75em',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5em',
                    borderRadius: '4px'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {space.name}
                  </span>
                </div>
              ))}
            </div>
          )
        )}

        {/* Item list (space contents or netdocs) */}
        {(sidebarTab !== 'spaces' || viewingSpace) ? (() => {
          const isSpaceView = !!viewingSpace;

          let displayItems: SidebarItem[];
          if (isSpaceView) {
            displayItems = spaceItems;
          } else {
            displayItems = sidebarItems.filter(item => item.type !== 'folder');
            if (searchQuery) {
              displayItems = displayItems.filter(item =>
                item.title?.toLowerCase().includes(searchQuery.toLowerCase())
              );
            }
          }

          if (displayItems.length === 0) {
            return <div className="sidebar-empty">{isSpaceView ? 'This space is empty' : 'No items yet'}</div>;
          }

          const activeDrag = isSpaceView ? spaceDrag : sidebarDrag;
          const drag = { ...activeDrag, onHandleDrop: activeDrag.handleDrop };

          return (
            <SidebarItemRenderer
              items={displayItems}
              truncateTitle={truncateTitle}
              isMobile={isMobile}
              isReorderMode={isReorderMode}
              {...drag}
              onHandleContextMenu={isSpaceView ? () => {} : (e, item) => handleContextMenu(e, item)}
              onItemClick={handleItemClick}
              showItemIcon={isSpaceView}
              {...(!isSpaceView ? {
                showNetdocInput,
                netdocInputTitle,
                setNetdocInputTitle,
                onNetdocInputSubmit: handleSubmitNetdocCreate,
                onNetdocInputCancel: closeNetdocInput,
                renamingItem,
                renameInput,
                setRenameInput,
                onItemRenameSubmit: handleItemRename,
                onItemRenameCancel: cancelItemRename,
              } : {})}
            />
          );
        })() : null}
      </div>
      )}

      {!isAuthenticated && (
        <div className="sidebar-empty" style={{ padding: '1em', textAlign: 'center', color: '#888' }}>
          Login to see your netdocs
        </div>
      )}
    </>
  );
};

export default Explorer;
