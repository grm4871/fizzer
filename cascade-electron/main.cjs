/**
 * @file main.cjs — Electron main process entry point
 *
 * Creates the main BrowserWindow, handles IPC for database operations and
 * keyboard shortcuts, and manages the application lifecycle. Provides
 * navigation security guards that restrict loading to the Cascade domains and local
 * dev origins. Keyboard shortcuts are intercepted at the main-process level
 * and forwarded to the renderer via IPC when Chromium would otherwise
 * swallow them. In production, loads https://cscd.online; in development,
 * loads the Vite dev server.
 *
 * @module cascade-electron/main
 */

// ═══════════════════════════════════════════════════════════════
// IMPORTS & CONFIG
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, session, Menu, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const explicitUserDataDir = process.env.CASCADE_USER_DATA_DIR || process.env.CASCADE_ELECTRON_DATA_DIR;
if (explicitUserDataDir) {
  const userDataDir = path.resolve(explicitUserDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
}

const db = require('./database.cjs');
const { startLocalAgentRun, cancelLocalAgentRun, reapOrphanedLocalAgentRuns } = require('./agent-runner.cjs');
const { connectDesktopRunner, disconnectDesktopRunner, isDesktopRunnerConnected, probeLocalModels } = require('./desktop-runner-host.cjs');
const { collectPlanUsage } = require('./plan-usage.cjs');
const { AgentRunState, settleCancelAcknowledgement } = require('./agent-run-state.cjs');
const worktrees = require('./worktrees.cjs');

// Suppress GLib-GObject and GTK warnings on Linux.
if (process.platform === 'linux') {
  process.env.G_MESSAGES_DEBUG = '';
  process.env.GTK_DEBUG = '';
}

let mainWindow;
let desktopUpdateInProgress = false;
const agentRunState = new AgentRunState();
// Removed: dead `serverProcess` variable — it was declared but never assigned,
// and the corresponding `if (serverProcess) serverProcess.kill()` in the
// 'closed' handler was therefore unreachable.

// ═══════════════════════════════════════════════════════════════
// WINDOW CREATION
// ═══════════════════════════════════════════════════════════════

/**
 * Checks whether the app is running in development mode.
 * Returns `true` when launched via `electron .` (i.e. not packaged).
 *
 * @returns {boolean}
 */
function isDevelopmentMode() {
  return !app.isPackaged;
}

/**
 * Application menu. No Debug menu — reload/devtools/zoom live on keyboard
 * shortcuts in configureWindow (Ctrl/Cmd+R, etc.).
 *
 * macOS still needs App/Edit/Window roles so Cmd+C/V/X/A work. Linux/Windows
 * get no menu bar (clipboard works on webContents without Edit roles).
 *
 * @returns {Electron.Menu | null}
 */
function buildApplicationMenu() {
  if (process.platform !== 'darwin') return null;

  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { role: 'windowMenu' },
  ]);
}

/**
 * Creates the main application window with security-hardened webPreferences.
 * Sets up navigation guards, keyboard shortcuts, and window lifecycle
 * handlers. In production the window loads https://cscd.online; in development
 * it loads the URL specified by the `--APP_URL=` CLI flag (defaults to
 * http://localhost:5173).
 */
/** Resolve the base URL the app loads from (prod vs dev `--APP_URL=`). */
function getAppBaseUrl() {
  if (app.isPackaged) return 'https://cscd.online';
  if (process.env.APP_URL || process.env.CASCADE_APP_URL) {
    return process.env.APP_URL || process.env.CASCADE_APP_URL;
  }
  const parsedArgs = {};
  process.argv.slice(2).forEach((arg) => {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      parsedArgs[key] = value || true;
    }
  });
  return parsedArgs['APP_URL'] || 'http://localhost:5173';
}

function getProjectRoot() {
  return path.resolve(__dirname, '..');
}

function getDesktopDownloadUrl() {
  return process.env.CASCADE_DESKTOP_DOWNLOAD_URL || 'https://cscd.online/download';
}

