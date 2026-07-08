/**
 * Desktop runner host — tells the Electron main process to connect as the
 * user's /runners relay so CLI agents can be piloted from any client.
 */

type RunnerElectronAPI = {
  setRunnerToken?: (opts: { token: string; apiUrl?: string }) => Promise<{ success: boolean; error?: string }>;
  clearRunnerToken?: () => Promise<{ success: boolean }>;
};

function runnerElectronAPI(): RunnerElectronAPI | undefined {
  return (window as unknown as { electronAPI?: RunnerElectronAPI }).electronAPI;
}

function resolveApiBase(): string {
  const configured = import.meta.env.VITE_API_URL || '';
  if (configured) return configured.replace(/\/$/, '');
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/$/, '');
  }
  return '';
}

/**
 * Ensure the main-process desktop runner relay is connected (after login).
 * Idempotent — safe to call on focus/visibility resync without killing runs.
 * No-op in a plain browser.
 *
 * @param opts.clearOnStop When true (default), the returned stop() tears the
 *   runner down (logout / unmount). Pass false for resume pings that should
 *   only re-assert the token without ever clearing on cleanup.
 */
export function startDesktopRunnerHost(opts?: { clearOnStop?: boolean }): () => void {
  const api = runnerElectronAPI();
  if (!api?.setRunnerToken) return () => {};

  const token = localStorage.getItem('docs_token');
  if (!token) return () => {};

  void api.setRunnerToken({ token, apiUrl: resolveApiBase() });

  const clearOnStop = opts?.clearOnStop !== false;
  return () => {
    if (clearOnStop) void api.clearRunnerToken?.();
  };
}

/** Soft re-assert of the runner connection (no teardown). */
export function ensureDesktopRunnerHost(): void {
  startDesktopRunnerHost({ clearOnStop: false })();
}
