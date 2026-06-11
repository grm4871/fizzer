import React from 'react';

interface SidebarToggleButtonProps {
  side: 'left' | 'right';  // which side the sidebar is on
  onToggle: () => void;
}

/**
 * Toggle button for collapsing/expanding sidebars.
 * The icon shows a filled half indicating where the sidebar is.
 *
 * @param side - Which side the sidebar is on:
 *   - 'left': left sidebar, right half filled (shows panel | content layout)
 *   - 'right': right sidebar, left half filled (shows content | panel layout)
 */
const SidebarToggleButton: React.FC<SidebarToggleButtonProps> = ({ side, onToggle }) => {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      style={{
        width: '22px',
        height: '22px',
        padding: 0,
        background: 'transparent',
        border: '1px solid rgba(193, 162, 99, 0.4)',
        borderRadius: '3px',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: 'all 0.15s ease',
        overflow: 'hidden',
        position: 'relative'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgba(193, 162, 99, 0.7)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgba(193, 162, 99, 0.4)';
      }}
      title="Toggle Sidebar"
    >
      {/* Empty half */}
      <div style={{
        position: 'absolute',
        [side === 'left' ? 'left' : 'right']: 0,
        top: 0,
        width: '50%',
        height: '100%',
        background: 'transparent'
      }} />
      {/* Filled half - indicates sidebar position */}
      <div style={{
        position: 'absolute',
        [side === 'left' ? 'right' : 'left']: 0,
        top: 0,
        width: '50%',
        height: '100%',
        background: 'rgba(193, 162, 99, 0.6)'
      }} />
    </button>
  );
};

export default SidebarToggleButton;
