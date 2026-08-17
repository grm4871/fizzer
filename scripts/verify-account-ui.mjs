#!/usr/bin/env node
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
const dbPath = `/tmp/cascade-account-ui-${apiPort}.db`;
async function wait(url) { for (let i = 0; i < 120; i += 1) { try { if ((await fetch(url)).ok) return; } catch {} await delay(150); } throw new Error(`timeout: ${url}`); }
async function json(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${path}: ${data.error || 'failed'}`);
  return data;
}

try { fs.unlinkSync(dbPath); } catch {}
const server = spawnElixirApi(root, {
    port: apiPort,
    dbPath: dbPath,
    extraEnv: {
      JWT_SECRET: 'account-ui-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], { cwd: root, env: { ...process.env, API_PORT: String(apiPort), VITE_API_URL: apiBase }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stderr.on('data', (c) => process.stderr.write(`[server] ${c}`));
preview.stderr.on('data', (c) => process.stderr.write(`[preview] ${c}`));
let browser;
try {
  await wait(`${apiBase}/api/health`); await wait(appUrl);
  const username = `account_ui_${Date.now()}`;
  const mateName = `account_mate_${Date.now()}`;
  const requesterName = `account_requester_${Date.now()}`;
  const { token } = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }) });
  const { token: mateToken } = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: mateName, password: 'testpass12345' }) });
  const { token: requesterToken } = await json('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: requesterName, password: 'testpass12345' }) });
  const auth = { authorization: `Bearer ${token}` };
  const mateAuth = { authorization: `Bearer ${mateToken}` };
  const requesterAuth = { authorization: `Bearer ${requesterToken}` };
  const { vault: profileVault } = await json('/api/vaults', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Profile workspace' }) });
  const { note: reportNote } = await json(`/api/vaults/${profileVault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'Community note', content: 'Reviewable content' }),
  });
  const { token: profileInviteToken } = await json(`/api/vaults/${profileVault.id}/invite-link`, {
    method: 'POST', headers: auth, body: JSON.stringify({ role: 'viewer' }),
  });
  const { vault: mateVault } = await json('/api/vaults', { method: 'POST', headers: mateAuth, body: JSON.stringify({ name: 'Mate workspace' }) });
  const { url: mateVaultInvite } = await json(`/api/vaults/${mateVault.id}/invite-link`, {
    method: 'POST', headers: mateAuth, body: JSON.stringify({ role: 'editor' }),
  });
  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('docs_token', value), token);
  await page.reload({ waitUntil: 'networkidle' });
  if (await page.evaluate(() => localStorage.getItem('docs_token')) !== null) throw new Error('legacy browser token was not removed after cookie migration');
  if (!(await page.context().cookies(apiBase)).some((cookie) => cookie.name === 'cascade_session' && cookie.httpOnly)) {
    throw new Error('browser session did not migrate into an HttpOnly cookie');
  }
  await page.locator('.sidebar-footer .user-info').click();
  const modal = page.locator('.account-settings');
  await modal.waitFor();
  await modal.getByLabel('Display name').fill('Multiplayer Person');
  await modal.getByRole('button', { name: 'Save profile' }).click();
  await modal.getByText('Profile saved').waitFor();
  if (!(await page.locator('.sidebar-footer .user-info').innerText()).includes('Multiplayer Person')) throw new Error('sidebar did not update after profile save');
  await page.reload({ waitUntil: 'networkidle' });
  if (!(await page.locator('.sidebar-footer .user-info').innerText()).includes('Multiplayer Person')) throw new Error('profile did not survive reload');
  const desktopLink = page.getByRole('link', { name: 'Get desktop' });
  await desktopLink.waitFor();
  if (await desktopLink.getAttribute('href') !== '/download') throw new Error('browser-only desktop handoff did not point to /download');
  // Shared vault management: invite, re-role, and remove from the account modal.
  await page.locator('.sidebar-footer .user-info').click();
  const sharing = page.locator('.account-settings');
  await sharing.waitFor();
  await sharing.getByRole('tab', { name: /Current vault/ }).click();
  if (!(await page.locator('.vault-name-meta').innerText()).includes('Private')) throw new Error('a private vault should read as private in the sidebar header');
  await sharing.getByLabel('Public summary').fill('A focused workspace for public product research.');
  await sharing.getByLabel('Topics').fill('Research, Product Design, research');
  await sharing.getByLabel('Community guidelines').fill('Bring evidence and keep critique constructive.');
  await sharing.getByLabel('Join policy').selectOption('request');
  await sharing.getByLabel('List this vault publicly').click();
  await sharing.getByText('Public discovery profile saved.').waitFor();
  const visibility = await json(`/api/vaults/${profileVault.id}/visibility`, { headers: auth });
  if (visibility.joinPolicy !== 'request' || visibility.topics.join(',') !== 'research,product design') throw new Error('public discovery settings did not normalize and persist');
  const requested = await json(`/api/public-vaults/${profileVault.id}/join`, { method: 'POST', headers: requesterAuth, body: '{}' });
  if (requested.requestStatus !== 'pending' || requested.role !== null) throw new Error('request policy granted membership without review');
  await page.keyboard.press('Escape');
  await sharing.waitFor({ state: 'detached' });
  await page.locator('.sidebar-footer .user-info').click();
  await sharing.getByRole('tab', { name: /Current vault/ }).click();
  await sharing.getByText(`@${requesterName}`).waitFor();
  await sharing.getByRole('button', { name: 'Approve as viewer' }).click();
  await sharing.getByText(`Added @${requesterName} as viewer`).waitFor();
  let approvedMember = sharing.locator(`.account-vault-members li:has-text("${requesterName}")`);
  await approvedMember.waitFor();
  if ((await approvedMember.getByLabel(`Role for @${requesterName}`).inputValue()) !== 'viewer') throw new Error('approved public request received editor access');
  await json(`/api/vaults/${profileVault.id}/reports`, {
    method: 'POST', headers: requesterAuth,
    body: JSON.stringify({ targetType: 'note', targetId: reportNote.id, reason: 'spam', detail: 'Viewer report detail' }),
  });
  await page.keyboard.press('Escape');
  await sharing.waitFor({ state: 'detached' });
  await page.locator('.sidebar-footer .user-info').click();
  await sharing.waitFor();
  await sharing.getByRole('tab', { name: /Current vault/ }).click();
  const queuedReport = sharing.locator('.account-moderation-queue article', { hasText: 'Viewer report detail' });
  await queuedReport.waitFor();
  if ((await queuedReport.innerText()).includes(requesterName)) throw new Error('vault owner queue exposed reporter identity');
  await queuedReport.getByRole('button', { name: 'Resolve' }).click();
  await sharing.getByText('Report resolved.').waitFor();
  approvedMember = sharing.locator(`.account-vault-members li:has-text("${requesterName}")`);
  page.once('dialog', (dialog) => dialog.accept());
  await approvedMember.getByLabel(`Remove @${requesterName}`).click();
  await sharing.getByText(`Removed @${requesterName}`).waitFor();
  await sharing.getByLabel('Invite by username').fill(mateName);
  await sharing.getByLabel('Invite role').selectOption('editor');
  await sharing.getByRole('button', { name: 'Invite', exact: true }).click();
  await sharing.getByText(`Added @${mateName} as editor`).waitFor();
  await sharing.locator(`.account-vault-members li:has-text("${mateName}")`).waitFor();
  // The sidebar header's member line proves the vault list refreshed after the membership change.
  await page.waitForFunction(() => document.querySelector('.vault-name-meta')?.textContent?.includes('2 members'));

  await sharing.getByLabel(`Role for @${mateName}`).selectOption('viewer');
  await sharing.getByText(`@${mateName} is now viewer`).waitFor();

  page.once('dialog', (dialog) => dialog.accept('Runtime safety reason'));
  await sharing.getByLabel(`Remove and ban @${mateName}`).click();
  await sharing.getByText(`Removed and banned @${mateName}`).waitFor();
  await sharing.locator(`.account-vault-members li:has-text("${mateName}")`).waitFor({ state: 'detached' });
  await sharing.locator('.account-banned-users', { hasText: mateName }).waitFor();
  await page.waitForFunction(() => document.querySelector('.vault-name-meta')?.textContent?.includes('Private'));
  const staleInvite = await fetch(`${apiBase}/api/vault-invites/${encodeURIComponent(profileInviteToken)}/accept`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...mateAuth }, body: '{}',
  });
  if (staleInvite.ok || !(await staleInvite.json()).error?.includes('banned')) throw new Error('pre-ban invite link allowed re-entry');
  await sharing.locator('.account-banned-users', { hasText: mateName }).getByRole('button', { name: 'Unban' }).click();
  await sharing.getByText(`Unbanned @${mateName}`).waitFor();

  await sharing.getByRole('tab', { name: /Security/ }).click();
  await page.getByLabel('Current password').fill('testpass12345');
  await page.getByLabel('New password', { exact: true }).fill('updatedpass12345');
  await page.getByLabel('Confirm new password').fill('updatedpass12345');
  await page.locator('.account-settings').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const passwordReload = page.waitForEvent('load');
  await page.getByRole('button', { name: 'Change password' }).click();
  await page.waitForFunction(() => document.querySelector('.account-settings')?.textContent?.includes('Password changed'));
  await passwordReload;
  await page.waitForLoadState('networkidle');
  await sharing.waitFor({ state: 'detached' });

  await page.getByRole('button', { name: /Vault switcher/ }).click();
  await page.getByRole('menuitem', { name: 'Join vault' }).click();
  await page.getByLabel('Vault invite link').fill(mateVaultInvite);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByText('Joined Mate workspace as editor.').waitFor();
  await page.getByRole('button', { name: /Vault switcher; current vault Mate workspace/ }).waitFor();

  await json(`/api/vaults/${profileVault.id}/reports`, {
    method: 'POST', headers: mateAuth,
    body: JSON.stringify({ targetType: 'vault', targetId: profileVault.id, reason: 'other', detail: 'Global report detail' }),
  });
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  const admin = page.getByRole('dialog', { name: 'Admin' });
  const globalReport = admin.locator('.admin-report-queue article', { hasText: 'Global report detail' });
  await globalReport.waitFor();
  await globalReport.getByText(`Reported by @${mateName}`).waitFor();
  await globalReport.getByRole('button', { name: 'Unlist vault' }).click();
  await globalReport.waitFor({ state: 'detached' });
  if (await page.evaluate(() => localStorage.getItem('docs_token')) !== null) throw new Error('password change restored a readable browser token');
  const unlisted = await page.evaluate(async ({ apiBase, vaultId }) => {
    const response = await fetch(`${apiBase}/api/vaults/${vaultId}/visibility`, { credentials: 'include' });
    return response.json();
  }, { apiBase, vaultId: profileVault.id });
  if (unlisted.visibility !== 'private') throw new Error('global report unlist action did not make the vault private');
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('[account-ui] OK — anonymous owner reports, ban/unban and stale-invite enforcement, accountable global unlist, account settings, and vault sharing');
} finally {
  if (browser) await browser.close();
  preview.kill('SIGTERM'); server.kill('SIGTERM');
  await delay(200);
  try { fs.unlinkSync(dbPath); } catch {}
}
