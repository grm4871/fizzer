import { useState, useEffect, useCallback } from 'react';
import MessageDialogue from './MessageDialogue';

interface MessageDialogueData {
  message: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
}

let showDialogueListener: ((data: MessageDialogueData) => void) | null = null;

/**
 * Show a MessageDialogue from anywhere. Single-button by default (just "Ok").
 * Pass onCancel for two-button mode.
 */
export function showMessageDialogue(message: string, options?: {
  onConfirm?: () => void;
  onCancel?: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
}) {
  if (showDialogueListener) {
    showDialogueListener({
      message,
      ...options
    });
  }
}

/**
 * MessageDialogueContainer must be mounted once at the top level of your app.
 */
export function MessageDialogueContainer() {
  const [dialogue, setDialogue] = useState<MessageDialogueData | null>(null);

  const handleShow = useCallback((data: MessageDialogueData) => {
    setDialogue(data);
  }, []);

  useEffect(() => {
    showDialogueListener = handleShow;
    return () => {
      showDialogueListener = null;
    };
  }, [handleShow]);

  if (!dialogue) return null;

  const dismiss = () => {
    dialogue.onConfirm?.();
    setDialogue(null);
  };

  return (
    <MessageDialogue
      message={dialogue.message}
      confirmLabel={dialogue.confirmLabel}
      cancelLabel={dialogue.cancelLabel}
      onConfirm={() => {
        dialogue.onConfirm?.();
        setDialogue(null);
      }}
      onCancel={dialogue.onCancel ? () => {
        dialogue.onCancel?.();
        setDialogue(null);
      } : undefined}
    />
  );
}
