import { useState, InputHTMLAttributes } from 'react';
import eyeballSvg from '../icons/eyeball.svg';

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  // All standard input props are inherited
}

/**
 * Password input with show/hide toggle button.
 * Uses an eye icon for clean visibility toggle.
 */
export default function PasswordInput({ className = '', style, ...props }: PasswordInputProps) {
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', ...style }}>
      <input
        {...props}
        type={showPassword ? 'text' : 'password'}
        className={className}
        style={{ paddingRight: '2.5em', width: '100%' }}
        autoComplete="current-password"
      />
      <button
        type="button"
        onClick={() => setShowPassword(!showPassword)}
        style={{
          position: 'absolute',
          right: '0.5em',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '0.25em',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: showPassword ? 1 : 0.5,
          transition: 'opacity 0.2s',
          pointerEvents: 'auto',
          touchAction: 'manipulation'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = showPassword ? '1' : '0.5')}
        aria-label={showPassword ? 'Hide password' : 'Show password'}
        tabIndex={-1}
      >
        <img
          src={eyeballSvg}
          alt=""
          style={{
            width: '18px',
            height: '10px',
            display: 'block'
          }}
        />
        {showPassword && (
          <div style={{
            position: 'absolute',
            width: '100%',
            height: '2px',
            background: '#c1a263',
            transform: 'rotate(-45deg)'
          }} />
        )}
      </button>
    </div>
  );
}
