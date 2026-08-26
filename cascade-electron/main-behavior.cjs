'use strict';

/**
 * Small, dependency-injected seams for the Electron entrypoint.
 * They keep lifecycle and update sequencing observable without inspecting source.
 */

function bootstrapDesktopDependencies({ packaged, installDesktopShellPath, loadModules }) {
  installDesktopShellPath({ packaged });
  return loadModules();
}

function registerReadyHousekeeping({
  app,
  session,
  createWindow,
  reapOrphanedLocalAgentRuns,
  pruneWorkspaces,
  onReady = () => {},
  onPruned = () => {},
  onError = console.error,
}) {
  app.whenReady().then(() => {
    onReady();
    session.defaultSession.setPermissionCheckHandler(() => true);
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(true));
    createWindow();

    void reapOrphanedLocalAgentRuns().catch((error) => {
      onError('[Main] Failed to reap orphaned agent processes:', error);
    });
    void pruneWorkspaces().then((pruned) => {
      onPruned(pruned);
    }).catch((error) => {
      onError('[Main] Failed to prune task workspaces:', error);
    });
  });
}

function createMainWindowOptions({ icon, preload, platform, backgroundColor }) {
  return {
    width: 1200,
    height: 800,
    icon,
    backgroundColor,
    autoHideMenuBar: platform !== 'darwin',
    backgroundThrottling: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload,
    },
  };
}

function createMainWindow({ BrowserWindow, options, configureWindow, url }) {
  const win = new BrowserWindow(options);
  configureWindow(win);
  win.loadURL(url);
  return win;
}

function runPackagedMacOSUpdate({ arch, executablePath, prepareMacOSUpdate, launchMacOSInstaller, quit, schedule = setTimeout }) {
  return Promise.resolve(prepareMacOSUpdate({ arch, executablePath })).then((update) => {
    launchMacOSInstaller(update);
    schedule(quit, 250);
    return { success: true, restarting: true };
  });
}

function createOriginPolicy({ instanceOrigin, isSameOrigin }) {
  return {
    isAllowedNavigation(url) {
      return isSameOrigin(url, instanceOrigin);
    },
    connectRunner(token, apiUrl, connectDesktopRunner) {
      if (!isSameOrigin(apiUrl, instanceOrigin)) {
        throw new Error('Runner origin does not match the desktop instance selected at startup');
      }
      return connectDesktopRunner(token, instanceOrigin);
    },
  };
}
module.exports = {
  bootstrapDesktopDependencies,
  createMainWindow,
  createMainWindowOptions,
  createOriginPolicy,
  registerReadyHousekeeping,
  runPackagedMacOSUpdate,
};
