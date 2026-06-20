/**
 * @file preload.cjs — Electron preload / context bridge
 *
 * Bridges the main process and the renderer via `contextBridge.exposeInMainWorld`.
 * All database and netdoc IPC calls are exposed as `window.electronAPI.*` so the
 * renderer never has direct access to Node or Electron internals.
 *
 * Exposed API surface:
 *  - Database Config: getConfig, updateDbPath, getConfigDir
 *  - Netdoc CRUD:     netdocExists, getNetdoc, saveNetdoc,
 *                     updateNetdocContent, deleteNetdoc
 *  - Netdoc Versions: getNetdocVersions, saveNetdocVersion,
 *                     getLatestVersionContent
 *  - Browser:         openExternal, getAdBlockState, setAdBlockSiteEnabled
 *  - Terminal:        startTerminal, writeTerminal, stopTerminal, onTerminalData
 *  - Shortcuts:       onShortcut (subscribe to main-process keyboard events)
 *
 * @module cascade-electron/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

// Expose safe IPC methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {

  // ── Database Config ──────────────────────────────────────────
  /** Get the current config (includes db_path) */
  getConfig: () => ipcRenderer.invoke('db:getConfig'),
  /** Update the database path in config.json */
  updateDbPath: (newPath) => ipcRenderer.invoke('db:updateDbPath', newPath),
  /** Get the config directory path */
  getConfigDir: () => ipcRenderer.invoke('db:getConfigDir'),
  /** Read/write small app settings persisted in the local SQLite database */
  getSetting: (key) => ipcRenderer.invoke('db:getSetting', key),
  setSetting: ({ key, value }) => ipcRenderer.invoke('db:setSetting', { key, value }),

  // ── Netdoc CRUD ──────────────────────────────────────────────
  netdocExists: (id) => ipcRenderer.invoke('netdoc:exists', id),
  getNetdoc: (id) => ipcRenderer.invoke('netdoc:get', id),
  saveNetdoc: ({ id, name, content, canEdit }) => ipcRenderer.invoke('netdoc:save', { id, name, content, canEdit }),
  updateNetdocContent: ({ id, name, content }) => ipcRenderer.invoke('netdoc:updateContent', { id, name, content }),
  deleteNetdoc: (id) => ipcRenderer.invoke('netdoc:delete', id),

  // ── Netdoc Versions ──────────────────────────────────────────
  getNetdocVersions: (netdocId) => ipcRenderer.invoke('netdoc:getVersions', netdocId),
  saveNetdocVersion: ({ id, netdocId, content, title, author }) => ipcRenderer.invoke('netdoc:saveVersion', { id, netdocId, content, title, author }),
  getLatestVersionContent: (netdocId) => ipcRenderer.invoke('netdoc:getLatestVersionContent', netdocId),

  // ── Browser ─────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('browser:openExternal', url),
  getAdBlockState: (url) => ipcRenderer.invoke('browser:getAdBlockState', url),
  setAdBlockSiteEnabled: ({ url, enabled }) => ipcRenderer.invoke('browser:setAdBlockSiteEnabled', { url, enabled }),

  // ── Windows ─────────────────────────────────────────────────
  /**
   * Pop a tab out into its own OS window. Resolves with `{ popped }`: true when
   * the drop point was outside the current window (a new window was created),
   * false when it was inside (caller should keep the tab where it is).
   */
  popOutTab: ({ tab, screenX, screenY }) => ipcRenderer.invoke('window:popOutTab', { tab, screenX, screenY }),
  /**
   * Merge a popped-out tab back into the window under the drop point (defaults to
   * the main window). Resolves `{ merged }`: true closes this popout window.
   */
  mergeTab: ({ tab, screenX, screenY }) => ipcRenderer.invoke('window:mergeTab', { tab, screenX, screenY }),
  /**
   * Subscribe to a tab being merged back into this window from a popout.
   * Returns an unsubscribe function.
   */
  onAdoptTab: (callback) => {
    const listener = (_event, tab) => callback(tab);
    ipcRenderer.on('window:adoptTab', listener);
    return () => ipcRenderer.removeListener('window:adoptTab', listener);
  },

  // ── Terminal ────────────────────────────────────────────────
  startTerminal: ({ id, cwd, cols, rows }) => ipcRenderer.invoke('terminal:start', { id, cwd, cols, rows }),
  writeTerminal: ({ id, data }) => ipcRenderer.invoke('terminal:write', { id, data }),
  resizeTerminal: ({ id, cols, rows }) => ipcRenderer.invoke('terminal:resize', { id, cols, rows }),
  stopTerminal: (id) => ipcRenderer.invoke('terminal:stop', id),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal:data', listener);
    return () => ipcRenderer.removeListener('terminal:data', listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal:exit', listener);
    return () => ipcRenderer.removeListener('terminal:exit', listener);
  },

  // ── Shortcuts ────────────────────────────────────────────────
  /**
   * Subscribe to keyboard shortcuts forwarded from the main process.
   * Returns an unsubscribe function.
   */
  onShortcut: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('shortcut', listener);
    return () => ipcRenderer.removeListener('shortcut', listener);
  },

  // ── WebContentsView Browser ──────────────────────────────────
  createView: (tabId, isChatNote) => ipcRenderer.invoke('browser:createView', tabId, isChatNote),
  setChatNote: (tabId, isChatNote) => ipcRenderer.invoke('browser:setChatNote', tabId, isChatNote),
  setViewBounds: (tabId, bounds) => ipcRenderer.invoke('browser:setViewBounds', tabId, bounds),
  setViewVisible: (tabId, visible) => ipcRenderer.invoke('browser:setViewVisible', tabId, visible),
  destroyView: (tabId) => ipcRenderer.invoke('browser:destroyView', tabId),
  loadURL: (tabId, url) => ipcRenderer.invoke('browser:loadURL', tabId, url),
  goBack: (tabId) => ipcRenderer.invoke('browser:goBack', tabId),
  goForward: (tabId) => ipcRenderer.invoke('browser:goForward', tabId),
  reload: (tabId) => ipcRenderer.invoke('browser:reload', tabId),
  onBrowserEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('browser:event', listener);
    return () => ipcRenderer.removeListener('browser:event', listener);
  }
});
