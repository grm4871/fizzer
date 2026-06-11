import { useState } from 'react';

interface SquareToggleProps<T = string | boolean> {
  /** The first option value */
  optionA: T;
  /** The second option value */
  optionB: T;
  /** Label to display for option A */
  labelA?: string;
  /** Label to display for option B */
  labelB?: string;
  /** Current selected value */
  value: T;
  /** onChange handler - if not provided, component is in "dummy" mode */
  onChange?: (value: T) => void;
  /** Size of the square in pixels */
  size?: number;
  /** Custom colors */
  colors?: {
    active?: string;
    inactive?: string;
    text?: string;
    border?: string;
  };
  /** Disable interaction */
  disabled?: boolean;
  /** If false, disables the yellow "on" state styling */
  directional?: boolean;
}

export default function SquareToggle<T = string | boolean>({
  optionA,
  optionB,
  labelA,
  labelB,
  value,
  onChange,
  size = 30,
  colors = {},
  disabled = false,
  directional = true
}: SquareToggleProps) {
  const {
    active = '#d4d4d4',
    inactive = '#3a3a3a',
    text = '#fff',
    border = '#555'
  } = colors;

  // Internal state for dummy mode
  const [internalValue, setInternalValue] = useState(value);
  const isDummy = !onChange;

  const currentValue = isDummy ? internalValue : value;
  const isOptionA = currentValue === optionA;

  const handleClick = () => {
    if (disabled) return;
    const newValue = isOptionA ? optionB : optionA;
    if (isDummy) {
      setInternalValue(newValue);
    } else {
      onChange?.(newValue);
    }
  };

  const displayLabel = isOptionA
    ? (labelA ?? String(optionA))
    : (labelB ?? String(optionB));

  const trackWidth = size * 2;
  const squareSize = size;

  // Yellow tint when "on" (optionB selected) - only if directional is true
  const isOn = !isOptionA;
  const trackColor = (directional && isOn) ? '#4a4520' : inactive;
  const squareColor = (directional && isOn) ? '#c4b54e' : active;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        marginTop: "1em",
        marginBottom: "1em"
      }}
    >
      {/* Toggle track with sliding square */}
      <div
        onClick={handleClick}
        style={{
          position: 'relative',
          width: trackWidth,
          height: squareSize,
          backgroundColor: trackColor,
          border: `2px solid ${border}`,
          borderRadius: '4px',
          cursor: isDummy || disabled ? 'default' : 'pointer',
          userSelect: 'none',
          opacity: disabled ? 0.5 : 1,
          transition: 'background-color 0.1s steps(2)',
        }}
      >
        {/* Sliding square */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: isOptionA ? 0 : squareSize,
            width: squareSize,
            height: squareSize,
            backgroundColor: squareColor,
            borderRadius: '2px',
            transition: 'left 0.1s steps(3), background-color 0.1s steps(2)',
          }}
        />
      </div>

      {/* Label */}
      {(labelA || labelB) && (
        <div
          style={{
            color: text,
            fontSize: '14px',
            userSelect: 'none',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {displayLabel}
        </div>
      )}
    </div>
  );
}
