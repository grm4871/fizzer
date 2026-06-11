interface GoButtonProps {
  onClick: () => void;
}

export default function GoButton({ onClick }: GoButtonProps) {
  return (
    <button
      onClick={onClick}
      style={{
        background: '#dec572',
        border: '1px solid #c1a263',
        color: '#000',
        cursor: 'pointer',
        padding: '0.25em 0.5em',
        fontSize: '0.85em',
        fontWeight: 'bold',
        whiteSpace: 'nowrap',
        flexShrink: 0,
        marginRight: '.5em',
        marginLeft: '0.5em'
      }}
      title="Navigate to URL (or press Enter)"
    >
      Go<i>!</i>
    </button>
  );
}
