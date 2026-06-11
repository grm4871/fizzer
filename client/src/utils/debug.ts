// Debug logging - only outputs when DEBUG mode is enabled
// Enable via: localStorage.setItem('debug', 'true') or ?debug=true in URL

const isDebug = (): boolean => {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem('debug') === 'true' ||
         new URLSearchParams(window.location.search).has('debug');
};

export const debug = (...args: any[]) => {
  if (isDebug()) {
    console.log(...args);
  }
};

export const debugError = (...args: any[]) => {
  if (isDebug()) {
    console.error(...args);
  }
};
