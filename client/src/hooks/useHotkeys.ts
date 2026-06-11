import { useEffect, useCallback } from 'react';

interface HotkeyHandlers {
  onToggleLeftSidebar?: () => void;
  onToggleRightSidebar?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onSearch?: () => void;
  onNewNetdoc?: () => void;
  onCycleMode?: () => void;
  onCycleModeReverse?: () => void;
  onSetEditMode?: () => void;
  onSetViewMode?: () => void;
}

// Global hotkeys hook - use in MainLayout or App
export const useHotkeys = (handlers: HotkeyHandlers) => {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const isMod = e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement;

    // Don't trigger hotkeys when typing in inputs (except for mod keys)
    const isInput = target.tagName === 'INPUT' ||
                    target.tagName === 'TEXTAREA' ||
                    target.isContentEditable;

    // Ctrl/Cmd + Alt + LeftArrow: Toggle left sidebar
    if (isMod && e.altKey && e.key === 'ArrowLeft') {
      e.preventDefault();
      handlers.onToggleLeftSidebar?.();
      return;
    }

    // Ctrl/Cmd + Alt + RightArrow: Toggle right sidebar
    if (isMod && e.altKey && e.key === 'ArrowRight') {
      e.preventDefault();
      handlers.onToggleRightSidebar?.();
      return;
    }

    // Ctrl/Cmd + [: Back
    if (isMod && !e.shiftKey && e.key === '[') {
      e.preventDefault();
      handlers.onBack?.();
      return;
    }

    // Ctrl/Cmd + ]: Forward
    if (isMod && !e.shiftKey && e.key === ']') {
      e.preventDefault();
      handlers.onForward?.();
      return;
    }

    // Ctrl/Cmd + Shift + N: New netdoc
    if (isMod && e.shiftKey && e.code === 'KeyN') {
      e.preventDefault();
      handlers.onNewNetdoc?.();
      return;
    }

    // Ctrl/Cmd + Enter: Cycle mode
    if (isMod && !e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      handlers.onCycleMode?.();
      return;
    }

    // Ctrl/Cmd + Shift + Enter: Cycle mode reverse (jump to first/last)
    if (isMod && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      handlers.onCycleModeReverse?.();
      return;
    }

    // Ctrl/Cmd + Shift + X: Switch to Edit mode
    if (isMod && e.shiftKey && e.code === 'KeyX') {
      e.preventDefault();
      handlers.onSetEditMode?.();
      return;
    }

    // Ctrl/Cmd + Shift + V: Switch to View mode
    if (isMod && e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      handlers.onSetViewMode?.();
      return;
    }

    // Non-modifier hotkeys (only when not in input)
    if (isInput) return;

    // /: Focus search
    if (e.key === '/' && !isMod) {
      e.preventDefault();
      handlers.onSearch?.();
      return;
    }
  }, [handlers]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
};
