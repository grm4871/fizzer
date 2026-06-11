import React, { useState } from 'react';
import MagnifyingGlass from '../icons/magnifyingGlass.svg';
import starSvg from '../icons/star.svg';
import RadialNewMenu from '../components/RadialNewMenu';
import { useMarquee, marqueeKeyframes } from '../utils/useMarquee';

interface SidebarHeaderProps {
  onNew: () => void;
  onNewSpace?: () => void;
  onToggleSearch: () => void;
  showSearch?: boolean;
  searchQuery?: string;
  setSearchQuery?: (value: string) => void;
  onSearchSubmit?: (query: string) => void;
  currentSpaceName?: string;
  onExitSpace?: () => void;
  onSpaceNameClick?: () => void;
  sidebarTab?: 'profile' | 'netdocs' | 'spaces';
  onRadialMenuChange?: (open: boolean) => void;
  onSaved?: () => void;
}

const SidebarHeader: React.FC<SidebarHeaderProps> = ({
  onNew,
  onNewSpace,
  onToggleSearch,
  showSearch = false,
  searchQuery = '',
  setSearchQuery,
  onSearchSubmit,
  currentSpaceName,
  onExitSpace,
  onSpaceNameClick,
  sidebarTab = 'netdocs',
  onRadialMenuChange,
  onSaved
}) => {
  const [spaceTitleHovered, setSpaceTitleHovered] = useState(false);
  const [spaceTitleClicked, setSpaceTitleClicked] = useState(false);
  const [radialMenuOpen, setRadialMenuOpen] = useState(false);

  // Marquee for long space names (only used in space view mode)
  const isInSpaceView = !!currentSpaceName;
  const canGoBack = !!onExitSpace;
  const headerTitle = currentSpaceName ? currentSpaceName.toUpperCase() : '';
  const { containerRef: marqueeContainerRef, measureRef: marqueeMeasureRef, shouldScroll, animationStyle } = useMarquee(50, 48, [headerTitle]);

  const handleRadialMenuChange = (open: boolean) => {
    setRadialMenuOpen(open);
    onRadialMenuChange?.(open);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchQuery.trim() && onSearchSubmit) {
      onSearchSubmit(searchQuery.trim());
    } else if (e.key === 'Escape') {
      onToggleSearch();
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '0.5em 0', marginBottom: '8px', overflow: 'visible' }}>
      <div
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          margin: '0.5em',
          height: '40px',
          overflow: 'visible'
        }}
      >
        {/* Horizontal bar behind button */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            height: '24px',
            borderRadius: '0.25em',
            border: '1px solid #c1a263',
            zIndex: 0,
            opacity: radialMenuOpen ? 0 : 1,
            transition: 'opacity 0.15s ease'
          }}
        />

        {/* Star icon - left of NEW button, navigates to saved space */}
        {onSaved && (
          <div
            onClick={onSaved}
            style={{
              position: 'absolute',
              left: 'calc(25% - 25px)',
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '4px',
              borderRadius: '0.25em',
              cursor: 'pointer',
              opacity: 0.7,
              transition: 'opacity 0.2s',
              zIndex: 1
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.opacity = '1';
              const img = e.currentTarget.querySelector('img');
              if (img) img.style.filter = 'url(#iconColorFilter)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.opacity = '0.7';
              const img = e.currentTarget.querySelector('img');
              if (img) img.style.filter = 'brightness(0) invert(0.5)';
            }}
          >
            <img src={starSvg} alt="Saved" width={14} height={14} style={{ filter: 'brightness(0) invert(0.5)', transition: 'filter 1.5s' }} />
          </div>
        )}

        <RadialNewMenu
          onNew={onNew}
          onNewSpace={onNewSpace}
          onOpenChange={handleRadialMenuChange}
        />

        {/* Search icon - right of NEW button */}
        <div
          onClick={onToggleSearch}
          title="Search"
          style={{
            position: 'absolute',
            right: 'calc(25% - 25px)',
            top: '50%',
            transform: 'translateY(-50%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4px',
            borderRadius: '0.25em',
            cursor: 'pointer',
            opacity: 0.7,
            transition: 'opacity 0.2s',
            zIndex: 1
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1';
            const img = e.currentTarget.querySelector('img');
            if (img) img.style.filter = 'url(#iconColorFilter)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.7';
            const img = e.currentTarget.querySelector('img');
            if (img) img.style.filter = 'brightness(0) invert(0.5)';
          }}
        >
          <img src={MagnifyingGlass} alt="Search" width={14} height={14} style={{ filter: 'brightness(0) invert(0.5)', transition: 'filter 1.5s' }} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', visibility: radialMenuOpen ? 'hidden' : 'visible' }}>
        {showSearch ? (
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => setSearchQuery?.(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            style={{
              flex: 1,
              minWidth: 0,
              padding: '4px 8px',
              fontSize: '12px',
              background: '#1a1410',
              color: 'var(--main-text)',
              border: '1px solid #c1a263',
              borderRadius: '4px',
              outline: 'none',
              overflow: 'visible',
              textOverflow: 'clip'
            }}
          />
        ) : isInSpaceView ? (
          /* Space view mode: show title with marquee */
          <>
            <style>{marqueeKeyframes}</style>
            <div
              ref={marqueeMeasureRef as React.RefObject<HTMLDivElement>}
              style={{ position: 'absolute', visibility: 'hidden', whiteSpace: 'nowrap' }}
            >
              <span style={{ fontWeight: 600, fontSize: '0.9em' }}>{headerTitle}</span>
            </div>
            <div
              ref={marqueeContainerRef as React.RefObject<HTMLDivElement>}
              onClick={onSpaceNameClick ? () => { setSpaceTitleClicked(true); onSpaceNameClick(); } : undefined}
              style={{ flex: 1, overflow: 'hidden', minWidth: 0, cursor: onSpaceNameClick ? 'pointer' : 'default', opacity: spaceTitleHovered && !spaceTitleClicked ? 0.85 : 1, transition: 'opacity 0.2s ease' }}
              onMouseEnter={() => { if (onSpaceNameClick) setSpaceTitleHovered(true); }}
              onMouseLeave={() => { setSpaceTitleHovered(false); setSpaceTitleClicked(false); }}
            >
              <div
                style={{
                  display: 'inline-flex',
                  gap: '48px',
                  whiteSpace: 'nowrap',
                  ...animationStyle
                }}
              >
                <span style={{ fontWeight: 600, fontSize: '0.9em', textDecoration: spaceTitleHovered || spaceTitleClicked ? 'underline' : 'none' }}>{headerTitle}</span>
                {shouldScroll && <span style={{ fontWeight: 600, fontSize: '0.9em', textDecoration: spaceTitleHovered || spaceTitleClicked ? 'underline' : 'none' }}>{headerTitle}</span>}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
};

export default SidebarHeader;
