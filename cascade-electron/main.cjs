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

const { app, BrowserWindow, ipcMain, session, Menu, shell, WebContentsView } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

const explicitUserDataDir = process.env.CASCADE_USER_DATA_DIR || process.env.CASCADE_ELECTRON_DATA_DIR;
if (explicitUserDataDir) {
  const userDataDir = path.resolve(explicitUserDataDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
}

const db = require('./database.cjs');

let nodePty = null;
try {
  nodePty = require('node-pty');
} catch (error) {
  console.error('[Terminal] node-pty is unavailable:', error?.message || error);
}

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
const terminalProcesses = new Map();
const webViews = new Map();
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

function injectCustomStyles(webContents) {
  if (!webContents || webContents.isDestroyed()) return;
  const url = webContents.getURL();
  if (url.includes('x.com') || url.includes('twitter.com')) {
    const css = `
      header[role="banner"] {
        display: none !important;
      }
      div[role="main"] {
        margin-left: 0 !important;
        margin-right: 0 !important;
        width: 100% !important;
        max-width: 100% !important;
      }
      div[data-testid="primaryColumn"],
      div[data-testid="primaryColumn"] * {
        max-width: 100% !important;
        border-right-width: 0 !important;
      }
      div[data-testid="primaryColumn"] {
        width: 100% !important;
        margin: 0 !important;
      }
    `;
    webContents.insertCSS(css).catch((error) => {
      console.error('[CustomCSS] Twitter CSS injection failed:', error?.message || error);
    });
    if (url.includes('/i/chat') || url.includes('/messages')) {
      webContents.executeJavaScript(`
        (function hideDmList() {
          // Find the conversation list column: on X's DM page, the main area
          // is a flex row with two children — the conversation list (narrower)
          // and the active chat (wider). We walk up from the chat header to
          // find the flex container, then hide the list sibling.
          function run() {
            // Strategy: find the element that contains the "Chat" heading and
            // search bar — that's the conversation list column. Walk the DOM
            // to find the flex parent that lays it out beside the active chat.
            const main = document.querySelector('div[data-testid="primaryColumn"]') || document.querySelector('main');
            if (!main) return false;

            // Look for a flex row whose children represent the two DM columns
            const flexRows = main.querySelectorAll('div');
            for (const el of flexRows) {
              const style = window.getComputedStyle(el);
              if (style.display !== 'flex' || style.flexDirection !== 'row') continue;
              const kids = Array.from(el.children).filter(c => c.tagName !== 'SCRIPT');
              if (kids.length < 2) continue;
              // Check if first child is narrower (conversation list) and second is wider (chat)
              const firstW = kids[0].getBoundingClientRect().width;
              const secondW = kids[1].getBoundingClientRect().width;
              if (firstW > 100 && secondW > 100 && firstW < secondW) {
                kids[0].style.setProperty('display', 'none', 'important');
                kids[1].style.setProperty('flex', '1', 'important');
                kids[1].style.setProperty('max-width', '100%', 'important');
                kids[1].style.setProperty('width', '100%', 'important');
                // Walk up and force all ancestors to fill width
                let node = kids[1];
                while (node && node !== document.body) {
                  node.style.setProperty('max-width', '100%', 'important');
                  node.style.setProperty('width', '100%', 'important');
                  // Also force all direct children inside the chat column
                  // to expand (X nests several wrapper divs with max-width)
                  for (const child of node.children) {
                    if (child.tagName === 'DIV' || child.tagName === 'SECTION') {
                      child.style.setProperty('max-width', '100%', 'important');
                    }
                  }
                  node = node.parentElement;
                }
                return true;
              }
            }
            return false;
          }
          if (!run()) {
            // DOM may not be fully rendered yet; retry a few times
            let attempts = 0;
            const timer = setInterval(() => {
              if (run() || ++attempts > 20) clearInterval(timer);
            }, 500);
          }
        })();
      `, true).catch(e => console.error('[ChatNote] DM list hide failed:', e));
    }
  } else if (url.includes('discord.com')) {
    const css = `
      nav[aria-label="Servers sidebar"],
      div[class*="guilds_"],
      div[class*="sidebar_"] {
        display: none !important;
      }
      div[class*="chat_"] {
        width: 100% !important;
        max-width: 100% !important;
      }
    `;
    webContents.insertCSS(css).catch((error) => {
      console.error('[CustomCSS] Discord CSS injection failed:', error?.message || error);
    });
  }
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

  // Intercept onBeforeRequest to cleanly block Discord RPC (ports 6463-6472) for both HTTP and WebSockets
  const originalOnBeforeRequest = webviewSession.webRequest.onBeforeRequest.bind(webviewSession.webRequest);
  webviewSession.webRequest.onBeforeRequest = (filter, listener) => {
    const targetListener = typeof filter === 'function' ? filter : listener;
    if (targetListener) {
      const wrappedListener = (details, callback) => {
        try {
          const parsedUrl = new URL(details.url);
          const hostname = parsedUrl.hostname;
          const port = parseInt(parsedUrl.port, 10);
          if ((hostname === '127.0.0.1' || hostname === 'localhost') && port >= 6463 && port <= 6472) {
            console.log('[WebView Block] Blocked Discord RPC:', details.url);
            callback({ cancel: true });
            return;
          }
        } catch (e) {}
        targetListener(details, callback);
      };

      const newFilter = {
        urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*']
      };
      originalOnBeforeRequest(newFilter, wrappedListener);
    } else {
      originalOnBeforeRequest(filter, listener);
    }
  };

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

/** Send an IPC message to every live window (terminal output may belong to the
 *  main window or a popped-out window). */
function broadcastToWindows(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function isAllowedNavHost(hostname) {
  return (
    hostname === 'cscd.online' ||
    hostname.endsWith('.cscd.online') ||
    hostname === 'netar.is' ||
    hostname.endsWith('.netar.is') ||
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
 * Shared per-window wiring: <webview> hardening + adblock tracking, navigation
 * guards, external-window blocking, and keyboard shortcuts. Applied to the main
 * window and every popped-out pane window so they behave identically.
 */
function configureWindow(win) {
  const browserLikeUserAgent = buildBrowserLikeUserAgent();

  win.on('closed', () => {
    cleanupWindowViews(win);
  });

  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    webPreferences.partition = WEBVIEW_PARTITION;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    delete webPreferences.preload;
    params.partition = WEBVIEW_PARTITION;
    params.useragent = browserLikeUserAgent;
  });

  win.webContents.on('did-attach-webview', (_event, webContents) => {
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
    // Defuse "you're using an adblocker" walls; injected script is idempotent.
    webContents.on('dom-ready', () => {
      injectAntiAdblockDefuser(webContents);
      injectCustomStyles(webContents);
    });
    webContents.on('will-navigate', (event, url) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'about:') {
          event.preventDefault();
          console.log('[WebView] Blocked custom protocol navigation:', url);
        }
      } catch {
        event.preventDefault();
      }
    });
    webContents.on('destroyed', () => {
      webContentsSites.delete(webContents.id);
    });
  });

  // Block navigation to sites outside netar.is / local dev.
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
 * In production it loads https://netar.is; in development the `--APP_URL=` URL.
 */
async function createWindow() {
  Menu.setApplicationMenu(buildApplicationMenu());

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
 * Open a tab that was dragged out of a window into its own OS window. The tab
 * descriptor (id/type/url/title/terminal history) rides in the URL hash; the
 * renderer detects `#popout=` and renders a single-tab workspace.
 */
function createPaneWindow(descriptor, bounds) {
  const win = new BrowserWindow({
    width: (bounds && bounds.width) || 900,
    height: (bounds && bounds.height) || 680,
    x: bounds && bounds.x,
    y: bounds && bounds.y,
    autoHideMenuBar: !isDevelopmentMode(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: true,
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

// ── WebContentsView Browser Handlers ──────────────────────────

function cleanupWindowViews(win) {
  for (const [tabId, entry] of webViews.entries()) {
    if (entry.win === win) {
      if (entry.destroyTimeout) clearTimeout(entry.destroyTimeout);
      try {
        win.contentView.removeChildView(entry.view);
      } catch (e) {}
      try {
        entry.view.webContents.close();
      } catch (e) {}
      webViews.delete(tabId);
    }
  }
}

ipcMain.handle('browser:createView', async (event, tabId, isChatNote) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('No parent window found');

    let entry = webViews.get(tabId);
    if (entry) {
      const oldIsChatNote = entry.isChatNote;
      entry.isChatNote = isChatNote;
      if (oldIsChatNote !== isChatNote) {
        entry.view.webContents.reload();
      }
      // Adoption logic
      entry.isTransitioning = false; // Transition complete
      if (entry.destroyTimeout) {
        clearTimeout(entry.destroyTimeout);
        entry.destroyTimeout = null;
      }
      if (entry.win && entry.win !== win && !entry.win.isDestroyed()) {
        try {
          entry.win.contentView.removeChildView(entry.view);
        } catch (e) {}
      }
      entry.win = win;
      try {
        win.contentView.addChildView(entry.view);
      } catch (e) {}

      const url = entry.view.webContents.getURL();
      const title = entry.view.webContents.getTitle();
      const isLoading = entry.view.webContents.isLoading();
      const canGoBack = entry.view.webContents.canGoBack();
      const canGoForward = entry.view.webContents.canGoForward();

      event.sender.send('browser:event', { tabId, type: 'navigate', url });
      event.sender.send('browser:event', { tabId, type: 'title', title });
      event.sender.send('browser:event', { tabId, type: 'loading', isLoading });
      event.sender.send('browser:event', { tabId, type: 'backforward', canGoBack, canGoForward });

      return { success: true, adopted: true };
    }

    const browserLikeUserAgent = buildBrowserLikeUserAgent();
    const view = new WebContentsView({
      webPreferences: {
        session: webviewBrowserSession || session.fromPartition(WEBVIEW_PARTITION),
        nodeIntegration: false,
        contextIsolation: true,
      }
    });

    view.webContents.setMaxListeners(100);
    view.webContents.setUserAgent(browserLikeUserAgent);

    view.webContents.on('dom-ready', () => {
      injectAntiAdblockDefuser(view.webContents);
      const e = webViews.get(tabId);
      if (e && e.isChatNote) {
        injectCustomStyles(view.webContents);
      }
    });

    const sendState = () => {
      if (win.isDestroyed() || event.sender.isDestroyed()) return;
      try {
        const canGoBack = view.webContents.canGoBack();
        const canGoForward = view.webContents.canGoForward();
        event.sender.send('browser:event', { tabId, type: 'backforward', canGoBack, canGoForward });
      } catch (e) {}
    };

    view.webContents.on('did-start-loading', () => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('browser:event', { tabId, type: 'loading', isLoading: true });
      }
    });

    view.webContents.on('did-stop-loading', () => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('browser:event', { tabId, type: 'loading', isLoading: false });
      }
      sendState();
    });

    view.webContents.on('did-navigate', (evt, url) => {
      const site = normalizeSite(url);
      if (site) {
        webContentsSites.set(view.webContents.id, site);
        applyAdBlockStateForSite(site);
      }
      if (!event.sender.isDestroyed()) {
        event.sender.send('browser:event', { tabId, type: 'navigate', url });
      }
      sendState();
    });

    view.webContents.on('did-navigate-in-page', (evt, url) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('browser:event', { tabId, type: 'navigate', url });
      }
      sendState();
    });

    view.webContents.on('page-title-updated', (evt, title) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('browser:event', { tabId, type: 'title', title });
      }
    });

    view.webContents.on('did-fail-load', (evt, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (errorCode === -3) return;
      if (!isMainFrame) return;
      if (!event.sender.isDestroyed()) {
        event.sender.send('browser:event', { tabId, type: 'fail', errorDescription: `${errorDescription} (Error: ${errorCode})` });
      }
    });

    view.webContents.on('console-message', (evt, level, message, line, sourceId) => {
      console.log('[WebContentsView Console]', { tabId, level, message, line, sourceId });
    });

    win.contentView.addChildView(view);
    webViews.set(tabId, { view, win, destroyTimeout: null, isChatNote, isTransitioning: false });
    return { success: true, adopted: false };
  } catch (error) {
    console.error('[WebContentsView] Failed to create view:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('browser:setChatNote', async (event, tabId, isChatNote) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false, error: 'View not found' };
  try {
    const oldIsChatNote = entry.isChatNote;
    entry.isChatNote = isChatNote;
    if (oldIsChatNote !== isChatNote) {
      entry.view.webContents.reload();
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('browser:setViewBounds', async (event, tabId, bounds) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false, error: 'View not found' };
  try {
    entry.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('browser:setViewVisible', async (event, tabId, visible) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false, error: 'View not found' };
  try {
    if (visible) {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (win && entry.win !== win) {
        if (entry.win && !entry.win.isDestroyed()) {
          try { entry.win.contentView.removeChildView(entry.view); } catch (e) {}
        }
        entry.win = win;
        win.contentView.addChildView(entry.view);
      }
    } else {
      entry.view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('browser:destroyView', async (event, tabId) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false };
  try {
    const win = BrowserWindow.fromWebContents(event.sender);

    // If the view has been adopted by another window, ignore this destroy request
    if (entry.win && entry.win !== win) {
      console.log('[browser:destroyView] Ignoring destroy request for tabId', tabId, 'because it is owned by a different window');
      return { success: true };
    }

    // If the view is transitioning, defer destruction with a 1-second timeout
    if (entry.isTransitioning) {
      console.log('[browser:destroyView] Deferring destruction for tabId', tabId, 'due to transition');
      if (entry.destroyTimeout) clearTimeout(entry.destroyTimeout);
      entry.destroyTimeout = setTimeout(() => {
        if (webViews.get(tabId) === entry) {
          if (entry.win && !entry.win.isDestroyed()) {
            try {
              entry.win.contentView.removeChildView(entry.view);
            } catch (e) {}
          }
          try {
            entry.view.webContents.close();
          } catch (e) {}
          webViews.delete(tabId);
        }
      }, 1000);
      return { success: true };
    }

    // Normal close: destroy IMMEDIATELY
    console.log('[browser:destroyView] Destroying tabId', tabId, 'immediately');
    if (entry.destroyTimeout) clearTimeout(entry.destroyTimeout);
    if (entry.win && !entry.win.isDestroyed()) {
      try {
        entry.win.contentView.removeChildView(entry.view);
      } catch (e) {}
    }
    try {
      entry.view.webContents.close();
    } catch (e) {}
    webViews.delete(tabId);

    // Flush cookies to disk immediately on view destruction to ensure session persistence
    try {
      const webviewSession = webviewBrowserSession || session.fromPartition(WEBVIEW_PARTITION);
      if (webviewSession && webviewSession.cookies) {
        webviewSession.cookies.flushStore().catch((err) => {
          console.error('[browser:destroyView] Failed to flush cookies:', err);
        });
      }
    } catch (err) {
      console.error('[browser:destroyView] Error flushing cookies:', err);
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('browser:loadURL', async (event, tabId, url) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false, error: 'View not found' };
  try {
    await entry.view.webContents.loadURL(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('browser:goBack', async (event, tabId) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false };
  try {
    if (entry.view.webContents.canGoBack()) {
      entry.view.webContents.goBack();
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('browser:goForward', async (event, tabId) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false };
  try {
    if (entry.view.webContents.canGoForward()) {
      entry.view.webContents.goForward();
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('browser:reload', async (event, tabId) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false };
  try {
    entry.view.webContents.reload();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
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
    const entry = webViews.get(tab.id);
    if (entry) {
      entry.isTransitioning = true;
    }
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
    const entry = webViews.get(tab.id);
    if (entry) {
      entry.isTransitioning = true;
    }
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
// TERMINAL IPC HANDLERS
// ═══════════════════════════════════════════════════════════════

function getDefaultTerminalShell() {
  if (process.platform === 'win32') {
    return {
      command: process.env.COMSPEC || 'cmd.exe',
      args: [],
    };
  }

  return {
    command: process.env.SHELL || '/bin/bash',
    args: [],
  };
}

function getTerminalCwd(inputCwd) {
  if (inputCwd && path.isAbsolute(inputCwd) && fs.existsSync(inputCwd)) return inputCwd;
  return path.resolve(__dirname, '..');
}

/** Starts a shell process for a renderer terminal tab. */
ipcMain.handle('terminal:start', async (_event, { id, cwd, cols, rows }) => {
  try {
    const terminalId = String(id || '');
    if (!terminalId) throw new Error('Missing terminal id');
    if (!nodePty) throw new Error('node-pty is unavailable. Run npm install and rebuild native modules for Electron.');

    const existing = terminalProcesses.get(terminalId);
    if (existing) return { success: true, reused: true };

    const shell = getDefaultTerminalShell();
    const ptyProcess = nodePty.spawn(shell.command, shell.args, {
      name: 'xterm-256color',
      cols: Number(cols) || 80,
      rows: Number(rows) || 24,
      cwd: getTerminalCwd(cwd),
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
        COLORTERM: process.env.COLORTERM || 'truecolor',
      },
    });

    terminalProcesses.set(terminalId, ptyProcess);

    // Broadcast to every window: a terminal tab may live in the main window or
    // in a popped-out window, and which one owns it can change over time.
    ptyProcess.onData((data) => {
      broadcastToWindows('terminal:data', { id: terminalId, data: String(data) });
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      terminalProcesses.delete(terminalId);
      broadcastToWindows('terminal:exit', { id: terminalId, code: exitCode, signal });
    });

    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to start terminal:', error);
    return { success: false, error: error.message };
  }
});

/** Writes raw input to a running terminal shell process. */
ipcMain.handle('terminal:write', async (_event, { id, data }) => {
  try {
    const ptyProcess = terminalProcesses.get(String(id));
    if (!ptyProcess) throw new Error('Terminal is not running');
    ptyProcess.write(String(data ?? ''));
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to write terminal input:', error);
    return { success: false, error: error.message };
  }
});

/** Resizes a running terminal PTY. */
ipcMain.handle('terminal:resize', async (_event, { id, cols, rows }) => {
  try {
    const ptyProcess = terminalProcesses.get(String(id));
    if (!ptyProcess) return { success: true };
    ptyProcess.resize(Math.max(2, Number(cols) || 80), Math.max(2, Number(rows) || 24));
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to resize terminal:', error);
    return { success: false, error: error.message };
  }
});

/** Stops a terminal shell process. */
ipcMain.handle('terminal:stop', async (_event, id) => {
  try {
    const terminalId = String(id);
    const ptyProcess = terminalProcesses.get(terminalId);
    if (ptyProcess) ptyProcess.kill();
    terminalProcesses.delete(terminalId);
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to stop terminal:', error);
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

// ── Frontend refresh ─────────────────────────────────────────
ipcMain.handle('app:updateAndRestart', async () => {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
    }
    return { success: true };
  } catch (error) {
    console.error('[IPC] Frontend refresh failed:', error);
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
  setTimeout(() => {
    void createWindow();
  }, 1000);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  try {
    const webviewSession = session.fromPartition(WEBVIEW_PARTITION);
    if (webviewSession && webviewSession.cookies) {
      webviewSession.cookies.flushStore().catch((err) => {
        console.error('[Main] Failed to flush cookies on quit:', err);
      });
    }
  } catch (err) {
    console.error('[Main] Error flushing cookies session:', err);
  }

  for (const [, ptyProcess] of terminalProcesses) {
    try {
      if (ptyProcess) ptyProcess.kill();
    } catch (_) {}
  }
  terminalProcesses.clear();

  try {
    db.closeDatabase();
  } catch (_) {}
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
