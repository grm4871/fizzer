import { useState, useEffect } from 'react';

// Normalize Crockford Base32: O→0, I/L→1
const normalizeCrockford = (id: string) => id.replace(/[oO]/g, '0').replace(/[iIlL]/g, '1');

interface UrlBarProps {
  value: string;
  onChange: (value: string) => void;
  onNavigateToNetdoc: (netdocId: string, netdocName: string) => void;
  onNavigateToProfile: (username: string) => void;
  onNavigateTo: (path: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  showNavButtons?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBlur?: () => void;
}

export default function UrlBar({
  value,
  onChange,
  onNavigateToNetdoc,
  onNavigateToProfile,
  onNavigateTo,
  placeholder = 'Enter netdoc URL or ID...',
  autoFocus = false,
  showNavButtons = false,
  onBack,
  onForward,
  canGoBack = false,
  canGoForward = false,
  onBlur,
}: UrlBarProps) {
  // Uppercase netdoc IDs for display
  const formatUrlDisplay = (url: string) => {
    const netdocMatch = url.match(/^(\/netdoc\/)(.+)$/i);
    if (netdocMatch) return netdocMatch[1] + netdocMatch[2].toUpperCase();
    return url;
  };

  const [localValue, setLocalValue] = useState(formatUrlDisplay(value));

  // Sync local value when prop changes (for forward/back navigation)
  useEffect(() => {
    setLocalValue(formatUrlDisplay(value));
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    onChange(newValue);
  };

  const handleNavigate = () => {
    const val = localValue.trim();

    // Handle known static routes
    if (val === '/' || val === '/explore') {
      onNavigateTo('/explore');
      return;
    }
    if (val === '/settings') {
      onNavigateTo('/settings');
      return;
    }
    if (val === '/tos') {
      onNavigateTo('/tos');
      return;
    }
    if (val === '/privacy') {
      onNavigateTo('/privacy');
      return;
    }

    // Check if it's a profile URL pattern
    if (val.startsWith('/profile/')) {
      const username = val.split('/profile/')[1];
      onNavigateToProfile(username);
      return;
    }

    // Check if it's just a username (starts with @)
    if (val.startsWith('@')) {
      const username = val.slice(1);
      onNavigateToProfile(username);
      return;
    }

    // Check if it's already a /id/ path
    if (val.startsWith('/id/')) {
      const username = val.split('/id/')[1];
      onNavigateToProfile(username);
      return;
    }

    // Otherwise treat as netdoc (handles /netdoc/ID or just ID)
    const netdocMatch = val.match(/\/netdoc\/(.+)$/);
    const rawId = netdocMatch ? netdocMatch[1] : val;
    const netdocId = normalizeCrockford(rawId);
    onNavigateToNetdoc(netdocId, `Netdoc ${netdocId}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleNavigate();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
      onBlur?.();
    }
  };

  return (
    <div style={{ display: 'flex', gap: '0.5em', flex: '1 1 0', minWidth: 0, alignItems: 'center' }}>
      {showNavButtons && (
        <>
          <button
            onClick={onBack}
            disabled={!canGoBack}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: canGoBack ? 'pointer' : 'not-allowed',
              padding: '0.25em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              userSelect: 'none',
              color: canGoBack ? 'var(--main-text)' : '#555',
              fontSize: '1.2em'
            }}
            title="Back"
          >
            ←
          </button>
          <button
            onClick={onForward}
            disabled={!canGoForward}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: canGoForward ? 'pointer' : 'not-allowed',
              padding: '0.25em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              userSelect: 'none',
              color: canGoForward ? 'var(--main-text)' : '#555',
              fontSize: '1.2em'
            }}
            title="Forward"
          >
            →
          </button>
        </>
      )}

      <div id="url-bar" style={{ display: 'flex', alignItems: 'center', background: 'transparent', padding: '0.35em 0.5em', border: '1px solid #555', flex: '1 1 0', minWidth: 0 }}>
        <input
          type="text"
          value={localValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={onBlur}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{
            flex: '1 1 0',
            minWidth: 0,
            background: 'transparent',
            color: '#aaa',
            border: 'none',
            padding: '0',
            fontSize: '0.9em',
            outline: 'none',
            cursor: 'text'
          }}
        />
      </div>
    </div>
  );
}
