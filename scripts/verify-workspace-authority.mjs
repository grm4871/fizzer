#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { pickPort } from './lib/test-ports.mjs';

const port = await pickPort();
const url = `http://127.0.0.1:${port}/app.html`;
const preview = spawn('npm', ['--workspace=client', 'run', 'preview', '--', '--host', '127.0.0.1', '--port', String(port)], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    if (i === 60) throw new Error('Preview did not start');
    await delay(250);
  }
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/socket.io/**', (route) => route.abort());
    const vaults = ['a', 'b'].map((id) => ({ id, name: `Vault ${id}`, role: 'owner', owner_id: 1 }));
    const notes = Object.fromEntries(['a', 'b'].flatMap((vault_id) => ['note', 'chat'].map((kind) => {
      const id = `${vault_id}-${kind}`;
      const content = kind === 'chat' ? 'cascade://chat-channel' : `Body ${vault_id}`;
      return [id, { id, vault_id, title: `${vault_id} ${kind}`, content, content_preview: content, folder_id: null, tags: [], is_pinned: 0, is_archived: 0, is_listed: 0, position: 0, word_count: 2, created_at: '2026-01-01', updated_at: '2026-01-01' }];
    })));
    let finishSave;
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      let body = {};
      if (route.request().method() === 'PUT' && path === '/api/notes/a-note') {
        const content = route.request().postDataJSON().content;
        await new Promise((resolve) => { finishSave = resolve; });
        notes['a-note'] = { ...notes['a-note'], content, content_preview: content };
      }
      if (path === '/api/session') body = { authenticated: true, user: { id: 1, username: 'verifier' } };
      else if (path === '/api/vaults') body = { vaults };
      else if (/\/vaults\/[ab]\/notes$/.test(path)) body = { notes: Object.values(notes).filter((note) => note.vault_id === path.split('/')[3]) };
      else if (/\/notes\/[ab]-/.test(path)) body = { note: notes[path.split('/')[3]] };
      else if (path.endsWith('/folders')) body = { folders: [] };
      else if (path.endsWith('/presence')) body = { participants: [], online: [], owner: 'verifier', profiles: {} };
      else if (path.endsWith('/messages')) body = { messages: [] };
      else if (path.endsWith('/agents') || path.endsWith('/vault-agents')) body = { agents: [] };
      else if (path === '/api/community/updates') body = { groups: [], counts: { total: 0, directMessages: 0, byVault: {}, byTarget: {} }, truncated: false };
      await route.fulfill({ json: body });
    });
    await page.addInitScript(() => {
      const pane = (id, tabId) => ({ type: 'pane', id, tabIds: [tabId], activeTabId: tabId });
      const workspacesByVault = Object.fromEntries(['a', 'b'].map((id) => [id, {
        openTabs: [{ id: `${id}-note`, title: `${id} note`, type: 'note', dirty: false }, { id: `${id}-chat`, title: `${id} chat`, type: 'chat', dirty: false }],
        layout: { type: 'split', id: `${id}-split`, direction: 'row', sizes: [50, 50], children: [pane(`${id}-left`, `${id}-note`), pane(`${id}-right`, `${id}-chat`)] },
        focusedPaneId: `${id}-left`,
      }]));
      if (!localStorage.getItem('cascade_session')) localStorage.setItem('cascade_session', JSON.stringify({ activeVaultId: 'a', workspacesByVault }));
    });
    await page.goto(url);
    await page.locator('.tab-item[title="a note"]').waitFor({ timeout: 10000 }).catch(async (error) => {
      throw new Error(`${error.message}\n${await page.locator('body').innerText()}\n${errors.join('\n')}`);
    });
    await page.locator('.tab-item[title="a chat"]').waitFor();
    await page.locator('.cm-content').first().waitFor();
    await page.locator('.cm-content').first().fill('Memory-only draft');
    async function switchVault(id) {
      const button = page.getByRole('button', { name: `Open vault Vault ${id}`, exact: true });
      if (!await button.isVisible()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).first().click();
      await button.click();
      if (viewport.width <= 900) await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
      await page.locator(`.tab-item[title="${id} note"]`).waitFor();
    }
    const saving = page.waitForRequest((request) => request.method() === 'PUT' && request.url().endsWith('/api/notes/a-note'));
    await page.locator('.cm-content').first().press('Control+Shift+s');
    await saving;
    await page.locator('.cm-content').first().fill('Newer memory-only draft');
    await switchVault('b');
    const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().endsWith('/api/notes/a-note'));
    assert(finishSave, 'Save request must be held before switching vaults');
    finishSave();
    await saved;
    assert.equal(await page.locator('.tab-item[title="a note"]').count(), 0);
    await page.locator('.tab-item[title="b chat"]').click();
    await switchVault('a');
    assert.equal(await page.locator('.cm-content').first().innerText(), 'Newer memory-only draft');
    await page.locator('.tab-item[title="a chat"] .tab-close').click();
    assert.equal(await page.locator('.tab-item[title="a chat"]').count(), 0);
    await switchVault('b');
    await switchVault('a');
    assert.equal(await page.locator('.tab-item[title="a chat"]').count(), 0);
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const stored = await page.evaluate(() => localStorage.getItem('cascade_session'));
    assert(!stored.includes('Newer memory-only draft'));
    assert(!stored.includes('noteContents'));
    assert.equal(JSON.parse(stored).workspacesByVault.b.openTabs.length, 2);
    await page.reload();
    await page.locator('.cm-content').first().waitFor();
    assert.equal(await page.locator('.cm-content').first().innerText(), 'Memory-only draft');
    let finishListing;
    await page.route('**/api/vaults/b/notes', async (route) => {
      await new Promise((resolve) => { finishListing = resolve; });
      await route.fulfill({ json: { notes: [notes['b-note']] } });
    });
    const listingRequest = page.waitForRequest('**/api/vaults/b/notes');
    await switchVault('b');
    await listingRequest;
    const logout = page.locator('#logout-btn');
    if (!await logout.isVisible()) await page.getByRole('button', { name: 'Expand sidebar', exact: true }).first().click();
    await logout.focus();
    await logout.press('Enter');
    const listingResponse = page.waitForResponse('**/api/vaults/b/notes');
    assert(finishListing, 'Listing request must be held before logout');
    finishListing();
    await listingResponse;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const loggedOut = await page.evaluate(() => JSON.parse(localStorage.getItem('cascade_session') || '{}'));
    assert.equal(loggedOut.activeVaultId ?? null, null);
    assert.deepEqual(loggedOut.vaultListingsByVault ?? {}, {});
    assert.deepEqual(loggedOut.workspacesByVault ?? {}, {});
    assert.deepEqual(errors, []);
    console.log(`PASS ${viewport.width}x${viewport.height}: two vaults, note/chat split panes, edits, focus, close, switch, persistence, reload, delayed save and late listing after logout`);
    await page.close();
  }
} finally {
  await browser?.close();
  preview.kill('SIGTERM');
}
