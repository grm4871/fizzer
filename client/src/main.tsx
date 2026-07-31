import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { PopoutApp } from './PopoutApp';
import { getPopoutDescriptor } from './popout';
import { installPerfObservers } from './perf';

// Long-task + hot-path profiler (always logs freezes ≥80ms; verbose via
// localStorage.cascade_perf=1 or ?perf=1). See client/src/perf.ts.
installPerfObservers();

// A window opened by dragging a tab out renders just that tab; otherwise the
// full workspace.
const popout = getPopoutDescriptor();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {popout ? <PopoutApp descriptor={popout} /> : <App />}
  </StrictMode>,
);
