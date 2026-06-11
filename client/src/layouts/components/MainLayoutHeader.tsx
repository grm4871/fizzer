import React, { useState, useEffect, useImperativeHandle, forwardRef, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import UrlBar from '../../top/UrlBar';
import { RouteType, LayoutMode } from '../../types/routing';
import { parseNetdocIdFromPath } from '../MainLayout';
import leftExpandedSvg from '../../icons/leftExpanded.svg';
import leftCollapsedSvg from '../../icons/leftCollapsed.svg';
import ModeCycler, { ModeCyclerHandle } from './header/ModeCycler';
import SplashTitle from './header/SplashTitle';
import starSvg from '../../icons/star.svg';
import starFilledSvg from '../../icons/starFilled.svg';

interface MainLayoutHeaderProps {
  isTabbedRoute: boolean;
  routeType: RouteType;
  isMobile: boolean;
  isRightSidebarCollapsed: boolean;
  setIsRightSidebarCollapsed: (collapsed: boolean) => void;
  isLeftSidebarCollapsed: boolean;
  setIsLeftSidebarCollapsed: (collapsed: boolean) => void;
  handleBack: () => void;
  handleForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  username: string;
  navigateToNetdoc: (netdocId: string, netdocName: string) => void;
  navigateToProfile: (profileUsername: string) => void;
  navigateTo: (path: string) => void;
  layoutMode: LayoutMode;
  setLayoutMode: (mode: LayoutMode) => void;
  canWrite: boolean;
  isSubscribed: boolean;
  onSubscriptionChange: (netdocId: string, shouldSubscribe: boolean) => Promise<void>;
  isNotificationsEnabled: boolean;
  onNotificationsChange: (netdocId: string, shouldEnable: boolean) => Promise<void>;
  currentNetdocId?: string;
  currentNetdoc?: any;
  currentSpace?: { id: string; name: string; monarchDisplayName?: string; jacketId?: string; canWrite?: boolean; jacketCanWrite?: boolean } | null;
  isSpaceSubscribed?: boolean;
  onSpaceSubscriptionChange?: (spaceId: string, shouldSubscribe: boolean) => Promise<void>;
  menuTitle?: string;
  onMenuClose?: () => void;
  isCreatingNewNetdoc?: boolean;
  isOwner?: boolean;
  isAuthenticated?: boolean;
}

export interface MainLayoutHeaderHandle {
  activateUrlBar: () => void;
  cycleMode: () => void;
  cycleModeReverse: () => void;
}

const MainLayoutHeader = forwardRef<MainLayoutHeaderHandle, MainLayoutHeaderProps>(({
  isTabbedRoute,
  routeType,
  isMobile,
  isRightSidebarCollapsed,
  setIsRightSidebarCollapsed,
  isLeftSidebarCollapsed,
  setIsLeftSidebarCollapsed,
  handleBack,
  handleForward,
  canGoBack,
  canGoForward,
  username,
  navigateToNetdoc,
  navigateToProfile,
  navigateTo,
  layoutMode,
  setLayoutMode,
  canWrite,
  isSubscribed,
  onSubscriptionChange,
  isNotificationsEnabled,
  onNotificationsChange,
  currentNetdocId,
  currentNetdoc,
  currentSpace,
  isSpaceSubscribed = false,
  onSpaceSubscriptionChange,
  menuTitle,
  onMenuClose,
  isCreatingNewNetdoc = false,
  isOwner = false,
  isAuthenticated = true,
}, ref) => {
  const location = useLocation();
  const [isUrlBarEditing, setIsUrlBarEditing] = useState(false);
  const modeCyclerRef = useRef<ModeCyclerHandle>(null);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    activateUrlBar: () => {
      if ((routeType === 'netdoc' && currentNetdoc) || ((routeType === 'space' || routeType === 'profile') && currentSpace)) {
        setIsUrlBarEditing(true);
      }
    },
    cycleMode: () => modeCyclerRef.current?.cycle(),
    cycleModeReverse: () => modeCyclerRef.current?.cycleReverse(),
  }), [routeType, currentNetdoc, currentSpace]);

  // Global escape key listener for URL bar editing and menu close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isUrlBarEditing) {
          setIsUrlBarEditing(false);
        } else if (menuTitle && onMenuClose) {
          onMenuClose();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isUrlBarEditing, menuTitle, onMenuClose]);

  if (!isTabbedRoute) return null;

  // Compute URL bar values
  const isProfileRoute = routeType === 'profile';
  const isNotificationsRoute = routeType === 'notifications';
  const netdocId = routeType === 'netdoc' ? parseNetdocIdFromPath(location.pathname) : undefined;

  let urlValue = '', urlPlaceholder = 'Enter netdoc URL or ID...';
  if (isNotificationsRoute) {
    urlValue = '/notifications';
  } else if (isProfileRoute) {
    const profileUsername = location.pathname.startsWith('/id/')
      ? location.pathname.split('/id/')[1]
      : username;
    urlValue = `/id/${profileUsername}`;
    urlPlaceholder = 'Enter profile URL...';
  } else if (routeType === 'explore') {
    urlValue = '';
  } else if (routeType === 'space') {
    const spaceId = location.pathname.split('/space/')[1];
    urlValue = `/space/${spaceId}`;
  } else {
    urlValue = `/netdoc/${netdocId}`;
  }

  const renderStarButton = (isActive: boolean, onClick: () => void) => (
    <button
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '15px',
        height: '15px',
        marginRight: '6px',
        marginLeft: '12px',
        flexShrink: 0
      }}
      title={isActive ? "Remove from sidebar" : "Add to sidebar"}
    >
      <img src={isActive ? starFilledSvg : starSvg} alt="Star" width={15} height={15} />
    </button>
  );

  return (
    <div id="header-url-bar" style={{ flexShrink: 0 }}>
      <div id="sidebar-action-button-flanks" style={{
        display: 'flex',
        flexDirection: 'row',
      }}>
        {/* Left sidebar toggle - stretched vertically */}
        <div id="sidebar-left-flank" style={{
          display: 'flex',
          alignItems: 'stretch',
          flexShrink: 0,
          borderLeft: 'none',
          borderBottom: (!isAuthenticated || isLeftSidebarCollapsed) ? '#555 1px solid' : '1px solid #c1a263',
          position: 'relative'
        }}>
          <button
            onClick={() => {
              if (isMobile && isLeftSidebarCollapsed && !isRightSidebarCollapsed) {
                // On mobile, close right sidebar first when opening left
                setIsRightSidebarCollapsed(true);
              }
              setIsLeftSidebarCollapsed(!isLeftSidebarCollapsed);
            }}
            style={{
              height: '100%',
              padding: '0 12px',
              background: 'transparent',
              border: 'none',
              borderRight: (!isAuthenticated || isLeftSidebarCollapsed) ? '#555 1px solid' : '1px solid #c1a263',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: isAuthenticated ? 1 : 0.5
            }}
            title={isLeftSidebarCollapsed ? "Open Left Sidebar" : "Close Left Sidebar"}
          >
            <img
              src={isAuthenticated ? (isLeftSidebarCollapsed ? leftCollapsedSvg : leftExpandedSvg) : leftCollapsedSvg}
              alt={isLeftSidebarCollapsed ? "Open Left Sidebar" : "Close Left Sidebar"}
              style={{ width: '20px', height: '20px' }}
            />
          </button>
          {!isAuthenticated && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                cursor: 'default',
                zIndex: 1
              }}
              title="Login to access sidebar"
            />
          )}
        </div>
        {/* Center content: URL bar */}
        <div style={{
          flex: '1 1 0',
          minWidth: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: '#111',
        }}>
          {/* URL bar row */}
            <div
              style={{
                borderBottom: '#555 1px solid',
                display: 'flex',
                alignItems: 'center',
                height: '48px'
              }}
            >
              {/* Navigation buttons - hidden on settings and admin */}
              {routeType !== 'settings' && routeType !== 'admin' && (
                <div style={{ display: 'flex', gap: '4px', padding: '0 .25em', flexShrink: 0 }}>
                  <button
                    onClick={handleBack}
                    disabled={!canGoBack}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: canGoBack ? 'pointer' : 'default',
                      opacity: canGoBack ? 1 : 0.3,
                      padding: '4px 8px',
                      color: 'inherit',
                      fontSize: '16px',
                    }}
                    title="Go back"
                  >
                    ←
                  </button>
                  <button
                    onClick={handleForward}
                    disabled={!canGoForward}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      cursor: canGoForward ? 'pointer' : 'default',
                      opacity: canGoForward ? 1 : 0.3,
                      padding: '4px 8px',
                      color: 'inherit',
                      fontSize: '16px',
                    }}
                    title="Go forward"
                  >
                    →
                  </button>
                </div>
              )}

              {!menuTitle && (
                <div style={{ flexShrink: 0 }}>
                  <ModeCycler ref={modeCyclerRef} mode={layoutMode} setMode={setLayoutMode} canWrite={(routeType === 'space' || routeType === 'profile') ? (currentSpace?.jacketCanWrite ?? false) : canWrite} isNetdoc={routeType === 'netdoc'} isCreatingNewNetdoc={isCreatingNewNetdoc} isOwner={isOwner} isSpace={routeType === 'space' || routeType === 'profile'} spaceCanWrite={currentSpace?.jacketCanWrite ?? false} />
                </div>
              )}
              {/* Click-to-edit container for SplashTitle/UrlBar swap.
                  Clicking anywhere in this div (not the nav buttons, star, or mode selector)
                  will swap the SplashTitle display for the editable UrlBar.
                  This container is separate from those controls to prevent accidental triggers. */}
              <div
                style={{
                  flex: '1 1 0',
                  minWidth: 0,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'center',
                  cursor: ((routeType === 'netdoc' && currentNetdoc) || ((routeType === 'space' || routeType === 'profile') && currentSpace)) && !isUrlBarEditing ? 'pointer' : 'default'
                }}
                onClick={() => {
                  if (((routeType === 'netdoc' && currentNetdoc) || ((routeType === 'space' || routeType === 'profile') && currentSpace)) && !isUrlBarEditing) {
                    setIsUrlBarEditing(true);
                  }
                }}
              >
                <div
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    overflow: 'hidden',
                    padding: '.25em'
                  }}
                >
                  {menuTitle ? (
                    <SplashTitle title={menuTitle} />
                  ) : routeType === 'netdoc' && currentNetdoc && !isUrlBarEditing ? (
                    <SplashTitle
                      spaceName={currentNetdoc.space?.name}
                      authorDisplayName={currentNetdoc.creator?.displayName}
                      title={currentNetdoc.name}
                      updatedAt={currentNetdoc.updated_at}
                    />
                  ) : routeType === 'space' && currentSpace && !isUrlBarEditing ? (
                    <SplashTitle title={currentSpace.name} authorDisplayName={currentSpace.monarchDisplayName} />
                  ) : routeType === 'profile' && currentSpace && !isUrlBarEditing ? (
                    <SplashTitle title={currentSpace.name} authorDisplayName={currentSpace.monarchDisplayName} />
                  ) : (
                    <UrlBar
                      value={urlValue}
                      onChange={() => { }}
                      onNavigateToNetdoc={navigateToNetdoc}
                      onNavigateToProfile={navigateToProfile}
                      onNavigateTo={navigateTo}
                      placeholder={urlPlaceholder}
                      showNavButtons={false}
                      onBack={handleBack}
                      onForward={handleForward}
                      canGoBack={canGoBack}
                      canGoForward={canGoForward}
                      onBlur={() => setIsUrlBarEditing(false)}
                      autoFocus={isUrlBarEditing}
                    />
                  )}
                </div>
              </div>
              
              {/* Star/Subscribe button for netdocs */}
              {routeType === 'netdoc' && currentNetdocId && renderStarButton(isSubscribed, () => onSubscriptionChange(currentNetdocId, !isSubscribed))}
              {/* Star/Subscribe button for spaces */}
              {routeType === 'space' && currentSpace && onSpaceSubscriptionChange && renderStarButton(isSpaceSubscribed, () => onSpaceSubscriptionChange(currentSpace.id, !isSpaceSubscribed))}
              {/* Bell/Notifications button
                  Enforcing unnotification on unsubscribe happens at database level (FK cascade).
                  Enforcing subscribed requirement for notifs happens at database level (FK constraint).
                  Clicking bell when unsubscribed auto-subscribes first, then enables notifs. */}
              {routeType === 'netdoc' && currentNetdocId && (
                <button
                  onClick={async () => {
                    if (!isSubscribed) {
                      // Auto-subscribe first, then enable notifications
                      await onSubscriptionChange(currentNetdocId, true);
                      await onNotificationsChange(currentNetdocId, true);
                    } else {
                      onNotificationsChange(currentNetdocId, !isNotificationsEnabled);
                    }
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '15px',
                    height: '15px',
                    marginRight: '12px',
                    flexShrink: 0
                  }}
                  title={!isSubscribed ? "Subscribe and enable notifications" : isNotificationsEnabled ? "Disable notifications" : "Enable notifications"}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 -2 24 24"
                    fill={isNotificationsEnabled ? "#c1a263" : "none"}
                    stroke={isNotificationsEnabled ? "#c1a263" : "#555"}
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                </button>
              )}
            </div>
        </div>
        {/* Right sidebar toggle */}
        <div id="sidebar-right-flank" style={{
          display: 'flex',
          alignItems: 'stretch',
          flexShrink: 0,
          borderRight: 'none',
          borderBottom: (!isAuthenticated || isRightSidebarCollapsed) ? '#555 1px solid' : '1px solid #c1a263',
          position: 'relative'
        }}>
          <button
            onClick={() => {
              if (isMobile && isRightSidebarCollapsed && !isLeftSidebarCollapsed) {
                // On mobile, close left sidebar first when opening right
                setIsLeftSidebarCollapsed(true);
              }
              setIsRightSidebarCollapsed(!isRightSidebarCollapsed);
            }}
            style={{
              height: '100%',
              padding: '0 12px',
              background: 'transparent',
              border: 'none',
              borderLeft: (!isAuthenticated || isRightSidebarCollapsed) ? '#555 1px solid' : '1px solid #c1a263',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: isAuthenticated ? 1 : 0.5
            }}
            title={isRightSidebarCollapsed ? "Open Right Sidebar" : "Close Right Sidebar"}
          >
            <img
              src={isAuthenticated ? (isRightSidebarCollapsed ? leftCollapsedSvg : leftExpandedSvg) : leftCollapsedSvg}
              alt={isRightSidebarCollapsed ? "Open Right Sidebar" : "Close Right Sidebar"}
              style={{ width: '20px', height: '20px', transform: 'scaleX(-1)' }}
            />
          </button>
          {!isAuthenticated && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                cursor: 'default',
                zIndex: 1
              }}
              title="Login to access sidebar"
            />
          )}
        </div>
      </div>
    </div>
  );
});
export default MainLayoutHeader;
