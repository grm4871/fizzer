import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'client', 'dist');
const html = fs.readFileSync(path.join(dist, 'app.html'), 'utf8');

function requiredAsset(pattern, label) {
  const match = html.match(pattern);
  if (!match) throw new Error(`Built app.html has no ${label}`);
  return path.join(dist, match[1].replace(/^\//, ''));
}

const entry = requiredAsset(/src="(\/assets\/main-[^"]+\.js)"/, 'main script');
const styles = requiredAsset(/href="(\/assets\/main-[^"]+\.css)"/, 'main stylesheet');
const entryGzip = gzipSync(fs.readFileSync(entry)).byteLength;
const stylesGzip = gzipSync(fs.readFileSync(styles)).byteLength;
const assetNames = fs.readdirSync(path.join(dist, 'assets'));

const limits = {
  entryGzip: 140 * 1024,
  stylesGzip: 40 * 1024,
};
if (entryGzip > limits.entryGzip) {
  throw new Error(`Entry bundle is ${entryGzip} gzip bytes; budget is ${limits.entryGzip}`);
}
if (stylesGzip > limits.stylesGzip) {
  throw new Error(`Main stylesheet is ${stylesGzip} gzip bytes; budget is ${limits.stylesGzip}`);
}
for (const lazyBoundary of ['ChatView-', 'SessionManager-', 'AccountSettings-', 'androidBatteryMonitor-']) {
  if (!assetNames.some((name) => name.startsWith(lazyBoundary) && name.endsWith('.js'))) {
    throw new Error(`Expected a separate lazy chunk for ${lazyBoundary.slice(0, -1)}`);
  }
}

console.log(
  `[verify-client-performance] OK — entry ${Math.round(entryGzip / 1024)} KiB gzip; styles ${Math.round(stylesGzip / 1024)} KiB gzip; heavy UI remains lazy`,
);
