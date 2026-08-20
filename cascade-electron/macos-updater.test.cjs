const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  INSTALL_SCRIPT,
  appBundleForExecutable,
  assetNameForArch,
  downloadVerifiedAsset,
  expectedSha256,
} = require('./macos-updater.cjs');

test('selects the matching macOS release asset', () => {
  assert.equal(assetNameForArch('arm64'), 'Fizzer-mac-arm64.dmg');
  assert.equal(assetNameForArch('x64'), 'Fizzer-mac-x64.dmg');
  assert.throws(() => assetNameForArch('ia32'), /architecture/);
});

test('requires GitHub release SHA-256 metadata', () => {
  const digest = 'a'.repeat(64);
  assert.equal(expectedSha256({ digest: `sha256:${digest}` }), digest);
  assert.throws(() => expectedSha256({}), /SHA-256 digest/);
});

test('locates the app bundle from the packaged executable', () => {
  assert.equal(
    appBundleForExecutable('/Applications/Fizzer.app/Contents/MacOS/fizzer-desktop'),
    '/Applications/Fizzer.app',
  );
  assert.throws(() => appBundleForExecutable('/tmp/fizzer-desktop'), /Fizzer.app bundle/);
});

test('downloads an asset only when its digest matches', async () => {
  const body = Buffer.from('verified update');
  const digest = require('node:crypto').createHash('sha256').update(body).digest('hex');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fizzer-updater-test-'));
  const destination = path.join(dir, 'update.dmg');
  const response = new Response(body);
  await downloadVerifiedAsset({ url: 'https://example.test/update', sha256: digest }, destination, async () => response);
  assert.deepEqual(await fs.readFile(destination), body);
  await fs.rm(dir, { recursive: true, force: true });
});

test('installer waits for exit, replaces atomically, clears quarantine, and relaunches', () => {
  assert.match(INSTALL_SCRIPT, /kill -0/);
  assert.match(INSTALL_SCRIPT, /hdiutil attach/);
  assert.match(INSTALL_SCRIPT, /ditto/);
  assert.match(INSTALL_SCRIPT, /com\.apple\.quarantine/);
  assert.match(INSTALL_SCRIPT, /backup/);
  assert.match(INSTALL_SCRIPT, /\/usr\/bin\/open/);
});
