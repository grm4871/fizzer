#!/usr/bin/env node
/**
 * Release check — vault rename + the relocated "Show agent memory" preference.
 *
 * Drives the built client in headless Chromium against a real server, because
 * both changes are pure renderer wiring that `vite build` will happily ship
 * broken (the client bundle is not type-checked). What this catches: the
 * rename control reaching PATCH /api/vaults/:id and the switcher label
 * updating, an editor not being offered rename at all, and the agent-memory
 * toggle having actually moved from the vault switcher into account settings.
 *
 * Build first: `npm run build && npm run build:client`.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const PREVIEW_PORT = Number(process.env.TEST_PREVIEW_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-vault-rename-${API_PORT}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url, { redirect: 'follow' })).ok) return; } catch { /* retry */ }
    await delay(400);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function must(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${url}: ${data.error || 'request failed'}`);
  return data;
}

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`[vault-rename-ui] OK  ${name}`);
  else { console.error(`[vault-rename-ui] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    DOCS_DB_PATH: DB_PATH,
    JWT_SECRET: 'vault-rename-secret',
    CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (c) => process.stderr.write(`[server-err] ${c}`));

const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, API_PORT: String(API_PORT) },
});
preview.stderr.on('data', (c) => process.stderr.write(`[preview] ${c}`));

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);

  const stamp = Date.now();
  const owner = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username: `vr_owner_${stamp}`, password: 'testpass12345' }),
  });
  const mate = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username: `vr_mate_${stamp}`, password: 'testpass12345' }),
  });
  const ownerAuth = { Authorization: `Bearer ${owner.token}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: ownerAuth, body: JSON.stringify({ name: 'Before Rename' }),
  });
  await must(`${API_BASE}/api/vaults/${vault.id}/members`, {
    method: 'POST', headers: ownerAuth, body: JSON.stringify({ username: `vr_mate_${stamp}`, role: 'editor' }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });

  const open = async (token) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate((t) => localStorage.setItem('docs_token', t), token);
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    return { page, errors };
  };

  // ── Owner renames the vault from the switcher.
  const { page, errors } = await open(owner.token);
  await page.locator('.vault-switcher-trigger, .sidebar-vault-button, [aria-label*="vault" i]').first().click();
  await page.locator('.vault-switcher-menu').waitFor({ timeout: 15000 });

  check('switcher no longer carries the agent-memory toggle',
    await page.locator('.vault-switcher-menu').getByText('Show agent memory').count() === 0);

  await page.getByRole('button', { name: 'Rename Before Rename' }).click();
  const input = page.getByLabel('Rename Before Rename');
  await input.fill('After Rename');
  await page.getByRole('button', { name: 'Save', exact: true }).click();

  await page.locator('.vault-switcher-menu').getByText('After Rename').first().waitFor({ timeout: 15000 });
  check('rename updates the switcher label', true);

  const persisted = await must(`${API_BASE}/api/vaults/${vault.id}`, { headers: ownerAuth });
  check('rename persisted server-side', persisted.vault.name === 'After Rename', persisted.vault.name);
  check('rename left the storage root untouched',
    persisted.vault.root_path === vault.root_path, `${vault.root_path} -> ${persisted.vault.root_path}`);

  // ── The preference moved into account settings and still round-trips.
  await page.keyboard.press('Escape');
  await page.locator('.sidebar-footer .user-info').click();
  const modal = page.locator('.account-settings');
  await modal.waitFor({ timeout: 15000 });
  const toggle = modal.locator('.account-settings-check input');
  check('account settings host the agent-memory preference', await toggle.count() === 1);
  await toggle.check();
  check('preference persists to localStorage',
    await page.evaluate(() => localStorage.getItem('cascade_show_agent_memory')) === '1');

  check('no runtime errors on the owner session', errors.length === 0, errors.join(' | '));
  await page.close();

  // ── An editor sees the new name but gets no rename control.
  const { page: matePage, errors: mateErrors } = await open(mate.token);
  await matePage.locator('.vault-switcher-trigger, .sidebar-vault-button, [aria-label*="vault" i]').first().click();
  await matePage.locator('.vault-switcher-menu').waitFor({ timeout: 15000 });
  check('editor sees the renamed vault',
    await matePage.locator('.vault-switcher-menu').getByText('After Rename').count() > 0);
  check('editor is not offered rename',
    await matePage.getByRole('button', { name: 'Rename After Rename' }).count() === 0);
  check('no runtime errors on the editor session', mateErrors.length === 0, mateErrors.join(' | '));
  await matePage.close();

  // ── Server-side gate, independent of what the UI renders.
  const forbidden = await fetch(`${API_BASE}/api/vaults/${vault.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mate.token}` },
    body: JSON.stringify({ name: 'Editor Rename' }),
  });
  check('editor cannot rename via the API', forbidden.status === 403, String(forbidden.status));

  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log('[vault-rename-ui] OK — vault rename, owner gating, and the relocated agent-memory preference');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  preview.kill('SIGTERM');
}
