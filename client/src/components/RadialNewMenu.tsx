import React, { useState, useEffect, useRef } from 'react';
import netdocSvg from '../icons/netdoc.svg';
import spaceSvg from '../icons/space.svg';

const createAnnularSector = (angle1: number, angle2: number, ri: number, ro: number) => {
  const toRad = (deg: number) => deg * Math.PI / 180;
  const x1i = ri * Math.cos(toRad(angle1));
  const y1i = ri * Math.sin(toRad(angle1));
  const x1o = ro * Math.cos(toRad(angle1));
  const y1o = ro * Math.sin(toRad(angle1));
  const x2i = ri * Math.cos(toRad(angle2));
  const y2i = ri * Math.sin(toRad(angle2));
  const x2o = ro * Math.cos(toRad(angle2));
  const y2o = ro * Math.sin(toRad(angle2));

  const largeArc = (angle2 - angle1) > 180 ? 1 : 0;

  return `M ${x1i},${y1i} L ${x1o},${y1o} A ${ro},${ro} 0 ${largeArc} 1 ${x2o},${y2o} L ${x2i},${y2i} A ${ri},${ri} 0 ${largeArc} 0 ${x1i},${y1i} Z`;
};

export interface RadialNewMenuProps {
  onNew: () => void;
  onNewSpace?: () => void;
  onOpenChange?: (open: boolean) => void;
}

const RadialNewMenu: React.FC<RadialNewMenuProps> = ({
  onNew,
  onNewSpace,
  onOpenChange
}) => {
  const [showRadialMenu, setShowRadialMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hoveredSection = useRef<string | null>(null);
  const justOpened = useRef(false);

  useEffect(() => {
    onOpenChange?.(showRadialMenu);
  }, [showRadialMenu]);

  useEffect(() => {
    if (!showRadialMenu) return;

    const handleMouseUp = (e: MouseEvent) => {
      if (isDragging) {
        if (menuRef.current) {
          const rect = menuRef.current.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          const dx = e.clientX - centerX;
          const dy = e.clientY - centerY;
          const distance = Math.sqrt(dx * dx + dy * dy);
          const isInOuterRing = distance > 25;

          if (isInOuterRing && hoveredSection.current === 'netdoc') {
            setShowRadialMenu(false);
            setIsDragging(false);
            onNew();
          } else if (isInOuterRing && hoveredSection.current === 'third' && onNewSpace) {
            setShowRadialMenu(false);
            setIsDragging(false);
            onNewSpace();
          } else if (!menuRef.current.contains(e.target as Node)) {
            setShowRadialMenu(false);
            setIsDragging(false);
          } else {
            setIsDragging(false);
          }
        } else {
          setIsDragging(false);
        }
      }
    };

    const handleClickOutside = (e: MouseEvent) => {
      if (!isDragging && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowRadialMenu(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowRadialMenu(false);
        setIsDragging(false);
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [showRadialMenu, isDragging, onNew, onNewSpace]);

  const innerRadius = 25;
  const outerRadius = 75;
  const toRad = (deg: number) => deg * Math.PI / 180;

  const topLeftPath = createAnnularSector(150, 270, innerRadius, outerRadius);
  const bottomPath = createAnnularSector(30, 150, innerRadius, outerRadius);

  const iconRadius = (innerRadius + outerRadius) / 2;
  const iconSize = 20;

  const netdocAngle = 210;

  return (
    <div
      ref={menuRef}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '40px',
        overflow: 'visible'
      }}
    >
      {/* Radial menu - overlays on top */}
      {showRadialMenu && (
        <svg
          viewBox="-75 -75 150 150"
          style={{
            position: 'absolute',
            width: '144px',
            height: '144px',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 200
          }}
        >
          <circle cx="0" cy="0" r="75" fill="#222" />
          {/* Left/top-left section - New Netdoc */}
          <path
            d={topLeftPath}
            fill="#222"
            stroke="#c1a263"
            strokeWidth="1"
            style={{ cursor: 'pointer' }}
            onClick={() => { if (!isDragging) { setShowRadialMenu(false); onNew(); } }}
            onMouseEnter={(e) => { hoveredSection.current = 'netdoc'; e.currentTarget.setAttribute('fill', '#2a2a2a'); }}
            onMouseLeave={(e) => { hoveredSection.current = null; e.currentTarget.setAttribute('fill', '#222'); }}
          />
          <image
            href={netdocSvg}
            x={iconRadius * Math.cos(toRad(netdocAngle)) - iconSize / 2}
            y={iconRadius * Math.sin(toRad(netdocAngle)) - iconSize / 2}
            width={iconSize}
            height={iconSize}
            style={{ pointerEvents: 'none' }}
            filter="url(#iconColorFilter)"
          />

          {/* Bottom section - New Space */}
          <path
            d={bottomPath}
            fill="#222"
            stroke="#c1a263"
            strokeWidth="1"
            style={{ cursor: 'pointer' }}
            onClick={() => {
              if (!isDragging && onNewSpace) {
                setShowRadialMenu(false);
                onNewSpace();
              }
            }}
            onMouseEnter={(e) => { hoveredSection.current = 'third'; e.currentTarget.setAttribute('fill', '#2a2a2a'); }}
            onMouseLeave={(e) => { hoveredSection.current = null; e.currentTarget.setAttribute('fill', '#222'); }}
          />
          <image
            href={spaceSvg}
            x={iconRadius * Math.cos(toRad(90)) - iconSize / 2}
            y={iconRadius * Math.sin(toRad(90)) - iconSize / 2}
            width={iconSize}
            height={iconSize}
            style={{ pointerEvents: 'none' }}
            filter="url(#iconColorFilter)"
          />
        </svg>
      )}

      {/* Center NEW button */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          if (!showRadialMenu) {
            setShowRadialMenu(true);
            setIsDragging(true);
            justOpened.current = true;
          }
        }}
        onClick={() => {
          if (showRadialMenu && !isDragging && !justOpened.current) {
            setShowRadialMenu(false);
          }
          justOpened.current = false;
        }}
        title="New"
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '50px',
          height: '50px',
          borderRadius: '100%',
          border: '2px solid #c1a263',
          fontSize: '0.9em',
          fontWeight: 'bold',
          color: '#e8d7b0',
          cursor: 'pointer',
          zIndex: 201,
          background: '#555'
        }}
      >
        <span>NEW<em>!</em></span>
      </div>
    </div>
  );
};

export default RadialNewMenu;
