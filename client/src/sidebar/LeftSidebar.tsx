/**
 * @file LeftSidebar.tsx
 * @description Left sidebar with Explorer content and navigation footer.
 */

import React from 'react';
import { SidebarItem } from '../types';
import { RouteType } from '../types/routing';
import './styles.css';
import { useResizableSidebar } from './useResizableSidebar';
import ResizeHandle from './ResizeHandle';
import Explorer from './Explorer';
import SidebarFooter from './SidebarFooter';

interface LeftSidebarProps {
  routeType?: RouteType;
  displayName?: string;
  onProfile: () => void;
  onSettings: () => void;
  isAuthenticated?: boolean;
  onLogin?: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  headerHeight?: number;
  footerHeight?: number;
  // Explorer props
  sidebarItems?: SidebarItem[];
  isMobile?: boolean;
  setIsOpen?: (open: boolean) => void;
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
  onViewingSpaceChange?: (space: { id: string; name: string } | null) => void;
  externalViewingSpace?: { id: string; name: string; monarchDisplayName?: string } | null;
  isOwnProfile?: boolean;
  subscribedSpaces?: { id: string; name: string; orderKey?: number; monarch?: { id: string; username: string; displayName: string } }[];
  setSubscribedSpaces?: React.Dispatch<React.SetStateAction<{ id: string; name: string; orderKey?: number; monarch?: { id: string; username: string; displayName: string } }[]>>;
  profileId?: string;
  onSaved?: () => void;
}

const LeftSidebar: React.FC<LeftSidebarProps> = ({
  routeType,
  displayName,
  onProfile,
  onSettings,
  isAuthenticated = true,
  onLogin,
  isCollapsed = false,
  onToggleCollapse,
  headerHeight = 0,
  footerHeight = 0,
  // Explorer props
  sidebarItems = [],
  isMobile = false,
  setIsOpen = () => {},
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
  isOwnProfile,
  subscribedSpaces,
  setSubscribedSpaces,
  profileId,
  onSaved,
}) => {
  // Resize functionality - handle is on RIGHT edge for left sidebar
  const { width: sidebarWidth, handleResizeStart } = useResizableSidebar({
    defaultWidth: 200,
    minWidth: 150,
    maxWidth: 400,
    side: 'right',
    isCollapsed: isCollapsed,
    onToggleCollapse: () => onToggleCollapse?.()
  });

  // When not authenticated, show only Login button
  if (!isAuthenticated) {
    return (
      <aside id="left-sidebar" className={isCollapsed ? 'left-sidebar-collapsed' : ''}>
        <SidebarFooter isAuthenticated={false} onLogin={onLogin} onProfile={onProfile} onSettings={onSettings} />
      </aside>
    );
  }

  return (
    <aside
      id="left-sidebar"
      className={isCollapsed ? 'left-sidebar-collapsed' : ''}
      style={{
        width: isCollapsed ? 0 : `${sidebarWidth}px`,
        display: 'flex',
        flexDirection: 'row'
      }}
    >
      {/* Content wrapper */}
      <div className="left-sidebar-style">
        {/* Resize handle - on right edge for left sidebar */}
        <ResizeHandle side="right" onMouseDown={handleResizeStart} headerHeight={headerHeight} footerHeight={footerHeight} />

        {/* Explorer content */}
        {/* this component is meant to be not hilitable. do not change that styling and do not remove this comment */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'visible', userSelect: 'none' }}>
          <Explorer
            routeType={routeType}
            displayName={displayName}
            sidebarItems={sidebarItems}
            isMobile={isMobile}
            setIsOpen={setIsOpen}
            onOpenNetdocInCurrentTab={onOpenNetdocInCurrentTab}
            onOpenNetdocInNewTab={onOpenNetdocInNewTab}
            onNew={onNew}
            onExplore={onExplore}
            onSubscriptionChange={onSubscriptionChange}
            onNetdocCreated={onNetdocCreated}
            onNetdocRenamed={onNetdocRenamed}
            setSidebarItems={setSidebarItems}
            fetchSidebarItems={fetchSidebarItems}
            navigateTo={navigateTo}
            onViewingSpaceChange={onViewingSpaceChange}
            externalViewingSpace={externalViewingSpace}
            isOwnProfile={isOwnProfile}
            subscribedSpaces={subscribedSpaces}
            setSubscribedSpaces={setSubscribedSpaces}
            onProfile={onProfile}
            profileId={profileId}
            isAuthenticated={isAuthenticated}
            onSaved={onSaved}
          />
        </div>

        <SidebarFooter
          onProfile={onProfile}
          onSettings={onSettings}
        />
      </div>
      {/* Border container - accent bar + medial border */}
      <div id="resize-handle-left" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ height: headerHeight - 1, flexShrink: 0 }} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row' }}>
          {/* Accent bar - gradient */}
          <div style={{
            width: '1px',
            background: 'linear-gradient(to bottom, var(--accent-blue) 0%, var(--accent-orange) 100%)',
            opacity: 0.4
          }} />
          <div style={{ width: '3px' }} />
          {/* Medial border */}
          <div style={{ width: '1px', background: '#c1a263' }} />
        </div>
        <div style={{ height: footerHeight, flexShrink: 0 }} />
      </div>
    </aside>
  );
};

export default LeftSidebar;
