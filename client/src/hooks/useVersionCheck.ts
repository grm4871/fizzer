import { useEffect } from 'react';

/**
 * Hook to check if the client version matches the server version.
 * If a mismatch is detected, it forces a hard reload to clear the cache.
 */
export const useVersionCheck = () => {
  useEffect(() => {
    // Only run in production/build environment where __APP_VERSION__ is defined
    // In dev mode, we might want to skip this or handle it differently
    if (typeof __APP_VERSION__ === 'undefined') return;

    const checkVersion = async () => {
      try {
        // Fetch version.json with cache busting
        const res = await fetch(`/version.json?t=${Date.now()}`);
        if (!res.ok) return;
        
        const data = await res.json();
        const serverVersion = data.version;
        
        console.log(`[VersionCheck] Client: ${__APP_VERSION__}, Server: ${serverVersion}`);
        
        if (serverVersion && serverVersion !== __APP_VERSION__) {
          console.log('[VersionCheck] Version mismatch detected. Reloading...');
          
          // Force hard reload from server, bypassing cache
          // Using location.href assignment with cache buster
          window.location.href = window.location.href.split('?')[0] + '?v=' + Date.now();
        }
      } catch (err) {
        console.error('[VersionCheck] Failed to check version:', err);
      }
    };

    // Check immediately on mount
    checkVersion();

    // Optional: Set up an interval to check periodically (e.g., every 5 minutes)
    // const interval = setInterval(checkVersion, 5 * 60 * 1000);
    // return () => clearInterval(interval);
    
    // For now, checks once on mount/navigation (since App remounts on nav in some setups, or strictly once in SPA)
  }, []);
};
