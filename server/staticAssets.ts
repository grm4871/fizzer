import path from 'node:path';

const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Vite fingerprints every file under `assets/`, so those responses can be
 * cached forever: a changed bundle always gets a new URL. HTML and the version
 * sentinel must keep revalidating so clients can discover those new URLs.
 */
export function clientAssetCacheControl(filePath: string): string | undefined {
  const normalized = filePath.replace(/[\\/]+/g, '/');
  if (normalized.includes('/assets/')) {
    return `public, max-age=${ONE_YEAR_SECONDS}, immutable`;
  }
  const name = path.basename(filePath);
  if (name === 'version.json') return 'no-store';
  if (name.endsWith('.html')) return 'no-cache';
  return undefined;
}
