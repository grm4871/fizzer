const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');
const db = require('./database.cjs');

// Suppress GLib-GObject and GTK warnings on Linux
if (process.platform === 'linux') {
  process.env.G_MESSAGES_DEBUG = '';
  process.env.GTK_DEBUG = '';
}

let mainWindow;
let serverProcess;

function isDevelopmentMode() {
  return !app.isPackaged;
}

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

function createWindow() {
  Menu.setApplicationMenu(buildApplicationMenu());

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: !isDevelopmentMode(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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
    if (serverProcess) serverProcess.kill();
  });

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
    }
  });
}

// IPC Handlers for database configuration
ipcMain.handle('db:getConfig', async () => {
  try {
    const config = db.getConfig();
    return { success: true, config };
  } catch (error) {
    console.error('[IPC] Failed to get config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db:updateDbPath', async (event, newPath) => {
  try {
    db.updateDbPath(newPath);
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to update db path:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('db:getConfigDir', async () => {
  try {
    const configDir = db.getAppDataPath();
    return { success: true, configDir };
  } catch (error) {
    console.error('[IPC] Failed to get config dir:', error);
    return { success: false, error: error.message };
  }
});

// ==================== NETDOC IPC HANDLERS ====================

ipcMain.handle('netdoc:exists', async (event, id) => {
  try {
    const exists = db.netdocExists(id);
    return { success: true, exists };
  } catch (error) {
    console.error('[IPC] Failed to check netdoc exists:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('netdoc:get', async (event, id) => {
  try {
    const netdoc = db.getNetdoc(id);
    return { success: true, netdoc };
  } catch (error) {
    console.error('[IPC] Failed to get netdoc:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('netdoc:save', async (event, { id, name, content, canEdit }) => {
  try {
    const netdoc = db.saveNetdoc(id, name, content, canEdit);
    return { success: true, netdoc };
  } catch (error) {
    console.error('[IPC] Failed to save netdoc:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('netdoc:updateContent', async (event, { id, name, content }) => {
  try {
    const updated = db.updateNetdocContent(id, name, content);
    return { success: true, updated };
  } catch (error) {
    console.error('[IPC] Failed to update netdoc content:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('netdoc:delete', async (event, id) => {
  try {
    const deleted = db.deleteNetdoc(id);
    return { success: true, deleted };
  } catch (error) {
    console.error('[IPC] Failed to delete netdoc:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('netdoc:getVersions', async (event, netdocId) => {
  try {
    const versions = db.getNetdocVersions(netdocId);
    return { success: true, versions };
  } catch (error) {
    console.error('[IPC] Failed to get netdoc versions:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('netdoc:saveVersion', async (event, { id, netdocId, content, title, author }) => {
  try {
    db.saveNetdocVersion(id, netdocId, content, title, author);
    return { success: true };
  } catch (error) {
    console.error('[IPC] Failed to save netdoc version:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('netdoc:getLatestVersionContent', async (event, netdocId) => {
  try {
    const content = db.getLatestVersionContent(netdocId);
    return { success: true, content };
  } catch (error) {
    console.error('[IPC] Failed to get latest version content:', error);
    return { success: false, error: error.message };
  }
});

app.whenReady().then(() => {
  // Initialize database
  try {
    db.initDatabase();
  } catch (error) {
    console.error('[Main] Failed to initialize database:', error);
  }

  session.defaultSession.clearStorageData({storages: ['cookies']})
        .then(() => {
            console.log('All cookies cleared');
        })
        .catch((error) => {
            console.error('Failed to clear cookies: ', error);
        });

  setTimeout(createWindow, 1000); // wait briefly for server to start
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


