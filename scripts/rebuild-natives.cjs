#!/usr/bin/env node
/**
 * Rebuild native Node modules for the current runtime.
 *
 * Cascade uses better-sqlite3 and bcrypt in the API process. After a Node
 * upgrade, or when prebuilds do not match, a native binary can fail with:
 *
 *   was compiled against a different Node.js version using NODE_MODULE_VERSION N
 *   This version of Node.js requires NODE_MODULE_VERSION M
 *
 * That often surfaces as Vite proxy ECONNREFUSED to localhost:3000 because the
 * backend never starts.
 *
 * Usage (repo root):
 *   npm run rebuild:native
 *   node scripts/rebuild-natives.cjs --ensure   # rebuild only if load fails
 *
 * Env:
 *   CASCADE_SKIP_NATIVE_REBUILD=1  skip all work (exit 0)
 *   npm_config_python / PYTHON     force the Python used by node-gyp
 *
 * On macOS, when PYTHON is unset, prefer /usr/bin/python3 so a broken Homebrew
 * Python (e.g. pyexpat on 3.14) does not fail node-gyp.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOT_NATIVE_PACKAGES = ['better-sqlite3', 'bcrypt'];

function log(msg) {
  console.log(`[rebuild-natives] ${msg}`);
}

function warn(msg) {
  console.warn(`[rebuild-natives] ${msg}`);
}

function isAbiMismatchError(err) {
  const msg = err && err.message ? err.message : String(err || '');
  return (
    /NODE_MODULE_VERSION/i.test(msg) ||
    /compiled against a different Node\.js version/i.test(msg) ||
    /was compiled against a different/i.test(msg)
  );
}

function preferMacSystemPython(env) {
  if (process.platform !== 'darwin') return env;
  if (env.npm_config_python || env.PYTHON || env.npm_config_python3) return env;

  const systemPython = '/usr/bin/python3';
  if (!fs.existsSync(systemPython)) return env;

  // Probe: broken Homebrew Pythons sometimes fail importing pyexpat under node-gyp.
  const probe = spawnSync(systemPython, ['-c', 'import sys; print(sys.executable)'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) return env;

  return {
    ...env,
    npm_config_python: systemPython,
    PYTHON: systemPython,
  };
}

function run(cmd, args, opts = {}) {
  const env = preferMacSystemPython({ ...process.env, ...(opts.env || {}) });
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || ROOT,
    env,
    stdio: opts.stdio || 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const err = new Error(
      `${cmd} ${args.join(' ')} failed with exit ${result.status}` +
        (opts.cwd ? ` (cwd=${opts.cwd})` : ''),
    );
    err.status = result.status;
    throw err;
  }
  return result;
}

function packageInstalled(pkgName, fromDir = ROOT) {
  try {
    require.resolve(`${pkgName}/package.json`, { paths: [fromDir] });
    return true;
  } catch {
    return false;
  }
}

function tryRequireNative(pkgName, fromDir = ROOT) {
  const resolved = require.resolve(pkgName, { paths: [fromDir] });
  // Drop cached copy so a rebuild is visible without restarting this process.
  delete require.cache[resolved];
  require(resolved);
}

function rootLoadOk() {
  for (const pkg of ROOT_NATIVE_PACKAGES) {
    if (!packageInstalled(pkg, ROOT)) continue;
    try {
      tryRequireNative(pkg, ROOT);
    } catch (err) {
      if (isAbiMismatchError(err)) {
        return { ok: false, pkg, err };
      }
      // Missing optional tooling or other load errors are not ABI rebuilds.
      throw err;
    }
  }
  return { ok: true };
}

function rebuildRoot() {
  const present = ROOT_NATIVE_PACKAGES.filter((pkg) => packageInstalled(pkg, ROOT));
  if (present.length === 0) {
    log('no root native packages found; skip root rebuild');
    return;
  }
  log(
    `rebuilding root natives for Node ${process.version} (ABI ${process.versions.modules}): ${present.join(', ')}`,
  );
  run('npm', ['rebuild', ...present], { cwd: ROOT });
  const check = rootLoadOk();
  if (!check.ok) {
    throw new Error(
      `root rebuild finished but ${check.pkg} still fails to load:\n${check.err && check.err.message}`,
    );
  }
  log('root natives OK');
}

function printRecoveryHint(err) {
  warn('Native module rebuild failed.');
  if (err && err.message) warn(err.message);
  warn('Recovery:');
  warn('  1) npm run rebuild:native');
  warn('  2) or: npm rebuild better-sqlite3 bcrypt');
  if (process.platform === 'darwin') {
    warn('  macOS node-gyp tip: npm_config_python=/usr/bin/python3 npm run rebuild:native');
  }
}

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    ensure: flags.has('--ensure'),
    postinstall: flags.has('--postinstall'),
  };
}

function main() {
  if (process.env.CASCADE_SKIP_NATIVE_REBUILD === '1') {
    log('CASCADE_SKIP_NATIVE_REBUILD=1; skipping');
    return;
  }

  const args = parseArgs(process.argv.slice(2));

  try {
    if (args.ensure || args.postinstall) {
      const check = rootLoadOk();
      if (check.ok) {
        if (!args.postinstall) log('root natives already load; skip root rebuild');
      } else {
        warn(
          `ABI mismatch for ${check.pkg} (Node ${process.version}, modules ${process.versions.modules}); rebuilding`,
        );
        rebuildRoot();
      }
    } else {
      rebuildRoot();
    }
  } catch (err) {
    printRecoveryHint(err);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  isAbiMismatchError,
  preferMacSystemPython,
  rootLoadOk,
  rebuildRoot,
};
