#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listPackage } from '@electron/asar';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronRoot = path.join(root, 'cascade-electron');
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : '';
};
const platform = valueAfter('--platform') || process.platform;
const arch = valueAfter('--arch') || process.arch;
const packageRoot = path.join(electronRoot, 'out', `Cascade-${platform}-${arch}`);
const resources = platform === 'darwin'
  ? path.join(packageRoot, 'Cascade.app', 'Contents', 'Resources')
  : path.join(packageRoot, 'resources');
const executable = platform === 'darwin'
  ? path.join(packageRoot, 'Cascade.app', 'Contents', 'MacOS', 'cascade')
  : path.join(packageRoot, platform === 'win32' ? 'cascade.exe' : 'cascade');

const requiredFiles = [
  executable,
  path.join(resources, 'app.asar'),
  path.join(resources, 'dist', 'package.json'),
  path.join(resources, 'dist', 'cli-agents', 'cli-agent.js'),
  path.join(resources, 'dist', 'cli-agents', 'cascade-note'),
  path.join(resources, 'dist', 'cli-agents', 'cascade-chat'),
  path.join(resources, 'dist', 'cli-agents', 'cascade-scratchpad'),
  path.join(resources, 'dist', 'cli-agents', 'auto-papercut.mjs'),
  path.join(resources, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
];
const missing = requiredFiles.filter((file) => !fs.existsSync(file));
if (missing.length) {
  throw new Error(`Packaged runtime is incomplete:\n${missing.map((file) => `- ${file}`).join('\n')}`);
}

// @electron/asar follows the host path separator when listing entries. Keep
// archive assertions identical on Windows, macOS, and Linux.
const asarEntries = new Set(
  listPackage(path.join(resources, 'app.asar')).map((entry) => entry.replaceAll('\\', '/')),
);
const requiredAsarEntries = [
  '/agent-runner.cjs',
  '/desktop-runner-host.cjs',
  '/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs',
];
const absentFromAsar = requiredAsarEntries.filter((entry) => !asarEntries.has(entry));
if (absentFromAsar.length) {
  throw new Error(`Packaged app.asar is incomplete:\n${absentFromAsar.map((entry) => `- ${entry}`).join('\n')}`);
}

console.log(`[verify-desktop-package] OK - ${platform}/${arch} includes the desktop shell, native SQLite binding, agent runtime, helpers, and Claude SDK`);
