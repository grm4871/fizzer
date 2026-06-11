interface SearchNavBoxProps {
  onSearch: () => void;
  onBack: () => void;
  onForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

export default function SearchNavBox({
  onSearch,
  onBack,
  onForward,
  canGoBack,
  canGoForward
}: SearchNavBoxProps) {
  return (
    <div style={{
      width: '40px',
      height: '40px',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '2px'
    }}>
      {/* Magnifying glass */}
      <button
        onClick={onSearch}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '2px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
        title="Search"
      >
        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="7" cy="7" r="5" stroke="var(--main-text)" strokeWidth="1.5"/>
          <line x1="10.5" y1="10.5" x2="14.5" y2="14.5" stroke="var(--main-text)" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
      </button>

      {/* Back/Forward arrows */}
      <div style={{
        display: 'flex',
        flexDirection: 'row',
        gap: '2px'
      }}>
        <button
          onClick={onBack}
          disabled={!canGoBack}
          style={{
            background: 'transparent',
            border: 'none',
            cursor: canGoBack ? 'pointer' : 'not-allowed',
            padding: '0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: canGoBack ? 'var(--main-text)' : '#555',
            fontSize: '0.75em',
            lineHeight: 1
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
            padding: '0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: canGoForward ? 'var(--main-text)' : '#555',
            fontSize: '0.75em',
            lineHeight: 1
          }}
          title="Forward"
        >
          →
        </button>
      </div>
    </div>
  );
}
