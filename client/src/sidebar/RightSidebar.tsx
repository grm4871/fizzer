/**
 * @file RightSidebar.tsx
 * @description Right sidebar displaying notifications feed.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Notification } from '../types';
import { useResizableSidebar } from './useResizableSidebar';
import ResizeHandle from './ResizeHandle';
import './styles.css';
import '../styles/collapsed.css';

interface NotificationsSidebarProps {
  notifications: Notification[];
  unreadCount: number;
  onNavigateToNetdoc: (netdocId: string, netdocName: string) => void;
  onMarkAsRead?: (notificationId: string) => void;
  onMarkAllAsRead?: () => void;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  isMobile: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  headerHeight?: number;
  footerHeight?: number;
}

const RightSidebar: React.FC<NotificationsSidebarProps> = ({
  notifications,
  unreadCount,
  onNavigateToNetdoc,
  onMarkAsRead,
  onMarkAllAsRead,
  isOpen,
  setIsOpen,
  isMobile,
  isCollapsed = false,
  onToggleCollapse,
  headerHeight = 0,
  footerHeight = 0
}) => {
  // ============================================================================
  // SIDEBAR SHELL STATE
  // ============================================================================

  /** Sidebar resize functionality - handle is on LEFT edge */
  const { width: sidebarWidth, handleResizeStart } = useResizableSidebar({
    defaultWidth: 250,
    minWidth: 180,
    maxWidth: 400,
    side: 'left',
    isCollapsed: isCollapsed,
    onToggleCollapse: () => onToggleCollapse?.()
  });

  /** Touch X position for detecting sidebar open/close swipes on mobile */
  const [touchStartX, setTouchStartX] = useState(0);

  /** Ref to the sidebar DOM element for outside-click detection */
  const sidebarRef = useRef<HTMLDivElement>(null);

  // ============================================================================
  // TOUCH AND MOBILE INTERACTIONS
  // ============================================================================

  const handleTouchStart = (e: TouchEvent) => {
    if (!isMobile) return;
    const x = e.touches[0].clientX;
    setTouchStartX(x);
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (!isMobile || touchStartX === 0) return;
    const x = e.touches[0].clientX;
    const screenWidth = window.innerWidth;

    // Open if swiping left from right edge
    if (!isOpen && touchStartX > screenWidth - 50 && x < touchStartX - 50) {
      setIsOpen(true);
    }
    // Close if swiping right on open drawer
    if (isOpen && x > touchStartX + 50) {
      setIsOpen(false);
    }
  };

  const handleTouchEnd = () => {
    setTouchStartX(0);
  };

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  /** Close sidebar when clicking outside (mobile only) */
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const isContextMenu = (target as HTMLElement).closest?.('[style*="z-index: 10000"]');
      if (isContextMenu) return;

      if (isMobile && isOpen && sidebarRef.current && !sidebarRef.current.contains(target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen, isMobile, setIsOpen]);

  /** Touch listeners for swipe detection */
  useEffect(() => {
    document.addEventListener('touchstart', handleTouchStart);
    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleTouchEnd);
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isOpen, touchStartX, isMobile]);

  // ============================================================================
  // HELPERS
  // ============================================================================


  const handleNotificationClick = (notif: Notification) => {
    // Handle netdoc notifications
    if (notif.netdocId) {
      onNavigateToNetdoc(notif.netdocId, notif.netdocName || 'Netdoc');
      if (onMarkAsRead && !notif.read) {
        onMarkAsRead(notif.id);
      }
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================

  const sidebarClass = isMobile
    ? (isOpen ? 'sidebar-mobile-open' : 'sidebar-mobile-closed')
    : (isCollapsed ? 'sidebar-collapsed' : '');

  const overlay = isMobile && isOpen ? (
    <div className="sidebar-overlay" onClick={() => setIsOpen(false)} />
  ) : null;

  return (
    <>
      {overlay}

      <aside
        id="right-sidebar"
        ref={sidebarRef}
        className={sidebarClass}
        style={{
          // Only set width on desktop - mobile uses CSS fixed positioning
          width: isMobile ? undefined : (isCollapsed ? 0 : `${sidebarWidth}px`),
          display: 'flex',
          flexDirection: 'row'
        }}
      >
        {/* Border container - medial border + accent bar (desktop only) */}
        {!isMobile && (
          <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
            <div style={{ height: headerHeight - 1, flexShrink: 0 }} />
            <div style={{ flex: 1, display: 'flex', flexDirection: 'row' }}>
              {/* Medial border */}
              <div style={{ width: '1px', background: '#c1a263' }} />
              <div style={{ width: '3px' }} />
              {/* Accent bar - gradient */}
              <div style={{
                width: '1px',
                background: 'linear-gradient(to bottom, var(--accent-blue) 0%, var(--accent-orange) 100%)',
                opacity: 0.4
              }} />
            </div>
            <div style={{ height: footerHeight, flexShrink: 0 }} />
          </div>
        )}

        {/* Content wrapper */}
        <div className="right-sidebar-style" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* Resize handle - on left edge for right sidebar */}
          {!isMobile && <ResizeHandle side="left" onMouseDown={handleResizeStart} headerHeight={headerHeight} footerHeight={footerHeight} />}

          {/* Header */}
          <div style={{
            padding: '0.75em',
            borderBottom: '1px solid #333',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0
          }}>
            <span style={{ fontWeight: 'bold', color: '#c1a263', fontSize: '0.9em' }}>
              Notifications {unreadCount > 0 && <span style={{ color: '#888' }}>({unreadCount})</span>}
            </span>
            {unreadCount > 0 && onMarkAllAsRead && (
              <button
                onClick={onMarkAllAsRead}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#888',
                  fontSize: '0.75em',
                  cursor: 'pointer',
                  padding: '0.25em 0.5em'
                }}
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Notification List */}
          <div style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0.5em'
          }}>
            {notifications.length === 0 ? (
              <div style={{
                textAlign: 'center',
                color: '#666',
                padding: '2em 1em',
                fontSize: '0.85em'
              }}>
                No notifications yet
              </div>
            ) : (
              notifications.map(notif => (
                <div
                  key={notif.id}
                  className="post-container post-container-iso collapsed"
                  onClick={() => handleNotificationClick(notif)}
                  style={{
                    marginBottom: '0.5em',
                    cursor: 'pointer',
                    opacity: notif.read ? 0.7 : 1,
                    transition: 'opacity 0.2s',
                    padding: 0
                  }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = notif.read ? '0.7' : '1')}
                >
                  <div className="post-alloi " style={{
                    padding: '0.6em',
                    backgroundColor: notif.read ? 'rgba(0,0,0,0.2)' : `rgba(${parseInt((notif.authorColor || 'c1a263').slice(0,2), 16)}, ${parseInt((notif.authorColor || 'c1a263').slice(2,4), 16)}, ${parseInt((notif.authorColor || 'c1a263').slice(4,6), 16)}, 0.05)`,
                    borderLeft: notif.read ? '2px solid transparent' : `6px solid #${notif.authorColor || 'c1a263'}`,
                    minHeight: 'auto'
                  }}>
                    {/* Netdoc Name Header */}
                    <div style={{
                      fontSize: '0.75em',
                      fontWeight: 'normal',
                      color: '--var(main-text',
                      marginBottom: '0.3em',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      opacity: 0.9
                    }}>
                      <span style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        letterSpacing: '0.05em'
                      }}>
                        {notif.netdocName ? notif.netdocName.toUpperCase() : 'NETDOC'}
                      </span>
                      {!notif.read && (
                        <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#c1a263' }} />
                      )}
                    </div>

                    {/* Content / Message */}
                    <div className="post-content">
                      <div className="post-paragraph" style={{ fontSize: '0.85em', color: '#ccc', lineHeight: '1.4' }}>
                        {/* Author line integrated with content or just above */}
                         <div style={{ 
                           marginBottom: '0.2em' 
                         }}>
                            <span style={{ fontWeight: 'bold', color: '#ddd' }}>{notif.authorName || 'Someone'}</span>
                         </div>
                        
                        {/* Plaintext Content */}
                        <div style={{ color: '#aaa' }}>
                          {notif.content ? (
                            <span style={{ overflowWrap: 'anywhere' }}>{notif.content}</span>
                          ) : (
                            <span style={{ fontStyle: 'italic', color: '#777' }}>
                              {notif.message}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </aside>
    </>
  );
};

export default RightSidebar;
