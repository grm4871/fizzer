#!/usr/bin/env node
/**
 * Exercise the touch-only reply gesture in the built client. This deliberately
 * uses Chromium's native touch input rather than mouse events: the handler
 * ignores mouse pointers and must coexist with the scroll container's pan-y
 * touch action.
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
const DB_PATH = `/tmp/cascade-chatswipe-ui-${API_PORT}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return;
    } catch { /* retry */ }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function must(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${url}: ${data.error || 'request failed'}`);
  return data;
}

function startServer() {
  const child = spawn('node', ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      DOCS_DB_PATH: DB_PATH,
      JWT_SECRET: 'chatswipe-ui-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

async function dispatchSwipe(client, point, dx, dy) {
  const touch = (x, y) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(point.x, point.y)] });
  await delay(25);
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(point.x + dx * 0.45, point.y + dy * 0.45)] });
  await delay(25);
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(point.x + dx, point.y + dy)] });
  await delay(25);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const server = startServer();
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(API_PORT), VITE_API_URL: API_BASE },
});
preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);

  const stamp = Date.now();
  const username = `swipe_ui_${stamp}`;
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, { method: 'POST', headers: auth });
  const { vault } = await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: `Swipe QA ${stamp}` }),
  });
  const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'touch-reply', content: 'cascade://chat-channel' }),
  });

  const targetId = `swipe-target-${stamp}`;
  for (let index = 0; index < 12; index += 1) {
    const id = index === 11 ? targetId : `swipe-history-${stamp}-${index}`;
    await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({
        id,
        channelId: channel.id,
        author: 'Sol',
        body: index === 11 ? 'swipe reply target' : `history row ${index}\n\nextra height`,
        createdAt: new Date(Date.now() + index).toISOString(),
      }),
    });
  }

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('docs_token', value), token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  console.log('[verify-chat-swipe-reply-ui] app loaded');
  // The mobile drawer intentionally starts closed; open it through the same
  // affordance a touch user uses before selecting the test channel.
  const expandSidebar = page.locator('#sidebar-expand-btn');
  await expandSidebar.waitFor({ timeout: 5000 });
  await expandSidebar.click();
  console.log('[verify-chat-swipe-reply-ui] sidebar opened');
  const channelEntry = page.locator(`#note-${channel.id}`);
  await channelEntry.waitFor({ timeout: 10000 });
  await channelEntry.click();
  await page.locator('.chat-header h2', { hasText: 'touch-reply' }).waitFor({ timeout: 20000 });
  console.log('[verify-chat-swipe-reply-ui] channel opened');

  const row = page.locator(`[data-message-id="${targetId}"]`);
  await row.waitFor({ timeout: 20000 });
  const computedTouchAction = await row.evaluate((element) => getComputedStyle(element).touchAction);
  if (computedTouchAction !== 'pan-y') throw new Error(`reply row lost pan-y touch action: ${computedTouchAction}`);
  const client = await context.newCDPSession(page);

  // A vertical pan must remain a scroll gesture and never arm a reply.
  const scroller = page.locator('.chat-messages');
  const beforeScroll = await scroller.evaluate((element) => element.scrollTop);
  const verticalBox = await row.boundingBox();
  if (!verticalBox) throw new Error('target message has no box');
  await dispatchSwipe(client, { x: verticalBox.x + 120, y: verticalBox.y + verticalBox.height / 2 }, 3, 96);
  await page.waitForTimeout(150);
  const afterScroll = await scroller.evaluate((element) => element.scrollTop);
  if (afterScroll >= beforeScroll) throw new Error('vertical touch did not retain chat scroll');
  if (await page.locator('.chat-reply-bar').count()) throw new Error('vertical touch incorrectly started a reply');
  console.log('[verify-chat-swipe-reply-ui] vertical pan retained scroll');

  await row.scrollIntoViewIfNeeded();
  const swipeBox = await row.boundingBox();
  if (!swipeBox) throw new Error('target message disappeared before swipe');
  await dispatchSwipe(client, { x: swipeBox.x + Math.min(230, swipeBox.width - 20), y: swipeBox.y + swipeBox.height / 2 }, -82, 3);
  const replyBar = page.locator('.chat-reply-bar');
  await replyBar.waitFor({ timeout: 5000 });
  if (!await replyBar.getByText('@sol', { exact: false }).count()) {
    throw new Error('swipe reply did not quote the touched message author');
  }

  await browser.close();
  browser = undefined;
  const fatal = errors.filter((line) => !line.includes('[VersionCheck]'));
  if (fatal.length) throw new Error(`Runtime errors:\n${fatal.join('\n')}`);
  console.log('[verify-chat-swipe-reply-ui] OK — vertical touch scrolled and left swipe opened reply');
} catch (error) {
  console.error('[verify-chat-swipe-reply-ui] FAILED:', error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
}
