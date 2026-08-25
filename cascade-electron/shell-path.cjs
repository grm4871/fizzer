'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function uniquePath(entries) {
  return [...new Set(entries.filter(Boolean))].join(path.delimiter);
}

function loginShellPath({ env = process.env, run = execFileSync } = {}) {
  const shell = env.SHELL && path.isAbsolute(env.SHELL) ? env.SHELL : '/bin/zsh';
  const marker = '__FIZZER_LOGIN_PATH__';
  try {
    if (!fs.existsSync(shell)) return '';
    const stdout = String(run(shell, ['-ilc', `command printf '\n${marker}%s\n' "$PATH"`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3_000,
      env,
    }) || '');
    const markerIndex = stdout.lastIndexOf(marker);
    return markerIndex === -1 ? '' : stdout.slice(markerIndex + marker.length).trim();
  } catch {
    return '';
  }
}

function macOSDesktopPath({ env = process.env, homeDir = os.homedir(), run = execFileSync } = {}) {
  const shellEntries = loginShellPath({ env, run }).split(path.delimiter);
  const fallbackEntries = [
    path.join(homeDir, '.bun', 'bin'),
    path.join(homeDir, '.local', 'bin'),
    path.join(homeDir, '.local', 'share', 'pnpm'),
    path.join(homeDir, '.volta', 'bin'),
    path.join(homeDir, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
  ];
  const inheritedEntries = String(env.PATH || '').split(path.delimiter);
  return uniquePath([...shellEntries, ...fallbackEntries, ...inheritedEntries]);
}

function installDesktopShellPath({ platform = process.platform, packaged = false, env = process.env, homeDir, run } = {}) {
  if (platform !== 'darwin' || !packaged) return env.PATH || '';
  env.PATH = macOSDesktopPath({ env, homeDir, run });
  return env.PATH;
}

module.exports = { installDesktopShellPath, loginShellPath, macOSDesktopPath };
