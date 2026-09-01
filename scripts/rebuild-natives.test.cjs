'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  isAbiMismatchError,
  preferMacSystemPython,
  rootLoadOk,
} = require('./rebuild-natives.cjs');

test('desktop runtime invokes Windows batch tools through cmd.exe', () => {
  const source = fs.readFileSync(path.join(__dirname, 'build-desktop-runtime.mjs'), 'utf8');
  assert.match(source, /process\.env\.ComSpec \|\| 'cmd\.exe'/);
  assert.match(source, /\['\/d', '\/s', '\/c', command, \.\.\.args\]/);
  assert.match(source, /spawnSync\(executable, executableArgs/);
});

test('isAbiMismatchError detects NODE_MODULE_VERSION failures', () => {
  assert.equal(
    isAbiMismatchError(
      new Error(
        "The module 'better_sqlite3.node' was compiled against a different Node.js version using NODE_MODULE_VERSION 140. This version of Node.js requires NODE_MODULE_VERSION 147.",
      ),
    ),
    true,
  );
  assert.equal(isAbiMismatchError(new Error('ENOENT: no such file')), false);
});

test('preferMacSystemPython sets system python only on darwin when unset', () => {
  const original = process.platform;
  // We cannot reassign process.platform portably in all Node builds; test pure branch via env.
  const withUser = preferMacSystemPython({
    npm_config_python: '/custom/python3',
    PATH: process.env.PATH,
  });
  assert.equal(withUser.npm_config_python, '/custom/python3');

  if (process.platform === 'darwin') {
    const next = preferMacSystemPython({ PATH: process.env.PATH });
    if (require('node:fs').existsSync('/usr/bin/python3')) {
      assert.equal(next.npm_config_python, '/usr/bin/python3');
      assert.equal(next.PYTHON, '/usr/bin/python3');
    }
  } else {
    const next = preferMacSystemPython({ PATH: process.env.PATH });
    assert.equal(next.npm_config_python, undefined);
  }

  assert.equal(original, process.platform);
});

test('rootLoadOk succeeds in this checkout', () => {
  const check = rootLoadOk();
  assert.equal(check.ok, true, check.err && check.err.message);
});

test('script path stays under scripts/', () => {
  assert.equal(path.basename(__dirname), 'scripts');
});
