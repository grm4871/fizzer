/**
 * @file SidebarItemRenderer.tsx
 * @description Renders sidebar items as a flat list with drag-and-drop support.
 */

import React from 'react';
import { SidebarItem } from '../types';

interface SidebarItemRendererProps {
  items: SidebarItem[];
  draggedId: string | null;
  dragOverId: string | null;
  dropPosition: 'before' | 'after' | null;
  isMobile: boolean;
  isReorderMode?: boolean;
  setDraggedId: (id: string | null) => void;
  setDragOverId: (id: string | null) => void;
  setDropPosition: (position: 'before' | 'after' | null) => void;
  resetDragState: () => void;
  onHandleContextMenu: (e: React.MouseEvent, item: SidebarItem) => void;
  onHandleDrop: (e: React.DragEvent, targetId: string, targetParentId?: string | null) => Promise<void>;
  onItemClick: (item: SidebarItem, e: React.MouseEvent) => Promise<void>;
  truncateTitle: (title: string | undefined | null, maxLength?: number) => string;
  // Netdoc input props
  showNetdocInput?: boolean;
  netdocInputTitle?: string;
  setNetdocInputTitle?: (value: string) => void;
  onNetdocInputSubmit?: () => void;
  onNetdocInputCancel?: () => void;
  // Item rename props
  renamingItem?: { id: string; type: 'netdoc' } | null;
  renameInput?: string;
  setRenameInput?: (value: string) => void;
  onItemRenameSubmit?: (itemId: string, itemType: 'netdoc', newName: string) => void;
  onItemRenameCancel?: () => void;
  showItemIcon?: boolean;
}

const SidebarItemRenderer: React.FC<SidebarItemRendererProps> = ({
  items,
  draggedId,
  dragOverId,
  dropPosition,
  isMobile,
  isReorderMode,
  setDraggedId,
  setDragOverId,
  setDropPosition,
  resetDragState,
  onHandleContextMenu,
  onHandleDrop,
  onItemClick,
  truncateTitle,
  renamingItem,
  renameInput,
  setRenameInput,
  onItemRenameSubmit,
  onItemRenameCancel,
  showItemIcon
}) => {
  // Touch handling for mobile drag-and-drop
  const longPressTimerRef = React.useRef<NodeJS.Timeout | null>(null);
  const touchStartPos = React.useRef<{ x: number; y: number } | null>(null);
  const isDraggingTouch = React.useRef(false);

  const handleTouchStart = (e: React.TouchEvent, itemId: string) => {
    if (!isReorderMode || !isMobile) return;

    const touch = e.touches[0];
    touchStartPos.current = { x: touch.clientX, y: touch.clientY };
    isDraggingTouch.current = false;

    longPressTimerRef.current = setTimeout(() => {
      isDraggingTouch.current = true;
      setDraggedId(itemId);
      if (navigator.vibrate) {
        navigator.vibrate(50);
      }
    }, 500);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartPos.current) return;

    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPos.current.x);
    const dy = Math.abs(touch.clientY - touchStartPos.current.y);

    if (!isDraggingTouch.current && (dx > 10 || dy > 10)) {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      return;
    }

    if (isDraggingTouch.current) {
      e.preventDefault();
      const elementAtPoint = document.elementFromPoint(touch.clientX, touch.clientY);
      if (elementAtPoint) {
        const itemElement = elementAtPoint.closest('.sidebar-item');
        if (itemElement) {
          const targetId = itemElement.getAttribute('data-item-id');
          if (targetId && targetId !== draggedId) {
            const rect = itemElement.getBoundingClientRect();
            const y = touch.clientY - rect.top;
            const height = rect.height;
            const position = y < height / 2 ? 'before' : 'after';
            setDragOverId(targetId);
            setDropPosition(position);
          }
        }
      }
    }
  };

  const handleTouchEnd = async () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    if (isDraggingTouch.current && dragOverId) {
      const targetItem = items.find(i => i.id === dragOverId);
      if (targetItem) {
        const syntheticEvent = {
          preventDefault: () => {},
          stopPropagation: () => {},
          dataTransfer: { effectAllowed: 'move', dropEffect: 'move' }
        } as React.DragEvent;
        await onHandleDrop(syntheticEvent, targetItem.id);
      }
    }

    isDraggingTouch.current = false;
    touchStartPos.current = null;
    resetDragState();
  };

  const handleDragLeave = () => {
    setDragOverId(null);
    setDropPosition(null);
  };

  return (
    <>
      {items.map(item => (
        <li
          key={item.id}
          data-item-id={item.id}
          draggable={!isMobile || isReorderMode}
          onDragStart={(e) => {
            setDraggedId(item.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onTouchStart={(e) => handleTouchStart(e, item.id)}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
          onDragOver={(e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = e.currentTarget.getBoundingClientRect();
            const midPoint = rect.top + rect.height / 2;
            const position = e.clientY < midPoint ? 'before' : 'after';
            setDragOverId(item.id);
            setDropPosition(position);
          }}
          onDragLeave={handleDragLeave}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onHandleDrop(e, item.id, item.parentId);
          }}
          onContextMenu={(e) => onHandleContextMenu(e, item)}
          className={`sidebar-item ${dragOverId === item.id && dropPosition === 'before' ? 'drop-before' : ''} ${dragOverId === item.id && dropPosition === 'after' ? 'drop-after' : ''} ${draggedId === item.id ? 'dragging' : ''}`}
          onMouseDown={async (e) => {
            if (e.button === 1) {
              e.preventDefault();
              await onItemClick(item, e);
            }
          }}
          onClick={async (e) => {
            if (isMobile && draggedId) {
              e.preventDefault();
              e.stopPropagation();
              return;
            }
            await onItemClick(item, e);
          }}
        >
          {renamingItem?.type === 'netdoc' && (renamingItem?.id === item.netdocId || renamingItem?.id === item.id) ? (
            <input
              type="text"
              value={renameInput}
              onChange={(e) => setRenameInput?.(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onItemRenameSubmit?.(item.netdocId || item.id, 'netdoc', renameInput || '');
                } else if (e.key === 'Escape') {
                  onItemRenameCancel?.();
                }
              }}
              onBlur={() => onItemRenameCancel?.()}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              style={{
                width: '100%',
                padding: '2px 4px',
                paddingLeft: '8px',
                fontSize: '13px',
                background: '#1a1410',
                color: 'var(--main-text)',
                border: '1px solid #c1a263',
                borderRadius: '4px',
                outline: 'none',
                boxSizing: 'border-box'
              }}
            />
          ) : (
            <button
              className="sidebar-button"
              style={{
                paddingLeft: '8px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}
            >
              {showItemIcon && <span style={{ marginRight: '6px', opacity: 0.6 }}>📄</span>}
              {truncateTitle(item.title)}
            </button>
          )}
        </li>
      ))}
    </>
  );
};

export default SidebarItemRenderer;
