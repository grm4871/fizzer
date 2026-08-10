#!/usr/bin/env node
/** Release check: typed Ask-agent handoffs survive the UI/API boundary. */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const API_PORT = await pickPort();
const PREVIEW_PORT = await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-chat-collaboration-ui-${API_PORT}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await delay(300);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function must(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${url}: ${data.error || 'request failed'}`);
  return data;
}

const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    DOCS_DB_PATH: DB_PATH,
    JWT_SECRET: 'chat-collaboration-ui-secret',
    CASCADE_ALLOW_OPEN_REGISTRATION: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server-err] ${chunk}`));
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root,
  env: { ...process.env, API_PORT: String(API_PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);
  const stamp = Date.now();
  const username = `collab_${stamp}`;
  const account = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  const auth = { authorization: `Bearer ${account.token}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Collaboration UI' }),
  });
  const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: 'agent-lab', content: 'cascade://chat-channel' }),
  });
  const solIdentity = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Sol', mention: 'sol', model: 'gpt-5.6-sol' }),
  });
  const terraIdentity = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Terra', mention: 'terra', model: 'gpt-5.6-terra' }),
  });
  const { registration: sol } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
    method: 'POST', headers: auth, body: JSON.stringify({ vaultAgentId: solIdentity.agent.id }),
  });
  const { registration: terra } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
    method: 'POST', headers: auth, body: JSON.stringify({ vaultAgentId: terraIdentity.agent.id }),
  });
  const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, { method: 'POST', headers: auth });
  const source = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      id: `source-${stamp}`, channelId: channel.id, author: '', registrationId: sol.id,
      body: 'Source result for a focused review.', createdAt: new Date().toISOString(),
    }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) errors.push(message.text());
  });
  // No runner is needed for this UI contract. Make the downstream run fail
  // immediately after the durable collaboration request has been posted.
  await page.route('**/api/vaults/*/runs', (route) => route.fulfill({
    status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test runner intentionally absent' }),
  }));
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((token) => localStorage.setItem('docs_token', token), account.token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  await page.getByText('agent-lab', { exact: false }).first().click();

  const sourceText = page.getByText('Source result for a focused review.', { exact: true });
  await sourceText.waitFor({ timeout: 20_000 });
  await sourceText.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ask agent…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask another agent' });
  await dialog.getByLabel('Agent').selectOption(terra.id);
  await dialog.getByLabel('Instruction').fill('Verify this claim against the implementation.');
  await dialog.getByRole('button', { name: 'Ask agent', exact: true }).click();

  await page.getByText('@terra Verify this claim against the implementation.', { exact: true }).first().waitFor({ timeout: 10_000 });
  const chip = page.locator('.chat-relationship-chip', { hasText: 'Review request' }).last();
  await chip.waitFor({ timeout: 5_000 });
  const messages = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages?detail=full`, { headers: auth });
  const request = messages.messages.find((message) => message.replyTo?.messageId === source.message.id);
  if (!request) throw new Error('linked collaboration request was not persisted');
  if (request.replyTo.relationship !== 'review_request') throw new Error('relationship was not persisted');
  const pending = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agent-dispatches/pending`, { headers: auth });
  const matching = pending.dispatches.filter((dispatch) => dispatch.messageId === request.id);
  if (matching.length !== 1 || matching[0].registration.id !== terra.id) {
    throw new Error('collaboration did not create exactly one Terra dispatch');
  }
  if (errors.length) throw new Error(`browser errors: ${errors.join(' | ')}`);
  console.log('[chat-collaboration-ui] OK — typed Ask-agent handoff is visible, durable, and single-target');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  preview.kill('SIGTERM');
}
