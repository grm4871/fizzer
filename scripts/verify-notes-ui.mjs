#!/usr/bin/env node
/**
 * Release check — notes, in-chat embeds, and persisted pane recovery.
 *
 * Proves the built renderer can show an embed card, open the target note, and
 * safely recover a legacy/corrupted layout that names the same note in two
 * panes. This is intentionally browser-level: the failure modes live at the
 * lazy NoteEditor / workspace boundary, not in the markdown parser alone.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';
import { spawnElixirApi } from './lib/elixir-api.mjs';

const apiPort = await pickPort();
const previewPort = await pickPort();
const root = new URL('..', import.meta.url).pathname;
const apiBase = `http://127.0.0.1:${apiPort}`;
const appUrl = `http://127.0.0.1:${previewPort}/app.html`;
const dbPath = `/tmp/cascade-notes-ui-${apiPort}.db`;

async function wait(url) {
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(150);
  }
  throw new Error(`timeout: ${url}`);
}
async function json(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${path}: ${data.error || 'failed'}`);
  return data;
}

try { fs.unlinkSync(dbPath); } catch {}
const server = spawnElixirApi(root, {
    port: apiPort,
    dbPath: dbPath,
    extraEnv: {
      JWT_SECRET: 'notes-ui-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], {
  cwd: root, env: { ...process.env, API_PORT: String(apiPort), VITE_API_URL: apiBase }, stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
preview.stderr.on('data', (c) => process.stderr.write(`[preview] ${c}`));

let browser;
try {
  await wait(`${apiBase}/api/health`);
  await wait(appUrl);
  const { token } = await json('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username: `notes_ui_${Date.now()}`, password: 'testpass12345' }),
  });
  const auth = { authorization: `Bearer ${token}` };
  const { vault } = await json('/api/vaults', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Notes UI' }) });
  for (const path of [
    `/api/vaults/${vault.id}/feed`,
    `/api/vaults/${vault.id}/feed/poll`,
    `/api/vaults/${vault.id}/widget-data/system-stats`,
  ]) {
    const response = await fetch(`${apiBase}${path}`, {
      method: path.endsWith('system-stats') ? 'GET' : 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: path.endsWith('system-stats') ? undefined : JSON.stringify({ url: 'https://example.com/feed.xml' }),
    });
    if (response.status !== 404) throw new Error(`${path} remains available (${response.status})`);
  }
  const { note: plan } = await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({
      title: 'Release plan',
      content: '# Release plan\nShip safely.\n\n```cascade-widget\n<button>Legacy widget</button>\n```',
    }),
  });
  const { note: channel } = await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'embed-channel', content: 'cascade://chat-channel' }),
  });
  await json(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify({ id: `embed-${Date.now()}`, body: 'Read ![[Release plan|the launch plan]].' }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`); });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`response ${response.status()}: ${response.url()}`);
  });
  const initialSession = { activeVaultId: vault.id, openTabs: [], layout: { type: 'pane', id: 'root', tabIds: [], activeTabId: null }, focusedPaneId: 'root' };
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ token: value, session }) => {
    localStorage.setItem('docs_token', value);
    localStorage.setItem('cascade_session', JSON.stringify(session));
  }, { token, session: initialSession });
  await page.reload({ waitUntil: 'networkidle' });

  const visibleSidebarActions = page.locator('.sidebar-actions:visible');
  if (await visibleSidebarActions.count() !== 1) throw new Error('sidebar rendered duplicate visible action rows');

  await page.locator('#new-note-btn-desktop').click();
  const createdNote = await page.waitForFunction(async ({ apiBase: base, token: authToken, vaultId }) => {
    const response = await fetch(`${base}/api/vaults/${vaultId}/notes?title=Untitled%20Note`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.notes?.find((note) => note.title.startsWith('Untitled Note')) || false;
  }, { apiBase, token, vaultId: vault.id });
  if (!createdNote) throw new Error('new-note action did not persist a note immediately');

  const savedTitle = `Blank saved note ${Date.now()}`;
  await page.locator('#editor-title').fill(savedTitle);
  await page.locator('#editor-title').press('Enter');
  await page.keyboard.press('Control+Shift+s');
  await page.waitForFunction(async ({ apiBase: base, token: authToken, vaultId, title }) => {
    const response = await fetch(`${base}/api/vaults/${vaultId}/notes?title=${encodeURIComponent(title)}`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload.notes?.some((note) => note.title === title);
  }, { apiBase, token, vaultId: vault.id, title: savedTitle });
  await page.keyboard.press('Control+s');
  const searchDialog = page.getByRole('dialog', { name: 'Search workspace' });
  await searchDialog.waitFor();
  if (!(await page.locator('#search-input').evaluate((input) => input === document.activeElement))) {
    throw new Error('Ctrl+S opened search without focusing its query input');
  }
  await page.keyboard.press('Escape');

  await page.getByText('embed-channel', { exact: false }).first().click();
  const embed = page.locator('.chat-doc-embed');
  await embed.waitFor({ timeout: 15000 });
  if (!(await embed.innerText()).includes('Release plan')) throw new Error('embed card did not resolve its note');
  await embed.click();
  await page.locator('.cm-editor').waitFor({ timeout: 15000 });
  if (await page.locator('#toolbar-widget').count()) throw new Error('sandboxed widget toolbar action is still available');
  if (await page.locator('.cm-cascade-widget').count()) throw new Error('legacy sandboxed widget still rendered');
  if (await page.locator('.cm-editor iframe[sandbox][srcdoc]').count()) throw new Error('legacy sandboxed widget iframe still mounted');

  // Simulate the old broken state exactly: one note id in two persisted panes.
  const corruptSession = {
    activeVaultId: vault.id,
    openTabs: [{ id: plan.id, title: plan.title, type: 'note', dirty: false }],
    layout: {
      type: 'split', id: 'corrupt-split', direction: 'row', sizes: [0.5, 0.5], children: [
        { type: 'pane', id: 'left', tabIds: [plan.id], activeTabId: plan.id },
        { type: 'pane', id: 'right', tabIds: [plan.id], activeTabId: plan.id },
      ],
    },
    focusedPaneId: 'right',
  };
  await page.evaluate((session) => localStorage.setItem('cascade_session', JSON.stringify(session)), corruptSession);
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.cm-editor').waitFor({ timeout: 15000 });
  if (await page.locator('.cm-editor').count() !== 1) throw new Error('corrupted layout mounted the note editor more than once');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('[notes-ui] OK — notes flows pass; feed APIs and sandboxed widgets are absent');
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
  await delay(200);
  try { fs.unlinkSync(dbPath); } catch {}
}
