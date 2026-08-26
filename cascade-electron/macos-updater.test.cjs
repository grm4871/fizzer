const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  appBundleForExecutable,
  assetNameForArch,
  createInstallScript,
  downloadVerifiedAsset,
  expectedSha256,
} = require('./macos-updater.cjs');

async function executableFile(file, contents) {
  await fsp.writeFile(file, contents, { mode: 0o700 });
  await fsp.chmod(file, 0o700);
  return file;
}

function runInstaller(scriptPath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [scriptPath, ...args]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr: String(stderr) }));
  });
}

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
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fizzer-updater-test-'));
  const destination = path.join(dir, 'update.dmg');
  await downloadVerifiedAsset(
    { url: 'https://example.test/update', sha256: digest },
    destination,
    async () => new Response(body),
  );
  assert.deepEqual(await fsp.readFile(destination), body);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('installer waits, stages with quarantine clearing, atomically replaces, and relaunches', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fizzer-installer-test-'));
  const target = path.join(root, 'Fizzer.app');
  const workDir = path.join(root, 'work');
  const state = path.join(root, 'kill-count');
  const opened = path.join(root, 'opened');
  const xattrs = path.join(root, 'xattrs');
  const commandsDir = path.join(root, 'commands');
  await fsp.mkdir(path.join(target, 'Contents'), { recursive: true });
  await fsp.writeFile(path.join(target, 'Contents', 'version'), 'old');
  await fsp.mkdir(workDir, { recursive: true });
  await fsp.mkdir(commandsDir);

  const kill = await executableFile(path.join(commandsDir, 'kill'), `#!/bin/bash
count=0
if test -f ${JSON.stringify(state)}; then count=$(cat ${JSON.stringify(state)}); fi
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(state)}
if test "$count" -eq 1; then exit 0; else exit 1; fi
`);
  const hdiutil = await executableFile(path.join(commandsDir, 'hdiutil'), `#!/bin/bash
if test "$1" = attach; then
  while test "$1" != -mountpoint; do shift; done
  shift
  /bin/mkdir -p "$1/Fizzer.app/Contents"
  printf 'new' > "$1/Fizzer.app/Contents/version"
fi
`);
  const ditto = await executableFile(path.join(commandsDir, 'ditto'), '#!/bin/bash\n/bin/cp -R "$1" "$2"\n');
  const xattr = await executableFile(path.join(commandsDir, 'xattr'), `#!/bin/bash
if test "$1" != -dr || test "$2" != com.apple.quarantine; then exit 2; fi
case "$3" in *.Fizzer.update-*.app) ;; *) exit 3 ;; esac
printf 'quarantine-cleared' > ${JSON.stringify(xattrs)}
`);
  const open = await executableFile(path.join(commandsDir, 'open'), `#!/bin/bash
printf '%s' "$1" > ${JSON.stringify(opened)}
`);
  const scriptPath = path.join(root, 'install.sh');
  const script = createInstallScript({
    kill,
    sleep: '/usr/bin/true',
    mkdir: '/bin/mkdir',
    rm: '/bin/rm',
    hdiutil,
    ditto,
    xattr,
    mv: '/bin/mv',
    open,
  });
  await fsp.writeFile(scriptPath, script, { mode: 0o700 });
  await fsp.chmod(scriptPath, 0o700);

  const result = await runInstaller(scriptPath, ['1234', path.join(root, 'update.dmg'), target, workDir]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await fsp.readFile(path.join(target, 'Contents', 'version'), 'utf8'), 'new');
  await assert.rejects(() => fsp.access(path.join(root, '.Fizzer.backup-1234.app')));
  assert.equal(await fsp.readFile(opened, 'utf8'), target);
  assert.equal(await fsp.readFile(xattrs, 'utf8'), 'quarantine-cleared');
  assert.ok(Number(await fsp.readFile(state, 'utf8')) >= 2);

  const target2 = path.join(root, 'Second.app');
  const workDir2 = path.join(root, 'work-2');
  await fsp.mkdir(path.join(target2, 'Contents'), { recursive: true });
  await fsp.writeFile(path.join(target2, 'Contents', 'version'), 'old-second');
  await fsp.mkdir(workDir2);
  const failMv = await executableFile(path.join(commandsDir, 'mv-fail-stage'), `#!/bin/bash
case "$1" in
  *.Fizzer.update-*) exit 1 ;;
esac
/bin/mv "$1" "$2"
`);
  const scriptPath2 = path.join(root, 'install-2.sh');
  await fsp.writeFile(scriptPath2, createInstallScript({
    kill,
    sleep: '/usr/bin/true',
    mkdir: '/bin/mkdir',
    rm: '/bin/rm',
    hdiutil,
    ditto,
    xattr,
    mv: failMv,
    open,
  }), { mode: 0o700 });
  await fsp.chmod(scriptPath2, 0o700);
  const rollback = await runInstaller(scriptPath2, ['5678', path.join(root, 'update-2.dmg'), target2, workDir2]);
  assert.equal(rollback.code, 1, rollback.stderr);
  assert.equal(await fsp.readFile(path.join(target2, 'Contents', 'version'), 'utf8'), 'old-second');
  await assert.rejects(() => fsp.access(path.join(root, '.Fizzer.backup-5678.app')));
  await fsp.rm(root, { recursive: true, force: true });
});
