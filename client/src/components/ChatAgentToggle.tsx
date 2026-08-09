import type { ChangeEvent, ReactNode } from 'react';

/**
 * A single labeled checkbox row inside the agent settings panel.
 * Extracted from ChatView's repeated `chat-agent-toggle` label blocks so the
 * markup (label + checkbox + copy name/hint) lives in one place.
 * Preserves the exact classNames and DOM structure of the originals.
 */
export function ChatAgentToggle({
  checked,
  onChange,
  name,
  hint,
  disabled,
  stateClass,
}: {
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  name: ReactNode;
  hint: ReactNode;
  disabled?: boolean;
  /** Extra suffix appended to the `chat-agent-toggle` className (e.g. ` is-hot`). */
  stateClass?: string;
}) {
  return (
    <label className={`chat-agent-toggle${stateClass || ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="chat-agent-toggle-copy">
        <span className="chat-agent-toggle-name">{name}</span>
        <span className="chat-agent-toggle-hint">{hint}</span>
      </span>
    </label>
  );
}
