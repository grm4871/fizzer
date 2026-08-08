#!/usr/bin/env node
/**
 * Release matrix — "Tabs, panes, menus, Superkanban".
 *
 * Drives the built client in headless Chromium to catch the failures this row
 * exists for: a menu item silently absent because its prop never reached the
 * component, a menu dismissed by the same right-click that opened it, a menu
 * clipped by an overflow ancestor, and a view that opens to nothing because the
 * tab type falls through the render switch.
 *
 * These are invisible to `vite build` — the client bundle is not type-checked,
 * so a misplaced JSX attribute compiles and ships (see AGENTS.md).
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
const DB_PATH = `/tmp/cascade-tabmenus-${API_PORT}.db`;
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

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`[tab-menus] OK  ${name}`);
  else { console.error(`[tab-menus] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    DOCS_DB_PATH: DB_PATH,
    JWT_SECRET: 'tabmenus-secret',
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
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    body: JSON.stringify({ username: `tabs_${stamp}`, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `Tabs ${stamp}` }) });
  await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'menus-chan', content: 'cascade://chat-channel' }),
  });
  // An opted-in board populates the command center; an ordinary/test board
  // below proves that a Kanban marker alone no longer leaks into the aggregate.
  await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      title: 'menus-board',
      content: '---\n\nkanban-plugin: board\nsuperkanban: true\n\n---\n\n## To do\n\n- [ ] first card\n\n## Done\n\n- [x] shipped\n',
    }),
  });
  await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      title: 'Kanban Feature Test',
      content: '---\nkanban-plugin: board\n---\n\n## In progress\n\n- [ ] should stay private to this board\n',
    }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`); });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('docs_token', t), token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });

  // ── Vault switcher: creation must work without window.prompt (unsupported
  // in Electron renderers) and select the newly created vault.
  const vaultButton = page.locator('.vault-name').first();
  await vaultButton.waitFor({ timeout: 20000 });
  await vaultButton.click();
  await page.getByRole('menuitem', { name: 'New vault' }).click();
  const vaultName = `Created ${stamp}`;
  await page.getByLabel('New vault name').fill(vaultName);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(
    (name) => document.querySelector('.vault-name-text')?.textContent?.trim() === name,
    vaultName,
    { timeout: 10000 },
  );
  check('vault switcher creates and selects a vault inline', true);
  const createdVaults = await must(`${API_BASE}/api/vaults`, { headers: auth });
  check('new vault persisted through the API', createdVaults.vaults.some((item) => item.name === vaultName));

  // Switch back to the seeded vault for the menu tests below.
  await vaultButton.click();
  await page.getByRole('menuitemradio', { name: new RegExp(`Tabs ${stamp}`) }).click();

  const entry = page.getByText('menus-chan', { exact: false }).first();
  await entry.waitFor({ timeout: 20000 });
  await entry.click();
  await page.getByText('#menus-chan', { exact: false }).first().waitFor({ timeout: 20000 });

  // ── The new-tab (+) menu: every item its props should produce.
  const plus = page.locator('.tab-new-btn').first();
  await plus.waitFor({ timeout: 10000 });
  await plus.click({ button: 'right' });

  const menu = page.locator('.tab-context-menu');
  await menu.waitFor({ timeout: 5000 });
  // The opening right-click must not also dismiss it (dismiss listeners attach
  // after the gesture settles). Anything less than a real pause misses this.
  await delay(600);
  check('+ menu stays open after the opening right-click', await menu.isVisible());

  const labels = (await menu.locator('button').allInnerTexts()).map((t) => t.trim().toLowerCase());
  check('+ menu offers New channel/chat', labels.some((t) => t.includes('new channel') || t.includes('new chat')), JSON.stringify(labels));
  check('+ menu offers Superkanban', labels.some((t) => t.includes('superkanban')), JSON.stringify(labels));

  // Clipped-menu regression: an overflow ancestor used to cut the menu off.
  const box = await menu.boundingBox();
  const viewport = page.viewportSize();
  check(
    '+ menu is fully inside the viewport',
    Boolean(box) && box.x >= 0 && box.y >= 0
      && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    JSON.stringify(box),
  );
  for (const item of await menu.locator('button').all()) {
    const itemBox = await item.boundingBox();
    if (!itemBox || itemBox.height < 8) {
      check('every + menu item is rendered with height', false, JSON.stringify(itemBox));
      break;
    }
  }

  // ── The item actually routes: Superkanban opens and renders content.
  await menu.locator('button', { hasText: 'Superkanban' }).click();
  await page.locator('[aria-label="Superkanban"], .superkanban-empty').first().waitFor({ timeout: 15000 });
  const aggregate = page.locator('[aria-label="Superkanban"]');
  check('Superkanban opens to a board, not a blank pane', await aggregate.count() > 0);
  if (await aggregate.count()) {
    const aggregateText = await aggregate.innerText();
    const aggregateTextLower = aggregateText.toLowerCase();
    check('Superkanban aggregates the seeded board', aggregateText.includes('first card'));
    check('Superkanban excludes boards that did not opt in', !aggregateText.includes('should stay private to this board'));
    check('Superkanban presents the active command-center lanes',
      ['ready', 'in progress', 'blocked', 'review'].every((lane) => aggregateTextLower.includes(lane)), aggregateText);
    check('Superkanban hides completed work by default', !aggregateText.includes('shipped'));
    check('Superkanban exposes board scope and health controls',
      await aggregate.getByLabel('Filter by board').count() === 1
        && await aggregate.getByLabel('Work summary').count() === 1);
    if (process.env.CAPTURE_UI) {
      await page.screenshot({ path: process.env.CAPTURE_UI, fullPage: true });
    }
  }

  // ── The per-tab menu on the tab we just opened.
  const skTab = page.locator('.tab-bar .tab-item', { hasText: 'Superkanban' }).first();
  await skTab.waitFor({ timeout: 10000 });
  await skTab.click({ button: 'right' });
  const tabMenu = page.locator('.tab-context-menu');
  await tabMenu.waitFor({ timeout: 5000 });
  await delay(600);
  check('tab menu stays open after the opening right-click', await tabMenu.isVisible());
  const tabLabels = (await tabMenu.locator('button').allInnerTexts()).map((t) => t.trim().toLowerCase());
  check('tab menu offers Close tab', tabLabels.some((t) => t.includes('close tab')), JSON.stringify(tabLabels));

  await tabMenu.locator('button', { hasText: 'Close tab' }).click();
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('.tab-bar .tab-item')).some((el) => el.textContent?.includes('Superkanban')),
    undefined,
    { timeout: 10000 },
  );
  check('Close tab removes the tab', true);
  check('the chat tab survived closing the other tab', await page.locator('.tab-bar .tab-item', { hasText: 'menus-chan' }).count() > 0);

  // The mobile swipe target must not participate in the desktop CSS grid. If
  // it does, closing the sidebar creates an implicit first row and pushes the
  // entire workspace halfway down the window.
  await page.getByLabel('Collapse sidebar').first().click();
  await page.locator('.app-shell.sidebar-closed').waitFor({ timeout: 5000 });
  const workspaceTop = await page.locator('.workspace').evaluate((element) => element.getBoundingClientRect().top);
  check('closing the desktop sidebar keeps the workspace at the top edge', workspaceTop <= 1, String(workspaceTop));

  // Desktop runner recovery is background state, not a page-load callout. A
  // slow socket reconnect must not make the workspace look blocked on reload.
  const desktopPage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desktopPage.addInitScript(() => { window.electronAPI = {}; });
  await desktopPage.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await desktopPage.evaluate((t) => localStorage.setItem('docs_token', t), token);
  await desktopPage.goto(APP_URL, { waitUntil: 'networkidle' });
  await desktopPage.locator('.workspace-toolbar').waitFor({ timeout: 20000 });
  check('desktop reload does not show a runner reconnect gate', await desktopPage.getByText('Desktop agent runner is reconnecting').count() === 0);
  await desktopPage.close();

  const fatal = errors.filter((line) => !line.includes('[VersionCheck]'));
  if (fatal.length > 0) {
    console.error('[tab-menus] Runtime errors:');
    for (const line of fatal) console.error(`  - ${line}`);
    failures++;
  }

  if (failures > 0) throw new Error(`${failures} check(s) failed`);
  console.log('[tab-menus] OK — tab/pane menus render every item, stay open, and route');
} catch (error) {
  console.error('[tab-menus] FAILED:', error.message || error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
  await delay(300);
}
