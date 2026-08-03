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
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    const label = this.props.label || 'This view';
    return (
      <div className="pane-empty" role="alert">
        <strong>{label} hit a render error</strong>
        <p style={{ maxWidth: 420, opacity: 0.8, fontSize: 13 }}>
          {error.message || 'Unknown error'}
        </p>
        <button type="button" onClick={this.reset}>
          Try again
        </button>
      </div>
    );
  }
}
