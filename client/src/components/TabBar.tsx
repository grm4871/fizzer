/**
 * @file TabBar.tsx — Tabbed navigation bar component
 *
 * Renders the top tab bar showing all open tabs. Supports:
 * - Icon differentiation (note vs web tab)
 * - Active tab highlight (both main active tab and split active tab)
 * - Close button on hover
 * - Middle-click to close
 * - Right-click context menu to split/open in split pane
 *
 * @component
 */

import { useState, useEffect } from 'react';
import { Globe, FileText, Columns, X, Plus, Terminal, Hash } from 'lucide-react';

export interface Tab {
  id: string;
  title: string;
  type: 'note' | 'web' | 'terminal' | 'chat';
  dirty?: boolean;
  url?: string;
  terminalHistory?: string;
  isChatNote?: boolean;
}

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  splitTabId?: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenSplitTab?: (id: string) => void;
  onCloseAllTabs?: () => void;
  onCloseOtherTabs?: (id: string) => void;
  onNewTab?: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  splitTabId,
  onSelectTab,
  onCloseTab,
  onOpenSplitTab,
  onCloseAllTabs,
  onCloseOtherTabs,
  onNewTab,
}: TabBarProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; tabId: string } | null>(null);

  useEffect(() => {
    const handleGlobalClick = () => setContextMenu(null);
    window.addEventListener('click', handleGlobalClick);
    return () => window.removeEventListener('click', handleGlobalClick);
  }, []);

  if (tabs.length === 0) {
    return (
      <div className="tab-bar">
        <div className="tab-bar-empty">No open tabs</div>
        {onNewTab && (
          <button className="tab-new-btn" onClick={onNewTab} title="New tab">
            <Plus size={15} />
          </button>
        )}
      </div>
    );
  }

  const handleContextMenu = (e: React.MouseEvent, tabId: string) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      tabId,
    });
  };

  return (
    <div className="tab-bar" id="tab-bar">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const isSplitActive = tab.id === splitTabId;
        
        return (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            className={`tab-item ${isActive ? 'active' : ''} ${isSplitActive ? 'split-active' : ''}`}
            onClick={() => onSelectTab(tab.id)}
            onContextMenu={(e) => handleContextMenu(e, tab.id)}
            onMouseDown={(e) => {
              // Middle-click to close
              if (e.button === 1) {
                e.preventDefault();
                onCloseTab(tab.id);
              }
            }}
            title={tab.url || tab.title}
          >
            {tab.dirty && <span className="tab-dirty" />}
            
            {/* Tab Icon */}
            <span className="tab-icon">
              {tab.type === 'web' ? (
                <Globe size={13} className="text-secondary" style={{ marginRight: '6px' }} />
              ) : tab.type === 'terminal' ? (
                <Terminal size={13} className="text-secondary" style={{ marginRight: '6px' }} />
              ) : tab.type === 'chat' ? (
                <Hash size={13} className="text-secondary" style={{ marginRight: '6px' }} />
              ) : (
                <FileText size={13} className="text-tertiary" style={{ marginRight: '6px' }} />
              )}
            </span>

            <span className="tab-title">{tab.title || 'Untitled'}</span>

            {/* Split view indicator */}
            {isSplitActive && (
              <span className="tab-split-indicator" title="Open in Split View" style={{ marginLeft: '6px', opacity: 0.7 }}>
                <Columns size={10} />
              </span>
            )}

            <span
              className="tab-close"
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }
              }}
              title="Close tab"
            >
              ×
            </span>
          </button>
        );
      })}

      {onNewTab && (
        <button className="tab-new-btn" onClick={onNewTab} title="New tab">
          <Plus size={15} />
        </button>
      )}

      {/* Right-click Context Menu */}
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{
            top: `${contextMenu.y}px`,
            left: `${contextMenu.x}px`,
          }}
        >
          <button
            onClick={() => {
              if (onOpenSplitTab) {
                onOpenSplitTab(contextMenu.tabId);
              }
            }}
          >
            <Columns size={13} />
            Open in Split View
          </button>
          <button
            onClick={() => {
              onCloseOtherTabs?.(contextMenu.tabId);
            }}
          >
            <X size={13} />
            Close other tabs
          </button>
          <button
            onClick={() => {
              onCloseAllTabs?.();
            }}
          >
            <X size={13} />
            Close all tabs
          </button>
        </div>
      )}
    </div>
  );
}
