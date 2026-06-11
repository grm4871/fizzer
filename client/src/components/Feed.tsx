import { ReactNode } from 'react';

// ============================================================================
// Utilities
// ============================================================================

export const formatTimeAgo = (dateString: string) => {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  return `${Math.floor(diffHours / 24)}d`;
};

// ============================================================================
// FeedNav
// ============================================================================

export interface FeedNavItem {
  icon?: string;
  label: ReactNode;
  onClick: () => void;
  opacity?: number;
}

export function FeedNav({ items, style }: { items: FeedNavItem[]; style?: React.CSSProperties }) {
  return (
    <div style={{
      display: 'flex',
      gap: '1rem',
      padding: '1.5rem 2rem',
      justifyContent: 'center',
      alignItems: 'center',
      flexWrap: 'wrap',
      ...style
    }}>
      {items.map((item, i) => (
        <button
          key={i}
          className="rectangle-button"
          onClick={item.onClick}
          style={{
            padding: '0.75em 1.5em',
            borderRadius: '8px',
            fontSize: '0.95rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5em',
            opacity: item.opacity
          }}
        >
          {item.icon && <img src={item.icon} alt="" width={16} height={16} style={{ filter: 'url(#iconColorFilter)' }} />}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

// ============================================================================
// FeedList
// ============================================================================

interface FeedListProps {
  children: ReactNode;
  isLoading: boolean;
  emptyMessage: string;
  isEmpty: boolean;
}

export function FeedList({ children, isLoading, emptyMessage, isEmpty }: FeedListProps) {
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const timeline = e.currentTarget;
    const scrollPercent = timeline.scrollHeight > 0
      ? ((timeline.scrollTop + timeline.clientHeight) / timeline.scrollHeight) * 100
      : 0;
    timeline.style.setProperty('--scroll-percentage', `${scrollPercent}%`);
  };

  return (
    <div
      id="timeline"
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: '0'
      }}
    >
      {isLoading && isEmpty ? (
        <div style={{ padding: '2em', textAlign: 'center', color: '#666' }}>
          Loading...
        </div>
      ) : isEmpty ? (
        <div style={{ padding: '2em', textAlign: 'center', color: '#666' }}>
          {emptyMessage}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

// ============================================================================
// FeedItem
// ============================================================================

interface FeedItemProps {
  onClick?: () => void;
  badge?: string;
  subtitle: ReactNode;
  title: string;
  preview?: string;
}

export function FeedItem({ onClick, badge, subtitle, title, preview }: FeedItemProps) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: '1em',
        borderBottom: '1px solid #1a1a1a',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background 0.15s ease'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.02)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      {/* Author row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.4em',
        marginBottom: '0.4em'
      }}>
        {badge && (
          <span style={{
            background: '#c1a263',
            color: '#000',
            padding: '1px 6px',
            borderRadius: '3px',
            fontSize: '0.7em',
            fontWeight: 'bold'
          }}>
            {badge}
          </span>
        )}
        {subtitle}
      </div>

      {/* Title */}
      <div style={{
        color: 'var(--main-text)',
        fontSize: '1em',
        marginBottom: preview ? '0.3em' : 0,
        userSelect: 'none'
      }}>
        {title}
      </div>

      {/* Content preview */}
      {preview && (
        <div style={{
          color: '#777',
          fontSize: '0.9em',
          lineHeight: 1.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 100,
          WebkitBoxOrient: 'vertical' as const,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}>
          {preview}
        </div>
      )}
    </div>
  );
}
