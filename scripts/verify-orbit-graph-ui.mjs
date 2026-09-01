#!/usr/bin/env node
/** Browser-level density, interaction, and responsive check for the built OrbitGraph. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';
import { stopChildProcess } from './lib/child-process.mjs';

const previewPort = await pickPort();
const root = new URL('..', import.meta.url).pathname;
const appUrl = `http://127.0.0.1:${previewPort}/app.html`;
const artifactDir = process.env.ORBIT_ARTIFACT_DIR || '/tmp/cascade-orbitgraph-review';
const vaultId = 'v-orbit';
const rootNoteId = 'note-index';

async function wait(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(150);
  }
  throw new Error(`timeout: ${url}`);
}

function realisticGraph(rootNoteId) {
  const notes = Array.from({ length: 96 }, (_, index) => ({
    id: index === 0 ? rootNoteId : `orbit-note-${index}`,
    title: index === 0 ? 'Index of working ideas' : `Working note ${index}`,
    kind: 'note',
    wordCount: index === 0 ? 2400 : 90 + (index % 9) * 55,
    archived: index > 88 ? 1 : 0,
  }));
  const chats = Array.from({ length: 20 }, (_, index) => ({
    id: `orbit-chat-${index}`,
    title: `Conversation ${index}`,
    kind: 'chat',
    wordCount: 0,
    archived: 0,
  }));
  const missing = Array.from({ length: 4 }, (_, index) => ({
    id: `orbit-missing-${index}`,
    title: `Unresolved thread ${index}`,
    kind: 'missing',
    wordCount: 0,
    archived: 0,
  }));
  return {
    nodes: [...notes, ...chats, ...missing],
    edges: [
      ...notes.slice(1).map((note, index) => ({
        source: note.id,
        target: index < 28 ? rootNoteId : notes[Math.floor(index / 3)].id,
        kind: 'wikilink',
      })),
      ...chats.map((chat, index) => ({ source: chat.id, target: notes[index * 3].id, kind: 'chat' })),
      ...missing.map((node, index) => ({ source: notes[index + 4].id, target: node.id, kind: 'wikilink' })),
    ],
  };
}

fs.mkdirSync(artifactDir, { recursive: true });
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], {
  cwd: root,
  env: { ...process.env, CASCADE_DISABLE_AUTO_REFRESH: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));

let browser;
try {
  await wait(appUrl);
  const graph = realisticGraph(rootNoteId);

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    const expectedSocketTeardown = response.status() === 400 && path === '/socket.io/';
    if (response.status() >= 400 && !expectedSocketTeardown) errors.push(`response ${response.status()}: ${path}`);
  });
  const socketReplies = [];
  await page.route('**/socket.io/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      const namespace = /40(\/[^,?]+)/.exec(request.postData() || '')?.[1];
      if (namespace) socketReplies.push(`40${namespace},{"sid":"orbit-ui"}`);
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
      return;
    }
    if (!url.searchParams.has('sid')) {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: '0{"sid":"orbit-ui","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}' });
      return;
    }
    await delay(40);
    await route.fulfill({ status: 200, contentType: 'text/plain', body: socketReplies.shift() || '6' });
  });
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(`${route.request().method()} ${path}`);
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return json({ authenticated: true, user: { id: 1, username: 'orbit_ui', displayName: 'Orbit UI', avatarUrl: '' }, owner: true });
    if (path === '/api/me/desktop-runner') return json({ online: false, runners: [] });
    if (path === '/api/community/updates') return json({ groups: [], counts: { total: 0, directMessages: 0, byVault: {}, byTarget: {} }, truncated: false });
    if (path === '/api/vaults') return json({ vaults: [{ id: vaultId, name: 'Research notebook', role: 'owner', memberCount: 1 }] });
    if (path === `/api/vaults/${vaultId}/graph`) return json(graph);
    if (/\/folders$/.test(path)) return json({ folders: [] });
    if (/\/notes$/.test(path)) return json({ notes: [{
      id: rootNoteId,
      vault_id: vaultId,
      folder_id: null,
      title: 'Index of working ideas',
      content_preview: '# Index',
      is_pinned: 1,
      is_archived: 0,
      is_listed: 1,
      position: 0,
      word_count: 2400,
      created_at: '2026-08-31 12:00:00',
      updated_at: '2026-08-31 12:00:00',
      tags: [],
    }] });
    if (/\/vault-agents$/.test(path) || /\/agents$/.test(path)) return json({ agents: [] });
    if (/\/messages$/.test(path)) return json({ messages: [] });
    if (/\/presence$/.test(path)) return json({ participants: [], online: [], owner: '', profiles: {} });
    if (path === `/api/notes/${rootNoteId}`) return json({ note: { id: rootNoteId, title: 'Index of working ideas', content: '# Index', tags: [] } });
    return json({});
  });
  await page.addInitScript(() => {
    localStorage.removeItem('cascade_session');
    localStorage.removeItem('cascade_session_v1');
    localStorage.removeItem('cascade_chat_state_v1');
    localStorage.setItem('cascade_disable_auto_refresh', 'true');
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => {
      const vault = document.querySelector('[aria-label="Open vault Research notebook"]');
      const orbit = document.querySelector('#orbit-btn');
      if (vault?.getAttribute('aria-current') !== 'page' || !(orbit instanceof HTMLButtonElement)) return false;
      orbit.click();
      return true;
    }, null, { timeout: 8000 });
  } catch (error) {
    console.error(`[orbit-ui] body: ${(await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1000)}`);
    console.error(`[orbit-ui] requests: ${requests.join(', ')}`);
    console.error(`[orbit-ui] errors: ${errors.join(', ')}`);
    throw error;
  }
  await page.locator('.orbit-node').first().waitFor();
  if (await page.locator('.orbit-node').count() !== 120) throw new Error('realistic graph did not render all 120 nodes');

  const defaultLabels = page.locator('.orbit-node[data-label-visible="true"]');
  if (await defaultLabels.count() !== 8) throw new Error(`default label budget drifted to ${await defaultLabels.count()}`);
  const defaultKinds = await defaultLabels.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-node-kind')));
  if (defaultKinds.some((kind) => kind !== 'note')) throw new Error(`default labels include non-notes: ${defaultKinds.join(',')}`);
  const noteWidth = await page.locator(`.orbit-node[data-node-id="${rootNoteId}"] .orbit-dot`).evaluate((node) => node.getBoundingClientRect().width);
  const chatWidth = await page.locator('.orbit-node[data-node-kind="chat"] .orbit-dot').first().evaluate((node) => node.getBoundingClientRect().width);
  if (noteWidth <= chatWidth * 1.4) throw new Error(`note/chat hierarchy is too weak (${noteWidth}/${chatWidth})`);
  const chatDash = await page.locator('.orbit-edge-line.is-chat').first().evaluate((node) => getComputedStyle(node).strokeDasharray);
  if (!chatDash || chatDash === 'none') throw new Error('chat references are not visually distinct from note links');

  await page.locator('.orbit-node[data-node-id="orbit-chat-0"]').hover();
  await page.locator('.orbit-edge-caption').first().waitFor();
  if (await page.locator('.orbit-node[data-label-visible="true"]').count() <= 8) {
    throw new Error('hover did not reveal the local reading trail');
  }
  await page.screenshot({ path: `${artifactDir}/orbit-wide-local-trail.png`, fullPage: true });

  await page.mouse.move(780, 520);
  for (let index = 0; index < 11; index += 1) await page.mouse.wheel(0, -120);
  await page.waitForTimeout(150);
  const zoomLabels = await page.locator('.orbit-node[data-label-visible="true"]').count();
  if (zoomLabels < 18) throw new Error(`zoom revealed only ${zoomLabels} labels`);
  await page.screenshot({ path: `${artifactDir}/orbit-wide-zoomed.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const vault = document.querySelector('[aria-label="Open vault Research notebook"]');
    const orbit = document.querySelector('#orbit-btn');
    if (vault?.getAttribute('aria-current') !== 'page' || !(orbit instanceof HTMLButtonElement)) return false;
    orbit.click();
    return true;
  });
  await page.locator('.orbit-node').first().waitFor();
  const headerBox = await page.locator('.orbit-graph-header').boundingBox();
  if (!headerBox || headerBox.x < 0 || headerBox.x + headerBox.width > 390) throw new Error('mobile graph header overflows');
  await page.screenshot({ path: `${artifactDir}/orbit-mobile.png`, fullPage: true });

  await page.locator(`.orbit-node[data-node-id="${rootNoteId}"]`).focus();
  if (!(await page.locator(`.orbit-node[data-node-id="${rootNoteId}"]`).evaluate((node) => node.classList.contains('is-focus')))) {
    throw new Error('keyboard focus did not select a local trail');
  }
  await page.keyboard.press('Enter');
  await page.locator('.orbit-modal').waitFor({ state: 'detached' });
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`[orbit-ui] OK — 120-node density, note/chat hierarchy, local reveal, zoom, keyboard, and mobile pass; artifacts: ${artifactDir}`);
} finally {
  await browser?.close();
  await stopChildProcess(preview);
}
