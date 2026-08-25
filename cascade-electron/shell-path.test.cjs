const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { installDesktopShellPath, macOSDesktopPath } = require('./shell-path.cjs');

test('packaged macOS merges login-shell, common user, Homebrew, and inherited paths', () => {
  const env = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh' };
  const result = installDesktopShellPath({
    platform: 'darwin',
    packaged: true,
    env,
    homeDir: '/Users/alice',
    run: () => 'welcome from .zshrc\n__FIZZER_LOGIN_PATH__/custom/node/bin:/opt/homebrew/bin:/usr/bin\n',
  });
  const entries = result.split(path.delimiter);
  assert.equal(entries[0], '/custom/node/bin');
  assert.ok(entries.includes('/Users/alice/.bun/bin'));
  assert.ok(entries.includes('/Users/alice/.local/bin'));
  assert.ok(entries.includes('/opt/homebrew/bin'));
  assert.equal(entries.filter((entry) => entry === '/opt/homebrew/bin').length, 1);
  assert.equal(env.PATH, result);
});

test('falls back to deterministic macOS paths when shell startup fails', () => {
  const result = macOSDesktopPath({
    env: { PATH: '/usr/bin', SHELL: '/missing/shell' },
    homeDir: '/Users/alice',
    run: () => { throw new Error('not called'); },
  });
  assert.ok(result.includes('/Users/alice/.bun/bin'));
  assert.ok(result.includes('/opt/homebrew/bin'));
  assert.ok(result.includes('/usr/bin'));
});

test('does not rewrite PATH outside packaged macOS', () => {
  const env = { PATH: '/custom/bin' };
  assert.equal(installDesktopShellPath({ platform: 'linux', packaged: true, env }), '/custom/bin');
  assert.equal(installDesktopShellPath({ platform: 'darwin', packaged: false, env }), '/custom/bin');
  assert.equal(env.PATH, '/custom/bin');
});
