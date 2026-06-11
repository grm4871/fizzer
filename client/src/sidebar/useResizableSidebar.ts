import { useState, useRef, useEffect } from 'react';

interface UseResizableSidebarOptions {
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  collapseThreshold?: number;
  side: 'left' | 'right';  // which side the resize handle is on
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

interface UseResizableSidebarReturn {
  width: number;
  setWidth: (width: number) => void;
  isResizing: boolean;
  handleResizeStart: (e: React.MouseEvent) => void;
}

/**
 * Hook for managing resizable sidebar state and behavior.
 *
 * @param side - Which side the resize handle is on:
 *   - 'left': handle on left edge (for right sidebar)
 *   - 'right': handle on right edge (for left sidebar)
 */
export function useResizableSidebar({
  defaultWidth = 200,
  minWidth = 50,
  maxWidth = 600,
  collapseThreshold = 80,
  side,
  isCollapsed,
  onToggleCollapse
}: UseResizableSidebarOptions): UseResizableSidebarReturn {
  const [width, setWidth] = useState(defaultWidth);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(defaultWidth);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = width;
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleResizeMove = (e: MouseEvent) => {
      // Key: deltaX calculation depends on which side the handle is on
      // - 'right' side handle (left sidebar): dragging right = increase width
      // - 'left' side handle (right sidebar): dragging left = increase width
      const deltaX = side === 'right'
        ? e.clientX - resizeStartX.current   // handle on right edge
        : resizeStartX.current - e.clientX;  // handle on left edge

      const rawWidth = resizeStartWidth.current + deltaX;

      // Collapse sidebar if dragged below threshold (check before clamping)
      if (rawWidth < collapseThreshold) {
        onToggleCollapse();
        setIsResizing(false);
      } else {
        const newWidth = Math.max(minWidth, Math.min(maxWidth, rawWidth));
        setWidth(newWidth);
      }
    };

    const handleResizeEnd = () => {
      setIsResizing(false);
    };

    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);

    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
    };
  }, [isResizing, width, minWidth, maxWidth, collapseThreshold, side, onToggleCollapse]);

  return { width, setWidth, isResizing, handleResizeStart };
}
