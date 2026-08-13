#!/usr/bin/env node
/**
 * Drives the built client in headless Chromium to confirm the chat message
 * delete affordance actually works end to end: right-click a message → confirm
 * → the row disappears and stays gone after a reload.
 *
 * Build first: `npm run build && npm run build:client`.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';
import { spawnElixirApi } from './lib/elixir-api.mjs';

// Ports come from the OS by default: a leftover dev server on a hardcoded
// port used to surface as an unexplained startup timeout.
const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const PREVIEW_PORT = Number(process.env.TEST_PREVIEW_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-chatdelete-ui-${API_PORT}.db`;
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

const server = spawnElixirApi(root, {
    port: API_PORT,
    dbPath: DB_PATH,
    extraEnv: {
      JWT_SECRET: 'chatdelete-ui-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });
server.stderr.on('data', (c) => process.stderr.write(`[server-err] ${c}`));

const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  // The built client uses relative /api paths; vite preview inherits
  // server.proxy, which targets API_PORT.
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
  // Unique vault name per run: vaults are backed by a directory keyed on user id
  // + name, and a fresh test db restarts user ids at 1 — a reused name makes the
  // new vault rescan the *previous* run's leftover .md files.
  const { vault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `QA Vault ${stamp}` }) });
  const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'qa-delete', content: 'cascade://chat-channel' }),
  });

  const keepId = `msg-${stamp}-keep`;
  const dropId = `msg-${stamp}-drop`;
  for (const [id, body, author] of [[keepId, 'keep this one', username], [dropId, 'delete this one', 'Claude']]) {
    await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({ id, channelId: channel.id, author, body, createdAt: new Date().toISOString() }),
    });
  }

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });
  const messageFetches = [];
  page.on('response', async (res) => {
    if (!res.url().includes('/messages')) return;
    messageFetches.push({ url: res.url(), status: res.status(), body: (await res.text().catch(() => '')).slice(0, 300) });
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('docs_token', t), token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });

  async function openChannel() {
    const entry = page.getByText('qa-delete', { exact: false }).first();
    await entry.waitFor({ timeout: 20000 });
    await entry.click();
    await page.getByText('#qa-delete', { exact: false }).first().waitFor({ timeout: 20000 });
  }
  await openChannel();
  const target = page.getByText('delete this one', { exact: false }).first();
  try {
    await target.waitFor({ timeout: 20000 });
  } catch (e) {
    await page.screenshot({ path: '/tmp/chat-delete-ui.png', fullPage: true });
    console.error('[debug] seeded vault/channel:', vault.id, channel.id);
    const all = await must(`${API_BASE}/api/vaults`, { headers: auth });
    for (const v of all.vaults) {
      const { notes } = await must(`${API_BASE}/api/vaults/${v.id}/notes`, { headers: auth });
      console.error(`[debug] vault ${v.id} (${v.name}):`, notes.map((n) => `${n.title}=${n.id}`).join(', '));
    }
    console.error('[debug] body text:', (await page.innerText('body')).slice(0, 800));
    console.error('[debug] message fetches:', JSON.stringify(messageFetches, null, 2).slice(0, 1500));
    throw e;
  }

  await target.click({ button: 'right' });
  const menuItem = page.locator('.chat-context-menu button.is-danger');
  await menuItem.waitFor({ timeout: 5000 });
  await menuItem.click();                       // arm
  await page.locator('.chat-context-menu button.is-armed').click();  // confirm

  await page.waitForFunction(
    () => !document.body.innerText.includes('delete this one'),
    undefined,
    { timeout: 10000 },
  );
  if (!(await page.getByText('keep this one', { exact: false }).count())) {
    throw new Error('the other message disappeared too');
  }

  // Server-side: it is really gone after a reload, not just hidden locally.
  await page.reload({ waitUntil: 'networkidle' });
  await openChannel();
  await page.getByText('keep this one', { exact: false }).first().waitFor({ timeout: 20000 });
  if ((await page.getByText('delete this one', { exact: false }).count()) > 0) {
    throw new Error('deleted message came back after reload');
  }

  const fatal = errors.filter((line) => !line.includes('[VersionCheck]'));
  if (fatal.length > 0) {
    console.error('[verify-chat-delete-ui] Runtime errors:');
    for (const line of fatal) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log('[verify-chat-delete-ui] OK — right-click delete removed the message and it stayed deleted');
} catch (error) {
  console.error('[verify-chat-delete-ui] FAILED:', error.message || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
  await delay(300);
}
