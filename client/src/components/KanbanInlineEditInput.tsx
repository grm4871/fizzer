import type { KeyboardEvent } from 'react';

/**
 * Autofocused inline text input used for renaming a Kanban column or card.
 * Extracted from KanbanView's two identical inline-edit `<input>` blocks.
 * Commits on Enter or blur; cancels on Escape. Preserves the original
 * classNames and behavior exactly.
 */
export function KanbanInlineEditInput({
  className,
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  className: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <input
      className={className}
      value={value}
      autoFocus
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') onCommit();
        if (event.key === 'Escape') onCancel();
      }}
    />
  );
}
