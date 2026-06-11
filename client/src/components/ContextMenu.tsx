import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';

interface MenuItem {
  label: string;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [position, setPosition] = useState({ top: y, left: x });

  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth <= 768);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, []);

  useEffect(() => {
    if (!menuRef.current || isMobile) return;

    // Get menu dimensions
    const rect = menuRef.current.getBoundingClientRect();
    const menuHeight = rect.height;
    const menuWidth = rect.width;
    
    // Get viewport dimensions
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;

    let newTop = y;
    let newLeft = x;

    // Check if menu goes off bottom of screen
    if (y + menuHeight > viewportHeight) {
      // Position above the cursor instead
      newTop = Math.max(0, y - menuHeight - 4); // 4px gap
    }

    // Check if menu goes off right of screen
    if (x + menuWidth > viewportWidth) {
      // Align to right edge
      newLeft = Math.max(0, viewportWidth - menuWidth - 4); // 4px gap
    }

    setPosition({ top: newTop, left: newLeft });
  }, [y, x, isMobile]);

  return createPortal(
    <>
      {/* Overlay to close menu when clicking outside */}
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 99999,
          background: isMobile ? 'rgba(0, 0, 0, 0.5)' : 'transparent',
          backdropFilter: isMobile ? 'blur(4px)' : 'none',
          transition: 'all 0.3s'
        }}
        onClick={onClose}
      />
      {/* Menu */}
      <div
        ref={menuRef}
        style={{
          position: 'fixed',
          top: isMobile ? 'auto' : position.top,
          bottom: isMobile ? '0' : 'auto',
          left: isMobile ? '0' : position.left,
          right: isMobile ? '0' : 'auto',
          background: '#1a1a1a',
          border: isMobile ? 'none' : '1px solid #c1a263',
          borderTop: isMobile ? '2px solid #c1a263' : '1px solid #c1a263',
          borderRadius: isMobile ? '20px 20px 0 0' : '4px',
          zIndex: 100000,
          boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.5)',
          minWidth: isMobile ? '100%' : '150px',
          paddingBottom: isMobile ? 'env(safe-area-inset-bottom, 20px)' : '0',
          animation: isMobile ? 'slideUp 0.3s ease-out' : 'fadeIn 0.1s ease-out'
        }}
      >
        {isMobile && (
          <div style={{
            width: '40px',
            height: '4px',
            background: '#444',
            borderRadius: '2px',
            margin: '12px auto',
          }} />
        )}
        {items.map((item, index) => (
          <button
            key={index}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            style={{
              display: 'block',
              width: '100%',
              padding: isMobile ? '16px 20px' : '8px 12px',
              background: 'transparent',
              border: 'none',
              color: 'var(--main-text)',
              cursor: 'pointer',
              fontSize: isMobile ? '16px' : '13px',
              textAlign: isMobile ? 'center' : 'left',
              borderBottom: (index < items.length - 1 && !isMobile) ? '1px solid #444' : 'none',
              whiteSpace: 'nowrap',
              borderRadius: index === 0 && !isMobile ? '4px 4px 0 0' : index === items.length - 1 && !isMobile ? '0 0 4px 4px' : '0'
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = '#222';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
            }}
          >
            {item.label}
          </button>
        ))}
        {isMobile && (
          <button
            onClick={onClose}
            style={{
              display: 'block',
              width: '100%',
              padding: '16px 20px',
              background: 'transparent',
              border: 'none',
              color: '#888',
              cursor: 'pointer',
              fontSize: '16px',
              textAlign: 'center',
              marginTop: '8px',
              borderTop: '1px solid #333'
            }}
          >
            Cancel
          </button>
        )}
        <style>{`
          @keyframes slideUp {
            from { transform: translateY(100%); }
            to { transform: translateY(0); }
          }
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
        `}</style>
      </div>
    </>,
    document.body
  );
}
