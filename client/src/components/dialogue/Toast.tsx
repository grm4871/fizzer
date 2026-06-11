import { useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';

interface ToastMessage {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

let toastId = 0;
let addToastListener: ((toast: ToastMessage) => void) | null = null;

/**
 * Show a toast notification. Call this from anywhere in your app.
 */
export function showToast(message: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') {
  const toast: ToastMessage = {
    id: ++toastId,
    message,
    type,
  };
  if (addToastListener) {
    addToastListener(toast);
  }
}

interface ToastItemProps {
  toast: ToastMessage;
  onRemove: (id: number) => void;
}

function ToastItem({ toast, onRemove }: ToastItemProps) {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    const displayTimer = setTimeout(() => {
      setIsExiting(true);
    }, 2500);

    const removeTimer = setTimeout(() => {
      onRemove(toast.id);
    }, 3000);

    return () => {
      clearTimeout(displayTimer);
      clearTimeout(removeTimer);
    };
  }, [toast.id, onRemove]);

  const getBackgroundColor = () => {
    switch (toast.type) {
      case 'success':
        return 'rgba(40, 167, 69, 0.95)';
      case 'error':
        return 'rgba(220, 53, 69, 0.95)';
      case 'warning':
        return 'rgba(255, 193, 7, 0.95)';
      default:
        return 'rgba(50, 60, 70, 0.95)';
    }
  };

  const getTextColor = () => {
    return toast.type === 'warning' ? '#212529' : '#ffffff';
  };

  return (
    <div
      style={{
        padding: '12px 20px',
        borderRadius: '8px',
        backgroundColor: getBackgroundColor(),
        color: getTextColor(),
        fontSize: '14px',
        fontWeight: 500,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
        marginBottom: '8px',
        opacity: isExiting ? 0 : 1,
        transform: isExiting ? 'translateX(100%)' : 'translateX(0)',
        transition: 'opacity 0.4s ease, transform 0.4s ease',
        backdropFilter: 'blur(8px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
      }}
    >
      {toast.message}
    </div>
  );
}

/**
 * ToastContainer must be mounted once at the top level of your app.
 * It renders toasts in a portal at the bottom-right corner of the screen.
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const addToast = useCallback((toast: ToastMessage) => {
    setToasts((prev) => [...prev, toast]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    addToastListener = addToast;
    return () => {
      addToastListener = null;
    };
  }, [addToast]);

  if (toasts.length === 0) {
    return null;
  }

  return ReactDOM.createPortal(
    <div
      style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column-reverse',
        alignItems: 'flex-end',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
    </div>,
    document.body
  );
}
