#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnElixirApi } from '../scripts/lib/elixir-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-elixir-reference-'));
const port = Number(process.env.TEST_API_PORT || (32_000 + (process.pid % 1_000)));
const target = `http://127.0.0.1:${port}`;
const dbPath = path.join(temp, 'reference.db');
const fixturePath = path.join(temp, 'fixtures.jsonl');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function json(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `${response.status} ${url}`);
  return body;
}

async function waitForHealth() {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      if ((await json(`${target}/api/health`)).status === 'ok') return;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error('reference server health timeout');
}

async function main() {
  const server = spawnElixirApi(root, {
    port,
    dbPath,
    extraEnv: {
      JWT_SECRET: 'capacity-reference-secret',
      CASCADE_REQUIRE_INVITE_REGISTRATION: '0',
    },
  });
  let serverExit = null;
  server.once('exit', (code, signal) => { serverExit = { code, signal }; });
  server.stdout.on('data', (chunk) => process.stdout.write(`[reference] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[reference] ${chunk}`));
  try {
    await Promise.race([
      waitForHealth(),
      new Promise((_resolve, reject) => server.once('exit', (code, signal) => reject(new Error(`reference server exited early: ${code ?? signal}`)))),
    ]);
    const stamp = Date.now();
    const { token } = await json(`${target}/api/auth/register`, {
      method: 'POST', body: JSON.stringify({ username: `capacity_${stamp}`, password: 'testpass12345' }),
    });
    const browserLogin = await fetch(`${target}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Cascade-Browser': '1' },
      body: JSON.stringify({ username: `capacity_${stamp}`, password: 'testpass12345' }),
    });
    const cookie = browserLogin.headers.get('set-cookie')?.split(';', 1)[0] || '';
    if (!browserLogin.ok || !cookie) throw new Error('reference browser login did not return the session cookie');
    const headers = { Authorization: `Bearer ${token}` };
    const { vault } = await json(`${target}/api/vaults`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'Capacity reference' }),
    });
    const { note: channel } = await json(`${target}/api/vaults/${vault.id}/notes`, {
      method: 'POST', headers, body: JSON.stringify({ title: 'load', content: 'cascade://chat-channel' }),
    });
    fs.writeFileSync(fixturePath, `${JSON.stringify({
      token,
      vaultId: vault.id,
      channelId: channel.id,
      ownedChatChannels: 1,
      runner: true,
      runIds: [],
    })}\n`);

    const protocol = spawn(process.execPath, [
      path.join(here, 'protocol-probe.mjs'),
      '--target', target,
      '--token', token,
      '--cookie', cookie,
      '--vault-id', vault.id,
      '--channel-id', channel.id,
    ], { cwd: root, stdio: 'inherit' });
    const protocolCode = await new Promise((resolve) => protocol.once('exit', resolve));
    if (protocolCode !== 0) throw new Error(`reference protocol probe failed with exit ${protocolCode}`);

    const load = spawn(process.execPath, [
      path.join(here, 'load.mjs'),
      '--target', target,
      '--fixtures', fixturePath,
      '--users', '1',
      '--ramp-seconds', '0',
      // Leave the full enforced 20-second reconnect recovery window after the
      // forced disconnect so this smoke reaches the load phase.
      '--soak-seconds', '24',
      '--chat-rps', '1',
      '--read-rps', '2',
      '--run-rps', '0.25',
      '--polling-percent', '0',
      '--reconnect-percent', '100',
      '--reconnect-at-seconds', '3',
      '--receipt-timeout-ms', '2000',
      // The one-user smoke necessarily has no eligible writer/runner while its
      // only socket reconnects. Full shards retain the default 99% attempt gate
      // because their other 90% of clients remain connected.
      '--min-workload-attempted-ratio', '0.75',
      // The reference smoke validates the harness/protocol, not capacity. The
      // full staged proof retains the default 1 s p99 acceptance gate.
      '--http-write-p99-ms', '5000',
    ], { cwd: root, stdio: 'inherit' });
    const code = await new Promise((resolve) => load.once('exit', resolve));
    if (code !== 0) throw new Error(`reference smoke failed with exit ${code}`);
  } finally {
    if (!serverExit) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => server.once('exit', resolve)),
        sleep(2_000).then(() => server.kill('SIGKILL')),
      ]).catch(() => {});
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