function canSelfUpdateFromSource() {
  if (app.isPackaged) return false;
  return fs.existsSync(path.join(getProjectRoot(), '.git'));
}

function runUpdateCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    let output = '';
    const appendOutput = (chunk) => {
      output = (output + chunk.toString()).slice(-16_000);
    };
    child.stdout.on('data', appendOutput);
    child.stderr.on('data', appendOutput);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        const rendered = [command, ...args].join(' ');
        reject(new Error(`${rendered} failed with exit code ${code}.\n${output}`.trim()));
      }
    });
  });
}

async function updateDesktopInPlace() {
  const root = getProjectRoot();
  const gitBin = process.platform === 'win32' ? 'git.exe' : 'git';

  // The desktop shell loads its UI from cscd.online, but its local agent
  // runner imports the generated dist/cli-agents module. dist is ignored, so a
  // source pull alone leaves CLI/harness fixes dormant until somebody happens
  // to build manually. Rebuild in place; it does not terminate main or active
  // agent processes.
  // Stash local changes so a dirty tree cannot abort the fast-forward pull,
  // and always restore them even if the local rebuild fails.
  const stashOut = await runUpdateCommand(gitBin, ['stash', '--include-untracked'], root);
  const didStash = !/No local changes to save/i.test(stashOut);
  try {
    await runUpdateCommand(gitBin, ['pull', '--ff-only'], root);
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    await runUpdateCommand(npmBin, ['run', 'build'], root);
  } finally {
    if (didStash) {
      await runUpdateCommand(gitBin, ['stash', 'pop'], root);
    }
  }
}

/** Reload every renderer without terminating the Electron main process. */
function refreshDesktopWindows() {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
  }
}

/** Send an IPC message to every live window. */
function broadcastToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function isAllowedNavHost(hostname) {
  return (
    hostname === 'cscd.online' ||
    hostname.endsWith('.cscd.online') ||
    hostname === 'localhost' ||
    hostname === '127.0.0.1'
  );
}

