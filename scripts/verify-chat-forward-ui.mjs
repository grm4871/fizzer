#!/usr/bin/env node
/**
 * Drives the built client in headless Chromium to confirm the chat forward
 * affordance works end to end: right-click a message → Forward → pick a channel
 * → the copy shows up in that channel with its "Forwarded from" banner and
 * survives a reload.
 *
 * Build first: `npm run build && npm run build:client`.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

// Ports come from the OS by default: a leftover dev server on a hardcoded
// port used to surface as an unexplained startup timeout.
const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const PREVIEW_PORT = Number(process.env.TEST_PREVIEW_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-chatforward-ui-${API_PORT}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return;
    } catch { /* retry */ }
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

const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    DOCS_DB_PATH: DB_PATH,
    JWT_SECRET: 'chatforward-ui-secret',
    CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (c) => process.stderr.write(`[server-err] ${c}`));

const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(API_PORT) },
});
preview.stderr.on('data', (c) => process.stderr.write(`[preview] ${c}`));

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);

  const stamp = Date.now();
  const username = `uitest_${stamp}`;
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `QA Vault ${stamp}` }) });
  const channels = {};
  for (const title of ['qa-source', 'qa-target']) {
    const { note } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
      method: 'POST', headers: auth, body: JSON.stringify({ title, content: 'cascade://chat-channel' }),
    });
    channels[title] = note;
  }

  await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channels['qa-source'].id}/messages`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      id: `msg-${stamp}-fwd`,
      channelId: channels['qa-source'].id,
      author: 'Claude',
      body: 'forward this one',
      createdAt: new Date().toISOString(),
    }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('docs_token', t), token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });

  async function openChannel(title) {
    const entry = page.getByText(title, { exact: false }).first();
    await entry.waitFor({ timeout: 20000 });
    await entry.click();
    await page.getByText(`#${title}`, { exact: false }).first().waitFor({ timeout: 20000 });
  }

  await openChannel('qa-source');
  const target = page.getByText('forward this one', { exact: false }).first();
  await target.waitFor({ timeout: 20000 });

  await target.click({ button: 'right' });
  const forwardItem = page.locator('.chat-context-menu button', { hasText: 'Forward' });
  await forwardItem.waitFor({ timeout: 5000 });
  await forwardItem.click();

  const picker = page.locator('.chat-forward-panel');
  await picker.waitFor({ timeout: 5000 });
  if (await picker.locator('.chat-forward-target', { hasText: 'qa-source' }).count()) {
    throw new Error('the picker offered the channel we are already in');
  }
  await picker.locator('.chat-forward-target', { hasText: 'qa-target' }).click();
  await picker.waitFor({ state: 'detached', timeout: 10000 });

  await openChannel('qa-target');
  await page.getByText('forward this one', { exact: false }).first().waitFor({ timeout: 20000 });
  await page.locator('.chat-forward-quote', { hasText: 'qa-source' }).first().waitFor({ timeout: 10000 });

  // Server-side: the copy is really persisted, not just a local echo.
  await page.reload({ waitUntil: 'networkidle' });
  await openChannel('qa-target');
  await page.getByText('forward this one', { exact: false }).first().waitFor({ timeout: 20000 });
  const banner = page.locator('.chat-forward-quote', { hasText: 'qa-source' }).first();
  await banner.waitFor({ timeout: 10000 });
  // innerText applies the banner's text-transform, so compare case-insensitively.
  if (!(await banner.innerText()).toLowerCase().includes('claude')) {
    throw new Error('forwarded banner lost the original author');
  }

  const fatal = errors.filter((line) => !line.includes('[VersionCheck]'));
  if (fatal.length > 0) {
    console.error('[verify-chat-forward-ui] Runtime errors:');
    for (const line of fatal) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log('[verify-chat-forward-ui] OK — right-click forward copied the message and it stayed forwarded');
} catch (error) {
  console.error('[verify-chat-forward-ui] FAILED:', error.message || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
  await delay(300);
}
