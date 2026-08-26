const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { spawn } = require('node:child_process');

const RELEASE_API = 'https://api.github.com/repos/grm4871/fizzer/releases/tags/desktop-beta';

function assetNameForArch(arch) {
  if (arch === 'arm64') return 'Fizzer-mac-arm64.dmg';
  if (arch === 'x64') return 'Fizzer-mac-x64.dmg';
  throw new Error(`Fizzer updates do not support this Mac architecture yet: ${arch}`);
}

function expectedSha256(asset) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest || '');
  if (!match) throw new Error('GitHub did not provide a SHA-256 digest for this update.');
  return match[1].toLowerCase();
}

async function fetchReleaseAsset(arch, fetchImpl = fetch) {
  const response = await fetchImpl(RELEASE_API, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Fizzer-Desktop-Updater',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);

  const release = await response.json();
  const name = assetNameForArch(arch);
  const asset = release.assets?.find((candidate) => candidate.name === name);
  if (!asset?.browser_download_url) throw new Error(`The latest release does not contain ${name}.`);
  return { name, url: asset.browser_download_url, sha256: expectedSha256(asset) };
}

async function downloadVerifiedAsset(asset, destination, fetchImpl = fetch) {
  const response = await fetchImpl(asset.url, { headers: { 'User-Agent': 'Fizzer-Desktop-Updater' } });
  if (!response.ok || !response.body) {
    throw new Error(`Fizzer update download failed with HTTP ${response.status}.`);
  }

  const hash = crypto.createHash('sha256');
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => hash.update(chunk));
  await pipeline(source, output);

  const actual = hash.digest('hex');
  if (actual !== asset.sha256) {
    await fsp.rm(destination, { force: true });
    throw new Error('The downloaded update did not match GitHub’s SHA-256 digest.');
  }
}

function appBundleForExecutable(executablePath) {
  const bundle = path.resolve(path.dirname(executablePath), '..', '..');
  if (!bundle.endsWith('.app')) throw new Error('Could not locate the running Fizzer.app bundle.');
  return bundle;
}

const INSTALL_COMMANDS = Object.freeze({
  kill: '/bin/kill',
  sleep: '/bin/sleep',
  mkdir: '/bin/mkdir',
  rm: '/bin/rm',
  hdiutil: '/usr/bin/hdiutil',
  ditto: '/usr/bin/ditto',
  xattr: '/usr/bin/xattr',
  mv: '/bin/mv',
  open: '/usr/bin/open',
});

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function createInstallScript(commands = INSTALL_COMMANDS) {
  const command = Object.fromEntries(
    Object.entries(INSTALL_COMMANDS).map(([name]) => [name, shellQuote(commands[name])]),
  );
  return `#!/bin/bash
set -euo pipefail

pid="$1"
dmg="$2"
target="$3"
work_dir="$4"
mount_point="$work_dir/mount"
parent="$(dirname "$target")"
stage="$parent/.Fizzer.update-$pid.app"
backup="$parent/.Fizzer.backup-$pid.app"

cleanup() {
  ${command.hdiutil} detach "$mount_point" -quiet >/dev/null 2>&1 || true
  ${command.rm} -rf "$work_dir" "$stage"
}
trap cleanup EXIT

while ${command.kill} -0 "$pid" >/dev/null 2>&1; do ${command.sleep} 0.2; done
${command.mkdir} -p "$mount_point"
${command.hdiutil} attach "$dmg" -nobrowse -readonly -mountpoint "$mount_point" -quiet
source_app="$mount_point/Fizzer.app"
test -d "$source_app"

${command.rm} -rf "$stage" "$backup"
${command.ditto} "$source_app" "$stage"
${command.xattr} -dr com.apple.quarantine "$stage"

if test -e "$target"; then ${command.mv} "$target" "$backup"; fi
if ${command.mv} "$stage" "$target"; then
  ${command.rm} -rf "$backup"
  ${command.open} "$target"
else
  if test -e "$backup"; then ${command.mv} "$backup" "$target"; fi
  exit 1
fi
`;
}

const INSTALL_SCRIPT = createInstallScript();

async function prepareMacOSUpdate({ arch, executablePath, fetchImpl = fetch }) {
  const target = appBundleForExecutable(executablePath);
  await fsp.access(path.dirname(target), fs.constants.W_OK);

  const workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'fizzer-update-'));
  const dmgPath = path.join(workDir, 'Fizzer.dmg');
  const scriptPath = path.join(workDir, 'install.sh');
  try {
    const asset = await fetchReleaseAsset(arch, fetchImpl);
    await downloadVerifiedAsset(asset, dmgPath, fetchImpl);
    await fsp.writeFile(scriptPath, INSTALL_SCRIPT, { mode: 0o700 });
    return { target, workDir, dmgPath, scriptPath };
  } catch (error) {
    await fsp.rm(workDir, { recursive: true, force: true });
    throw error;
  }
}

function launchMacOSInstaller(update, pid = process.pid) {
  const child = spawn('/bin/bash', [
    update.scriptPath,
    String(pid),
    update.dmgPath,
    update.target,
    update.workDir,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
}

module.exports = {
  INSTALL_SCRIPT,
  appBundleForExecutable,
  assetNameForArch,
  createInstallScript,
  downloadVerifiedAsset,
  expectedSha256,
  fetchReleaseAsset,
  launchMacOSInstaller,
  prepareMacOSUpdate,
};
