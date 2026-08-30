#!/usr/bin/env node
/** Browser-level Updates smoke: badges, modal, canonical read, and deep links. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';
import { spawnElixirApi } from './lib/elixir-api.mjs';
import { installBrowserSession } from './lib/browser-session.mjs';
import { stopChildProcess } from './lib/child-process.mjs';

const apiPort = await pickPort();
const root = new URL('..', import.meta.url).pathname;
const apiBase = `http://127.0.0.1:${apiPort}`;
const appUrl = `${apiBase}/app.html`;
const dbPath = `/tmp/cascade-updates-ui-${apiPort}.db`;
const vaultRoot = `/tmp/cascade-updates-ui-vaults-${apiPort}`;

async function wait(url) {
  for (let i = 0; i < 160; i += 1) {
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

for (const target of [dbPath, vaultRoot]) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}

const server = spawnElixirApi(root, {
    port: apiPort,
    dbPath: dbPath,
    extraEnv: {
      JWT_SECRET: 'updates-ui-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

let browser;
try {
  await wait(`${apiBase}/api/health`);
  await wait(appUrl);
  const suffix = Date.now();
  const alice = await json('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username: `updates_alice_${suffix}`, password: 'testpass12345' }),
  });
  const bob = await json('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ username: `updates_bob_${suffix}`, password: 'testpass12345' }),
  });
  const aliceAuth = { authorization: `Bearer ${alice.token}` };
  const bobAuth = { authorization: `Bearer ${bob.token}` };
  const { vault } = await json('/api/vaults', {
    method: 'POST', headers: aliceAuth, body: JSON.stringify({ name: 'Updates team' }),
  });
  const { note: neutralNote } = await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: aliceAuth,
    body: JSON.stringify({ title: 'Start here', content: '# Start here' }),
  });
  await json(`/api/vaults/${vault.id}/members`, {
    method: 'POST', headers: aliceAuth,
    body: JSON.stringify({ username: bob.user.username, role: 'editor' }),
  });
  await delay(1100);
  const { note } = await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: aliceAuth,
    body: JSON.stringify({ title: 'Release roadmap', content: '# Release roadmap\nShip the loop.' }),
  });
  const { note: channel } = await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: aliceAuth,
    body: JSON.stringify({ title: 'team-updates', content: 'cascade://chat-channel' }),
  });
  const messageId = `updates-message-${suffix}`;
  await json(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: aliceAuth,
    body: JSON.stringify({ id: messageId, body: `Ready for @${bob.user.username}.` }),
  });

  const seeded = await json('/api/community/updates', { headers: bobAuth });
  if (seeded.counts.total !== 2) throw new Error(`expected 2 seeded updates, got ${seeded.counts.total}`);

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`console.error: ${message.text()}`); });
  await installBrowserSession(page.context(), apiBase, bob.token);
  await page.addInitScript(({ vaultId, noteId, noteTitle }) => {
    localStorage.setItem('cascade_session', JSON.stringify({
      activeVaultId: vaultId,
      openTabs: [{ id: noteId, title: noteTitle, type: 'note', dirty: false }],
      layout: { type: 'pane', id: 'root', tabIds: [noteId], activeTabId: noteId },
      focusedPaneId: 'root',
    }));
  }, { vaultId: vault.id, noteId: neutralNote.id, noteTitle: neutralNote.title });
  await page.goto(appUrl, { waitUntil: 'networkidle' });

  const updatesButton = page.locator('#community-updates-btn');
  await updatesButton.waitFor({ timeout: 15000 });
  await page.locator('.workspace-updates-badge').waitFor({ timeout: 15000 });
  if ((await page.locator('.workspace-updates-badge').innerText()).trim() !== '2') {
    throw new Error('workspace unread badge did not show 2');
  }
  if (await page.locator('.tree-item > .activity-dot.is-human').count() !== 2) {
    throw new Error('note/channel unread badges were not both rendered');
  }

  const socketMessageId = `updates-socket-message-${suffix}`;
  await json(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: aliceAuth,
    body: JSON.stringify({ id: socketMessageId, body: 'Socket refresh check.' }),
  });
  await page.waitForFunction(() => document.querySelector('.workspace-updates-badge')?.textContent?.trim() === '3');

  await updatesButton.click();
  await page.locator('.updates-modal').waitFor();
  await page.locator('.updates-item', { hasText: 'team-updates' }).first().click();
  await page.locator(`[data-message-id="${socketMessageId}"]`).waitFor({ timeout: 15000 });
  await page.locator('.workspace-updates-badge').waitFor({ timeout: 15000 });
  if ((await page.locator('.workspace-updates-badge').innerText()).trim() !== '1') {
    throw new Error('opening the channel did not clear its canonical unread watermark');
  }

  await updatesButton.click();
  await page.locator('.updates-item', { hasText: note.title }).click();
  await page.locator('.tab-item.active', { hasText: note.title }).waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !document.querySelector('.workspace-updates-badge'));
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('[updates-ui] OK — socket refresh, badges, modal, channel message jump, note deep link, and mark-read');
} finally {
  await browser?.close();
  await stopChildProcess(server);
  for (const target of [dbPath, vaultRoot]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
}
