#!/usr/bin/env node
/**
 * Load the built client in headless Chromium and fail on console/page errors.
 * Usage: node scripts/verify-client-runtime.mjs [--url http://localhost:4173/app.html]
 */
import { spawn } from 'child_process';
import { setTimeout as delay } from 'timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const explicitUrl = process.argv.find((arg) => arg.startsWith('http'));
const targetUrl = explicitUrl || `http://127.0.0.1:${await pickPort()}/app.html`;
const previewPort = Number(new URL(targetUrl).port || 4173);

async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return;
    } catch {
      // retry
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let preview;
if (!process.argv.includes('--no-preview')) {
  preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VITE_API_URL: process.env.VITE_API_URL || 'http://127.0.0.1:3000' },
  });
  preview.stdout.on('data', (chunk) => process.stdout.write(`[preview] ${chunk}`));
  preview.stderr.on('data', (chunk) => process.stderr.write(`[preview] ${chunk}`));
}

try {
  await waitForUrl(targetUrl);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];

  // A static Vite preview has no API process. Cookie sessions cannot be
  // detected from JavaScript, so the app intentionally probes /api/session;
  // model the anonymous server response instead of treating proxy failure as
  // a renderer failure. Production --no-preview checks still hit the real API.
  if (preview) {
    await page.route('**/api/session', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: false }),
    }));
  }

  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });

  const response = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 60000 });
  if (!response || !response.ok()) {
    throw new Error(`Failed to load ${targetUrl}: ${response?.status()}`);
  }

  // Give React a moment to mount hooks that previously threw ReferenceError.
  await page.waitForTimeout(2000);

  await browser.close();

  const fatal = errors.filter((line) => !line.includes('[VersionCheck]'));
  if (fatal.length > 0) {
    console.error('[verify-client-runtime] Runtime errors detected:');
    for (const line of fatal) console.error(`  - ${line}`);
    process.exit(1);
  }

  console.log(`[verify-client-runtime] OK — loaded ${targetUrl} with no fatal runtime errors`);
} catch (error) {
  console.error('[verify-client-runtime] FAILED:', error);
  process.exit(1);
} finally {
  if (preview) {
    preview.kill('SIGTERM');
  }
}
