import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { PopoutApp } from './PopoutApp';
import { getPopoutDescriptor } from './popout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { loadPersistedSession } from './chat/session';

// A window opened by dragging a tab out renders just that tab; otherwise the
// full workspace.
const popout = getPopoutDescriptor();

// Start the focused tab's chunk while auth/session are still in flight so the
// first workspace paint is not a Suspense placeholder.
if (!popout) {
  const tabs = loadPersistedSession().openTabs;
  if (tabs.some((tab) => tab.type === 'chat')) void import('./components/ChatView');
  if (tabs.some((tab) => tab.type === 'note')) void import('./components/NoteEditor');
  if (tabs.some((tab) => tab.type === 'superkanban')) void import('./components/SuperkanbanView');
}

// Capacitor exposes `androidBridge` before the web bundle runs. Keep its core
// SDK and diagnostics plugin out of normal web/Electron startup entirely.
if (!popout && (window as unknown as { androidBridge?: unknown }).androidBridge) {
  void import('./androidBatteryMonitor').then(({ startAndroidBatteryMonitoring }) => {
    startAndroidBatteryMonitoring();
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Fizzer">
      {popout ? <PopoutApp descriptor={popout} /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
