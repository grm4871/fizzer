import React from 'react';

interface ResizeHandleProps {
  side: 'left' | 'right';  // which edge the handle appears on
  onMouseDown: (e: React.MouseEvent) => void;
  headerHeight?: number;
  footerHeight?: number;
}

/**
 * Resize handle for sidebars.
 *
 * @param side - Which edge the handle appears on:
 *   - 'left': appears on left edge (for right sidebar)
 *   - 'right': appears on right edge (for left sidebar)
 */
const ResizeHandle: React.FC<ResizeHandleProps> = ({ side, onMouseDown, headerHeight = 0, footerHeight = 0 }) => {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        [side]: 0,
        width: '8px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 1000
      }}
    >
      {/* Spacer for header height */}
      <div style={{ height: headerHeight - 1, flexShrink: 0 }} />
      {/* Actual resize handle - starts below header, ends above footer */}
      <div
        onMouseDown={onMouseDown}
        style={{
          flex: 1,
          cursor: 'ew-resize',
          background: 'transparent',
          borderLeft: side === 'left' ? '1px solid #c1a263' : undefined,
          borderRight: side === 'right' ? '1px solid #c1a263' : undefined
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(193, 162, 99, 0.2)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
        }}
      />
      {/* Spacer for footer height */}
      <div style={{ height: footerHeight, flexShrink: 0,
          borderLeft: side === 'left' ? '1px solid #c1a263' : undefined,
          borderRight: side === 'right' ? '1px solid #c1a263' : undefined
      }} />
    </div>
  );
};

export default ResizeHandle;
