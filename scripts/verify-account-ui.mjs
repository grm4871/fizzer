#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const apiPort = await pickPort();
const previewPort = await pickPort();
const root = new URL('..', import.meta.url).pathname;
const apiBase = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${previewPort}/app.html`;
const dbPath = `/tmp/cascade-account-ui-${apiPort}.db`;
async function wait(url) { for (let i = 0; i < 120; i += 1) { try { if ((await fetch(url)).ok) return; } catch {} await delay(150); } throw new Error(`timeout: ${url}`); }
async function json(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${path}: ${data.error || 'failed'}`);
  return data;
}

try { fs.unlinkSync(dbPath); } catch {}
const server = spawn('node', ['dist/index.js'], { cwd: root, env: { ...process.env, API_PORT: String(apiPort), API_HOST: '127.0.0.1', DOCS_DB_PATH: dbPath, JWT_SECRET: 'account-ui-secret', CASCADE_ALLOW_OPEN_REGISTRATION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], { cwd: root, env: { ...process.env, API_PORT: String(apiPort), VITE_API_URL: apiBase }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
preview.stderr.on('data', (c) => process.stderr.write(`[preview] ${c}`));
let browser;
try {
  await wait(`${apiBase}/api/health`); await wait(appUrl);
  const username = `account_ui_${Date.now()}`;
  const mateName = `account_mate_${Date.now()}`;
  const { token } = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }) });
  await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: mateName, password: 'testpass12345' }) });
  const auth = { authorization: `Bearer ${token}` };
  await json('/api/vaults', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Profile workspace' }) });
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('docs_token', value), token);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.sidebar-footer .user-info').click();
  const modal = page.locator('.account-settings');
  await modal.waitFor();
  await modal.getByLabel('Display name').fill('Multiplayer Person');
  await modal.getByRole('button', { name: 'Save profile' }).click();
  await modal.getByText('Profile saved').waitFor();
  if (!(await page.locator('.sidebar-footer .user-info').innerText()).includes('Multiplayer Person')) throw new Error('sidebar did not update after profile save');
  await page.reload({ waitUntil: 'networkidle' });
  if (!(await page.locator('.sidebar-footer .user-info').innerText()).includes('Multiplayer Person')) throw new Error('profile did not survive reload');
  // Shared vault management: invite, re-role, and remove from the account modal.
  await page.locator('.sidebar-footer .user-info').click();
  const sharing = page.locator('.account-settings');
  await sharing.waitFor();
  if (await page.locator('#vault-shared-badge').count()) throw new Error('a private vault should not show the shared badge');
  await sharing.getByLabel('Invite by username').fill(mateName);
  await sharing.getByLabel('Invite role').selectOption('editor');
  await sharing.getByRole('button', { name: 'Invite' }).click();
  await sharing.getByText(`Added @${mateName} as editor`).waitFor();
  await sharing.locator(`.account-vault-members li:has-text("${mateName}")`).waitFor();
  // The switcher badge proves the vault list refreshed after the membership change.
  await page.locator('#vault-shared-badge').waitFor();
  if ((await page.locator('#vault-shared-badge').innerText()).trim() !== '2') throw new Error('shared badge did not show 2 members');

  await sharing.getByLabel(`Role for @${mateName}`).selectOption('viewer');
  await sharing.getByText(`@${mateName} is now viewer`).waitFor();

  page.once('dialog', (dialog) => dialog.accept());
  await sharing.getByLabel(`Remove @${mateName}`).click();
  await sharing.getByText(`Removed @${mateName}`).waitFor();
  if (await sharing.locator(`.account-vault-members li:has-text("${mateName}")`).count()) throw new Error('removed member still listed');
  await page.waitForFunction(() => !document.querySelector('#vault-shared-badge'));

  await page.getByLabel('Current password').fill('testpass12345');
  await page.getByLabel('New password', { exact: true }).fill('updatedpass12345');
  await page.getByLabel('Confirm new password').fill('updatedpass12345');
  await page.locator('.account-settings').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.waitForFunction(() => document.querySelector('.account-settings')?.textContent?.includes('Password changed'));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('[account-ui] OK — account modal, live profile update, reload persistence, vault member invite/role/remove, and password change');
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM'); server.kill('SIGTERM');
  await delay(200);
  try { fs.unlinkSync(dbPath); } catch {}
}
