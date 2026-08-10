import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { PopoutApp } from './PopoutApp';
import { getPopoutDescriptor } from './popout';
import { ErrorBoundary } from './components/ErrorBoundary';

// A window opened by dragging a tab out renders just that tab; otherwise the
// full workspace.
const popout = getPopoutDescriptor();

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
