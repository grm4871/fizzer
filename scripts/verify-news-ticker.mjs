#!/usr/bin/env node
/**
 * Ad-hoc runtime check for the toolbar news ticker: it renders, it actually
 * moves, and it advances to a different headline when a scroll finishes.
 * Build first: `npm run build && npm run build:client`.
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';
import { spawnElixirApi } from './lib/elixir-api.mjs';

const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const PREVIEW_PORT = Number(process.env.TEST_PREVIEW_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const APP_URL = `http://127.0.0.1:${PREVIEW_PORT}/app.html`;
const DB_PATH = `/tmp/cascade-newsticker-${API_PORT}.db`;
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
  if (cond) console.log(`[news-ticker] OK  ${name}`);
  else { console.error(`[news-ticker] FAIL ${name}${detail ? ` — ${detail}` : ''}`); failures++; }
}

const server = spawnElixirApi(root, {
    port: API_PORT,
    dbPath: DB_PATH,
    extraEnv: {
      JWT_SECRET: 'newsticker-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
  });
server.stderr.on('data', (c) => process.stderr.write(`[server-err] ${c}`));

const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(PREVIEW_PORT)], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, API_PORT: String(API_PORT) },
});
preview.stderr.on('data', (c) => process.stderr.write(`[preview] ${c}`));

let browser;
try {
  await waitForUrl(`${API_BASE}/api/health`);
  await waitForUrl(APP_URL);

  const stamp = Date.now();
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username: `news_${stamp}`, password: 'testpass12345' }),
  });
  const auth = { Authorization: `Bearer ${token}` };
  const { vault } = await must(`${API_BASE}/api/vaults`, { method: 'POST', headers: auth, body: JSON.stringify({ name: `News ${stamp}` }) });
  await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
    method: 'POST', headers: auth, body: JSON.stringify({ title: 'news-chan', content: 'cascade://chat-channel' }),
  });

  const { chromium } = await import('playwright');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => localStorage.setItem('docs_token', t), token);
  await page.goto(APP_URL, { waitUntil: 'networkidle' });

  const track = page.locator('.news-ticker-track');
  await track.waitFor({ timeout: 20000 });
  check('ticker renders in the workspace toolbar', await page.locator('.workspace-toolbar .news-ticker').count() === 1);

  const first = (await track.innerText()).trim();
  check('headline is non-empty', first.length > 0, first);
  check('ticker is animating', await track.evaluate((el) => el.classList.contains('is-running')));

  const x1 = (await track.boundingBox())?.x;
  await delay(1200);
  const x2 = (await track.boundingBox())?.x;
  check('headline scrolls right-to-left', Number.isFinite(x1) && Number.isFinite(x2) && x2 < x1, `${x1} → ${x2}`);

  // The long scrolling line must not widen the toolbar or the document — it is
  // clipped by the strip, not laid out into the bar.
  const overflow = await page.evaluate(() => {
    const bar = document.querySelector('.workspace-toolbar');
    return {
      barScroll: bar.scrollWidth, barClient: bar.clientWidth,
      docScroll: document.documentElement.scrollWidth, docClient: document.documentElement.clientWidth,
    };
  });
  check(
    'scrolling text does not overflow the toolbar or page',
    overflow.barScroll <= overflow.barClient + 1 && overflow.docScroll <= overflow.docClient + 1,
    JSON.stringify(overflow),
  );

  // Electron/window restore can mount the toolbar while it has zero width.
  // The ticker must remain readable, then resume motion when layout returns.
  await page.locator('.workspace-toolbar').evaluate((el) => { el.style.display = 'none'; });
  await page.waitForFunction(() => document.querySelector('.news-ticker-track')?.classList.contains('is-static'));
  check('ticker stays visible while its toolbar has no width', await track.isVisible() === false
    && await track.evaluate((el) => el.classList.contains('is-static')));
  await page.locator('.workspace-toolbar').evaluate((el) => { el.style.display = 'flex'; });
  await page.waitForFunction(() => document.querySelector('.news-ticker-track')?.classList.contains('is-running'));
  check('ticker resumes after toolbar layout returns', await track.evaluate((el) => el.classList.contains('is-running')));

  // Fast-forward the animation so the next headline is drawn without waiting
  // out a full pass.
  await track.evaluate((el) => { el.style.animationDuration = '0.4s'; });
  await page.waitForFunction(
    (prev) => {
      const el = document.querySelector('.news-ticker-track');
      return el && el.textContent.trim() !== prev;
    },
    first,
    { timeout: 20000 },
  );
  const second = (await page.locator('.news-ticker-track').innerText()).trim();
  check('advances to a different headline', second !== first, `${first} → ${second}`);

  check('no runtime errors', errors.length === 0, errors.join(' | '));

  if (process.env.NEWS_TICKER_SHOT) {
    // Freeze at chosen points of the pass: mid-bar, and exiting past the label
    // (where a hard left-edge cut would show).
    for (const phase of [0.5, 0.88]) {
      await page.locator('.news-ticker-track').evaluate((el, p) => {
        const seconds = parseFloat(getComputedStyle(el).animationDuration) || 10;
        el.style.animationDuration = `${seconds}s`;
        el.style.animationDelay = `-${seconds * p}s`;
        el.style.animationPlayState = 'paused';
      }, phase);
      await page.locator('.workspace-toolbar').screenshot({
        path: process.env.NEWS_TICKER_SHOT.replace(/\.png$/, `-${Math.round(phase * 100)}.png`),
      });
    }
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  preview.kill('SIGTERM');
}

process.exit(failures ? 1 : 0);
