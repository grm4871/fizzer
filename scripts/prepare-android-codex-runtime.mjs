import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { get } from 'node:https';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const VERSION = '0.147.0';
const BINARY_SHA256 = 'e23d0be344d2496986c985cd3db61e6f649b1ddd900e6afc1b5aaabbffcbb4e2';
const PACKAGE_URL = `https://registry.npmjs.org/@openai/codex/-/codex-${VERSION}-linux-arm64.tgz`;
const root = new URL('..', import.meta.url).pathname;
const output = join(root, 'android/app/src/main/jniLibs/arm64-v8a/libcodex.so');

async function download(url, destination) {
  await new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Codex download failed with HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolve, reject);
    });
    request.on('error', reject);
  });
}

async function run(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

await mkdir(join(root, 'android/app/src/main/jniLibs/arm64-v8a'), { recursive: true });
if (existsSync(output)) {
  const current = createHash('sha256').update(await readFile(output)).digest('hex');
  if (current === BINARY_SHA256) {
    console.log(`[android-codex] runtime already matches Codex ${VERSION}`);
    process.exit(0);
  }
}

const scratch = join(tmpdir(), `fizzer-codex-${process.pid}`);
const archive = join(scratch, 'codex.tgz');
await mkdir(scratch, { recursive: true });
try {
  console.log(`[android-codex] downloading Codex ${VERSION} ARM64 runtime`);
  await download(PACKAGE_URL, archive);
  await run('tar', ['-xzf', archive], scratch);
  const binary = join(scratch, 'package/vendor/aarch64-unknown-linux-musl/bin/codex');
  const digest = createHash('sha256').update(await readFile(binary)).digest('hex');
  if (digest !== BINARY_SHA256) throw new Error(`Codex binary checksum mismatch: ${digest}`);
  await copyFile(binary, output);
  await chmod(output, 0o755);
  console.log(`[android-codex] staged ${output}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
