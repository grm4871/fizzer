export default function LockIcon({ size = 48, color = '#dec572' }: { size?: number; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Lock body */}
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      {/* Lock shackle */}
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      {/* Lock keyhole */}
      <circle cx="12" cy="16" r="1" />
    </svg>
  );
}
