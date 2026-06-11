/**
 * @file PseudoWindow.tsx
 * @description Fullscreen overlay wrapper with close button. Used for settings, admin, permissions, etc.
 */

import { ReactNode } from 'react';

export interface PseudoWindowProps {
  onClose: () => void;
  children: ReactNode;
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: '#111',
  zIndex: 100,
  overflow: 'auto'
};

export const PseudoWindow = ({ onClose, children }: PseudoWindowProps) => {
  return (
    <div className="pseudo-window" style={overlayStyle}>
      <div style={{ position: 'sticky', top: 0, display: 'flex', justifyContent: 'flex-end', zIndex: 10, pointerEvents: 'none' }}>
        <button
          onClick={onClose}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#888', fontSize: '24px', padding: '0.5rem', pointerEvents: 'auto' }}
          title="Close (Esc)"
        >
          ✕
        </button>
      </div>
      {children}
    </div>
  );
};