function canReachUrl(url) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve(false);
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const req = transport.request(
      parsed,
      { method: 'HEAD', timeout: 1000 },
      (res) => {
        res.resume();
        resolve(true);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function waitForAppUrl(url, timeoutMs = 30000) {
  if (app.isPackaged) return;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReachUrl(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.error(`[Main] Timed out waiting for app URL: ${url}`);
}

/**
 * Shared per-window wiring: navigation guards, external-window blocking, and
 * keyboard shortcuts. Applied to the main window and every popped-out pane
 * window so they behave identically.
 */
function configureWindow(win) {
  // Linux/Windows attach the application menu to each window. Even with
  // Menu.setApplicationMenu(null), a leftover window menu bar (e.g. old Debug)
  // can stick until we explicitly clear it per-window.
  if (process.platform !== 'darwin') {
    try { win.setMenu(null); } catch { /* ignore */ }
    try { win.setMenuBarVisibility(false); } catch { /* ignore */ }
    try { win.setAutoHideMenuBar(true); } catch { /* ignore */ }
  }

  const logDesktopLifecycle = (name, detail = {}) => {
    appendPerfLogLines({
      iso: new Date().toISOString(),
      t: Date.now(),
      kind: 'desktop-lifecycle',
      name,
      detail: { windowId: win.id, ...detail },
    });
  };
  win.on('unresponsive', () => logDesktopLifecycle('window.unresponsive'));
  win.on('responsive', () => logDesktopLifecycle('window.responsive'));
  // Renderer OOM/crashes leave a dead shell unless we reload. Keep agents alive
  // in main; only bounce the webContents (same path as Ctrl/Cmd+R).
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason || 'unknown';
    const exitCode = details?.exitCode;
    logDesktopLifecycle('renderer.gone', { reason, exitCode });
    console.error('[Main] render-process-gone', { windowId: win.id, reason, exitCode });
    // clean-exit is a normal teardown (window close / app quit) — do not reload.
    if (reason === 'clean-exit' || win.isDestroyed() || win.webContents.isDestroyed()) return;
    setTimeout(() => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      logDesktopLifecycle('renderer.recover-reload', { reason, exitCode });
      win.webContents.reloadIgnoringCache();
    }, 250);
  });

  // Block navigation to sites outside cscd.online / local dev.
  win.webContents.on('will-navigate', (event, url) => {
    try {
      if (!isAllowedNavHost(new URL(url).hostname)) {
        event.preventDefault();
        console.log('[Main] Blocked navigation to:', url);
      }
    } catch {
      event.preventDefault();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (!isAllowedNavHost(new URL(url).hostname)) {
        console.log('[Main] Blocked window open to:', url);
        return { action: 'deny' };
      }
    } catch {
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // No native Electron/Chromium right-click menu (Inspect Element, Back, etc.).
  // In-app React menus (sidebar/chat) use DOM handlers and still work.
  win.webContents.on('context-menu', (event) => {
    event.preventDefault();
  });
  win.on('system-context-menu', (event) => {
    event.preventDefault();
  });

  // Local keyboard shortcuts (only fire while this window is focused).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? input.meta : input.control;

    if (modifier && input.code === 'KeyR' && !input.shift) {
      event.preventDefault();
      win.webContents.reload();
    } else if (modifier && input.code === 'KeyR' && input.shift) {
      event.preventDefault();
      app.relaunch();
      app.quit();
    } else if (modifier && (input.code === 'Equal' || input.code === 'NumpadAdd')) {
      event.preventDefault();
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5);
    } else if (modifier && (input.code === 'Minus' || input.code === 'NumpadSubtract')) {
      event.preventDefault();
      win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5);
    } else if (modifier && (input.code === 'Digit0' || input.code === 'Numpad0')) {
      event.preventDefault();
      win.webContents.setZoomLevel(0);
    } else if (modifier && input.code === 'KeyN' && !input.shift) {
      // Chromium reserves Ctrl+N; intercept and forward to the renderer.
      event.preventDefault();
      win.webContents.send('shortcut', 'new-note');
    } else if (modifier && input.code === 'Backslash' && !input.shift) {
      event.preventDefault();
      win.webContents.send('shortcut', 'toggle-sidebar');
    }
  });
}

/**
 * Creates the main application window with security-hardened webPreferences.
 * In production it loads https://cscd.online; in development the `--APP_URL=` URL.
 */
async function createWindow() {
  // Always install (or clear) the app menu before windows open.
  Menu.setApplicationMenu(buildApplicationMenu());

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    // Never show a menu bar on Linux/Windows (Debug used to live here in
    // unpackaged launches). macOS uses the system menu bar via setApplicationMenu.
    autoHideMenuBar: process.platform !== 'darwin',
    // Keep the renderer warm while unfocused so alt-tab back doesn't wait on
    // Chromium's background timer/rAF throttle before first paint.
    backgroundThrottling: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  configureWindow(mainWindow);

  const baseUrl = getAppBaseUrl();
  await waitForAppUrl(baseUrl);
  console.log('[Main] Loading app URL:', baseUrl);
  mainWindow.loadURL(baseUrl);

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || app.isPackaged) return;
    console.error('[Main] Failed to load app URL:', errorCode, errorDescription, validatedURL);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadURL(getAppBaseUrl());
    }, 1000);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Open a note tab that was dragged out of a window into its own OS window.
 * The tab descriptor rides in the URL hash; the renderer detects `#popout=`
 * and renders a single-tab workspace.
 */
