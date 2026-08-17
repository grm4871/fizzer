import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  backendCommand,
  buildBackendEnvironment,
  launchTestBackend,
  resolveTestBackend,
} from './test-backend.mjs';

test('backend selection defaults to elixir and rejects the removed Node backend', () => {
  assert.equal(resolveTestBackend(undefined), 'elixir');
  assert.equal(resolveTestBackend(' ELIXIR '), 'elixir');
  assert.throws(() => resolveTestBackend('node'), /has been removed/);
  assert.throws(() => resolveTestBackend('proxy'), /must be elixir/);
});

test('commands launch the Elixir backend directly', () => {
  assert.deepEqual(backendCommand('elixir', '/repo'), {
    command: 'mix',
    args: ['run', '--no-halt'],
    cwd: '/repo/backend_elixir',
  });
});

test('environment maps shared paths into the temp root', () => {
  const env = buildBackendEnvironment({
    backend: 'elixir', repoRoot: '/repo', port: 4321,
    databasePath: '/tmp/safe/data/docs.db', tempRoot: '/tmp/safe',
    env: { JWT_SECRET: 'secret' },
  });
  assert.equal(env.API_PORT, '4321');
  assert.equal(env.API_HOST, '127.0.0.1');
  assert.equal(env.CASCADE_BIND_IP, '127.0.0.1');
  assert.equal(env.DOCS_DB_PATH, '/tmp/safe/data/docs.db');
  assert.equal(env.CASCADE_CLIENT_DIST_DIR, '/tmp/safe/client-dist');
  assert.equal(env.CASCADE_VAULTS_BASE_DIR, '/tmp/safe/vaults');
  assert.equal(env.JWT_SECRET, 'secret');
});

test('explicit invite gating maps to Elixir network registration gating', () => {
  const env = buildBackendEnvironment({
    backend: 'elixir', repoRoot: '/repo', port: 4321,
    databasePath: '/tmp/safe/data/docs.db', tempRoot: '/tmp/safe',
    env: { CASCADE_REQUIRE_INVITE_REGISTRATION: 'true' },
  });
  assert.equal(env.CASCADE_NETWORK_MODE, 'true');
});

test('launcher waits for health and terminates the whole fixture cleanly', async () => {
  const script = `
    const http = require('node:http');
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: req.url === '/api/health' ? 'ok' : 'no' }));
    });
    server.listen(Number(process.env.API_PORT), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `;
  const backend = await launchTestBackend({
    backend: 'elixir', name: 'launcher-unit', pipeOutput: false, keepTemp: false,
    command: { command: process.execPath, args: ['-e', script] },
  });
  assert.equal((await fetch(`${backend.baseUrl}/api/health`).then((response) => response.json())).status, 'ok');
  assert.ok(fs.existsSync(backend.databasePath.replace('/docs.db', '')));
  const tempRoot = backend.tempRoot;
  await backend.stop();
  assert.equal(fs.existsSync(tempRoot), false);
});

test('early process exit fails readiness and cleans its temporary root', async () => {
  await assert.rejects(
    launchTestBackend({
      backend: 'elixir', name: 'launcher-exit', pipeOutput: false, keepTemp: false,
      command: { command: process.execPath, args: ['-e', 'process.exit(23)'] },
      readinessTimeoutMs: 2_000,
    }),
    /exited before readiness.*code=23/s,
  );
});
