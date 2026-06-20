/**
 * @file popout.ts — Pop-out window helpers
 *
 * A popped-out tab loads the same app with a `#popout=<encoded tab>` hash. This
 * reads that descriptor so `main.tsx` can render the standalone single-tab view
 * ({@link PopoutApp}) instead of the full workspace.
 */

import type { Tab } from './components/TabBar';

const POPOUT_HASH_PREFIX = '#popout=';

/** Returns the popped-out tab descriptor, or null when this is a normal window. */
export function getPopoutDescriptor(): Tab | null {
  const hash = window.location.hash;
  if (!hash.startsWith(POPOUT_HASH_PREFIX)) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(hash.slice(POPOUT_HASH_PREFIX.length)));
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.type !== 'string') return null;
    return parsed as Tab;
  } catch {
    return null;
  }
}
