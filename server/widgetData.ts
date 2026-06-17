import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const WIDGET_DATA_TTL_MS = 2000;

const ALLOWED_WIDGET_DATA: Record<string, string> = {
  'system-stats': '.cascade/scripts/system-stats.py',
};

const cache = new Map<string, { expiresAt: number; payload: WidgetDataResult }>();

export type WidgetDataResult = {
  key: string;
  data: unknown;
  fetched_at: string;
  cached: boolean;
};

function resolveAllowedScript(vaultRoot: string, key: string) {
  const rel = ALLOWED_WIDGET_DATA[key];
  if (!rel) return null;

  const abs = path.resolve(vaultRoot, rel);
  const allowedRoot = path.resolve(vaultRoot, '.cascade/scripts');
  if (!abs.startsWith(allowedRoot + path.sep) && abs !== allowedRoot) return null;
  if (!fs.existsSync(abs)) return null;
  return abs;
}

function runPythonScript(scriptPath: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [scriptPath], { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    const limit = 64 * 1024;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString()).slice(-limit);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Widget data script timed out'));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Widget data script failed with exit code ${code}`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function fetchWidgetData(
  vaultRoot: string,
  key: string,
  options: { force?: boolean; timeoutMs?: number } = {},
): Promise<WidgetDataResult> {
  const scriptPath = resolveAllowedScript(vaultRoot, key);
  if (!scriptPath) throw new Error('Unknown or missing widget data source');

  const cacheKey = `${vaultRoot}:${key}`;
  const cached = cache.get(cacheKey);
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return { ...cached.payload, cached: true };
  }

  const stdout = await runPythonScript(scriptPath, vaultRoot, options.timeoutMs ?? 15000);
  const line = stdout.split('\n').filter(Boolean).pop();
  if (!line) throw new Error('Widget data script returned no output');

  const data = JSON.parse(line) as unknown;
  const payload: WidgetDataResult = {
    key,
    data,
    fetched_at: new Date().toISOString(),
    cached: false,
  };
  cache.set(cacheKey, { expiresAt: Date.now() + WIDGET_DATA_TTL_MS, payload });
  return payload;
}