import { useState, useEffect } from 'react';

/**
 * Hook to detect if the device is mobile (width < 600px).
 * Returns true if mobile, false otherwise.
 */
export function useMobile() {
  // Use a lazy initializer to avoid window access issues during SSR (though this is client-only)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const handleChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);

    // Ensure state is in sync on mount
    setIsMobile(mediaQuery.matches);

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isMobile;
}
