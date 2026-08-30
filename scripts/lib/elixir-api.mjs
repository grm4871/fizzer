import { spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function elixirApiCommand(repoRoot) {
  return { command: 'mix', args: ['run', '--no-halt'], cwd: path.join(repoRoot, 'backend_elixir') };
}

export function elixirApiEnv(repoRoot, {
  port = process.env.API_PORT || 3000,
  dbPath,
  extraEnv = {},
} = {}) {
  const dataDir = extraEnv.CASCADE_DATA_DIR
    || (dbPath ? path.dirname(dbPath) : path.join(repoRoot, '.cascade-dev'));
  return {
    ...process.env,
    API_PORT: String(port),
    API_HOST: '127.0.0.1',
    CASCADE_BIND_IP: '127.0.0.1',
    CASCADE_SERVER: 'true',
    CASCADE_REPO_ROOT: repoRoot,
    DOCS_DB_PATH: dbPath || process.env.DOCS_DB_PATH,
    CASCADE_DATA_DIR: dataDir,
    CASCADE_VAULTS_BASE_DIR: path.join(dataDir, 'vaults'),
    CASCADE_QMD_DIR: path.join(dataDir, 'qmd'),
    CASCADE_DOWNLOADS_DIR: path.join(dataDir, 'downloads'),
    CASCADE_CLIENT_DIST_DIR: path.join(repoRoot, 'client/dist'),
    MIX_ENV: process.env.MIX_ENV || 'dev',
    ...extraEnv,
  };
}

export function spawnElixirApi(repoRoot, options = {}) {
  const spec = elixirApiCommand(repoRoot);
  return spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: elixirApiEnv(repoRoot, options),
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    detached: options.detached === true,
  });
}

export async function waitForElixirHealth(baseUrl, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
      const body = await response.json().catch(() => null);
      if (response.ok && body?.status === 'ok') return body;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw new Error(`Elixir API did not become healthy at ${baseUrl}/api/health${lastError ? `: ${lastError.message}` : ''}`);
}
