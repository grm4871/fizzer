/**
 * @file main.cjs — Electron main process entry point
 *
 * Creates the main BrowserWindow, handles IPC for database operations and
 * keyboard shortcuts, and manages the application lifecycle. Provides
 * navigation security guards that restrict loading to netar.is and local
 * dev origins. Keyboard shortcuts are intercepted at the main-process level
 * and forwarded to the renderer via IPC when Chromium would otherwise
 * swallow them. In production, loads https://netar.is; in development,
 * loads the Vite dev server.
 *
 * @module cascade-electron/main
 */

// ═══════════════════════════════════════════════════════════════
// IMPORTS & CONFIG
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, session, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const db = require('./database.cjs');

// Suppress GLib-GObject and GTK warnings on Linux, and disable hardware acceleration to fix blank webviews
if (process.platform === 'linux') {
  process.env.G_MESSAGES_DEBUG = '';
  process.env.GTK_DEBUG = '';
  app.disableHardwareAcceleration();
}

let mainWindow;
const WEBVIEW_PARTITION = 'persist:webview';
const DEFAULT_ADBLOCK_SETTINGS = Object.freeze({
  enabled: true,
  disabledSites: [],
});
let adBlocker = null;
let webviewBrowserSession = null;
let activeWebviewSite = '';
const webContentsSites = new Map();
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
 * Builds a debug-only application menu with Reload, DevTools, and Zoom
 * controls. Returns `null` in production so the default menu is suppressed.
 *
 * @returns {Electron.Menu | null}
 */
