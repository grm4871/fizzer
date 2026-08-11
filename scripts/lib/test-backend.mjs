import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { pickPort } from './test-ports.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VALID_BACKENDS = new Set(['node', 'elixir']);

export function resolveTestBackend(value = process.env.CASCADE_TEST_BACKEND) {
  const backend = String(value || 'node').trim().toLowerCase();
  if (!VALID_BACKENDS.has(backend)) {
    throw new Error(`CASCADE_TEST_BACKEND must be node or elixir, got ${JSON.stringify(value)}`);
  }
  return backend;
}

export function backendCommand(backend, repoRoot = DEFAULT_ROOT) {
  if (resolveTestBackend(backend) === 'elixir') {
    return { command: 'mix', args: ['run', '--no-halt'], cwd: path.join(repoRoot, 'backend_elixir') };
  }
  return { command: process.execPath, args: ['dist/index.js'], cwd: repoRoot };
}

export function buildBackendEnvironment({
  backend,
  repoRoot = DEFAULT_ROOT,
  port,
  databasePath,
  tempRoot,
  env = {},
}) {
  const kind = resolveTestBackend(backend);
  const dataRoot = path.join(tempRoot, 'data');
  const result = {
    ...process.env,
    ...env,
    API_PORT: String(port),
    API_HOST: '127.0.0.1',
    CASCADE_BIND_IP: '127.0.0.1',
    CASCADE_SERVER: 'true',
    CASCADE_REPO_ROOT: repoRoot,
    CASCADE_DATA_DIR: dataRoot,
    CASCADE_VAULTS_BASE_DIR: path.join(tempRoot, 'vaults'),
    CASCADE_QMD_DIR: path.join(tempRoot, 'qmd'),
    CASCADE_DOWNLOADS_DIR: path.join(tempRoot, 'downloads'),
    DOCS_DB_PATH: databasePath,
    MIX_ENV: kind === 'elixir' ? (env.MIX_ENV || 'dev') : (env.MIX_ENV || process.env.MIX_ENV),
  };
  // Node exposes a testable invite override. Elixir currently ties the same
  // registration gate to network mode, so translate only when the caller made
  // the Node override explicit and did not set Elixir's broader mode itself.
  if (kind === 'elixir' && env.CASCADE_NETWORK_MODE == null && env.CASCADE_REQUIRE_INVITE_REGISTRATION != null) {
    result.CASCADE_NETWORK_MODE = /^(1|true|yes|on)$/i.test(env.CASCADE_REQUIRE_INVITE_REGISTRATION)
      ? 'true'
      : 'false';
  }
  if (result.MIX_ENV == null) delete result.MIX_ENV;
  return result;
}

function copyTree(source, destination) {
  if (!source) return;
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function tail(text, max = 8_000) {
  return text.length <= max ? text : text.slice(-max);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return true;
  return Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

function signalProcessGroup(child, signal) {
  if (child.exitCode != null || child.signalCode != null) return;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

/**
 * Start either Cascade backend in a throwaway filesystem sandbox.
 *
 * `prepare` runs after fixture copies and before the process starts, which lets
 * an existing e2e create a legacy Node-compatible database without owning any
 * lifecycle or cleanup code.
 */
export async function launchTestBackend(options = {}) {
  const backend = resolveTestBackend(options.backend);
  const repoRoot = path.resolve(options.repoRoot || DEFAULT_ROOT);
  const port = options.port || await pickPort();
  const ownedTempRoot = !options.tempRoot;
  const keepTemp = options.keepTemp ?? process.env.CASCADE_KEEP_TEST_ARTIFACTS === '1';
  const tempRoot = options.tempRoot
    ? path.resolve(options.tempRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), `cascade-${options.name || 'backend'}-${backend}-`));
  const databasePath = path.join(tempRoot, 'data', 'docs.db');
  const vaultsRoot = path.join(tempRoot, 'vaults');
  const qmdRoot = path.join(tempRoot, 'qmd');
  const downloadsRoot = path.join(tempRoot, 'downloads');

  for (const directory of [path.dirname(databasePath), vaultsRoot, qmdRoot, downloadsRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  if (options.fixtureDatabasePath) fs.copyFileSync(options.fixtureDatabasePath, databasePath);
  copyTree(options.fixtureVaultsRoot, vaultsRoot);

  const context = { backend, repoRoot, port, baseUrl: `http://127.0.0.1:${port}`, tempRoot, databasePath, vaultsRoot, qmdRoot, downloadsRoot };
  await options.prepare?.(context);

  const spec = options.command || backendCommand(backend, repoRoot);
  const childEnv = buildBackendEnvironment({
    backend,
    repoRoot,
    port,
    databasePath,
    tempRoot,
    env: options.env,
  });
  const child = spawn(spec.command, spec.args || [], {
    cwd: spec.cwd || repoRoot,
    env: childEnv,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const pipeOutput = options.pipeOutput ?? process.env.CASCADE_TEST_BACKEND_LOGS !== '0';
  child.stdout.on('data', (chunk) => {
    stdout = tail(stdout + chunk);
    if (pipeOutput) process.stdout.write(`[${backend}] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    stderr = tail(stderr + chunk);
    if (pipeOutput) process.stderr.write(`[${backend}-err] ${chunk}`);
  });

  let stopped = false;
  async function stop({ cleanup = !keepTemp } = {}) {
    if (!stopped) {
      stopped = true;
      signalProcessGroup(child, 'SIGTERM');
      if (!(await waitForExit(child, options.stopTimeoutMs || 5_000))) {
        signalProcessGroup(child, 'SIGKILL');
        await waitForExit(child, 2_000);
      }
    }
    if (cleanup && ownedTempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const readinessTimeoutMs = options.readinessTimeoutMs || (backend === 'elixir' ? 45_000 : 15_000);
  const deadline = Date.now() + readinessTimeoutMs;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error(`${backend} backend exited before readiness (code=${child.exitCode}, signal=${child.signalCode})\n${tail(stderr || stdout)}`);
      }
      try {
        const response = await fetch(`${context.baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
        const body = await response.json().catch(() => null);
        if (response.ok && body?.status === 'ok') {
          return { ...context, child, env: childEnv, get stdout() { return stdout; }, get stderr() { return stderr; }, stop };
        }
      } catch { /* still booting */ }
      await delay(100);
    }
    throw new Error(`${backend} backend did not become healthy within ${readinessTimeoutMs}ms\n${tail(stderr || stdout)}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
