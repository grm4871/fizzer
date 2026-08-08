#!/usr/bin/env node
/**
 * Rebuild native Node modules for the current runtime.
 *
 * Cascade uses better-sqlite3 (and bcrypt) on the API process (system Node ABI)
 * and better-sqlite3 again inside Electron (Electron ABI). After a Node upgrade,
 * or when prebuilds do not match, the .node binary can fail with:
 *
 *   was compiled against a different Node.js version using NODE_MODULE_VERSION N
 *   This version of Node.js requires NODE_MODULE_VERSION M
 *
 * That often surfaces as Vite proxy ECONNREFUSED to localhost:3000 because the
 * backend never starts.
 *
 * Usage (repo root):
 *   npm run rebuild:native
 *   node scripts/rebuild-natives.cjs --root-only
 *   node scripts/rebuild-natives.cjs --electron-only
 *   node scripts/rebuild-natives.cjs --ensure   # rebuild only if load fails
 *
 * Env:
 *   CASCADE_SKIP_NATIVE_REBUILD=1  skip all work (exit 0)
 *   npm_config_python / PYTHON     force the Python used by node-gyp
 *
 * On macOS, when PYTHON is unset, prefer /usr/bin/python3 so a broken Homebrew
 * Python (e.g. pyexpat on 3.14) does not fail electron-rebuild / node-gyp.
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON_DIR = path.join(ROOT, 'cascade-electron');
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

function electronBindingPath() {
  return path.join(
    ELECTRON_DIR,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
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

function findElectronRebuildCli() {
  for (const fromDir of [ELECTRON_DIR, ROOT]) {
    try {
      const moduleEntry = require.resolve('@electron/rebuild', { paths: [fromDir] });
      const packagePath = path.resolve(path.dirname(moduleEntry), '..', 'package.json');
      const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      const relativeCli = typeof packageJson.bin === 'string'
        ? packageJson.bin
        : packageJson.bin?.['electron-rebuild'];
      if (!relativeCli) continue;
      const cli = path.resolve(path.dirname(packagePath), relativeCli);
      if (fs.existsSync(cli)) return cli;
    } catch {
      // Try the next dependency root.
    }
  }
  return null;
}

function rebuildElectron() {
  if (!fs.existsSync(path.join(ELECTRON_DIR, 'package.json'))) {
    log('cascade-electron/ missing; skip Electron rebuild');
    return;
  }
  if (!packageInstalled('better-sqlite3', ELECTRON_DIR)) {
    log('cascade-electron better-sqlite3 not installed; run: npm install --prefix cascade-electron');
    return;
  }

  const cli = findElectronRebuildCli();
  if (!cli) {
    warn(
      'electron-rebuild not found. Install Electron deps: npm install --prefix cascade-electron',
    );
    return;
  }

  log(`rebuilding cascade-electron better-sqlite3 for Electron (via ${path.relative(ROOT, cli)})`);
  // Resolve the package's JavaScript entrypoint, not npm's platform-specific
  // .bin shim. On Windows the extensionless shim is POSIX shell and cannot be
  // parsed by node.exe.
  run(process.execPath, [cli, '-f', '-w', 'better-sqlite3'], { cwd: ELECTRON_DIR });

  const binding = electronBindingPath();
  if (!fs.existsSync(binding)) {
    throw new Error(`Electron rebuild finished but binding missing: ${binding}`);
  }
  log(`Electron native binding present: ${path.relative(ROOT, binding)}`);
}

function printRecoveryHint(err) {
  warn('Native module rebuild failed.');
  if (err && err.message) warn(err.message);
  warn('Recovery:');
  warn('  1) npm run rebuild:native');
  warn('  2) or: npm rebuild better-sqlite3 bcrypt');
  warn('  3) Electron: npm install --prefix cascade-electron && npm run rebuild:native -- --electron-only');
  if (process.platform === 'darwin') {
    warn('  macOS node-gyp tip: npm_config_python=/usr/bin/python3 npm run rebuild:native');
  }
}

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    rootOnly: flags.has('--root-only'),
    electronOnly: flags.has('--electron-only'),
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
  const doRoot = !args.electronOnly;
  const doElectron = !args.rootOnly;

  try {
    if (doRoot) {
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
    }

    if (doElectron) {
      // postinstall at repo root should not force Electron rebuild (Docker/server
      // installs omit Electron). Explicit npm run rebuild:native still does both.
      if (args.postinstall) {
        // no-op for electron on root postinstall
      } else if (args.ensure) {
        // Only rebuild Electron if the package is installed; we cannot load the
        // Electron-ABI binary under system Node, so rebuild when binding missing
        // or when --ensure was requested with electron present after a failed start.
        if (packageInstalled('better-sqlite3', ELECTRON_DIR) && !fs.existsSync(electronBindingPath())) {
          rebuildElectron();
        } else if (!args.rootOnly) {
          // Conservative: if electron deps exist, rebuild so ABI matches current Electron.
          if (packageInstalled('better-sqlite3', ELECTRON_DIR) && findElectronRebuildCli()) {
            rebuildElectron();
          }
        }
      } else {
        rebuildElectron();
      }
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
  findElectronRebuildCli,
  rootLoadOk,
  rebuildRoot,
  rebuildElectron,
};
