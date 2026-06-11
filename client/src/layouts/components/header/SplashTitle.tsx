import { useMarquee, marqueeKeyframes } from '../../../utils/useMarquee';

interface SplashTitleProps {
  spaceName?: string;
  authorDisplayName?: string;
  title?: string;
  updatedAt?: string;
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const day = date.getDate().toString().padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${day} ${month} ${year}`;
}

export default function SplashTitle({
  spaceName,
  authorDisplayName,
  title,
  updatedAt,
}: SplashTitleProps) {
  const { containerRef, measureRef, shouldScroll, animationStyle } = useMarquee(50, 48, [spaceName, authorDisplayName, title, updatedAt]);

  const contentBlock = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: '0.95em',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }}
    >
      {spaceName && (
        <span style={{ color: '#888', whiteSpace: 'nowrap' }}>
          {spaceName}
        </span>
      )}
      {spaceName && <span style={{ color: '#555' }}>•</span>}
      {authorDisplayName && (
        <span style={{ color: '#c1a263', whiteSpace: 'nowrap' }}>
          {authorDisplayName}
        </span>
      )}
      {authorDisplayName && <span style={{ color: '#555' }}>•</span>}
      <span style={{ fontWeight: 500, color: '#c1a263', whiteSpace: 'nowrap' }}>
        {title || 'Untitled'}
      </span>
      {updatedAt && <span style={{ color: '#555' }}>•</span>}
      {updatedAt && (
        <span style={{ color: '#888', whiteSpace: 'nowrap' }}>
          {formatDate(updatedAt)}
        </span>
      )}
    </div>
  );

  return (
    <>
      <style>{marqueeKeyframes}</style>
      <div
        ref={containerRef as React.RefObject<HTMLDivElement>}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: shouldScroll ? 'flex-start' : 'center',
          flex: '1 1 0',
          minWidth: 0,
          overflowX: 'hidden',
          overflowY: 'visible',
          padding: '2px 0',
        }}
      >
        {/* Hidden measuring element */}
        <div
          ref={measureRef as React.RefObject<HTMLDivElement>}
          style={{
            position: 'absolute',
            visibility: 'hidden',
            whiteSpace: 'nowrap',
          }}
        >
          {contentBlock}
        </div>

        {/* Visible scrolling content */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '3em',
            ...animationStyle,
          }}
        >
          {contentBlock}
          {shouldScroll && contentBlock}
        </div>
      </div>
    </>
  );
}
