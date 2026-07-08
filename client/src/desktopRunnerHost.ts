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
 * Connect the main-process desktop runner relay after login.
 * No-op in a plain browser.
 */
export function startDesktopRunnerHost(): () => void {
  const api = runnerElectronAPI();
  if (!api?.setRunnerToken) return () => {};

  const token = localStorage.getItem('docs_token');
  if (!token) return () => {};

  void api.setRunnerToken({ token, apiUrl: resolveApiBase() });

  return () => {
    void api.clearRunnerToken?.();
  };
}
