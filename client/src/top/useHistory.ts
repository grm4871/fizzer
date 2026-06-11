import { useState, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

interface HistoryEntry {
  path: string;
}

export function useHistory() {
  const navigate = useNavigate();
  const location = useLocation();

  // Initialize with current path
  const [history, setHistory] = useState<HistoryEntry[]>(() => [{ path: location.pathname }]);
  const [historyIndex, setHistoryIndex] = useState(0);

  // Push a new path to history
  // If we're in the middle of the stack, truncate everything after current index
  const pushHistory = useCallback((path: string, state?: any) => {
    // Don't push if it's the same as current path
    if (location.pathname === path) return;

    setHistory(prev => {
      // Truncate forward history and add new entry
      const truncated = prev.slice(0, historyIndex + 1);
      return [...truncated, { path }];
    });
    setHistoryIndex(prev => prev + 1);
    navigate(path, state ? { state } : undefined);
  }, [history, historyIndex, navigate, location.pathname]);

  // Replace the current entry in history (no new entry added)
  const replaceHistory = useCallback((path: string, state?: any) => {
    if (location.pathname === path) return;

    setHistory(prev => {
      const updated = [...prev];
      updated[historyIndex] = { path };
      return updated;
    });
    navigate(path, { replace: true, ...(state ? { state } : {}) });
  }, [historyIndex, navigate, location.pathname]);

  // Go back in history
  const goBack = useCallback(() => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      navigate(history[newIndex].path);
    }
  }, [historyIndex, history, navigate]);

  // Go forward in history
  const goForward = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      setHistoryIndex(newIndex);
      navigate(history[newIndex].path);
    }
  }, [historyIndex, history, navigate]);

  const canGoBack = useMemo(() => historyIndex > 0, [historyIndex]);
  const canGoForward = useMemo(() => historyIndex < history.length - 1, [historyIndex, history.length]);

  return {
    pushHistory,
    replaceHistory,
    goBack,
    goForward,
    canGoBack,
    canGoForward,
  };
}