function createPaneWindow(descriptor, bounds) {
  const win = new BrowserWindow({
    width: (bounds && bounds.width) || 900,
    height: (bounds && bounds.height) || 680,
    x: bounds && bounds.x,
    y: bounds && bounds.y,
    autoHideMenuBar: process.platform !== 'darwin',
    backgroundThrottling: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  configureWindow(win);
  const hash = '#popout=' + encodeURIComponent(JSON.stringify(descriptor));
  win.loadURL(getAppBaseUrl() + hash);
  return win;
}

// ═══════════════════════════════════════════════════════════════
// DATABASE IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

/** Returns the full application config object (includes db_path). */
ipcMain.handle('db:getConfig', async () => {
  try {
    const config = db.getConfig();
    return { success: true, config };
  } catch (error) {
    console.error('[IPC] Failed to get config:', error);
    return { success: false, error: error.message };
  }
});

/** Updates the database file path in config.json and persists to disk. */
ipcMain.handle('db:updateDbPath', async (event, newPath) => {
  try {
    db.updateDbPath(newPath);
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to update db path:', error);
    return { success: false, error: error.message };
  }
});

/** Returns the absolute path to the application config directory. */
ipcMain.handle('db:getConfigDir', async () => {
  try {
    const configDir = db.getAppDataPath();
    return { success: true, configDir };
  } catch (error) {
    console.error('[IPC] Failed to get config dir:', error);
    return { success: false, error: error.message };
  }
});

/** Reads a small renderer setting from the local SQLite database. */
ipcMain.handle('db:getSetting', async (_event, key) => {
  try {
    return { success: true, value: db.getSetting(String(key)) };
  } catch (error) {
    console.error('[IPC] Failed to get setting:', error);
    return { success: false, error: error.message };
  }
});

/** Persists a small renderer setting in the local SQLite database. */
ipcMain.handle('db:setSetting', async (_event, { key, value }) => {
  try {
    db.setSetting(String(key), String(value ?? ''));
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to set setting:', error);
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════
// WINDOW IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

/**
 * Pop a tab out into its own OS window when it was dragged and released outside
 * the sending window. `screenX/screenY` are the drop point in screen pixels;
 * if they fall inside the sender's bounds we treat it as an in-window drop and
 * do nothing (`popped: false`), so the renderer keeps the tab where it is.
 */
ipcMain.handle('window:popOutTab', async (event, { tab, screenX, screenY }) => {
  try {
    if (!tab || typeof tab.id !== 'string') throw new Error('Missing tab descriptor');
    const senderWin = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const b = senderWin ? senderWin.getBounds() : { x: 0, y: 0, width: 0, height: 0 };
    const x = Number(screenX);
    const y = Number(screenY);
    const inside =
      Number.isFinite(x) && Number.isFinite(y) &&
      x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

    if (inside) return { success: true, popped: false };

    const width = 900;
    const height = 680;
    const bounds = {
      width,
      height,
      x: Number.isFinite(x) ? Math.round(x - width / 2) : undefined,
      y: Number.isFinite(y) ? Math.round(y - 40) : undefined,
    };
    createPaneWindow(tab, bounds);
    return { success: true, popped: true };
  } catch (error) {
    console.error('[IPC] Failed to pop out tab:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Merge a popped-out tab back into another window. Called when the popout's tab
 * is dragged and released outside the popout: the destination is the window
 * under the drop point (falling back to the main window), which is told to adopt
 * the tab; the now-empty popout window is closed.
 */
ipcMain.handle('window:mergeTab', async (event, { tab, screenX, screenY }) => {
  try {
    if (!tab || typeof tab.id !== 'string') throw new Error('Missing tab descriptor');
    const sender = BrowserWindow.fromWebContents(event.sender);
    const x = Number(screenX);
    const y = Number(screenY);
    const within = (b) => Number.isFinite(x) && Number.isFinite(y) && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;

    // Releasing inside the popout itself is not a merge gesture.
    if (sender && !sender.isDestroyed() && within(sender.getBounds())) {
      return { success: true, merged: false };
    }

    const target =
      BrowserWindow.getAllWindows().find((w) => w !== sender && !w.isDestroyed() && within(w.getBounds())) ||
      (sender !== mainWindow && mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

    if (!target) return { success: true, merged: false };

    target.webContents.send('window:adoptTab', tab);
    target.focus();
    if (sender && !sender.isDestroyed()) sender.close();
    return { success: true, merged: true };
  } catch (error) {
    console.error('[IPC] Failed to merge tab:', error);
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════
// LOCAL AGENT IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

/** Run a CLI agent (Grok, Codex, etc.) on this machine instead of the remote server. */
const localAgentRunPromises = new Map();
ipcMain.handle('agent:start', async (event, opts) => {
  try {
    const runId = Number(opts?.runId);
    if (!Number.isFinite(runId)) throw new Error('Invalid run id');
    // A renderer reload can make the server re-assert a delegation. The child
    // already owned by main must continue; never start a duplicate process.
    if (!agentRunState.start(runId)) return { success: true, alreadyRunning: true };
    const sendEvent = (payload) => {
      const eventPayload = agentRunState.record(payload);
      if (!eventPayload) return;
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('agent:event', eventPayload);
        }
      }
    };
    const runPromise = startLocalAgentRun(opts, sendEvent).catch((error) => {
      console.error('[IPC] Local agent run failed:', error);
      agentRunState.cancel(runId);
    }).finally(() => {
      if (localAgentRunPromises.get(runId) === runPromise) localAgentRunPromises.delete(runId);
    });
    localAgentRunPromises.set(runId, runPromise);
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to start local agent:', error);
    return { success: false, error: error.message };
  }
});

/** Cancel a locally running CLI agent process. */
ipcMain.handle('agent:cancel', async (_event, runId) => {
  try {
    const id = Number(runId);
    const running = localAgentRunPromises.get(id);
    const cancelled = await cancelLocalAgentRun(id);
    // Do not acknowledge steering until close/error cleanup has completed.
    // The CLI registry is cleared in the child's close handler just before the
    // owning promise settles; a Stop in that interval used to return false and
    // leave a terminal Akron run behind a stale "Could not cancel run" notice.
    const acknowledged = await settleCancelAcknowledgement(cancelled, running);
    agentRunState.cancel(runId);
    return { success: acknowledged };
  } catch (error) {
    console.error('[IPC] Failed to cancel local agent:', error);
    return { success: false, error: error.message };
  }
});

/** Restore main-owned runs and missed events after renderer reload/freeze. */
ipcMain.handle('agent:getState', async (_event, afterSeq = 0) => agentRunState.snapshot(afterSeq));

/** Configure helper env for local agent children (renderer owns /runners socket). */
ipcMain.handle('runner:setToken', async (_event, { token, apiUrl } = {}) => {
  try {
    return connectDesktopRunner(token, apiUrl);
  } catch (error) {
    console.error('[IPC] Failed to configure desktop runner:', error);
    return { success: false, error: error.message };
  }
});

/** Clear helper env on logout. */
ipcMain.handle('runner:clearToken', async () => {
  try {
    await disconnectDesktopRunner();
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to clear desktop runner:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('runner:status', async () => ({
  // Token present means main is configured; socket online is renderer-side.
  connected: isDesktopRunnerConnected(),
}));

ipcMain.handle('runner:models', async () => {
  try {
    return { models: probeLocalModels() };
  } catch (error) {
    console.error('[IPC] Failed to probe runner models:', error);
    return { models: {} };
  }
});

ipcMain.handle('runner:planUsage', async () => {
  try {
    const grokCwd = path.join(app.getPath('userData'), 'usage-probe');
    fs.mkdirSync(grokCwd, { recursive: true });
    return { usage: await collectPlanUsage({ grokCwd }) };
  } catch (error) {
    console.error('[IPC] Failed to probe subscription usage:', error);
    return { usage: {}, error: error.message };
  }
});

ipcMain.handle('clipboard:readImage', async () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return null;
  const url = image.toDataURL();
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!match) return null;
  return {
    media_type: match[1],
    data: match[2],
    url,
    name: 'clipboard-image.png',
  };
});

// ═══════════════════════════════════════════════════════════════
// NETDOC IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

/** Checks whether a netdoc with the given ID exists in the local database. */
ipcMain.handle('netdoc:exists', async (event, id) => {
  try {
    const exists = db.netdocExists(id);
    return { success: true, exists };
  } catch (error) {
    console.error('[IPC] Failed to check netdoc exists:', error);
    return { success: false, error: error.message };
  }
});

/** Retrieves a single netdoc row by ID, or null if not found. */
ipcMain.handle('netdoc:get', async (event, id) => {
  try {
    const netdoc = db.getNetdoc(id);
    return { success: true, netdoc };
  } catch (error) {
    console.error('[IPC] Failed to get netdoc:', error);
    return { success: false, error: error.message };
  }
});

/** Inserts or upserts a netdoc (id, name, content, canEdit) into the database. */
ipcMain.handle('netdoc:save', async (event, { id, name, content, canEdit }) => {
  try {
    const netdoc = db.saveNetdoc(id, name, content, canEdit);
    return { success: true, netdoc };
  } catch (error) {
    console.error('[IPC] Failed to save netdoc:', error);
    return { success: false, error: error.message };
  }
});

/** Updates the name and text content of an existing netdoc. */
ipcMain.handle('netdoc:updateContent', async (event, { id, name, content }) => {
  try {
    const updated = db.updateNetdocContent(id, name, content);
    return { success: true, updated };
  } catch (error) {
    console.error('[IPC] Failed to update netdoc content:', error);
    return { success: false, error: error.message };
  }
});

/** Permanently deletes a netdoc by ID (cascades to versions/comments). */
ipcMain.handle('netdoc:delete', async (event, id) => {
  try {
    const deleted = db.deleteNetdoc(id);
    return { success: true, deleted };
  } catch (error) {
    console.error('[IPC] Failed to delete netdoc:', error);
    return { success: false, error: error.message };
  }
});

/** Returns all saved versions for a netdoc, ordered newest-first. */
ipcMain.handle('netdoc:getVersions', async (event, netdocId) => {
  try {
    const versions = db.getNetdocVersions(netdocId);
    return { success: true, versions };
  } catch (error) {
    console.error('[IPC] Failed to get netdoc versions:', error);
    return { success: false, error: error.message };
  }
});

/** Saves a new version snapshot for a netdoc (id, netdocId, content, title, author). */
ipcMain.handle('netdoc:saveVersion', async (event, { id, netdocId, content, title, author }) => {
  try {
    db.saveNetdocVersion(id, netdocId, content, title, author);
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to save netdoc version:', error);
    return { success: false, error: error.message };
  }
});

/** Returns the text content of the most recent version for diff comparison. */
ipcMain.handle('netdoc:getLatestVersionContent', async (event, netdocId) => {
  try {
    const content = db.getLatestVersionContent(netdocId);
    return { success: true, content };
  } catch (error) {
    console.error('[IPC] Failed to get latest version content:', error);
    return { success: false, error: error.message };
  }
});

// ── Perf / freeze log (renderer → disk for agents) ───────────
// JSONL append-only. Primary: userData/logs/cascade-perf.jsonl
// Mirror: os.tmpdir()/cascade-perf.jsonl (easy for desktop agents).
const PERF_LOG_MAX_BYTES = 2 * 1024 * 1024;

function getPerfLogPaths() {
  const primary = path.join(app.getPath('userData'), 'logs', 'cascade-perf.jsonl');
  const mirror = path.join(os.tmpdir(), 'cascade-perf.jsonl');
  return { primary, mirror, paths: [primary, mirror] };
}

function rotatePerfLogIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const st = fs.statSync(filePath);
    if (st.size < PERF_LOG_MAX_BYTES) return;
    const text = fs.readFileSync(filePath, 'utf8');
    // Keep roughly the last half so we don't thrash on every write after cap.
    const keepFrom = Math.floor(text.length / 2);
    const cut = text.indexOf('\n', keepFrom);
    const kept = cut >= 0 ? text.slice(cut + 1) : text.slice(keepFrom);
    fs.writeFileSync(filePath, kept, 'utf8');
  } catch (err) {
    console.warn('[perf] rotate failed', filePath, err?.message || err);
  }
}

function appendPerfLogLines(lines) {
  const rows = (Array.isArray(lines) ? lines : [lines])
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .filter((line) => line && line.trim().length > 0);
  if (rows.length === 0) return getPerfLogPaths();

  const chunk = `${rows.join('\n')}\n`;
  const { primary, mirror, paths } = getPerfLogPaths();
  for (const filePath of paths) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotatePerfLogIfNeeded(filePath);
      fs.appendFileSync(filePath, chunk, 'utf8');
    } catch (err) {
      console.warn('[perf] append failed', filePath, err?.message || err);
    }
  }
  return { primary, mirror, paths };
}

ipcMain.handle('perf:append', async (_event, lines) => {
  try {
    return { success: true, ...appendPerfLogLines(lines) };
  } catch (error) {
    console.error('[IPC] perf:append failed:', error);
    return { success: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('perf:getPath', async () => {
  try {
    const { primary, mirror, paths } = getPerfLogPaths();
    return { success: true, primary, mirror, paths };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
});

// ── Task workspaces (git worktrees) and pull requests ────────
// Git and `gh` only ever run in the main process; the renderer sends the
// channel's working directory and gets structured status back.
ipcMain.handle('worktree:list', async (_event, { dir } = {}) => worktrees.listWorkspaces(dir));
ipcMain.handle('worktree:status', async (_event, { dir } = {}) => worktrees.workspaceStatus(dir));
ipcMain.handle('worktree:create', async (_event, opts = {}) => worktrees.createWorkspace(opts));
ipcMain.handle('worktree:remove', async (_event, opts = {}) => worktrees.removeWorkspace(opts));
ipcMain.handle('worktree:createPullRequest', async (_event, opts = {}) => worktrees.createPullRequest(opts));
ipcMain.handle('worktree:pullRequest', async (_event, { dir } = {}) => worktrees.pullRequestStatus(dir));

// ── Desktop app update ───────────────────────────────────────
// Keep the original channel name so updated hosted UI remains compatible with
// desktop shells that have not received the in-place updater yet.
ipcMain.handle('app:updateAndRestart', async () => {
  try {
    if (desktopUpdateInProgress) {
      return { success: false, error: 'A desktop update is already running.' };
    }

    if (!canSelfUpdateFromSource()) {
      const downloadUrl = getDesktopDownloadUrl();
      await shell.openExternal(downloadUrl);
      return {
        success: false,
        error: `This installed build cannot update itself yet. Opened ${downloadUrl} to download the latest desktop app.`,
      };
    }

    desktopUpdateInProgress = true;
    void updateDesktopInPlace()
      .then(() => {
        desktopUpdateInProgress = false;
        refreshDesktopWindows();
      })
      .catch((error) => {
        desktopUpdateInProgress = false;
        console.error('[IPC] Desktop update failed:', error);
        broadcastToWindows('app:updateFailed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return { success: true, refreshing: true };
  } catch (error) {
    desktopUpdateInProgress = false;
    console.error('[IPC] Desktop update failed:', error);
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ═══════════════════════════════════════════════════════════════

  app.whenReady().then(async () => {
  try {
    await reapOrphanedLocalAgentRuns();
  } catch (error) {
    console.error('[Main] Failed to reap orphaned agent processes:', error);
  }
  // Initialize database
  try {
    db.initDatabase();
  } catch (error) {
    console.error('[Main] Failed to initialize database:', error);
  }

  // Allow app-shell permissions needed by the hosted app.
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  // Brief delay to ensure database initialization completes
  setTimeout(() => {
    void createWindow();
  }, 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  disconnectDesktopRunner();
  try {
    db.closeDatabase();
  } catch (_) {}
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
