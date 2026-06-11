import { useEffect } from 'react';

interface ConfirmUpdateSuccessProps {
  status: 'idle' | 'saving' | 'success' | 'error';
  onDismiss?: () => void;
  successMessage?: string;
  errorMessage?: string;
  savingMessage?: string;
  autoDismissDelay?: number;
}

export default function ConfirmUpdateSuccess({
  status,
  onDismiss,
  successMessage = 'Saved',
  errorMessage = 'Error saving',
  savingMessage = 'Saving...',
  autoDismissDelay = 2000
}: ConfirmUpdateSuccessProps) {
  useEffect(() => {
    if (status === 'success' || status === 'error') {
      const timer = setTimeout(() => {
        if (onDismiss) {
          onDismiss();
        }
      }, autoDismissDelay);
      return () => clearTimeout(timer);
    }
  }, [status, onDismiss, autoDismissDelay]);

  if (status === 'idle') {
    return null;
  }

  if (status === 'saving') {
    return <span style={{ color: '#dec572', fontSize: '0.9em' }}>{savingMessage}</span>;
  }

  if (status === 'success') {
    return <span style={{ color: '#4ade80', fontSize: '0.9em' }}>✓ {successMessage}</span>;
  }

  if (status === 'error') {
    return <span style={{ color: '#ef4444', fontSize: '0.9em' }}>✗ {errorMessage}</span>;
  }

  return null;
}
