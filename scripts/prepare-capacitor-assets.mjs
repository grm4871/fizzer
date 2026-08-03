#!/usr/bin/env node
/** Keep the downloadable APK from being recursively embedded in the next APK. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nestedApk = path.join(root, 'client', 'dist', 'cascade-android.apk');
try {
  fs.unlinkSync(nestedApk);
  console.log(`[android] excluded generated download artifact: ${path.relative(root, nestedApk)}`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
