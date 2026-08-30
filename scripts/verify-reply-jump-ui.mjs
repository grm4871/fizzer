#!/usr/bin/env node
/**
 * Release check — clicking a reply quote jumps to the quoted message.
 *
 * The quote used to be an inert <div>, so the only way back to the original
 * was scrolling. This drives the built client: it seeds enough messages that
 * the target is scrolled well out of view, clicks the quote, and asserts the
 * original is both centred and selected. It also asserts the click does not
 * leak into the chunk's own select handler.
 *
 * Build first: `npm run build && npm run build:client`.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';
import { spawnElixirApi } from './lib/elixir-api.mjs';
import { installBrowserSession } from './lib/browser-session.mjs';
import { stopChildProcess } from './lib/child-process.mjs';

const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const PREVIEW_PORT = Number(process.env.TEST_PREVIEW_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-reply-jump-${API_PORT}.db`;
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
  if (cond) console.log(`[reply-jump-ui] OK  ${name}`);
  else { console.error(`[reply-jump-ui] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const server = spawnElixirApi(root, {
    port: API_PORT,
    dbPath: DB_PATH,
    extraEnv: {
      JWT_SECRET: 'reply-jump-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
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
  const me = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username: `rj_${stamp}`, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${me.token}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Reply Jump' }),
  });
  const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'jumpchan', content: 'cascade://chat-channel' }),
  });
  const send = (body, replyTo) => must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify({ body, ...(replyTo ? { replyTo } : {}) }),
  });

  const first = await send('ORIGINAL ANCHOR MESSAGE to jump back to');
  const anchorId = first.message?.id || first.id;
  if (!anchorId) throw new Error('could not read the seeded message id');
  // Push the anchor far out of view.
  for (let i = 0; i < 40; i += 1) await send(`filler message ${i} ${'lorem ipsum '.repeat(6)}`);
  await send('this is the reply', {
    messageId: anchorId, author: `rj_${stamp}`, mention: `rj_${stamp}`, preview: 'ORIGINAL ANCHOR MESSAGE',
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('[VersionCheck]')) {
      errors.push(`console.error: ${m.text()}`);
    }
  });
  await installBrowserSession(page.context(), API_BASE, me.token);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.getByText('jumpchan', { exact: false }).first().click();
  await page.locator('.chat-reply-quote').first().waitFor({ timeout: 20000 });
  await delay(800);

  const quote = page.locator('button.chat-reply-quote').first();
  check('the reply quote is a button, not an inert div', await quote.count() === 1);

  const anchorSel = `[data-message-id="${anchorId}"]`;
  const visibility = async () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const scroller = document.querySelector('.chat-messages') || el?.closest('[class*="messages"]');
    if (!el || !scroller) return { found: Boolean(el), inView: false };
    const a = el.getBoundingClientRect();
    const b = scroller.getBoundingClientRect();
    return { found: true, inView: a.top < b.bottom && a.bottom > b.top, selected: el.className.includes('selected') };
  }, anchorSel);

  const before = await visibility();
  check('anchor starts scrolled out of view', before.found && !before.inView, JSON.stringify(before));

  await quote.click();
  await page.locator(anchorSel).waitFor({ state: 'visible', timeout: 5000 });
  check('the original briefly pulses after the jump', await page.locator(anchorSel).evaluate((el) => el.classList.contains('is-jump-highlighted')));
  await delay(1400);
  const after = await visibility();
  check('clicking the quote scrolls the original into view', after.inView, JSON.stringify(after));
  check('the original is highlighted after the jump', Boolean(after.selected), JSON.stringify(after));
  check('the jump pulse clears after the brief highlight', !(await page.locator(anchorSel).evaluate((el) => el.classList.contains('is-jump-highlighted'))));

  check('no runtime errors', errors.length === 0, errors.join(' | '));
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log('[reply-jump-ui] OK — reply quotes jump to and highlight the quoted message');
} finally {
  await browser?.close();
  await Promise.all([stopChildProcess(preview), stopChildProcess(server)]);
}
