import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Compact label for logs / recovery UI (e.g. "Kanban", "Workspace"). */
  label?: string;
  /** Optional custom fallback. Receives reset to remount children. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catch render failures so one pane (e.g. a bad kanban card markdown tree)
 * cannot white-screen the whole desktop shell. Without this, React unmounts
 * the tree and the only recovery is a full reload.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const label = this.props.label || 'UI';
    console.error(`[ErrorBoundary:${label}]`, error, info?.componentStack);
    // A deploy can replace a lazy chunk between the shell loading and a tab
    // opening (notably NoteEditor). React caches that rejected import, so the
    // old “Try again” button could never recover. Reload once for *this exact*
    // missing URL; a persistent bad deploy still stops at the fallback rather
    // than looping forever.
    if (isDynamicImportFailure(error)) {
      const key = `cascade:dynamic-import-reload:${error.message}`;
      try {
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          const url = new URL(window.location.href);
          url.searchParams.set('chunk-reload', String(Date.now()));
          window.location.replace(url.toString());
          return;
        }
      } catch {
        // Storage can be unavailable in embedded/private contexts; the
        // fallback's Reload button remains a safe manual recovery.
      }
    }
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const label = this.props.label || 'This view';
    const reloadRequired = isDynamicImportFailure(error);
    return (
      <div className="pane-empty" role="alert">
        <strong>{label} hit a render error</strong>
        <p style={{ maxWidth: 420, opacity: 0.8, fontSize: 13 }}>
          {error.message || 'Unknown error'}
        </p>
        <button type="button" onClick={reloadRequired ? () => window.location.reload() : this.reset}>
          {reloadRequired ? 'Reload' : 'Try again'}
        </button>
      </div>
    );
  }
}

function isDynamicImportFailure(error: Error): boolean {
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module/i
    .test(String(error?.message || ''));
}
