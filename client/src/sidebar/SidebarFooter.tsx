import React from 'react';
import profileSvg from '../icons/profile.svg';
import settingsSvg from '../icons/settings.svg';
import './styles.css';

// Dagwood layout - stacked vertically like the sandwich
const dagwoodCorners = [
  { borderRadius: '0.25em 0.25em 0 0', borderBottom: '1px solid #333' },
  { borderRadius: '0 0 0.25em 0.25em', borderTop: '1px solid #333' },
];

interface SidebarFooterProps {
  onProfile: () => void;
  onSettings: () => void;
  isAuthenticated?: boolean;
  onLogin?: () => void;
  onExplore?: () => void;
}

const SidebarFooter: React.FC<SidebarFooterProps> = ({
  onProfile,
  onSettings,
  isAuthenticated = true,
  onLogin,
  onExplore
}) => {
  const buttons = [
    { icon: profileSvg, label: 'Profile', onClick: onProfile },
    { icon: settingsSvg, label: 'Settings', onClick: onSettings },
  ];
  const imgStyle = (size: string) => ({ width: size, height: size, display: 'block' as const, filter: 'url(#iconColorFilter)', userSelect: 'none' as const, pointerEvents: 'none' as const });

  if (!isAuthenticated) {
    return (
      <div className="sidebar-footer">
        <div style={{ paddingLeft: '0.75em', paddingRight: '0.75em' }}>
          <hr className="sidebar-hr" />
        </div>
        <div className="rectangle-button" onClick={onLogin} style={{ borderRadius: '0.25em' }}>
          Login
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar-footer">
      <div style={{ paddingLeft: '1em', paddingRight: '1em' }}>
        <hr className="sidebar-hr" style={{ marginBottom: '4px' }} />
      </div>

      {/* Container for 3 buttons */}
      <div style={{ background: '#111', borderRadius: '20px', padding: '0.75em', border: '1px solid #c1a263' }}>
        {/* Dagwood Layout - stacked vertically like the sandwich */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {buttons.map((btn, i) => (
            <div key={btn.label} className="rectangle-button sidebar-footer-row" onClick={btn.onClick}
              style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '6px', padding: '0.4em 0.75em 0.4em 0.74em', border: '1px solid #555', ...dagwoodCorners[i] }}>
              <img src={btn.icon} alt={btn.label} style={imgStyle('1.2em')} />
              <span style={{ fontSize: '0.9em' }}>{btn.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SidebarFooter;
