import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { PopoutApp } from './PopoutApp';
import { getPopoutDescriptor } from './popout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { startAndroidBatteryMonitoring } from './androidBatteryMonitor';

// A window opened by dragging a tab out renders just that tab; otherwise the
// full workspace.
const popout = getPopoutDescriptor();

if (!popout) startAndroidBatteryMonitoring();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="Fizzer">
      {popout ? <PopoutApp descriptor={popout} /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
