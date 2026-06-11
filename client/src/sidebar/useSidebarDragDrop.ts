import { useState } from 'react';
import { SidebarItem } from '../types';
import { apiFetch } from '../utils/api';

/**
 * Custom hook for managing drag-and-drop reordering of flat sidebar items.
 *
 * @param {SidebarItem[]} items - Current items array
 * @param {Function} setItems - Setter to update items array
 * @param {Function} [fetchSidebarData] - Optional callback to refresh sidebar after operations
 * @param {string | null} userId - Current user ID for API calls
 * @param {string | null} spaceId - Optional space ID for space-scoped reorder
 * @returns {Object} Drag state and handlers
 */
export const useSidebarDragDrop = (
  items: SidebarItem[],
  setItems: (items: SidebarItem[]) => void,
  fetchSidebarData?: () => Promise<void>,
  userId?: string | null,
  spaceId?: string | null
) => {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [dropPosition, setDropPosition] = useState<'before' | 'after' | null>(null);

  const resetDragState = () => {
    setDraggedId(null);
    setDragOverId(null);
    setDropPosition(null);
  };

  const handleDragLeave = () => {
    setDragOverId(null);
    setDropPosition(null);
  };

  /**
   * Handle drop of dragged item — flat reorder only.
   */
  const handleDrop = async (e: React.DragEvent, targetId: string, _targetParentId?: string | null) => {
    e.preventDefault();

    if (!draggedId || draggedId === targetId || !userId) {
      resetDragState();
      return;
    }

    try {
      const draggedItem = items.find(i => i.id === draggedId);
      if (!draggedItem) {
        resetDragState();
        return;
      }

      const originalItems = items;

      // Flat reorder: all items are siblings
      const draggedIdx = items.findIndex(s => s.id === draggedId);
      const targetIdx = items.findIndex(s => s.id === targetId);

      if (draggedIdx < 0 || targetIdx < 0) {
        resetDragState();
        return;
      }

      const reordered = items.filter((_, i) => i !== draggedIdx);
      const draggedElement = items[draggedIdx];

      let insertIdx = targetIdx;
      if (dropPosition === 'before') {
        insertIdx = draggedIdx < targetIdx ? targetIdx - 1 : targetIdx;
      } else if (dropPosition === 'after') {
        insertIdx = draggedIdx < targetIdx ? targetIdx : targetIdx + 1;
      }

      reordered.splice(insertIdx, 0, draggedElement);

      const itemPayload = reordered.map((sibling, idx) => ({
        id: sibling.id,
        orderKey: idx
      }));

      const reorderRes = await apiFetch('/api/sidebar/folder/reorder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userId,
          spaceId: spaceId,
          folders: [],
          items: itemPayload
        })
      });

      if (reorderRes.ok) {
        if (fetchSidebarData) {
          await fetchSidebarData();
        }
      } else {
        console.error('[DragDrop] Reorder failed:', reorderRes.status);
        setItems(originalItems);
      }
    } catch (error) {
      console.error('Drop error:', error);
    } finally {
      resetDragState();
    }
  };

  return {
    draggedId,
    setDraggedId,
    dragOverId,
    setDragOverId,
    dropPosition,
    setDropPosition,
    resetDragState,
    handleDragLeave,
    handleDrop
  };
};
