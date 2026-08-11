#!/usr/bin/env node
/**
 * Exercise the touch-only reply gesture in the built client. This deliberately
 * uses Chromium's native touch input rather than mouse events: the handler
 * ignores mouse pointers and must coexist with the scroll container's pan-y
 * touch action.
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
const DB_PATH = `/tmp/cascade-chatswipe-ui-${API_PORT}.db`;
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return;
    } catch { /* retry */ }
    await delay(300);
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

function startServer() {
  const child = spawn('node', ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      DOCS_DB_PATH: DB_PATH,
      JWT_SECRET: 'chatswipe-ui-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  return child;
}

async function dispatchSwipe(client, point, dx, dy) {
  const touch = (x, y) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch(point.x, point.y)] });
  await delay(25);
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(point.x + dx * 0.45, point.y + dy * 0.45)] });
  await delay(25);
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touch(point.x + dx, point.y + dy)] });
  await delay(25);
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const server = startServer();
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT: String(API_PORT), VITE_API_URL: API_BASE },
});
preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);

  const stamp = Date.now();
  const username = `swipe_ui_${stamp}`;
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, { method: 'POST', headers: auth });
  const { vault } = await must(`${API_BASE}/api/vaults`, {
    method: 'POST', headers: auth, body: JSON.stringify({ name: `Swipe QA ${stamp}` }),
  });
  const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'touch-reply', content: 'cascade://chat-channel' }),
  });

  const targetId = `swipe-target-${stamp}`;
  for (let index = 0; index < 24; index += 1) {
    await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        id: `swipe-history-${stamp}-${index}`,
        channelId: channel.id,
        body: `history row ${index}\n\nextra height\n\nmore scroll space`,
        createdAt: new Date(Date.now() + index).toISOString(),
      }),
    });
  }

  const missionRootId = `swipe-mission-root-${stamp}`;
  const missionRootBody = 'mission swipe reply target';
  await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ id: missionRootId, channelId: channel.id, body: missionRootBody }),
  });
  const { agent: solIdentity } = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Sol', mention: 'sol', model: 'gpt-5.6-sol' }),
  });
  const { agent: terraIdentity } = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ agentId: 'codex', displayName: 'Terra', mention: 'terra', model: 'gpt-5.6-terra' }),
  });
  const { registration: sol } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ vaultAgentId: solIdentity.id, orchestrator: true }),
  });
  const { registration: terra } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
    method: 'POST', headers: auth, body: JSON.stringify({ vaultAgentId: terraIdentity.id }),
  });
  const missionTitle = 'Touch reply mission';
  const { mission } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      rootMessageId: missionRootId,
      coordinatorRegistrationId: sol.id,
      title: missionTitle,
      objective: missionRootBody,
    }),
  });
  const { task } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/tasks`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({
      coordinatorRegistrationId: sol.id,
      title: 'Exercise trace reply',
      assignee: '@terra',
      prompt: 'Render a durable trace row.',
    }),
  });
  // The fixture intentionally has no desktop runner. Settle any optimistic
  // dispatch shell, then add one deterministic completed trace line.
  await delay(100);
  const beforeTrace = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, { headers: auth });
  for (const message of beforeTrace.messages.filter((item) => item.status === 'running' || item.status === 'sending')) {
    await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ ...message, body: 'Offline fixture settled.', status: 'completed' }),
    });
  }
  const traceTargetId = `swipe-trace-${stamp}`;
  const traceTargetBody = 'run trace swipe reply target';
  await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${agentToken}` },
    body: JSON.stringify({
      id: traceTargetId,
      channelId: channel.id,
      author: 'Terra',
      agentId: 'codex',
      registrationId: terra.id,
      body: traceTargetBody,
      missionTaskId: task.id,
      status: 'completed',
      createdAt: new Date().toISOString(),
    }),
  });
  // Keep the ordinary-message target last so list virtualization mounts it on
  // initial paint even with the mission fixture above it.
  await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ id: targetId, channelId: channel.id, body: 'swipe reply target' }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((value) => localStorage.setItem('docs_token', value), token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });
  console.log('[verify-chat-swipe-reply-ui] app loaded');
  // The mobile drawer intentionally starts closed; open it through the same
  // affordance a touch user uses before selecting the test channel.
  const expandSidebar = page.locator('#sidebar-expand-btn');
  await expandSidebar.waitFor({ timeout: 5000 });
  await expandSidebar.click();
  console.log('[verify-chat-swipe-reply-ui] sidebar opened');
  const channelEntry = page.locator(`#note-${channel.id}`);
  await channelEntry.waitFor({ timeout: 10000 });
  await channelEntry.click();
  await page.locator('.chat-header h2', { hasText: 'touch-reply' }).waitFor({ timeout: 20000 });
  console.log('[verify-chat-swipe-reply-ui] channel opened');

  const row = page.locator(`[data-message-id="${targetId}"]`);
  await row.waitFor({ timeout: 20000 });
  await row.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(100);
  const computedTouchAction = await row.evaluate((element) => getComputedStyle(element).touchAction);
  if (computedTouchAction !== 'pan-y') throw new Error(`reply row lost pan-y touch action: ${computedTouchAction}`);
  const client = await context.newCDPSession(page);
  await page.evaluate(() => {
    window.__swipeTrace = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      document.addEventListener(type, (event) => {
        const pointer = event;
        window.__swipeTrace.push({ type, x: pointer.clientX, y: pointer.clientY, pointerType: pointer.pointerType });
      }, true);
    }
  });

  // A vertical pan must remain a scroll gesture and never arm a reply.
  const scroller = page.locator('.chat-messages');
  const beforeScroll = await scroller.evaluate((element) => element.scrollTop);
  const verticalBox = await row.boundingBox();
  if (!verticalBox) throw new Error('target message has no box');
  await dispatchSwipe(client, { x: verticalBox.x + 120, y: verticalBox.y + verticalBox.height / 2 }, 3, 96);
  await page.waitForTimeout(150);
  const afterScroll = await scroller.evaluate((element) => element.scrollTop);
  if (afterScroll >= beforeScroll) {
    const geometry = await scroller.evaluate((element) => ({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    throw new Error(`vertical touch did not retain chat scroll: before=${beforeScroll} after=${afterScroll} geometry=${JSON.stringify(geometry)}`);
  }
  if (await page.locator('.chat-reply-bar').count()) throw new Error('vertical touch incorrectly started a reply');
  console.log('[verify-chat-swipe-reply-ui] vertical pan retained scroll');

  await row.scrollIntoViewIfNeeded();
  const swipeBox = await row.boundingBox();
  if (!swipeBox) throw new Error('target message disappeared before swipe');
  await dispatchSwipe(client, { x: swipeBox.x + Math.min(230, swipeBox.width - 20), y: swipeBox.y + swipeBox.height / 2 }, -82, 3);
  const replyBar = page.locator('.chat-reply-bar');
  try {
    await replyBar.waitFor({ timeout: 5000 });
  } catch (error) {
    const trace = await page.evaluate(() => window.__swipeTrace);
    const state = await row.evaluate((element) => ({ className: element.className, transform: element.querySelector('.chat-swipe-content')?.style.transform }));
    throw new Error(`reply did not open; trace=${JSON.stringify(trace)} state=${JSON.stringify(state)} cause=${error}`);
  }
  if (!(await page.locator('.chat-reply-bar-preview').innerText()).includes('swipe reply target')) {
    throw new Error('swipe reply did not quote the touched message');
  }

  await page.locator('.chat-reply-bar-close').click();

  const missionCard = page.locator('.chat-mission-card', { hasText: missionTitle });
  await missionCard.waitFor({ timeout: 20_000 });
  const missionToggle = missionCard.locator('.chat-mission-toggle');
  await missionToggle.scrollIntoViewIfNeeded();
  const missionBox = await missionToggle.boundingBox();
  if (!missionBox) throw new Error('mission toggle has no box');
  const missionWasOpen = await missionCard.getAttribute('data-open');
  await dispatchSwipe(client, {
    x: missionBox.x + Math.min(250, missionBox.width - 18),
    y: missionBox.y + missionBox.height / 2,
  }, -82, 3);
  await replyBar.waitFor({ timeout: 5000 });
  if (!(await page.locator('.chat-reply-bar-preview').innerText()).includes(missionRootBody)) {
    throw new Error('mission swipe did not target the originating message');
  }
  if ((await missionCard.getAttribute('data-open')) !== missionWasOpen) {
    throw new Error('mission swipe also toggled the mission card');
  }
  await page.locator('.chat-reply-bar-close').click();

  // A regular tap remains the progressive-disclosure action after swiping.
  await missionToggle.tap();
  if ((await missionCard.getAttribute('data-open')) !== 'true') {
    throw new Error('mission tap no longer expands the card');
  }
  // Agent-identity boundaries keep the worker trace in its own chronological
  // row rather than nesting Terra's work under Sol's mission card.
  const traces = page.locator('.chat-work-trace:not(.is-embedded)');
  await traces.first().waitFor({ timeout: 10_000 });
  let trace;
  for (let index = 0; index < await traces.count(); index += 1) {
    const candidate = traces.nth(index);
    const candidateToggle = candidate.locator('.chat-work-trace-toggle');
    if (!(await candidate.evaluate((node) => node.classList.contains('is-open')))) {
      await candidateToggle.scrollIntoViewIfNeeded();
      await candidateToggle.tap();
    }
    if (await candidate.locator(`.chat-work-line[data-message-id="${traceTargetId}"]`).count()) {
      trace = candidate;
      break;
    }
  }
  if (!trace) throw new Error('worker trace target was not rendered');
  const traceToggle = trace.locator('.chat-work-trace-toggle');
  if (await traceToggle.count()) {
    if (await trace.evaluate((node) => node.classList.contains('is-open'))) await traceToggle.tap();
    await traceToggle.scrollIntoViewIfNeeded();
    const traceCardBox = await traceToggle.boundingBox();
    if (!traceCardBox) throw new Error('collapsed trace toggle has no box');
    const traceWasExpanded = await trace.evaluate((node) => node.classList.contains('is-open'));
    await dispatchSwipe(client, {
      x: traceCardBox.x + Math.min(250, traceCardBox.width - 18),
      y: traceCardBox.y + traceCardBox.height / 2,
    }, -82, 3);
    try {
      await replyBar.waitFor({ timeout: 1500 });
    } catch {
      // Expanding candidate traces immediately above this row can leave one
      // compositor frame with stale touch geometry. Re-resolve the live box
      // once; a genuinely broken reply gesture still fails the second probe.
      await traceToggle.scrollIntoViewIfNeeded();
      const retryBox = await traceToggle.boundingBox();
      if (!retryBox) throw new Error('collapsed trace toggle disappeared before retry');
      await dispatchSwipe(client, {
        x: retryBox.x + Math.min(250, retryBox.width - 18),
        y: retryBox.y + retryBox.height / 2,
      }, -82, 3);
      await replyBar.waitFor({ timeout: 5000 });
    }
    const traceReplyPreview = await page.locator('.chat-reply-bar-preview').innerText();
    if (!traceReplyPreview.trim() || traceReplyPreview.includes(missionRootBody)) {
      throw new Error('collapsed trace swipe did not target a work message');
    }
    if (await trace.evaluate((node) => node.classList.contains('is-open')) !== traceWasExpanded) {
      throw new Error('collapsed trace swipe also expanded the trace');
    }
    await page.locator('.chat-reply-bar-close').click();
    await traceToggle.tap();
  }
  const traceLine = trace.locator(`.chat-work-line[data-message-id="${traceTargetId}"]`);
  await traceLine.waitFor({ timeout: 10_000 });
  const traceFold = traceLine.locator('.chat-work-line-fold');
  await traceFold.scrollIntoViewIfNeeded();
  const traceWasOpen = await traceLine.evaluate((node) => node.classList.contains('is-open'));
  const traceBox = await traceFold.boundingBox();
  if (!traceBox) throw new Error('trace fold row has no box');
  await dispatchSwipe(client, {
    x: traceBox.x + Math.min(250, traceBox.width - 18),
    y: traceBox.y + traceBox.height / 2,
  }, -82, 3);
  try {
    await replyBar.waitFor({ timeout: 1500 });
  } catch {
    // Opening the nested scroll region can move its first row after the
    // compositor has already returned a box. Resolve and exercise the live
    // fold row once more; a broken gesture still fails this second probe.
    await traceFold.scrollIntoViewIfNeeded();
    const retryBox = await traceFold.boundingBox();
    if (!retryBox) throw new Error('trace fold row disappeared before retry');
    await dispatchSwipe(client, {
      x: retryBox.x + Math.min(250, retryBox.width - 18),
      y: retryBox.y + retryBox.height / 2,
    }, -82, 3);
    await replyBar.waitFor({ timeout: 5000 });
  }
  if (!(await page.locator('.chat-reply-bar-preview').innerText()).includes(traceTargetBody)) {
    throw new Error('trace swipe did not target the individual work message');
  }
  if (await traceLine.evaluate((node) => node.classList.contains('is-open')) !== traceWasOpen) {
    throw new Error('trace swipe also toggled the work line');
  }

  await browser.close();
  browser = undefined;
  const fatal = errors.filter((line) => {
    if (line.includes('[VersionCheck]')) return false;
    // The mission fixture has no desktop runner. Its optimistic dispatch shell
    // can be hydrated after the synthetic settle and return one expected 404;
    // the runner-backed dispatch itself is expected to shed with 503.
    if (line.includes('Failed to load resource: the server responded with a status of 404')) return false;
    if (line.includes('Failed to load resource: the server responded with a status of 503')) return false;
    return true;
  });
  if (fatal.length) throw new Error(`Runtime errors:\n${fatal.join('\n')}`);
  console.log('[verify-chat-swipe-reply-ui] OK — touch reply works for messages, missions, and run traces');
} catch (error) {
  console.error('[verify-chat-swipe-reply-ui] FAILED:', error);
  process.exitCode = 1;
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
  server.kill('SIGTERM');
}
