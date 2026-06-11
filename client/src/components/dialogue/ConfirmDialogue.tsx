import { useState } from 'react';
import { createPortal } from 'react-dom';

interface ConfirmDialogueProps {
  title?: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
}

export default function ConfirmDialogue({ message, onConfirm, onCancel, confirmLabel = 'Ok', cancelLabel = 'Cancel' }: ConfirmDialogueProps) {
  const [isExiting, setIsExiting] = useState(false);

  const handleCancel = () => {
    setIsExiting(true);
    setTimeout(onCancel, 300);
  };

  const handleConfirm = () => {
    setIsExiting(true);
    setTimeout(onConfirm, 300);
  };

  return createPortal(
    <div className="modal-overlay confirm-dialog-overlay" onClick={handleCancel}>
      <div
        className={`modal-dialog confirm-dialog ${isExiting ? 'confirm-dialog-exit' : 'confirm-dialog-enter'}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'auto', height: 'auto', maxWidth: '400px', maxHeight: '200px', border: "1px solid var(--main-text)", borderRadius: 0 }}
      >
        <p style={{ marginBottom: '24px', fontSize: '16px' }}>{message}</p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          <button onClick={handleCancel} className="rectangle-button" style={{ background: '#555' }}>
            {cancelLabel}
          </button>
          <button onClick={handleConfirm} className="rectangle-button" style={{ background: '#c33', paddingLeft: "20px", paddingRight: "20px" }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
