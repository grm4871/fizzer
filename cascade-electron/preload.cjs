const { contextBridge, ipcRenderer } = require('electron');

// Expose safe IPC methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Get the current config (includes db_path)
  getConfig: () => ipcRenderer.invoke('db:getConfig'),

  // Update the database path in config.json
  updateDbPath: (newPath) => ipcRenderer.invoke('db:updateDbPath', newPath),

  // Get the config directory path
  getConfigDir: () => ipcRenderer.invoke('db:getConfigDir'),

  // Netdoc operations
  netdocExists: (id) => ipcRenderer.invoke('netdoc:exists', id),
  getNetdoc: (id) => ipcRenderer.invoke('netdoc:get', id),
  saveNetdoc: ({ id, name, content, canEdit }) => ipcRenderer.invoke('netdoc:save', { id, name, content, canEdit }),
  updateNetdocContent: ({ id, name, content }) => ipcRenderer.invoke('netdoc:updateContent', { id, name, content }),
  deleteNetdoc: (id) => ipcRenderer.invoke('netdoc:delete', id),
  getNetdocVersions: (netdocId) => ipcRenderer.invoke('netdoc:getVersions', netdocId),
  saveNetdocVersion: ({ id, netdocId, content, title, author }) => ipcRenderer.invoke('netdoc:saveVersion', { id, netdocId, content, title, author }),
  getLatestVersionContent: (netdocId) => ipcRenderer.invoke('netdoc:getLatestVersionContent', netdocId),

  // Subscribe to keyboard shortcuts forwarded from the main process.
  // Returns an unsubscribe function.
  onShortcut: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('shortcut', listener);
    return () => ipcRenderer.removeListener('shortcut', listener);
  }
});
