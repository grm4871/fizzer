#!/usr/bin/env node
/** Browser regression: every vault owns and restores its own tab/pane workspace. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';
import { spawnElixirApi } from './lib/elixir-api.mjs';

const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const PREVIEW_PORT = Number(process.env.TEST_PREVIEW_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-vault-workspaces-${API_PORT}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(url, { redirect: 'follow' })).ok) return; } catch { /* retry */ }
    await delay(400);
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

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`[vault-workspaces-ui] OK  ${name}`);
  else {
    console.error(`[vault-workspaces-ui] FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

const server = spawnElixirApi(root, {
    port: API_PORT,
    dbPath: DB_PATH,
    detached: process.platform !== 'win32',
    extraEnv: {
      JWT_SECRET: 'vault-workspaces-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });
server.stderr.on('data', (chunk) => process.stderr.write(`[server-err] ${chunk}`));

const preview = spawn(
  'npm',
  ['--workspace=client', 'run', 'dev', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)],
  {
    cwd: root,
    env: { ...process.env, API_PORT: String(API_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  },
);
preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);

  const stamp = Date.now();
  const testUsername = `vault_ws_${stamp}`;
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username: testUsername, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const createVault = async (name) => (await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name }),
  })).vault;
  const createNote = async (vaultId, title) => (await must(`${API_BASE}/api/vaults/${vaultId}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title, content: `# ${title}\n` }),
  })).note;

  const vaultA = await createVault(`Workspace Alpha ${stamp}`);
  const vaultB = await createVault(`Workspace Beta ${stamp}`);
  const a1 = await createNote(vaultA.id, 'Alpha one');
  const a2 = await createNote(vaultA.id, 'Alpha two');
  const b1 = await createNote(vaultB.id, 'Beta one');
  const b2 = await createNote(vaultB.id, 'Beta two');

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    const staleSocketPoll = response.status() === 400 && response.url().includes('/socket.io/');
    if (response.status() >= 400 && !staleSocketPoll) errors.push(`http ${response.status()}: ${response.url()}`);
  });

  const selectVault = async (vault) => {
    const choice = page.getByRole('button', { name: `Open vault ${vault.name}` });
    await choice.waitFor({ timeout: 10_000 });
    await choice.click();
    await page.waitForFunction(
      (name) => document.querySelector('.vault-name-text')?.textContent?.trim() === name,
      vault.name,
      { timeout: 10_000 },
    );
  };
  const openNote = async (note, inNewTab = false) => {
    const item = page.locator(`#note-${note.id}`);
    await item.waitFor({ timeout: 15_000 });
    await item.click(inNewTab ? { modifiers: ['Control'] } : undefined);
    await page.locator('.tab-item', { hasText: note.title }).waitFor({ timeout: 15_000 });
  };
  const tabTitles = () => page.locator('.tab-item .tab-title').allInnerTexts();

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username').fill(testUsername);
  await page.getByLabel('Password').fill('testpass12345');
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.locator('.vault-rail').waitFor({ timeout: 15_000 });

  const railBox = await page.locator('.vault-rail').boundingBox();
  const panelBox = await page.locator('.sidebar-panel').boundingBox();
  check('vault rail is inset beside the notes and channels panel',
    Boolean(railBox && panelBox)
      && railBox.x < panelBox.x
      && Math.abs((railBox.x + railBox.width) - panelBox.x) <= 2
      && railBox.height === panelBox.height);

  await selectVault(vaultA);
  await openNote(a1);
  const connector = page.locator('.vault-selection-connector path');
  await connector.waitFor({ timeout: 10_000 });
  check('active vault selection is one filled ribbon into the active page',
    /^M [\d.-]+ [\d.-]+ C .+ L [\d.-]+ [\d.-]+ C .+ Z$/.test(
      await connector.getAttribute('d') || '',
    ) && await connector.evaluate((path) => getComputedStyle(path).fill !== 'none'));
  await openNote(a2, true);

  // Give Alpha a distinct two-pane layout with Alpha two focused.
  const alphaTwoTab = page.locator('.tab-item', { hasText: a2.title });
  const alphaPaneContent = page.locator('.pane-content').first();
  const paneBox = await alphaPaneContent.boundingBox();
  if (!paneBox) throw new Error('Alpha pane content has no bounding box');
  await alphaTwoTab.dragTo(alphaPaneContent, {
    targetPosition: { x: paneBox.width - 4, y: paneBox.height / 2 },
  });
  await page.waitForFunction(() => document.querySelectorAll('.editor-pane').length === 2, undefined, { timeout: 10_000 });
  check('Alpha workspace can hold a split layout', await page.locator('.editor-pane').count() === 2);
  check('Alpha two is the focused pane', (await page.locator('.editor-pane.is-focused .tab-title').allInnerTexts()).includes(a2.title));

  await selectVault(vaultB);
  check('switching to Beta does not carry Alpha tabs',
    !(await tabTitles()).some((title) => title.startsWith('Alpha')), JSON.stringify(await tabTitles()));
  const betaDefaultTab = page.locator('.editor-pane.is-focused .tab-item.active .tab-title');
  await betaDefaultTab.waitFor({ timeout: 15_000 });
  check('new Beta workspace selects a default page',
    await page.locator('.editor-pane').count() === 1
      && (await betaDefaultTab.innerText()).trim().length > 0);

  await openNote(b1);
  await openNote(b2, true);
  await page.locator('.tab-item', { hasText: b1.title }).click();
  check('Beta keeps an independent tab list',
    JSON.stringify((await tabTitles()).sort()) === JSON.stringify([b1.title, b2.title].sort()));

  await selectVault(vaultA);
  const restoredAlphaTitles = await tabTitles();
  check('returning to Alpha restores its tabs only',
    [a1.title, a2.title].every((title) => restoredAlphaTitles.includes(title))
      && !restoredAlphaTitles.some((title) => title.startsWith('Beta')),
    JSON.stringify(restoredAlphaTitles));
  check('returning to Alpha restores its pane layout', await page.locator('.editor-pane').count() === 2);
  check('returning to Alpha restores its focused pane',
    (await page.locator('.editor-pane.is-focused .tab-title').allInnerTexts()).includes(a2.title));

  await selectVault(vaultB);
  const restoredBetaTitles = await tabTitles();
  check('returning to Beta restores its tabs only',
    [b1.title, b2.title].every((title) => restoredBetaTitles.includes(title))
      && !restoredBetaTitles.some((title) => title.startsWith('Alpha')),
    JSON.stringify(restoredBetaTitles));
  check('returning to Beta restores its active tab',
    (await page.locator('.editor-pane.is-focused .tab-item.active .tab-title').innerText()) === b1.title);

  await delay(400);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('cascade_session') || '{}'));
  check('localStorage saves both vault workspaces',
    Boolean(stored.workspacesByVault?.[vaultA.id]) && Boolean(stored.workspacesByVault?.[vaultB.id]));
  check('localStorage keeps Alpha split and Beta unsplit',
    stored.workspacesByVault?.[vaultA.id]?.layout?.type === 'split'
      && stored.workspacesByVault?.[vaultB.id]?.layout?.type === 'pane');

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.tab-item', { hasText: b1.title }).waitFor({ timeout: 15_000 });
  check('reload restores the active vault workspace',
    (await tabTitles()).includes(b1.title)
      && (await tabTitles()).includes(b2.title)
      && !(await tabTitles()).some((title) => title.startsWith('Alpha')));
  await selectVault(vaultA);
  check('reload retains inactive vault workspaces too',
    await page.locator('.editor-pane').count() === 2
      && (await tabTitles()).includes(a1.title)
      && (await tabTitles()).includes(a2.title));

  const guideLauncher = page.getByRole('button', { name: 'Ask the Fizzer guide' });
  await guideLauncher.click();
  await page.getByRole('button', { name: 'Hide help button' }).click();
  check('hide help removes the launcher', await guideLauncher.count() === 0);
  await page.reload({ waitUntil: 'networkidle' });
  check('hide help setting survives reload', await guideLauncher.count() === 0);

  const fatal = errors.filter((line) => !line.includes('[VersionCheck]'));
  if (fatal.length > 0) {
    console.error('[vault-workspaces-ui] Runtime errors:');
    for (const line of fatal) console.error(`  - ${line}`);
    failures += 1;
  }
  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log('[vault-workspaces-ui] OK — vault tabs, layout, focus, and reload state stay isolated');
} catch (error) {
  console.error('[vault-workspaces-ui] FAILED:', error.message || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  const signal = (child, name) => {
    if (child.exitCode != null || child.signalCode != null) return;
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  };
  for (const child of [preview, server]) {
    signal(child, 'SIGTERM');
  }
  await delay(1_000);
  for (const child of [preview, server]) signal(child, 'SIGKILL');
  try { fs.unlinkSync(DB_PATH); } catch { /* clean */ }
}
