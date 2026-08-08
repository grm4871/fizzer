#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const root = new URL('..', import.meta.url).pathname;
const previewPort = await pickPort();
const appUrl = `http://127.0.0.1:${previewPort}/app.html`;

async function waitForUrl(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`timeout: ${url}`);
}

const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], {
  cwd: root,
  env: { ...process.env, CASCADE_DISABLE_AUTO_REFRESH: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

let browser;
try {
  await waitForUrl(appUrl);
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
  const errors = [];
  const requests = [];
  let joinedPublicVault = false;
  let dmCreated = false;
  let allowDirectMessages = true;
  let blocks = [{ id: 3, username: 'bob', displayName: 'Bob Blocked', avatarUrl: '', createdAt: '2026-08-08 05:00:00' }];
  const socketReplies = [];

  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('[VersionCheck]')) {
      errors.push(`console.error: ${message.text()}`);
    }
  });

  await page.route('**/socket.io/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      const body = request.postData() || '';
      const namespace = /40(\/[^,?]+)/.exec(body)?.[1];
      if (namespace) socketReplies.push(`40${namespace},{"sid":"ui-test"}`);
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
      return;
    }
    if (!url.searchParams.has('sid')) {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '0{"sid":"ui-test","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}' });
      return;
    }
    await delay(40);
    await route.fulfill({ status: 200, contentType: 'text/plain', body: socketReplies.shift() || '6' });
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    requests.push({ method, path, body: request.postDataJSON?.() });

    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return json({ user: { id: 1, username: 'ui_tester', displayName: 'UI Tester', avatarUrl: '' }, owner: false });
    if (path === '/api/me/desktop-runner') return json({ online: true, runners: [] });
    if (path === '/api/vaults' && method === 'GET') return json({ vaults: [
      { id: 'v-home', name: 'Home', root_path: '/tmp/home', created_at: '2026-08-08 04:00:00', role: 'owner', memberCount: 1 },
      ...(joinedPublicVault ? [{ id: 'v-public', name: 'Community Lab', root_path: '/tmp/public', created_at: '2026-08-08 04:30:00', role: 'viewer', memberCount: 13 }] : []),
    ] });
    if (path === '/api/public-vaults' && method === 'GET') return json({ vaults: [
      { id: 'v-public', name: 'Community Lab', ownerUserId: 2, ownerUsername: 'alice', ownerDisplayName: 'Alice', ownerAvatarUrl: '', memberCount: 12, joinRole: 'viewer', createdAt: '2026-08-08 04:30:00', role: joinedPublicVault ? 'viewer' : null },
      { id: 'v-design', name: 'Design Commons', ownerUserId: 4, ownerUsername: 'frank', ownerDisplayName: 'Frank', ownerAvatarUrl: '', memberCount: 6, joinRole: 'editor', createdAt: '2026-08-08 04:20:00', role: null },
    ] });
    if (path === '/api/public-vaults/v-public/join' && method === 'POST') {
      joinedPublicVault = true;
      return json({ vaultId: 'v-public', name: 'Community Lab', role: 'viewer', alreadyMember: false }, 201);
    }
    if (path === '/api/me/direct-messages' && method === 'GET') return json({ conversations: [{
      user: { id: 2, username: 'alice', displayName: 'Alice Example', avatarUrl: '' },
      vaultId: 'v-home', channelId: 'dm-alice', title: 'DM — @alice', createdAt: '2026-08-08 05:00:00',
    }] });
    if (path === '/api/direct-messages' && method === 'POST') {
      dmCreated = true;
      return json({ user: { id: 5, username: 'dana', displayName: 'Dana', avatarUrl: '' }, vaultId: 'v-home', channelId: 'dm-dana', title: 'DM — @dana', createdAt: '2026-08-08 06:00:00', created: true }, 201);
    }
    if (path === '/api/me/dm-settings' && method === 'GET') return json({ allowDirectMessages });
    if (path === '/api/me/dm-settings' && method === 'PUT') {
      allowDirectMessages = Boolean(request.postDataJSON().allowDirectMessages);
      return json({ allowDirectMessages });
    }
    if (path === '/api/me/blocks' && method === 'GET') return json({ blocks });
    if (path === '/api/me/blocks' && method === 'POST') {
      const username = request.postDataJSON().username;
      const block = { id: 6, username, displayName: username === 'charlie' ? 'Charlie' : username, avatarUrl: '', createdAt: '2026-08-08 06:00:00' };
      blocks = [block, ...blocks.filter((item) => item.username !== username)];
      return json({ block }, 201);
    }
    if (path === '/api/me/blocks/bob' && method === 'DELETE') {
      blocks = blocks.filter((item) => item.username !== 'bob');
      return json({ ok: true });
    }
    if (/\/folders$/.test(path)) return json({ folders: [] });
    if (/\/notes$/.test(path) && method === 'GET') return json({ notes: dmCreated && path.includes('/v-home/') ? [{
      id: 'dm-dana', vault_id: 'v-home', folder_id: null, title: 'DM — @dana', content_preview: '<!-- cascade:chat-channel -->', is_pinned: 0, is_archived: 0, is_listed: 1, position: 0, word_count: 0, created_at: '2026-08-08 06:00:00', updated_at: '2026-08-08 06:00:00', tags: [],
    }] : [] });
    if (/\/vault-agents$/.test(path)) return json({ agents: [] });
    if (/\/messages$/.test(path)) return json({ messages: [] });
    if (/\/agents$/.test(path)) return json({ agents: [] });
    if (/\/presence$/.test(path)) return json({ participants: [], online: [], owner: '', profiles: {} });
    return json({});
  });

  await page.addInitScript(() => {
    localStorage.setItem('docs_token', 'discovery-ui-token');
    localStorage.removeItem('cascade_session_v1');
    localStorage.removeItem('cascade_chat_state_v1');
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Vault switcher; current vault Home/ }).waitFor();

  await page.getByRole('button', { name: /Vault switcher/ }).click();
  await page.getByRole('menuitem', { name: 'Browse public vaults' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect' });
  await dialog.getByText('Community Lab').waitFor();
  await dialog.getByLabel('Search public vaults').fill('design');
  await dialog.getByText('Design Commons').waitFor();
  if (await dialog.getByText('Community Lab').count()) throw new Error('public vault search did not filter rows');
  await dialog.getByLabel('Search public vaults').fill('community');
  await dialog.getByRole('button', { name: 'Join', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /current vault Community Lab/ }).waitFor();

  await page.getByRole('button', { name: /Vault switcher/ }).click();
  await page.getByRole('menuitem', { name: 'Direct messages' }).click();
  await dialog.getByText('Alice Example').waitFor();
  const privacy = dialog.getByRole('switch', { name: 'Allow messages from strangers' });
  if ((await privacy.getAttribute('aria-checked')) !== 'true') throw new Error('DM privacy did not load as enabled');
  await privacy.click();
  await dialog.getByText('New direct messages are turned off.').waitFor();
  if ((await privacy.getAttribute('aria-checked')) !== 'false') throw new Error('DM privacy toggle did not update');
  await dialog.getByRole('button', { name: 'Unblock', exact: true }).click();
  await dialog.getByText('Nobody is blocked.').waitFor();
  await dialog.getByLabel('Username to block').fill('charlie');
  await dialog.getByRole('button', { name: 'Block', exact: true }).click();
  await dialog.getByText('@charlie', { exact: true }).waitFor();
  await dialog.getByLabel('Message someone').fill('dana');
  await dialog.getByRole('button', { name: 'Start DM' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.locator('.tab-title', { hasText: 'DM — @dana' }).waitFor();

  const expectedCalls = [
    ['POST', '/api/public-vaults/v-public/join'],
    ['PUT', '/api/me/dm-settings'],
    ['DELETE', '/api/me/blocks/bob'],
    ['POST', '/api/me/blocks'],
    ['POST', '/api/direct-messages'],
  ];
  for (const [method, path] of expectedCalls) {
    if (!requests.some((request) => request.method === method && request.path === path)) throw new Error(`missing ${method} ${path}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('[discovery-dms-ui] OK — switcher entries, public browse/search/join, DM open, privacy, block/unblock, and conversation navigation');
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM');
  await delay(150);
}
