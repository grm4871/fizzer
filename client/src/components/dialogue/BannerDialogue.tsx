import { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';

interface BannerMessage {
  id: number;
  message: string;
  success: boolean;
  mode?: 'button';
  buttonLabel?: string;
  onDismiss?: () => void;
  color?: string;
}

let bannerId = 0;
let addBannerListener: ((banner: BannerMessage) => void) | null = null;

/**
 * Show a banner notification at the top of the screen. Call this from anywhere.
 */
export function showBanner(message: string, success: boolean = true, options?: { mode?: 'button'; buttonLabel?: string; onDismiss?: () => void; color?: string }) {
  const banner: BannerMessage = {
    id: ++bannerId,
    message,
    success,
    mode: options?.mode,
    buttonLabel: options?.buttonLabel,
    onDismiss: options?.onDismiss,
    color: options?.color,
  };
  if (addBannerListener) {
    addBannerListener(banner);
  }
}

interface BannerItemProps {
  banner: BannerMessage;
  onRemove: (id: number) => void;
  forceExit?: boolean;
}

function BannerItem({ banner, onRemove, forceExit = false }: BannerItemProps) {
  const [isExiting, setIsExiting] = useState(false);
  const hasTriggeredForceExit = useRef(false);
  const [exitDuration, setExitDuration] = useState(250); // ms
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const autoTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const exitTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isButtonMode = banner.mode === 'button';

  const dismiss = useCallback((duration: number) => {
    if (isExiting) return;
    setExitDuration(duration);
    setIsExiting(true);
    if (autoTimeoutRef.current) {
      clearTimeout(autoTimeoutRef.current);
    }
    exitTimeoutRef.current = setTimeout(() => {
      onRemove(banner.id);
    }, duration);
  }, [banner.id, onRemove, isExiting]);

  // Force exit when evicted by a new banner
  useEffect(() => {
    if (forceExit && !hasTriggeredForceExit.current) {
      hasTriggeredForceExit.current = true;
      dismiss(150);
    }
  }, [forceExit, dismiss]);

  // Auto-dismiss after 5 seconds (not in button mode)
  useEffect(() => {
    if (isButtonMode) return;
    autoTimeoutRef.current = setTimeout(() => {
      dismiss(250);
    }, 5000);
    return () => {
      if (autoTimeoutRef.current) clearTimeout(autoTimeoutRef.current);
    };
  }, [dismiss, isButtonMode]);

  const handleMouseEnter = () => {
    if (isButtonMode) return;
    if (!hoverTimeoutRef.current) {
      hoverTimeoutRef.current = setTimeout(() => {
        dismiss(250);
      }, 500);
    }
  };

  const handleClick = () => {
    if (isButtonMode) return;
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
    }
    dismiss(125);
  };

  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      if (exitTimeoutRef.current) clearTimeout(exitTimeoutRef.current);
    };
  }, []);

  return (
    <div
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      style={{
        backgroundColor: banner.color || (banner.success ? '#4ade80' : '#ef4444'),
        color: '#fff',
        padding: isExiting ? '0 20px' : '10px 20px',
        borderRadius: '4px',
        cursor: isButtonMode ? 'default' : 'pointer',
        transform: isExiting ? 'translateY(-100%)' : 'translateY(0)',
        opacity: isExiting ? 0 : 1,
        maxHeight: isExiting ? '0px' : '100px',
        marginBottom: isExiting ? '0px' : '8px',
        overflow: 'hidden',
        transition: `all ${exitDuration}ms ease-out`,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        fontSize: '14px',
        fontWeight: 500,
        whiteSpace: 'pre-line',
        display: 'flex',
        alignItems: 'center',
        gap: isButtonMode ? '12px' : undefined,
      }}
    >
      {banner.message}
      {isButtonMode && (
        <button
          onClick={(e) => { e.stopPropagation(); banner.onDismiss?.(); dismiss(125); }}
          style={{
            background: 'rgba(0, 0, 0, 0.25)',
            color: '#fff',
            border: '1px solid rgba(255, 255, 255, 0.3)',
            borderRadius: '3px',
            padding: '2px 10px',
            cursor: 'pointer',
            fontSize: '13px',
            fontWeight: 500,
            whiteSpace: 'nowrap',
          }}
        >
          {banner.buttonLabel || 'ok'}
        </button>
      )}
    </div>
  );
}

/**
 * BannerContainer must be mounted once at the top level of your app.
 * It renders banners in a portal at the top-center of the screen.
 */
export function BannerContainer() {
  const [banners, setBanners] = useState<BannerMessage[]>([]);
  const [exitingIds, setExitingIds] = useState<Set<number>>(new Set());

  const addBanner = useCallback((banner: BannerMessage) => {
    setBanners((prev) => [...prev, banner]);
  }, []);

  // Whenever banners change, check if we need to push out the oldest
  useEffect(() => {
    const visibleCount = banners.filter(b => !exitingIds.has(b.id)).length;
    if (visibleCount > 2) {
      // Find oldest non-exiting banner and mark it for exit
      const oldest = banners.find(b => !exitingIds.has(b.id));
      if (oldest) {
        setExitingIds((ids) => new Set(ids).add(oldest.id));
      }
    }
  }, [banners, exitingIds]);

  const removeBanner = useCallback((id: number) => {
    setBanners((prev) => prev.filter((b) => b.id !== id));
    setExitingIds((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  }, []);

  useEffect(() => {
    addBannerListener = addBanner;
    return () => {
      addBannerListener = null;
    };
  }, [addBanner]);

  if (banners.length === 0) {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        top: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        pointerEvents: 'auto',
      }}
    >
      {banners.map((banner) => (
        <BannerItem key={banner.id} banner={banner} onRemove={removeBanner} forceExit={exitingIds.has(banner.id)} />
      ))}
    </div>,
    document.body
  );
}
