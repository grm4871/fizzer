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

const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');
const db = require('./database.cjs');

// Suppress GLib-GObject and GTK warnings on Linux, and disable hardware acceleration to fix blank webviews
if (process.platform === 'linux') {
  process.env.G_MESSAGES_DEBUG = '';
  process.env.GTK_DEBUG = '';
  app.disableHardwareAcceleration();
}

let mainWindow;
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
 * Creates the main application window with security-hardened webPreferences.
 * Sets up navigation guards, keyboard shortcuts, and window lifecycle
 * handlers. In production the window loads https://netar.is; in development
 * it loads the URL specified by the `--APP_URL=` CLI flag (defaults to
 * http://localhost:5173).
 */
function createWindow() {
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

  app.whenReady().then(() => {
  // Initialize database
  try {
    db.initDatabase();
  } catch (error) {
    console.error('[Main] Failed to initialize database:', error);
  }

  // Allow webview login flows to request browser-level permissions without
  // clearing persisted session data. Clearing cookies here breaks sites such as
  // x.com by wiping the webview's login/session state on every app launch.
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