function buildApplicationMenu() {
  if (!isDevelopmentMode()) return null;

  return Menu.buildFromTemplate([
    {
      label: 'Debug',
      submenu: [
        { role: 'reload', label: 'Reload' },
        { role: 'forceReload', label: 'Force Reload' },
        { role: 'toggleDevTools', label: 'Toggle DevTools' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Actual Size' },
        { role: 'zoomIn', label: 'Zoom In' },
        { role: 'zoomOut', label: 'Zoom Out' },
      ],
    },
  ]);
}

/**
 * Build a mainstream Chrome user agent for embedded browsing. Electron's
 * default UA includes an Electron token, which some sites treat as a bot,
 * unsupported browser, or adblock-like environment.
 *
 * @returns {string}
 */
function buildBrowserLikeUserAgent() {
  const chromeVersion = process.versions.chrome || '120.0.0.0';

  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
  }

  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

// ═══════════════════════════════════════════════════════════════
// ANTI-ADBLOCK DEFUSER
// ═══════════════════════════════════════════════════════════════

/**
 * Script injected into every <webview> page to neutralize "you're using an
 * adblocker" walls. Many sites (ZDNet, Forbes, etc.) render a full-viewport
 * modal that dims/locks the page. This runs independently of our adblock
 * toggle: it finds high-z-index / full-viewport overlays whose text mentions
 * ad blocking, removes them, and restores scrolling. A MutationObserver plus
 * a low-frequency interval catch modals that appear after initial load.
 */
const ANTI_ADBLOCK_DEFUSER = `
(function () {
  if (window.__cascadeAntiAdblockDefuser) return;
  window.__cascadeAntiAdblockDefuser = true;

  var KEYWORDS = [
    'adblock', 'ad block', 'ad-block', 'ad blocker', 'using an ad',
    'disable your ad', 'turn off your ad', 'whitelist', 'allow ads',
    'support us by', 'we rely on advertising'
  ];

  function textMatches(el) {
    var text = (el.textContent || '').toLowerCase();
    if (!text || text.length > 2000) return false;
    for (var i = 0; i < KEYWORDS.length; i++) {
      if (text.indexOf(KEYWORDS[i]) !== -1) return true;
    }
    return false;
  }

  function isOverlay(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var style;
    try { style = getComputedStyle(el); } catch (e) { return false; }
    if (style.position !== 'fixed' && style.position !== 'absolute') return false;
    var z = parseInt(style.zIndex, 10) || 0;
    var rect = el.getBoundingClientRect();
    var coversViewport = rect.width >= window.innerWidth * 0.8 &&
                         rect.height >= window.innerHeight * 0.6;
    return z >= 1000 || coversViewport;
  }

  function topOverlay(el) {
    var best = isOverlay(el) ? el : null;
    var parent = el.parentElement;
    var hops = 0;
    while (parent && parent !== document.body && hops < 6) {
      if (isOverlay(parent)) best = parent;
      parent = parent.parentElement;
      hops++;
    }
    return best;
  }

  function unlockScroll() {
    [document.documentElement, document.body].forEach(function (el) {
      if (!el) return;
      el.style.setProperty('overflow', 'auto', 'important');
      el.style.setProperty('position', 'static', 'important');
      ['modal-open', 'no-scroll', 'noscroll', 'overflow-hidden',
       'adblock', 'ad-block', 'has-adblock'].forEach(function (c) {
        el.classList.remove(c);
      });
    });
  }

  function sweep() {
    var removed = false;
    var nodes = document.querySelectorAll('div, section, aside, dialog');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!el.isConnected || !textMatches(el)) continue;
      var target = topOverlay(el);
      if (!target) continue;
      target.remove();
      removed = true;
    }
    if (removed) unlockScroll();
  }

  function run() { try { sweep(); } catch (e) {} }

  run();
  var observer = new MutationObserver(run);
  function observe() {
    if (document.body) observer.observe(document.body, { childList: true, subtree: true });
  }
  observe();
  document.addEventListener('DOMContentLoaded', function () { run(); observe(); });
  setInterval(run, 1000);
})();
`;

function injectAntiAdblockDefuser(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  webContents.executeJavaScript(ANTI_ADBLOCK_DEFUSER, true).catch((error) => {
    console.error('[AntiAdblock] Injection failed:', error?.message || error);
  });
}

function normalizeSite(urlOrHostname) {
  try {
    const parsedUrl = /^[a-z][a-z\d+.-]*:/i.test(urlOrHostname)
      ? new URL(urlOrHostname)
      : new URL(`https://${urlOrHostname}`);
    return parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function getAdBlockSettings() {
  const config = db.getConfig() || {};
  const adblock = config.browser?.adblock || {};
  const disabledSites = Array.isArray(adblock.disabledSites)
    ? [...new Set(adblock.disabledSites.map((site) => normalizeSite(String(site))).filter(Boolean))]
    : [];

  return {
    enabled: typeof adblock.enabled === 'boolean' ? adblock.enabled : DEFAULT_ADBLOCK_SETTINGS.enabled,
    disabledSites,
  };
}

function saveAdBlockSettings(settings) {
  const config = db.getConfig();
  const configPath = db.getConfigPath();
  if (!config || !configPath) throw new Error('Config not initialized');

  config.browser = {
    ...(config.browser || {}),
    adblock: {
      enabled: Boolean(settings.enabled),
      disabledSites: [...new Set((settings.disabledSites || []).map(normalizeSite).filter(Boolean))].sort(),
    },
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function isSiteAdBlockEnabled(site) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return getAdBlockSettings().enabled;

  const settings = getAdBlockSettings();
  if (!settings.enabled) return false;
  return !settings.disabledSites.some((disabledSite) =>
    normalizedSite === disabledSite || normalizedSite.endsWith(`.${disabledSite}`)
  );
}

function setAdBlockSessionEnabled(enabled) {
  if (!adBlocker || !webviewBrowserSession) return;

  const isCurrentlyEnabled = adBlocker.isBlockingEnabled(webviewBrowserSession);
  if (enabled && !isCurrentlyEnabled) {
    adBlocker.enableBlockingInSession(webviewBrowserSession);
    console.log('[AdBlock] Session blocking enabled');
  } else if (!enabled && isCurrentlyEnabled) {
    adBlocker.disableBlockingInSession(webviewBrowserSession);
    console.log('[AdBlock] Session blocking disabled');
  }
}

function applyAdBlockStateForSite(site) {
  const normalizedSite = normalizeSite(site);
  if (!normalizedSite) return;

  activeWebviewSite = normalizedSite;
  setAdBlockSessionEnabled(isSiteAdBlockEnabled(normalizedSite));
}

function getRequestSite(details) {
  if (details.resourceType === 'mainFrame') {
    const site = normalizeSite(details.url);
    if (site && details.webContentsId) webContentsSites.set(details.webContentsId, site);
    return site;
  }

  const frameSite = details.webContentsId ? webContentsSites.get(details.webContentsId) : '';
  if (frameSite) return frameSite;
  if (details.referrer) return normalizeSite(details.referrer);
  return normalizeSite(details.url);
}

function makeSiteAwareBlocker(blocker) {
  const originalOnBeforeRequest = blocker.onBeforeRequest.bind(blocker);
  const originalOnHeadersReceived = blocker.onHeadersReceived.bind(blocker);
  const originalOnInjectCosmeticFilters = blocker.onInjectCosmeticFilters.bind(blocker);

  blocker.onBeforeRequest = (details, callback) => {
    const site = getRequestSite(details);
    if (!isSiteAdBlockEnabled(site)) {
      callback({});
      return;
    }

    originalOnBeforeRequest(details, callback);
  };

  blocker.onHeadersReceived = (details, callback) => {
    const site = getRequestSite(details);
    if (!isSiteAdBlockEnabled(site)) {
      callback({});
      return;
    }

    originalOnHeadersReceived(details, callback);
  };

  blocker.onInjectCosmeticFilters = async (event, url, msg) => {
    const site = event.sender?.id ? webContentsSites.get(event.sender.id) : normalizeSite(url);
    if (!isSiteAdBlockEnabled(site)) return undefined;
    return originalOnInjectCosmeticFilters(event, url, msg);
  };

  return blocker;
}

async function enableAdBlocker(webviewSession) {
  try {
    const enginePath = path.join(db.getAppDataPath(), 'adblock-full-engine.bin');
    const blocker = await ElectronBlocker.fromPrebuiltFull(fetch, {
      path: enginePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    let blockedRequests = 0;
    let redirectedRequests = 0;

    blocker.on('request-blocked', () => {
      blockedRequests += 1;
      if (blockedRequests === 1 || blockedRequests % 100 === 0) {
        console.log('[AdBlock] Blocked requests:', blockedRequests);
      }
    });
    blocker.on('request-redirected', () => {
      redirectedRequests += 1;
      if (redirectedRequests === 1 || redirectedRequests % 100 === 0) {
        console.log('[AdBlock] Redirected requests:', redirectedRequests);
      }
    });

    adBlocker = makeSiteAwareBlocker(blocker);
    adBlocker.enableBlockingInSession(webviewSession);
    if (activeWebviewSite) applyAdBlockStateForSite(activeWebviewSite);
    console.log('[AdBlock] Enabled full ads/tracking/annoyances blocking for webview session');
  } catch (error) {
    console.error('[AdBlock] Failed to initialize:', error);
  }
}

/**
 * Configures the persistent browser session used by <webview> tags.
 *
 * @returns {Electron.Session}
 */
async function configureWebviewSession() {
  const webviewSession = session.fromPartition(WEBVIEW_PARTITION);
  webviewBrowserSession = webviewSession;
  const browserLikeUserAgent = buildBrowserLikeUserAgent();

  webviewSession.setUserAgent(browserLikeUserAgent);
  webviewSession.setPermissionCheckHandler(() => true);
  webviewSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  webviewSession.on('will-download', (_event, item) => {
    console.log('[WebView Download]', item.getURL(), '->', item.getFilename());
  });

  await enableAdBlocker(webviewSession);

  return webviewSession;
}

/**
 * Creates the main application window with security-hardened webPreferences.
 * Sets up navigation guards, keyboard shortcuts, and window lifecycle
 * handlers. In production the window loads https://netar.is; in development
 * it loads the URL specified by the `--APP_URL=` CLI flag (defaults to
 * http://localhost:5173).
 */
function createWindow() {
  Menu.setApplicationMenu(buildApplicationMenu());
  const browserLikeUserAgent = buildBrowserLikeUserAgent();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: !isDevelopmentMode(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    webPreferences.partition = WEBVIEW_PARTITION;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    delete webPreferences.preload;
    params.partition = WEBVIEW_PARTITION;
    params.useragent = browserLikeUserAgent;
  });

  mainWindow.webContents.on('did-attach-webview', (_event, webContents) => {
    const rememberWebviewSite = (url) => {
      const site = normalizeSite(url);
      if (!site) return;
      webContentsSites.set(webContents.id, site);
      applyAdBlockStateForSite(site);
    };

    rememberWebviewSite(webContents.getURL());
    webContents.on('did-start-navigation', (_navEvent, url, _isInPlace, isMainFrame) => {
      if (isMainFrame) rememberWebviewSite(url);
    });
    webContents.on('did-navigate', (_navEvent, url) => rememberWebviewSite(url));

    // Defuse "you're using an adblocker" walls regardless of the adblock
    // toggle. dom-ready fires on every main-frame navigation; the injected
    // script is idempotent (guards via window.__cascadeAntiAdblockDefuser).
    webContents.on('dom-ready', () => injectAntiAdblockDefuser(webContents));

    webContents.on('destroyed', () => {
      webContentsSites.delete(webContents.id);
    });
  });
  
  // Load URL based on environment (dev vs prod)
  if (app.isPackaged) {
    mainWindow.loadURL('https://netar.is');
  } else {
    // Development mode logic
    const args = process.argv.slice(2);
    const parsedArgs = {};
    args.forEach(arg => {
      if (arg.startsWith('--')) {
        const [key, value] = arg.slice(2).split('=');
        parsedArgs[key] = value || true;
      }
    });

    const devUrl = parsedArgs['APP_URL'] || 'http://localhost:5173';
    console.log('[Main] Loading dev URL:', devUrl);
    mainWindow.loadURL(devUrl);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // ═══════════════════════════════════════════════════════════════
  // NAVIGATION SECURITY
  // ═══════════════════════════════════════════════════════════════

  // Block navigation to sites outside netar.is
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url);
    const isAllowed =
      parsedUrl.hostname === 'netar.is' ||
      parsedUrl.hostname.endsWith('.netar.is') ||
      parsedUrl.hostname === 'localhost' ||
      parsedUrl.hostname === '127.0.0.1';

    if (!isAllowed) {
      event.preventDefault();
      console.log('[Main] Blocked navigation to:', url);
    }
  });

  // Block new windows to external sites
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const parsedUrl = new URL(url);
    const isAllowed =
      parsedUrl.hostname === 'netar.is' ||
      parsedUrl.hostname.endsWith('.netar.is') ||
      parsedUrl.hostname === 'localhost' ||
      parsedUrl.hostname === '127.0.0.1';

    if (!isAllowed) {
      console.log('[Main] Blocked window open to:', url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // ═══════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════

  // Local keyboard shortcuts (only work when window is focused)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    // Mac: Cmd, Windows/Linux: Ctrl
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? input.meta : input.control;

    if (modifier && input.code === 'KeyR' && !input.shift) {
      // Refresh: Cmd/Ctrl + R
      event.preventDefault();
      mainWindow.webContents.reload();
    } else if (modifier && input.code === 'KeyR' && input.shift) {
      // Relaunch: Cmd/Ctrl + Shift + R
      event.preventDefault();
      app.relaunch();
      app.exit(0);
    } else if (modifier && (input.code === 'Equal' || input.code === 'NumpadAdd')) {
      // Zoom in: Cmd/Ctrl + Plus/=
      event.preventDefault();
      const currentZoom = mainWindow.webContents.getZoomLevel();
      mainWindow.webContents.setZoomLevel(currentZoom + 0.5);
    } else if (modifier && (input.code === 'Minus' || input.code === 'NumpadSubtract')) {
      // Zoom out: Cmd/Ctrl + Minus
      event.preventDefault();
      const currentZoom = mainWindow.webContents.getZoomLevel();
      mainWindow.webContents.setZoomLevel(currentZoom - 0.5);
    } else if (modifier && (input.code === 'Digit0' || input.code === 'Numpad0')) {
      // Reset zoom: Cmd/Ctrl + 0
      event.preventDefault();
      mainWindow.webContents.setZoomLevel(0);
    } else if (modifier && input.code === 'KeyN' && !input.shift) {
      // New Note: Cmd/Ctrl + N
      // Chromium reserves Ctrl+N (new window) and never dispatches it to the
      // page, so we intercept it here and forward it to the renderer.
      event.preventDefault();
      mainWindow.webContents.send('shortcut', 'new-note');
    } else if (modifier && input.code === 'Backslash' && !input.shift) {
      // Toggle Sidebar: Cmd/Ctrl + \
      event.preventDefault();
      mainWindow.webContents.send('shortcut', 'toggle-sidebar');
    }
  });
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

// ═══════════════════════════════════════════════════════════════
// BROWSER IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

/** Opens an HTTP(S) URL in the user's default browser. */
ipcMain.handle('browser:openExternal', async (_event, url) => {
  try {
    const parsedUrl = new URL(String(url));
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Only HTTP(S) URLs can be opened externally');
    }

    await shell.openExternal(parsedUrl.toString());
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to open external URL:', error);
    return { success: false, error: error.message };
  }
});

/** Returns adblock state for an HTTP(S) URL's site. */
ipcMain.handle('browser:getAdBlockState', async (_event, url) => {
  try {
    const site = normalizeSite(String(url));
    if (!site) throw new Error('Invalid URL');

    return {
      success: true,
      site,
      enabled: isSiteAdBlockEnabled(site),
      blockerReady: Boolean(adBlocker),
    };
  } catch (error) {
    console.error('[IPC] Failed to get adblock state:', error);
    return { success: false, error: error.message };
  }
});

/** Enables or disables adblocking for an HTTP(S) URL's site. */
ipcMain.handle('browser:setAdBlockSiteEnabled', async (_event, { url, enabled }) => {
  try {
    const site = normalizeSite(String(url));
    if (!site) throw new Error('Invalid URL');

    const settings = getAdBlockSettings();
    const disabledSites = new Set(settings.disabledSites);

    if (enabled) {
      disabledSites.delete(site);
    } else {
      disabledSites.add(site);
    }

    saveAdBlockSettings({
      ...settings,
      disabledSites: [...disabledSites],
    });
    applyAdBlockStateForSite(site);

    return {
      success: true,
      site,
      enabled: isSiteAdBlockEnabled(site),
      blockerReady: Boolean(adBlocker),
    };
  } catch (error) {
    console.error('[IPC] Failed to set adblock state:', error);
    return { success: false, error: error.message };
  }
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

// ═══════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ═══════════════════════════════════════════════════════════════

  app.whenReady().then(async () => {
  // Initialize database
  try {
    db.initDatabase();
  } catch (error) {
    console.error('[Main] Failed to initialize database:', error);
  }

  await configureWebviewSession();

  // Allow app-shell browser-level permissions without clearing persisted
  // session data. Clearing cookies here breaks sites such as x.com by wiping
  // the webview's login/session state on every app launch.
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  // Brief delay to ensure database initialization completes
  setTimeout(createWindow, 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  // Close database
  try {
    db.closeDatabase();
  } catch (error) {
    console.error('[Main] Failed to close database:', error);
  }
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
