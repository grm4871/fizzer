import { useState } from 'react';
import { createPortal } from 'react-dom';

interface MessageDialogueProps {
  message: string;
  onConfirm: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
}

export default function MessageDialogue({ message, onConfirm, onCancel, confirmLabel = 'Ok', cancelLabel = 'Cancel' }: MessageDialogueProps) {
  const [isExiting, setIsExiting] = useState(false);

  const handleDismiss = () => {
    setIsExiting(true);
    setTimeout(onCancel || onConfirm, 300);
  };

  const handleConfirm = () => {
    setIsExiting(true);
    setTimeout(onConfirm, 300);
  };

  const isSingleButton = !onCancel;

  return createPortal(
    <div className="modal-overlay confirm-dialog-overlay" onClick={handleDismiss}>
      <div
        className={`modal-dialog confirm-dialog ${isExiting ? 'confirm-dialog-exit' : 'confirm-dialog-enter'}`}
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'auto', height: 'auto', maxWidth: '400px', maxHeight: '200px', overflow: 'auto', border: "1px solid var(--main-text)", borderRadius: 0 }}
      >
        <p style={{ marginBottom: '24px', fontSize: '16px', whiteSpace: 'pre-line' }}>{message}</p>
        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
          {!isSingleButton && (
            <button onClick={handleDismiss} className="rectangle-button" style={{ background: '#555' }}>
              {cancelLabel}
            </button>
          )}
          <button onClick={handleConfirm} className="rectangle-button" style={{ background: isSingleButton ? '#555' : '#c33', paddingLeft: "20px", paddingRight: "20px" }}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
