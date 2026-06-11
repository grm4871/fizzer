import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import netdocSvg from '../icons/netdoc.svg';
import FolderIcon from '../icons/FolderIcon';

const New: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const spaceId = (location.state as any)?.spaceId;

  const handleDocumentClick = () => {
    navigate('/netdoc', { state: { type: 'netdoc', spaceId } });
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      width: '100%'
    }}>
      <svg viewBox="0 0 200 200" style={{ width: '300px', height: '300px' }}>
        {/* Document section - top right */}
        <path
          d="M100,100 L100,20 A80,80 0 0,1 169.28,140 Z"
          fill="#222"
          stroke="#c1a263"
          strokeWidth="2"
          style={{ cursor: 'pointer' }}
          onClick={handleDocumentClick}
          onMouseEnter={(e) => e.currentTarget.setAttribute('fill', '#2a2a2a')}
          onMouseLeave={(e) => e.currentTarget.setAttribute('fill', '#222')}
        />
        <image href={netdocSvg} x="120" y="55" width="30" height="30" style={{ pointerEvents: 'none' }} filter="url(#iconColorFilter)" />

        {/* Folder section - top left (disabled) */}
        <path
          d="M100,100 L30.72,140 A80,80 0 0,1 100,20 Z"
          fill="#1a1a1a"
          stroke="#555"
          strokeWidth="2"
          style={{ cursor: 'not-allowed', opacity: 0.5 }}
        />
        <foreignObject x="45" y="55" width="30" height="30" style={{ pointerEvents: 'none', opacity: 0.4 }}>
          <FolderIcon size={30} color="#666" />
        </foreignObject>

        {/* Center circle */}
        <circle cx="100" cy="100" r="25" fill="#111" stroke="#c1a263" strokeWidth="2" />
        <text x="100" y="105" fill="#e8d7b0" fontSize="14" textAnchor="middle" fontWeight="bold" style={{ pointerEvents: 'none' }}>NEW</text>
      </svg>
    </div>
  );
};

export default New;
