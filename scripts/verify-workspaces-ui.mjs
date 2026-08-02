#!/usr/bin/env node
/**
 * Release check — "Task workspaces and pull requests" (chat channel settings).
 *
 * Drives the built client in headless Chromium with a stubbed desktop bridge
 * (`window.electronAPI.*Worktree*`), because the real one lives in the Electron
 * main process and is covered by cascade-electron/worktrees.test.cjs against
 * real git repos. What this catches is the renderer half: the panel hidden when
 * there is no bridge, the settings panel being reachable at all, "Use" actually
 * persisting the channel cwd, creation wiring, and the PR button's gating.
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
const DB_PATH = `/tmp/cascade-workspaces-${API_PORT}.db`;
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
  if (cond) console.log(`[workspaces-ui] OK  ${name}`);
  else { console.error(`[workspaces-ui] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    DOCS_DB_PATH: DB_PATH,
    JWT_SECRET: 'workspaces-secret',
    CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (c) => process.stderr.write(`[server-err] ${c}`));

const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, API_PORT: String(API_PORT) },
});
preview.stderr.on('data', (c) => process.stderr.write(`[preview] ${c}`));

// Stub of cascade-electron/worktrees.cjs, shaped exactly like the IPC results.
const BRIDGE = `
window.__worktreeCalls = [];
const record = (name, args) => window.__worktreeCalls.push({ name, args });
const workspaces = [
  { path: '/repo', branch: 'master', isPrimary: true, managed: false, channelId: null, baseBranch: null, createdAt: null, exists: true },
  { path: '/ws/native-prs', branch: 'cascade/native-prs', isPrimary: false, managed: true, channelId: 'c1', baseBranch: 'master', createdAt: '2026-08-02T00:00:00Z', exists: true },
];
const status = (dir) => ({
  ok: true, path: dir, repo: 'cascade', branch: dir === '/repo' ? 'master' : 'cascade/native-prs',
  head: 'abc1234', isPrimary: dir === '/repo', baseBranch: 'master', dirty: false, changedFiles: [],
  commits: dir === '/repo' ? [] : [{ sha: 'def5678', subject: 'add native PRs' }],
  unpushed: dir === '/repo' ? 0 : 1, behindBase: 0, hasUpstream: false,
});
window.electronAPI = {
  listWorktrees: async (dir) => { record('list', dir); return { ok: true, repo: 'cascade', primaryRoot: '/repo', workspaces }; },
  getWorktreeStatus: async (dir) => { record('status', dir); return status(dir); },
  createWorktree: async (opts) => { record('create', opts); return { ok: true, path: '/ws/' + opts.slug, branch: 'cascade/' + opts.slug }; },
  removeWorktree: async (opts) => { record('remove', opts); return { ok: false, error: '1 commit(s) exist only here', needsForce: true }; },
  createWorktreePullRequest: async (opts) => { record('pr', opts); return { ok: true, url: 'https://github.com/x/y/pull/7', branch: 'cascade/native-prs', base: 'master', draft: opts.draft }; },
  getWorktreePullRequest: async (dir) => { record('prStatus', dir); return { ok: true, pr: null }; },
};
`;

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);

  const stamp = Date.now();
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username: `ws_${stamp}`, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `WS ${stamp}` }) });
  const { note } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'ws-chan', content: 'cascade://chat-channel' }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });

  // ── Browser tab (no desktop bridge): the panel must not appear at all.
  const plain = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await plain.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await plain.evaluate((t) => localStorage.setItem('docs_token', t), token);
  await plain.goto(APP_URL, { waitUntil: 'networkidle' });
  await plain.getByText('ws-chan', { exact: false }).first().click();
  await plain.getByRole('button', { name: 'Agent settings' }).first().click();
  await plain.locator('.chat-channel-settings-panel').waitFor({ timeout: 15000 });
  check('settings panel is reachable from the chat sidebar', await plain.locator('.chat-channel-settings-panel').isVisible());
  check('no workspace panel without a desktop bridge', await plain.locator('.chat-workspaces').count() === 0);
  await plain.close();

  // ── Desktop shell (bridge present).
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.addInitScript(BRIDGE);
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('docs_token', t), token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.getByText('ws-chan', { exact: false }).first().click();
  await page.getByRole('button', { name: 'Agent settings' }).first().click();

  const panel = page.locator('.chat-workspaces');
  await panel.waitFor({ timeout: 15000 });
  check('workspace panel renders on desktop', await panel.isVisible());
  check('prompts for a working directory when the channel has none',
    (await panel.innerText()).includes('Set a working directory'));

  // Point the channel at a repo — the panel should list workspaces for it.
  const cwdInput = page.locator('.chat-channel-cwd input');
  await cwdInput.fill('/repo');
  await cwdInput.press('Enter');
  await page.locator('.chat-workspaces-list li').first().waitFor({ timeout: 15000 });
  const rows = await page.locator('.chat-workspaces-list li').allInnerTexts();
  check('lists the primary checkout and the managed workspace', rows.length === 2 && rows.join(' ').includes('cascade/native-prs'), JSON.stringify(rows));
  check('marks the active workspace', await page.locator('.chat-workspaces-list li.is-active').count() === 1);
  check('primary checkout offers no delete', await page.locator('.chat-workspaces-list li').first().locator('.chat-workspace-remove').count() === 0);

  // ── "Use" repoints the channel cwd, and that must persist server-side.
  await page.locator('.chat-workspaces-list li', { hasText: 'cascade/native-prs' }).getByRole('button', { name: 'Use' }).click();
  await page.waitForFunction(() => document.querySelector('.chat-channel-cwd input')?.value === '/ws/native-prs', null, { timeout: 10000 });
  const settings = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${note.id}/settings`, { headers: auth });
  check('using a workspace persists the channel working directory', settings.settings?.cwd === '/ws/native-prs', JSON.stringify(settings.settings));

  // ── PR gating: available in a workspace with commits, refused on primary.
  const prButton = page.getByRole('button', { name: 'Open pull request' });
  await prButton.waitFor({ timeout: 10000 });
  check('pull request button is enabled for a workspace with commits', await prButton.isEnabled());
  await prButton.click();
  await page.locator('.chat-workspace-create textarea').waitFor({ timeout: 5000 });
  const titleInput = page.locator('.chat-workspace-review input[type="text"], .chat-workspace-review input:not([type])').first();
  check('pull request title is prefilled from the workspace commit', (await titleInput.inputValue()).includes('add native PRs'));
  await page.locator('.chat-workspace-review textarea').fill('verified headless');
  await page.getByRole('button', { name: 'Push & open' }).click();
  await page.waitForFunction(() => (document.querySelector('.chat-workspaces-notice')?.textContent || '').includes('pull/7'), null, { timeout: 10000 });
  const prCall = await page.evaluate(() => window.__worktreeCalls.filter((c) => c.name === 'pr').pop());
  check('PR request carries dir, title, body and draft flag',
    prCall?.args?.dir === '/ws/native-prs' && prCall.args.draft === true && prCall.args.body === 'verified headless',
    JSON.stringify(prCall));

  // ── Creation passes the slug and channel id through to the bridge.
  await page.getByRole('button', { name: 'New isolated workspace' }).click();
  const slugInput = page.locator('.chat-workspace-create input').first();
  await slugInput.fill('Second Try');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.waitForFunction(() => window.__worktreeCalls.some((c) => c.name === 'create'), null, { timeout: 10000 });
  const createCall = await page.evaluate(() => window.__worktreeCalls.filter((c) => c.name === 'create').pop());
  check('create passes the typed slug and channel id', createCall?.args?.slug === 'Second Try' && Boolean(createCall.args.channelId), JSON.stringify(createCall));

  // ── A refused removal explains itself instead of silently doing nothing.
  await page.locator('.chat-workspaces-list li', { hasText: 'cascade/native-prs' }).locator('.chat-workspace-remove').click();
  await page.waitForFunction(() => (document.querySelector('.chat-workspaces-notice')?.textContent || '').includes('only here'), null, { timeout: 10000 });
  check('refused removal surfaces why and arms the confirm',
    await page.locator('.chat-workspace-remove.is-armed').count() === 1);

  if (process.env.WORKSPACES_SHOT) {
    await page.locator('.chat-channel-settings-panel').screenshot({ path: process.env.WORKSPACES_SHOT });
  }

  check('no runtime errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  preview.kill('SIGTERM');
}

process.exit(failures ? 1 : 0);
