#!/usr/bin/env node
/**
 * Verify rendered client style contracts in Chromium.
 * Usage: node scripts/verify-client-styles.mjs [http://localhost:4173/app.html] [--no-preview]
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { pickPort } from './lib/test-ports.mjs';

const explicitUrl =
  process.argv.find((arg) => arg.startsWith('http')) ||
  process.argv.find((arg) => arg.startsWith('--url='))?.slice('--url='.length) ||
  (process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : undefined);
const targetUrl = explicitUrl || `http://127.0.0.1:${await pickPort()}/app.html`;
const previewPort = Number(new URL(targetUrl).port || 4173);
const root = new URL('..', import.meta.url).pathname;

async function waitForUrl(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return;
    } catch {
      // The preview may still be starting.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

let preview;
if (!process.argv.includes('--no-preview')) {
  preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(previewPort)], {
    cwd: root,
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
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const response = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (!response || !response.ok()) {
      throw new Error(`Failed to load ${targetUrl}: ${response?.status()}`);
    }

    const styles = await page.evaluate(() => {
      const fixture = document.createElement('div');
      fixture.id = 'client-style-verification-fixture';
      fixture.style.cssText = 'position:fixed;left:-10000px;top:0;width:400px;height:400px;pointer-events:none;';
      fixture.innerHTML = `
        <div class="chat-avatar" data-avatar="chat"><img alt="" /></div>
        <div class="sidebar-footer"><div class="user-avatar" data-avatar="sidebar"><img alt="" /></div></div>
        <div class="account-avatar-preview" data-avatar="account"><img alt="" /></div>
        <div class="session-manager-avatar" data-avatar="session"><img alt="" /></div>
        <div class="chat-work-trace">
          <div class="chat-work-line-body">
            <div class="cascade-run-panel open">
              <div class="crp-term"><pre class="crp-term-pre">output</pre></div>
            </div>
          </div>
        </div>`;
      document.body.append(fixture);

      const avatarSelectors = [
        ['chat', '[data-avatar="chat"]'],
        ['sidebar', '[data-avatar="sidebar"]'],
        ['account', '[data-avatar="account"]'],
        ['session', '[data-avatar="session"]'],
      ];
      const avatars = avatarSelectors.flatMap(([name, selector]) => {
        const outer = fixture.querySelector(selector);
        const image = outer?.querySelector('img');
        return [
          ['outer', name, outer],
          ['image', name, image],
        ].map(([kind, surface, element]) => {
          const style = element ? getComputedStyle(element) : null;
          return {
            kind,
            surface,
            exists: Boolean(element),
            borderRadius: style?.borderRadius || '',
            borderTopLeftRadius: style?.borderTopLeftRadius || '',
          };
        });
      });

      const panel = fixture.querySelector('.cascade-run-panel');
      const lineBody = fixture.querySelector('.chat-work-line-body');
      const terms = [...fixture.querySelectorAll('.crp-term, .crp-term-pre')];
      const panelStyle = panel ? getComputedStyle(panel) : null;
      const lineBodyStyle = lineBody ? getComputedStyle(lineBody) : null;
      return {
        avatars,
        panel: panelStyle
          ? {
              borderTopWidth: panelStyle.borderTopWidth,
              borderRightWidth: panelStyle.borderRightWidth,
              borderBottomWidth: panelStyle.borderBottomWidth,
              borderLeftWidth: panelStyle.borderLeftWidth,
              borderRadius: panelStyle.borderRadius,
              backgroundColor: panelStyle.backgroundColor,
            }
          : null,
        terms: terms.map((term) => ({ className: term.className, overflow: getComputedStyle(term).overflow })),
        lineBody: lineBodyStyle ? { borderLeftWidth: lineBodyStyle.borderLeftWidth } : null,
      };
    });

    const failures = [];
    for (const avatar of styles.avatars) {
      if (!avatar.exists) failures.push(`missing ${avatar.kind} ${avatar.surface} avatar`);
      if (avatar.borderRadius !== '50%' || avatar.borderTopLeftRadius !== '50%') {
        failures.push(`${avatar.kind} ${avatar.surface} avatar is ${avatar.borderRadius || 'unset'}, not circular`);
      }
    }
    if (!styles.panel) {
      failures.push('missing cascade-run-panel fixture');
    } else {
      for (const side of ['borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
        if (styles.panel[side] !== '0px') failures.push(`panel ${side} is ${styles.panel[side]}`);
      }
      if (styles.panel.borderRadius !== '0px') failures.push(`panel border radius is ${styles.panel.borderRadius}`);
      if (!['transparent', 'rgba(0, 0, 0, 0)'].includes(styles.panel.backgroundColor)) {
        failures.push(`panel background is ${styles.panel.backgroundColor}`);
      }
    }
    for (const term of styles.terms) {
      if (term.overflow !== 'visible') failures.push(`${term.className} overflow is ${term.overflow}`);
    }
    if (!styles.lineBody || styles.lineBody.borderLeftWidth !== '0px') {
      failures.push(`work-line-body border-left is ${styles.lineBody?.borderLeftWidth || 'unset'}`);
    }
    if (failures.length > 0) throw new Error(failures.join('; '));
    console.log(`[verify-client-styles] OK — rendered CSS contracts verified at ${targetUrl}`);
  } finally {
    await browser.close();
  }
} catch (error) {
  console.error('[verify-client-styles] FAILED:', error);
  process.exit(1);
} finally {
  if (preview) preview.kill('SIGTERM');
}
