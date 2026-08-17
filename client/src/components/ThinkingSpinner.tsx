/**
 * Status-slot spinner: same 8–10px circle geometry as mission/work status dots.
 * CSS-only ring — no braille glyph metrics to fight.
 */

export function ThinkingSpinner({
  className = '',
  title = 'Working',
}: {
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`thinking-spinner ${className}`.trim()}
      title={title}
      role="status"
      aria-label={title}
    />
  );
}
