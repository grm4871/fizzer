#!/usr/bin/env node
/** Built-client smoke for the inline mission artifact and coordinator setting. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const PREVIEW_PORT = Number(process.env.TEST_PREVIEW_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-mission-ui-${API_PORT}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(url, { redirect: 'follow' })).ok) return; } catch { /* booting */ }
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

async function waitForCoordinator(vaultId, channelId, auth, registrationId, expected) {
  const deadline = Date.now() + 10_000;
  let agents = [];
  while (Date.now() < deadline) {
    ({ agents = [] } = await must(`${API_BASE}/api/vaults/${vaultId}/channels/${channelId}/agents`, { headers: auth }));
    if (agents.find((item) => item.id === registrationId)?.orchestrator === expected) return agents;
    await delay(100);
  }
  return agents;
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`[mission-ui] OK  ${label}`);
  else {
    console.error(`[mission-ui] FAIL ${label}${detail ? ` — ${detail}` : ''}`);
    failures += 1;
  }
}

try { fs.unlinkSync(DB_PATH); } catch { /* clean */ }
const server = spawn('node', ['dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(API_PORT),
    API_HOST: '127.0.0.1',
    DOCS_DB_PATH: DB_PATH,
    JWT_SECRET: 'mission-ui-secret',
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
  const username = `mission_ui_${stamp}`;
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  const auth = { authorization: `Bearer ${token}` };
  const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, {
    method: 'POST', headers: auth,
  });
  const agentAuth = { authorization: `Bearer ${agentToken}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Mission UI' }),
  });
  const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: 'mission-room', content: 'cascade://chat-channel' }),
  });
  const { note: ordinaryNote } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: 'vault-sidebar-note', content: '# Ordinary note' }),
  });
  const rootMessage = {
    id: `mission-root-${stamp}`,
    channelId: channel.id,
    author: 'Sol',
    agentId: 'codex',
    body: 'Implement the chat-first orchestration slice.',
    createdAt: new Date(Date.now() - 10_000).toISOString(),
  };
  // Seed the root before enabling the coordinator so this renderer smoke does
  // not need a live desktop model runner.
  await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify(rootMessage),
  });
  const { agent: solIdentity } = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Sol', mention: 'sol', model: 'gpt-5.6-sol' }),
  });
  // This fixture has no connected desktop runner, so using a real Codex
  // registration still cannot launch a provider process. It lets the card
  // verify the per-task model and reasoning-effort projection.
  const { agent: terraIdentity } = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Terra', mention: 'terra', model: 'gpt-5.6-terra' }),
  });
  const { vault: originVault } = await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: 'Other Agent Origin' }),
  });
  const { agent: crossVaultIdentity } = await must(`${API_BASE}/api/vaults/${originVault.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Luna', mention: 'luna', model: 'gpt-5.6-luna' }),
  });
  const { note: secondChannel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ title: 'second-room', content: 'cascade://chat-channel' }),
  });
  const { agents: secondChannelAgents } = await must(
    `${API_BASE}/api/vaults/${vault.id}/channels/${secondChannel.id}/agents`,
    { headers: auth },
  );
  check('vault agents automatically belong to every channel', (
    secondChannelAgents.some((agent) => agent.vaultAgentId === solIdentity.id)
      && secondChannelAgents.some((agent) => agent.vaultAgentId === terraIdentity.id)
      && secondChannelAgents.some((agent) => agent.vaultAgentId === crossVaultIdentity.id)
  ));
  const { registration: sol } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ vaultAgentId: solIdentity.id, orchestrator: true }),
  });
  const { registration: terra } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
    method: 'POST', headers: auth, body: JSON.stringify({ vaultAgentId: terraIdentity.id }),
  });
  const { mission } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      rootMessageId: rootMessage.id,
      coordinatorRegistrationId: sol.id,
      title: 'Chat-first orchestration',
      objective: rootMessage.body,
    }),
  });
  const { task } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/tasks`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      coordinatorRegistrationId: sol.id,
      title: 'Verify multiplayer persistence',
      assignee: '@terra',
      prompt: 'Verify live updates and reload persistence.',
      reasoningEffort: 'high',
    }),
  });
  // Task creation intentionally produces a queued worker shell. Settle that
  // provider-free fixture before testing the completed trace state; otherwise
  // the scheduler may append a live placeholder after the synthetic final.
  await delay(100);
  const beforeTrace = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, { headers: auth });
  for (const message of beforeTrace.messages.filter((item) => item.status === 'running' || item.status === 'sending')) {
    await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({ ...message, body: 'Worker queued for runtime verification.', status: 'completed' }),
    });
  }
  const traceMessages = [
    {
      id: `sys-mission-${mission.id}-trace`, channelId: channel.id, author: 'Cascade',
      // Keep the runtime fixture provider-free: an @mention would create a
      // fresh dispatch/placeholder and alter the transcript being asserted.
      body: 'Sol: worker evidence is ready for review.',
    },
    {
      id: `trace-worker-${stamp}`, channelId: channel.id, author: 'Terra', agentId: 'codex',
      body: 'Inspected multiplayer persistence and collected the runtime evidence.',
      missionTaskId: task.id,
    },
    {
      id: `trace-final-${stamp}`, channelId: channel.id, author: 'Sol', registrationId: sol.id,
      body: 'Integrated the evidence; the user-facing answer remains a normal message.',
    },
  ];
  for (const message of traceMessages) {
    message.createdAt = new Date().toISOString();
    await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST', headers: message.agentId || message.registrationId || message.author === 'Cascade' ? agentAuth : auth, body: JSON.stringify(message),
    });
    await delay(5);
  }
  const seeded = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, { headers: auth });
  if (!seeded.messages.find((message) => message.id === rootMessage.id)?.mission) {
    throw new Error('seeded mission projection was missing before the browser loaded');
  }
  for (const message of traceMessages) {
    if (!seeded.messages.some((item) => item.id === message.id)) {
      throw new Error(`seeded work-trace message ${message.id} was missing before the browser loaded`);
    }
  }

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const channelResponses = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`http.${response.status()}: ${response.url()}`);
    if (response.url().includes(`/channels/${channel.id}/`)) {
      channelResponses.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => {
    localStorage.setItem('docs_token', value);
    localStorage.setItem('cascade_chat_users_collapsed', '0');
  }, token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  const openChannel = async () => {
    const entry = page.locator(`#note-${channel.id}`);
    await entry.waitFor({ timeout: 20_000 });
    await entry.click();
    try {
      await page.locator('.chat-header h2', { hasText: 'mission-room' }).waitFor({ timeout: 20_000 });
    } catch (error) {
      console.error('[mission-ui] page after channel click:\n' + (await page.locator('body').innerText()).slice(0, 4000));
      console.error('[mission-ui] browser errors:\n' + errors.join('\n'));
      await page.screenshot({ path: '/tmp/cascade-mission-ui-fail.png', fullPage: true });
      throw error;
    }
  };
  await openChannel();
  const sharedVaultRail = page.locator('.chat-view.is-sidebar-only .chat-users');
  await sharedVaultRail.waitFor({ timeout: 10_000 });
  check('channel uses the vault-shell people and agents rail', await sharedVaultRail.isVisible());
  const browserSeed = await page.evaluate(async ({ vaultId, channelId }) => {
    const headers = { authorization: `Bearer ${localStorage.getItem('docs_token') || ''}` };
    const [messages, agents] = await Promise.all([
      fetch(`/api/vaults/${vaultId}/channels/${channelId}/messages`, { headers }).then((response) => response.json()),
      fetch(`/api/vaults/${vaultId}/channels/${channelId}/agents`, { headers }).then((response) => response.json()),
    ]);
    return { messages, agents };
  }, { vaultId: vault.id, channelId: channel.id });

  const card = page.locator('.chat-mission-card', { hasText: 'Chat-first orchestration' });
  try {
    await card.waitFor({ timeout: 20_000 });
  } catch (error) {
    console.error('[mission-ui] page without mission card:\n' + (await page.locator('body').innerText()).slice(0, 5000));
    console.error('[mission-ui] browser errors:\n' + errors.join('\n'));
    console.error('[mission-ui] browser API snapshot:\n' + JSON.stringify(browserSeed, null, 2).slice(0, 8000));
    console.error('[mission-ui] channel responses:\n' + channelResponses.join('\n'));
    await page.screenshot({ path: '/tmp/cascade-mission-ui-fail.png', fullPage: true });
    throw error;
  }
  check('mission artifact renders inline', await card.isVisible());
  check('active mission starts compact', !(await card.evaluate((node) => (
    node.classList.contains('is-open') || node.getAttribute('data-open') === 'true'
  ))));
  check('live mission shows thinking whirl on the card', (
    await card.locator('.chat-mission-toggle .thinking-spinner.chat-mission-whirl').count()
  ) === 1);
  check('live mission marks the card as live', await card.evaluate((node) => node.classList.contains('is-live')));
  check('live mission keeps a directly accessible stop action', (
    await card.getByRole('button', { name: 'Stop', exact: true }).count()
  ) === 1);
  check('collapsed mission exposes thinking activity strip', (
    await card.locator('.chat-mission-peek').count()
  ) === 1 && (await card.locator('.chat-mission-peek').isVisible()));
  check('collapsed mission peek shows live work summary', (
    (await card.locator('.chat-mission-peek').innerText()).length > 0
  ));
  check('collapsed peek has no second solid status ball', (
    await card.locator('.chat-mission-peek-dot').count()
  ) === 0);
  await card.locator('.chat-mission-toggle').click();
  check('mission expands to its worker task', (await card.innerText()).includes('Verify multiplayer persistence'));
  check('thinking trace is nested inside the mission card', (
    await card.locator('.chat-mission-trace .chat-work-trace.is-embedded').count()
  ) === 1);
  check('expanded mission hides the collapsed peek', (
    await card.locator('.chat-mission-peek').count()
  ) === 0);
  check('embedded work stream has no nested card chrome', await card.locator('.chat-mission-trace .chat-work-trace').evaluate((node) => {
    const style = getComputedStyle(node);
    return node.classList.contains('is-embedded')
      && style.borderTopWidth === '0px'
      && (style.boxShadow === 'none' || style.boxShadow === '');
  }));
  // Mission chrome is a normal message surface: right-click Reply anywhere on
  // the card header (collapsed or expanded) targets the originating message.
  await card.locator('.chat-mission-toggle').click({ button: 'right' });
  const replyMenu = page.getByRole('menuitem', { name: /Reply/i });
  await replyMenu.waitFor({ timeout: 5_000 });
  await replyMenu.click();
  await page.locator('.chat-reply-bar').waitFor({ timeout: 5_000 });
  check('right-click reply targets the mission originating message', (
    await page.locator('.chat-reply-bar-preview').innerText()
  ).includes('Implement the chat-first orchestration slice'));
  await page.locator('.chat-reply-bar-close').click();
  // Also when collapsed — user often right-clicks the compact card.
  if (await card.evaluate((node) => node.classList.contains('is-open') || node.getAttribute('data-open') === 'true')) {
    await card.locator('.chat-mission-toggle').click();
  }
  await card.locator('.chat-mission-toggle').click({ button: 'right' });
  await replyMenu.waitFor({ timeout: 5_000 });
  await replyMenu.click();
  await page.locator('.chat-reply-bar').waitFor({ timeout: 5_000 });
  check('collapsed mission right-click still replies to the origin', (
    await page.locator('.chat-reply-bar-preview').innerText()
  ).includes('Implement the chat-first orchestration slice'));
  await page.locator('.chat-reply-bar-close').click();
  check('mission has no dedicated Reply button', (
    await card.getByRole('button', { name: 'Reply', exact: true }).count()
  ) === 0);
  // Re-expand for the remaining expanded assertions.
  if (!(await card.evaluate((node) => node.classList.contains('is-open') || node.getAttribute('data-open') === 'true'))) {
    await card.locator('.chat-mission-toggle').click();
  }
  check('mission task renders durable change-state chips', await card.locator('.chat-mission-chips .chat-mission-chip').count() >= 1);
  check('mission exposes worker model and adaptive effort', (
    (await card.innerText()).includes('gpt-5.6-terra') && (await card.innerText()).includes('high effort')
  ));
  await card.getByRole('button', { name: 'Timeline' }).click();
  await card.locator('.chat-mission-event').first().waitFor({ timeout: 10_000 });
  check('mission timeline loads durable state history', (
    (await card.locator('.chat-mission-timeline').innerText()).includes('Mission opened')
      && (await card.locator('.chat-mission-timeline').innerText()).includes('Task added')
  ));
  await page.getByRole('button', { name: 'Open mission history' }).click();
  const archive = page.getByRole('dialog', { name: 'Mission history' });
  await archive.waitFor({ timeout: 10_000 });
  const archivedCard = archive.locator('.chat-mission-card', { hasText: 'Chat-first orchestration' });
  await archivedCard.waitFor({ timeout: 10_000 });
  check('channel mission archive exposes work beyond the message window', (
    await archivedCard.count()
  ) === 1);
  await archive.getByRole('button', { name: 'Close mission history' }).click();
  await archive.waitFor({ state: 'detached', timeout: 5_000 });

  // Nested mission traces force-open the stream; collapsed peek is only for
  // compact activity (hidden while expanded).
  const workTrace = card.locator('.chat-mission-trace .chat-work-trace').first();
  await workTrace.waitFor({ timeout: 10_000 });
  check('worker chatter collapses into a work trace', await workTrace.isVisible());
  // Collapse again to assert the compact activity line geometry.
  await card.locator('.chat-mission-toggle').click();
  await card.locator('.chat-mission-peek').waitFor({ timeout: 5_000 });
  const railStyle = await card.evaluate((node) => {
    const headDot = node.querySelector('.chat-mission-toggle .thinking-spinner, .chat-mission-toggle .chat-mission-state');
    const gutter = node.querySelector('.chat-mission-peek-gutter');
    const author = node.querySelector('.chat-mission-peek-author, .chat-mission-peek-label');
    const kicker = node.querySelector('.chat-mission-kicker');
    const head = headDot ? headDot.getBoundingClientRect() : null;
    const gut = gutter ? gutter.getBoundingClientRect() : null;
    const text = author ? author.getBoundingClientRect() : null;
    const kick = kicker ? kicker.getBoundingClientRect() : null;
    return {
      headW: headDot ? getComputedStyle(headDot).width : '',
      gutW: gutter ? getComputedStyle(gutter).width : '',
      headCenterX: head ? head.left + head.width / 2 : null,
      gutCenterX: gut ? gut.left + gut.width / 2 : null,
      textLeft: text ? text.left : null,
      kickerLeft: kick ? kick.left : null,
    };
  });
  check('collapsed peek reserves the status-dot column', (
    railStyle.headW === '8px' && railStyle.gutW === '8px'
  ), JSON.stringify(railStyle));
  check('peek gutter aligns under the mission status slot', (
    railStyle.headCenterX != null && railStyle.gutCenterX != null
      && Math.abs(railStyle.headCenterX - railStyle.gutCenterX) <= 1.5
  ), JSON.stringify(railStyle));
  // Author/label start with the MISSION kicker (title is further right after the badge).
  check('peek text aligns with the mission kicker column', (
    railStyle.textLeft != null && railStyle.kickerLeft != null
      && Math.abs(railStyle.textLeft - railStyle.kickerLeft) <= 2
  ), JSON.stringify(railStyle));
  // Re-open for the remaining expanded-stream assertions.
  await card.locator('.chat-mission-toggle').click();
  await workTrace.waitFor({ timeout: 5_000 });
  // Coordinator follow-ups that stay in the work run render as compact lines
  // inside the mission stream (not a second full bubble above the mission).
  const finalAsWorkLine = await workTrace.locator(`.chat-work-line[data-message-id="${traceMessages[2].id}"]`).count();
  const finalAsFullBubble = await page.locator(`.chat-message-chunk[data-message-id="${traceMessages[2].id}"]`).count();
  check('coordinator prose stays in the mission stream when work continues', (
    finalAsWorkLine === 1 && finalAsFullBubble === 0
  ), `workLine=${finalAsWorkLine}, fullBubble=${finalAsFullBubble}`);
  check('embedded mission stream starts expanded', await workTrace.evaluate((node) => node.classList.contains('is-open') && node.classList.contains('is-forced-open')));
  const traceLines = workTrace.locator('.chat-work-line');
  const traceLineCount = await traceLines.count();
  check('expanded trace exposes its worker steps', traceLineCount >= 1, `count=${traceLineCount}`);
  check('expanded stream retains coordinator evidence', finalAsWorkLine === 1);
  const workerLine = workTrace.locator(`[data-message-id="${traceMessages[1].id}"]`);
  await workerLine.locator('.chat-work-line-fold').click();
  check('an individual step restores its full evidence', (
    await workerLine.innerText()
  ).includes('Inspected multiplayer persistence'));

  await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${task.id}`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ status: 'running', summary: 'Second client connected.' }),
  });
  await page.waitForFunction(() => document.querySelector('.chat-mission-task.is-running') !== null, null, { timeout: 10_000 });
  check('live task update does not collapse an open artifact', await card.evaluate((node) => (
    node.classList.contains('is-open') || node.getAttribute('data-open') === 'true'
  )));

  await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${task.id}`, {
    method: 'PATCH', headers: auth,
    body: JSON.stringify({ status: 'completed', summary: 'Reload and multiplayer projection passed.' }),
  });
  await page.waitForFunction(() => document.querySelector('.chat-mission-card.is-reviewing') !== null, null, { timeout: 10_000 });
  check('worker completion waits for coordinator review', (await card.locator('.chat-mission-toggle').innerText()).includes('reviewing'));

  await page.reload({ waitUntil: 'networkidle' });
  await openChannel();
  const reloadedCard = page.locator('.chat-mission-card', { hasText: 'Chat-first orchestration' });
  await reloadedCard.waitFor({ timeout: 20_000 });
  await reloadedCard.locator('.chat-mission-toggle').click();
  check('reload retains task status and evidence', (await reloadedCard.innerText()).includes('Reload and multiplayer projection passed.'));

  await page.locator('.sidebar-footer .user-info').click();
  const accountDialog = page.getByRole('dialog', { name: 'Account' });
  await accountDialog.waitFor({ timeout: 5_000 });
  await accountDialog.getByLabel('Display name').fill('Mission Operator');
  await accountDialog.locator('input[type="file"]').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgo=', 'base64'),
  });
  await accountDialog.getByRole('button', { name: 'Save profile' }).click();
  await accountDialog.getByText('Profile saved').waitFor({ timeout: 5_000 });
  check('account modal saves display name and profile picture', await accountDialog.locator('.account-avatar-preview img').isVisible());
  await accountDialog.getByRole('button', { name: 'Close account settings' }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await openChannel();
  check('profile identity survives reload', (await page.locator('.sidebar-footer .user-info').innerText()).includes('Mission Operator'));

  const solRow = sharedVaultRail.locator('.chat-agent-edit-btn', { hasText: 'Sol' });
  await solRow.waitFor({ timeout: 10_000 });
  await solRow.click();
  const coordinatorToggle = page.getByLabel('Coordinate this channel');
  await coordinatorToggle.waitFor({ timeout: 5_000 });
  check('coordinator toggle reflects persisted membership', await coordinatorToggle.isChecked());
  check('coordinator implies the default human-message route', await page.getByLabel('Reply to every human message').isDisabled());
  const membershipMenu = page.locator('.chat-agent-menu');
  const groupTitles = (await membershipMenu.locator('.chat-agent-group-title').allInnerTexts()).map((title) => title.toLowerCase());
  check('agent settings separates runtime, reply policy, access, and permissions',
    ['runtime', 'replies', 'mentions', 'execution'].every((title) => groupTitles.includes(title)),
    JSON.stringify(groupTitles));
  const editorBox = await membershipMenu.boundingBox();
  const viewport = page.viewportSize();
  check('agent editor is a focused full-screen workspace',
    Boolean(editorBox && viewport)
      && editorBox.x <= 1
      && editorBox.y <= 1
      && editorBox.width >= viewport.width - 2
      && editorBox.height >= viewport.height - 2);
  check('safe autonomous execution is the default',
    await membershipMenu.getByText('Auto', { exact: true }).count() === 1
      && await membershipMenu.getByLabel('Full host access').isChecked() === false);
  const switchBox = await coordinatorToggle.boundingBox();
  check('agent settings uses compact switch controls instead of raw checkboxes',
    Boolean(switchBox) && switchBox.width >= 28 && switchBox.width > switchBox.height);
  check('vault identity is presented as scoped navigation',
    await membershipMenu.getByRole('button', { name: /Edit vault identity/ }).count() === 1);
  if (process.env.CAPTURE_AGENT_EDITOR) {
    await page.screenshot({ path: process.env.CAPTURE_AGENT_EDITOR, fullPage: true });
  }

  await coordinatorToggle.uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  let agents = await waitForCoordinator(vault.id, channel.id, auth, sol.id, false);
  check('disabling coordination persists', agents.find((item) => item.id === sol.id)?.orchestrator === false);
  await solRow.click();
  await page.getByLabel('Coordinate this channel').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  agents = await waitForCoordinator(vault.id, channel.id, auth, sol.id, true);
  check('re-enabling coordination persists', agents.find((item) => item.id === sol.id)?.orchestrator === true);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent('cascade:agent-permission', { detail: {
    runId: 991,
    requestId: 'permission-smoke',
    toolName: 'Bash',
    title: 'Run a system command?',
    description: 'The agent wants to inspect a process outside its workspace.',
  } })));
  const permissionCard = page.getByRole('dialog', { name: 'Run a system command?' });
  await permissionCard.waitFor({ timeout: 5_000 });
  check('non-Yolo permission request is actionable in the app',
    await permissionCard.getByRole('button', { name: 'Allow once' }).count() === 1
      && await permissionCard.getByRole('button', { name: 'Deny' }).count() === 1);
  await permissionCard.getByRole('button', { name: 'Deny' }).click();
  await permissionCard.waitFor({ state: 'detached', timeout: 5_000 });

  const stopCard = page.locator('.chat-mission-card', { hasText: 'Chat-first orchestration' });
  await stopCard.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.chat-mission-card.is-canceled') !== null, null, { timeout: 10_000 });
  check('mission stop settles the mission and removes the live stop action', (
    await stopCard.getByRole('button', { name: 'Stop', exact: true }).count()
  ) === 0 && (await stopCard.innerText()).includes('canceled'));

  await page.locator(`#note-${ordinaryNote.id}`).click();
  await page.getByText('Ordinary note', { exact: true }).waitFor({ timeout: 10_000 });
  check('ordinary note keeps the same vault people and agents rail', (
    await sharedVaultRail.isVisible()
      && (await sharedVaultRail.textContent()).includes('People in this vault')
      && (await sharedVaultRail.textContent()).includes('Agents in this vault')
  ));

  const expectedOfflineRun = errors.some((line) => line.startsWith('http.503:') && line.endsWith('/runs'));
  const fatal = errors.filter((line) => {
    if (line.includes('[VersionCheck]')) return false;
    // This smoke intentionally has no desktop runner; automatic mission
    // dispatch therefore probes /runs and gets the expected 503.
    if (expectedOfflineRun && line.startsWith('http.503:') && line.endsWith('/runs')) return false;
    if (expectedOfflineRun && line.includes('Failed to load resource: the server responded with a status of 503')) return false;
    // The same deliberately offline dispatch briefly projects its optimistic
    // `agent-dispatch-*` shell. It has no server message until a desktop
    // claims the run, so media hydration can race one expected 404.
    if (expectedOfflineRun && line.includes('/messages/agent-dispatch-')) return false;
    if (expectedOfflineRun && line.includes('Failed to load resource: the server responded with a status of 404')) return false;
    return true;
  });
  check('no console errors or uncaught exceptions', fatal.length === 0, fatal.join(' | '));
} catch (error) {
  console.error('[mission-ui] FAILED:', error.message || error);
  failures += 1;
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
  await delay(300);
  try { fs.unlinkSync(DB_PATH); } catch { /* clean */ }
}

process.exit(failures ? 1 : 0);
