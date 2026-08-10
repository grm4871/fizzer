#!/usr/bin/env node
/**
 * Browser-level product-surface audit.
 *
 * Walks every primary desktop surface plus the mobile navigation/settings
 * surfaces against a real disposable API. In addition to rendering each view,
 * it guards the spacing and text sizes that make the secondary UI legible.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const root = new URL('..', import.meta.url).pathname;
const apiPort = await pickPort();
const apiBase = `http://127.0.0.1:${apiPort}`;
const appUrl = `${apiBase}/app.html`;
const dbPath = `/tmp/fizzer-surface-polish-${apiPort}.db`;
const vaultRoot = `/tmp/fizzer-surface-polish-vaults-${apiPort}`;
const captureRoot = process.env.CAPTURE_UI_DIR
  ? path.resolve(process.env.CAPTURE_UI_DIR)
  : `/tmp/fizzer-surface-polish-captures-${apiPort}`;

async function waitFor(url) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function json(endpoint, options = {}) {
  const response = await fetch(`${apiBase}${endpoint}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${endpoint}: ${data.error || 'failed'}`);
  return data;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

for (const target of [dbPath, vaultRoot, captureRoot]) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
}
fs.mkdirSync(captureRoot, { recursive: true });

const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(apiPort),
    API_HOST: '127.0.0.1',
    DOCS_DB_PATH: dbPath,
    CASCADE_VAULTS_BASE_DIR: vaultRoot,
    JWT_SECRET: 'surface-polish-ui-secret',
    CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

let browser;
const audited = [];

async function auditSurface(page, name, locator, {
  bodyCopy,
  control,
  minControlHeight = 0,
  minWidth = 250,
  minHeight = 100,
} = {}) {
  const surface = locator.first();
  await surface.waitFor({ state: 'visible', timeout: 20_000 });
  const [box, viewport] = await Promise.all([surface.boundingBox(), page.viewportSize()]);
  if (!box || !viewport) throw new Error(`${name}: surface has no visible geometry`);
  const tolerance = 1.5;
  if (
    box.x < -tolerance
    || box.y < -tolerance
    || box.x + box.width > viewport.width + tolerance
    || box.y + box.height > viewport.height + tolerance
  ) {
    throw new Error(`${name}: clipped outside ${viewport.width}x${viewport.height}: ${JSON.stringify(box)}`);
  }
  if (box.width < minWidth || box.height < minHeight) {
    throw new Error(`${name}: undersized primary surface: ${JSON.stringify(box)}`);
  }
  if (bodyCopy) {
    const copy = surface.locator(bodyCopy).first();
    await copy.waitFor({ state: 'visible' });
    const fontSize = Number.parseFloat(await copy.evaluate((element) => getComputedStyle(element).fontSize));
    if (fontSize < 12) throw new Error(`${name}: body copy is ${fontSize}px; expected at least 12px`);
  }
  if (control) {
    const target = surface.locator(control).first();
    await target.waitFor({ state: 'visible' });
    const controlBox = await target.boundingBox();
    if (!controlBox || controlBox.height < minControlHeight) {
      throw new Error(`${name}: primary control is shorter than ${minControlHeight}px: ${JSON.stringify(controlBox)}`);
    }
  }
  await page.screenshot({ path: path.join(captureRoot, `${String(audited.length + 1).padStart(2, '0')}-${name}.png`) });
  audited.push(name);
}

async function auditSettingsTabs(page, prefix) {
  const dialog = page.locator('.account-settings');
  const sections = [
    ['Profile', 'account-profile'],
    ['Preferences', 'account-preferences'],
    ['Security', 'account-security'],
    ['Current vault', 'account-vault'],
  ];
  for (const [label, id] of sections) {
    const tab = dialog.getByRole('tab', { name: new RegExp(`^${label}`) });
    await tab.click();
    if (await tab.getAttribute('aria-selected') !== 'true') throw new Error(`${prefix}-${id}: selected tab was not announced`);
    if (await dialog.getByRole('tabpanel').count() !== 1) throw new Error(`${prefix}-${id}: expected exactly one visible settings panel`);
    const panel = dialog.locator(`#${id}`);
    await panel.waitFor({ state: 'visible' });
    const [panelBox, dialogBox, overflowX] = await Promise.all([
      panel.boundingBox(), dialog.boundingBox(),
      panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
    ]);
    if (!panelBox || !dialogBox || panelBox.y < dialogBox.y || panelBox.y + panelBox.height > dialogBox.y + dialogBox.height + 1) {
      throw new Error(`${prefix}-${id}: panel escaped its settings dialog`);
    }
    if (overflowX) throw new Error(`${prefix}-${id}: panel has horizontal overflow`);
    await page.screenshot({ path: path.join(captureRoot, `${String(audited.length + 1).padStart(2, '0')}-${prefix}-${id}.png`) });
    audited.push(`${prefix}-${id}`);
  }
  const vaultPanel = dialog.locator('#account-vault');
  const headerBefore = await dialog.locator(':scope > header').boundingBox();
  await vaultPanel.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const headerAfter = await dialog.locator(':scope > header').boundingBox();
  if (!headerBefore || !headerAfter || Math.abs(headerBefore.y - headerAfter.y) > 1) {
    throw new Error(`${prefix}: scrolling vault settings moved the dialog header`);
  }
}

try {
  await waitFor(`${apiBase}/api/health`);

  const stamp = Date.now();
  const owner = await json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: `surface_owner_${stamp}`, password: 'testpass12345' }),
  });
  const collaborator = await json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username: `surface_friend_${stamp}`, password: 'testpass12345' }),
  });
  const ownerAuth = authHeaders(owner.token);
  const collaboratorAuth = authHeaders(collaborator.token);
  const { vault } = await json('/api/vaults', {
    method: 'POST',
    headers: ownerAuth,
    body: JSON.stringify({ name: 'Northstar Studio' }),
  });
  await json(`/api/vaults/${vault.id}/folders`, {
    method: 'POST', headers: ownerAuth, body: JSON.stringify({ name: 'Product' }),
  });
  const { note: welcome } = await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST',
    headers: ownerAuth,
    body: JSON.stringify({
      title: 'Welcome',
      content: '# Welcome to Northstar\n\nA calm place for product thinking.\n\n## This week\n\n- Finalize launch brief\n- Review customer notes\n- Ship onboarding polish',
    }),
  });
  await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST',
    headers: ownerAuth,
    body: JSON.stringify({
      title: 'Roadmap',
      content: '---\nkanban-plugin: board\nsuperkanban: true\n---\n\n## Backlog\n\n- [ ] Improve onboarding\n- [ ] Clarify pricing\n\n## In progress\n\n- [ ] Polish every surface\n\n## Review\n\n- [ ] Mobile navigation\n\n## Done\n\n- [x] Chat redesign',
    }),
  });
  const { note: channel } = await json(`/api/vaults/${vault.id}/notes`, {
    method: 'POST',
    headers: ownerAuth,
    body: JSON.stringify({ title: 'devspam', content: 'cascade://chat-channel' }),
  });
  await json(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST',
    headers: ownerAuth,
    body: JSON.stringify({ body: 'The main chat is our visual north star.' }),
  });
  await json(`/api/vaults/${vault.id}/members`, {
    method: 'POST',
    headers: ownerAuth,
    body: JSON.stringify({ username: collaborator.user.username, role: 'editor' }),
  });
  await json(`/api/vaults/${vault.id}/visibility`, {
    method: 'PUT',
    headers: ownerAuth,
    body: JSON.stringify({
      visibility: 'public',
      summary: 'A calm studio for thoughtful product work.',
      topics: ['product design', 'research'],
      guidelines: 'Bring context. Keep critique specific and kind.',
      homeNoteId: welcome.id,
      joinPolicy: 'open',
    }),
  });
  await delay(1100);
  await json(`/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST',
    headers: collaboratorAuth,
    body: JSON.stringify({ body: `Ready for @${owner.user.username}.` }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });

  const anonymousContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const anonymous = await anonymousContext.newPage();
  await anonymous.goto(appUrl, { waitUntil: 'networkidle' });
  await auditSurface(anonymous, 'auth-login', anonymous.locator('.auth-panel'), {
    bodyCopy: '.auth-intro p', control: '#auth-submit', minControlHeight: 44,
  });
  await anonymous.getByRole('button', { name: 'Create account' }).click();
  await auditSurface(anonymous, 'auth-register', anonymous.locator('.auth-panel'), {
    bodyCopy: '.auth-intro p', control: '#auth-submit', minControlHeight: 44,
  });
  await anonymous.getByRole('button', { name: /Already have an account/ }).click();
  await anonymous.getByRole('button', { name: 'Forgot password?' }).click();
  await auditSurface(anonymous, 'auth-recovery', anonymous.locator('.auth-panel'), {
    bodyCopy: '.auth-intro p', control: '#auth-submit', minControlHeight: 44,
  });
  await anonymousContext.close();

  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ownerContext.addInitScript(({ token, vaultId }) => {
    localStorage.setItem('docs_token', token);
    localStorage.setItem('cascade_session', JSON.stringify({
      activeVaultId: vaultId,
      openTabs: [],
      layout: { type: 'pane', id: 'root', tabIds: [], activeTabId: null },
      focusedPaneId: 'root',
    }));
  }, { token: owner.token, vaultId: vault.id });
  const page = await ownerContext.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('WebSocket') && !message.text().includes('Failed to load resource')) errors.push(`console.error: ${message.text()}`);
  });
  page.on('response', (response) => {
    const isSocketReconnect = response.status() === 400 && response.url().includes('/socket.io/');
    if (response.status() >= 400 && !isSocketReconnect) errors.push(`http.${response.status()}: ${response.url()}`);
  });
  await page.goto(appUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /Vault switcher/ }).waitFor();

  await page.locator('.tree-item', { hasText: 'devspam' }).click();
  await auditSurface(page, 'main-chat', page.locator('.app-shell'), { bodyCopy: '.chat-message-body' });

  const showMembers = page.getByRole('button', { name: 'Show vault members' });
  if (await showMembers.count()) await showMembers.click();
  await auditSurface(page, 'chat-members', page.getByLabel('Chat users'), { bodyCopy: '.chat-runs-empty' });
  await page.getByRole('button', { name: 'Project setup' }).click();
  await auditSurface(page, 'project-setup', page.locator('.chat-channel-settings-panel'), { minWidth: 240 });
  await page.getByRole('button', { name: 'Project setup' }).click();
  await page.getByRole('button', { name: 'Add agent' }).click();
  await auditSurface(page, 'agent-picker', page.locator('.chat-agent-menu'), {
    bodyCopy: '.chat-runs-empty', control: 'button', minControlHeight: 28, minWidth: 240,
  });
  const createAgent = page.getByRole('button', { name: 'Create new…' });
  if (await createAgent.count()) {
    await createAgent.click();
    const agentEditor = page.getByRole('dialog', { name: 'New vault agent' });
    await auditSurface(page, 'agent-editor', agentEditor, {
      bodyCopy: '.chat-agent-editor-heading > span', control: 'select', minControlHeight: 28,
    });
    await agentEditor.getByRole('button', { name: 'Close agent editor' }).click();
  }

  await page.getByRole('button', { name: /Vault switcher/ }).click();
  await auditSurface(page, 'vault-switcher', page.getByRole('dialog', { name: 'Vault workspace' }), {
    bodyCopy: '.vault-switcher-copy small', control: '.vault-switcher-action', minControlHeight: 96,
  });
  await page.getByRole('button', { name: `Manage ${vault.name}` }).click();
  const managedSettings = page.locator('.account-settings');
  await managedSettings.waitFor({ state: 'visible' });
  if (await managedSettings.getByRole('tab', { name: /^Current vault/ }).getAttribute('aria-selected') !== 'true') {
    throw new Error('vault-switcher: Manage did not open the Current vault settings panel');
  }
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await auditSurface(page, 'new-tab', page.locator('.new-tab-page'), { bodyCopy: ':scope > span:not(.surface-kicker)' });

  await page.locator('.tree-item', { hasText: 'Welcome' }).click();
  await auditSurface(page, 'note-editor', page.locator('.editor-container'), { control: '.toolbar-btn', minControlHeight: 28 });

  await page.locator('.tree-item', { hasText: 'Roadmap' }).click();
  await auditSurface(page, 'kanban', page.locator('.kanban-view'), {
    bodyCopy: '.kanban-card', control: '.kanban-card', minControlHeight: 42,
  });

  const newTabButton = page.getByRole('button', { name: 'New tab', exact: true });
  await newTabButton.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Superkanban' }).click();
  await auditSurface(page, 'superkanban', page.getByLabel('Superkanban', { exact: true }), {
    bodyCopy: '.kanban-card', control: '.kanban-search', minControlHeight: 34,
  });

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', ctrlKey: true })));
  await auditSurface(page, 'command-palette', page.getByRole('dialog', { name: 'Open anything' }), {
    bodyCopy: '.item-path', control: '.command-palette-input-wrap', minControlHeight: 58,
  });
  await page.keyboard.press('Escape');

  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true })));
  await auditSurface(page, 'search', page.getByRole('dialog', { name: 'Search workspace' }), {
    control: '.search-input-wrap', minControlHeight: 58,
  });
  await page.keyboard.press('Escape');

  await page.locator('.sidebar-footer .user-info').click();
  await auditSurface(page, 'settings', page.locator('.account-settings'), {
    bodyCopy: '> header p', control: '.account-settings-nav button', minControlHeight: 48,
  });
  await auditSettingsTabs(page, 'settings');
  await page.keyboard.press('Escape');

  await page.getByTitle('Messages').click();
  const connect = page.getByRole('dialog', { name: 'Connect' });
  await auditSurface(page, 'connect-messages', connect, {
    bodyCopy: '.discovery-dms-header p', control: '.discovery-dms-tabs button', minControlHeight: 44,
  });
  await connect.getByRole('tab', { name: /Explore vaults/ }).click();
  await auditSurface(page, 'connect-explore', connect, {
    bodyCopy: '.public-vault-purpose', control: '.discovery-search', minControlHeight: 44,
  });
  await page.keyboard.press('Escape');

  await page.locator('#community-updates-btn').click();
  await auditSurface(page, 'updates', page.getByRole('dialog', { name: 'Updates' }), {
    bodyCopy: '.updates-header p', control: '.updates-header .btn-icon', minControlHeight: 38,
  });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Inspect running AI sessions' }).click();
  await auditSurface(page, 'sessions', page.getByRole('dialog', { name: 'Agent sessions' }), {
    bodyCopy: '.session-manager-empty span', control: 'button[aria-label="Close session manager"]', minControlHeight: 28,
  });
  await page.keyboard.press('Escape');

  await page.getByTitle('Admin').click();
  await auditSurface(page, 'administration', page.getByRole('dialog', { name: 'Admin' }), {
    bodyCopy: '> .admin-panel-hint', control: '.admin-panel-header .btn-icon', minControlHeight: 38,
  });
  await page.keyboard.press('Escape');
  await ownerContext.close();

  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await guestContext.addInitScript(({ token, vaultId }) => {
    localStorage.setItem('docs_token', token);
    localStorage.setItem('cascade_session', JSON.stringify({
      activeVaultId: vaultId,
      openTabs: [],
      layout: { type: 'pane', id: 'root', tabIds: [], activeTabId: null },
      focusedPaneId: 'root',
    }));
  }, { token: collaborator.token, vaultId: vault.id });
  const guestPage = await guestContext.newPage();
  await guestPage.goto(appUrl, { waitUntil: 'networkidle' });
  await guestPage.getByRole('button', { name: /Vault switcher/ }).click();
  await guestPage.getByRole('menuitem', { name: 'Browse public vaults' }).click();
  const guestConnect = guestPage.getByRole('dialog', { name: 'Connect' });
  await guestConnect.getByRole('button', { name: 'View Northstar Studio details' }).click();
  await guestConnect.getByRole('button', { name: 'Report vault' }).click();
  await auditSurface(guestPage, 'report', guestPage.getByRole('dialog', { name: 'Report Northstar Studio' }), {
    bodyCopy: 'label', control: 'textarea', minControlHeight: 70,
  });
  await guestContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await mobileContext.addInitScript(({ token, vaultId }) => {
    localStorage.setItem('docs_token', token);
    localStorage.setItem('cascade_session', JSON.stringify({
      activeVaultId: vaultId,
      openTabs: [],
      layout: { type: 'pane', id: 'root', tabIds: [], activeTabId: null },
      focusedPaneId: 'root',
    }));
  }, { token: owner.token, vaultId: vault.id });
  const mobile = await mobileContext.newPage();
  await mobile.goto(appUrl, { waitUntil: 'networkidle' });
  await auditSurface(mobile, 'mobile-main', mobile.locator('.app-shell'));
  const expandSidebar = mobile.getByLabel('Expand sidebar').first();
  if (await expandSidebar.count()) await expandSidebar.click();
  await auditSurface(mobile, 'mobile-sidebar', mobile.locator('.sidebar'));
  await mobile.locator('.sidebar-footer .user-info').click();
  await auditSurface(mobile, 'mobile-settings', mobile.locator('.account-settings'), {
    bodyCopy: '> header p', control: '.account-settings-nav button', minControlHeight: 46,
  });
  await auditSettingsTabs(mobile, 'mobile-settings');
  await mobile.keyboard.press('Escape');
  await mobile.getByTitle('Messages').click();
  await auditSurface(mobile, 'mobile-connect', mobile.getByRole('dialog', { name: 'Connect' }), {
    bodyCopy: '.discovery-dms-header p', control: '.discovery-dms-tabs button', minControlHeight: 42,
  });
  await mobile.keyboard.press('Escape');
  await mobile.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true })));
  await auditSurface(mobile, 'mobile-search', mobile.getByRole('dialog', { name: 'Search workspace' }), {
    control: '.search-input-wrap', minControlHeight: 54,
  });
  await mobileContext.close();

  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`[surface-polish-ui] OK — ${audited.length} primary desktop/mobile surfaces passed (${captureRoot})`);
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await delay(250);
  for (const target of [dbPath, vaultRoot]) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
}
