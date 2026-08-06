#!/usr/bin/env node
/**
 * Mobile navigation regression check. Exercises real Chromium touch input so
 * the transparent drawer edge, safe-area toolbar button, and message swipe
 * recognizer share the same pointer path they use in the Android WebView.
 *
 * Build first: `npm run build && npm run build:client`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const apiPort = await pickPort();
const previewPort = await pickPort();
const apiBase = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${previewPort}/app.html`;
const dbPath = `/tmp/cascade-mobile-navigation-${apiPort}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitFor(url, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await delay(150);
  }
  throw new Error(`timeout: ${url}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${path}: ${body.error || 'request failed'}`);
  return body;
}

async function touchSwipe(cdp, from, to, steps = 6) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (to.x - from.x) * ratio, y: from.y + (to.y - from.y) * ratio, id: 1 }],
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

try { fs.unlinkSync(dbPath); } catch { /* fresh temporary database */ }
const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: { ...process.env, API_PORT: String(apiPort), API_HOST: '127.0.0.1', DOCS_DB_PATH: dbPath, JWT_SECRET: 'mobile-navigation-secret', CASCADE_ALLOW_OPEN_REGISTRATION: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], {
  cwd: root,
  // The production bundle intentionally uses same-origin API paths. Vite's
  // preview proxy needs this runtime port to route those paths to our isolated
  // temporary backend.
  env: { ...process.env, API_PORT: String(apiPort), VITE_API_URL: apiBase },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

let browser;
try {
  await waitFor(`${apiBase}/api/health`);
  await waitFor(appUrl);
  const stamp = Date.now();
  const { token } = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: `mobile_nav_${stamp}`, password: 'testpass12345' }) });
  const auth = { authorization: `Bearer ${token}` };
  const { vault } = await request('/api/vaults', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Mobile navigation' }) });
  const { note: channel } = await request(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'touch-target', content: 'cascade://chat-channel' }),
  });
  await request(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ id: `mobile-touch-${stamp}`, body: 'Swipe this message left to reply.' }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`); });

  const session = { activeVaultId: vault.id, openTabs: [], layout: { type: 'pane', id: 'root', tabIds: [], activeTabId: null }, focusedPaneId: 'root' };
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token: value, savedSession }) => {
    localStorage.setItem('docs_token', value);
    localStorage.setItem('cascade_session', JSON.stringify(savedSession));
  }, { token, savedSession: session });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator(`#note-${channel.id}`).click();
  await page.locator('.chat-header h2', { hasText: 'touch-target' }).waitFor({ timeout: 15000 });

  const expand = page.locator('#sidebar-expand-btn');
  const box = await expand.boundingBox();
  if (!box || box.width < 48 || box.height < 48) throw new Error('sidebar expand button is smaller than the 48px mobile target');
  const centerIsButton = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#sidebar-expand-btn') !== null, {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  if (!centerIsButton) throw new Error('sidebar expand button center is covered by another layer');
  await expand.click();
  await page.locator('.sidebar').waitFor({ state: 'visible' });
  await page.locator('.sidebar-backdrop').click({ position: { x: 370, y: 700 } });
  await expand.waitFor({ state: 'visible' });

  const cdp = await context.newCDPSession(page);
  await touchSwipe(cdp, { x: 20, y: 180 }, { x: 112, y: 180 });
  await page.locator('.sidebar').waitFor({ state: 'visible' });
  await page.locator('.sidebar-backdrop').click({ position: { x: 370, y: 700 } });

  const message = page.locator('.chat-swipe-row', { hasText: 'Swipe this message left to reply.' });
  const messageBox = await message.boundingBox();
  if (!messageBox) throw new Error('chat message did not render for swipe conflict coverage');
  await touchSwipe(cdp, { x: messageBox.x + messageBox.width - 18, y: messageBox.y + messageBox.height / 2 }, { x: messageBox.x + messageBox.width - 98, y: messageBox.y + messageBox.height / 2 });
  await page.locator('.chat-reply-bar').waitFor({ timeout: 5000 });

  const fatal = errors.filter((line) => !line.includes('[VersionCheck]'));
  if (fatal.length) throw new Error(fatal.join('\n'));
  console.log('[mobile-navigation-ui] OK — accessible drawer button, edge swipe, and chat reply swipe');
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
  await delay(150);
  try { fs.unlinkSync(dbPath); } catch { /* temporary database already gone */ }
}
