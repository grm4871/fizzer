const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bootstrapDesktopDependencies,
  createMainWindow,
  createMainWindowOptions,
  createOriginPolicy,
  registerReadyHousekeeping,
  runPackagedMacOSUpdate,
} = require('./main-behavior.cjs');

test('main window loads the selected URL immediately with a painted secure shell', () => {
  const events = [];
  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.webContents = { loadURL: (url) => events.push(['load', url]) };
    }
    loadURL(url) {
      this.webContents.loadURL(url);
    }
  }
  const options = createMainWindowOptions({
    icon: '/tmp/Fizzer.icns',
    preload: '/tmp/preload.cjs',
    platform: 'darwin',
    backgroundColor: '#101014',
  });
  const win = createMainWindow({
    BrowserWindow: FakeBrowserWindow,
    options,
    configureWindow: () => events.push('configure'),
    url: 'https://fizzer.example.test/app',
  });
  assert.equal(win.options.backgroundColor, '#101014');
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.deepEqual(events, ['configure', ['load', 'https://fizzer.example.test/app']]);
});

test('desktop startup creates its first window before housekeeping', async () => {
  const events = [];
  const app = { whenReady: () => Promise.resolve() };
  const session = {
    defaultSession: {
      setPermissionCheckHandler: (handler) => {
        events.push(handler() ? 'permission-check-approved' : 'permission-check-denied');
      },
      setPermissionRequestHandler: (handler) => {
        let approved = false;
        handler({}, 'media', () => { approved = true; });
        events.push(approved ? 'permission-request-approved' : 'permission-request-denied');
      },
    },
  };
  registerReadyHousekeeping({
    app,
    session,
    createWindow: () => events.push('create-window'),
    reapOrphanedLocalAgentRuns: async () => { events.push('reap'); },
    pruneWorkspaces: async () => { events.push('prune'); return { removed: [], forgotten: [], kept: [] }; },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, [
    'permission-check-approved',
    'permission-request-approved',
    'create-window',
    'reap',
    'prune',
  ]);
});

test('desktop navigation and runner helpers use the selected exact origin', () => {
  const policy = createOriginPolicy({
    instanceOrigin: 'https://fizzer.example.test:8443',
    isSameOrigin: (url, origin) => {
      try {
        return new URL(url).origin === origin;
      } catch {
        return false;
      }
    },
  });
  assert.equal(policy.isAllowedNavigation('https://fizzer.example.test:8443/app'), true);
  assert.equal(policy.isAllowedNavigation('https://fizzer.example.test:8443/settings'), true);
  assert.equal(policy.isAllowedNavigation('https://other.example.test/app'), false);
  assert.deepEqual(
    policy.connectRunner('token', 'https://fizzer.example.test:8443/app', (token, origin) => ({ token, origin })),
    { token: 'token', origin: 'https://fizzer.example.test:8443' },
  );
  assert.throws(
    () => policy.connectRunner('token', 'https://other.example.test/app', () => {}),
  );
});

test('packaged macOS update prepares before launching and quitting', async () => {
  const events = [];
  const result = await runPackagedMacOSUpdate({
    arch: 'arm64',
    executablePath: '/Applications/Fizzer.app/Contents/MacOS/fizzer',
    prepareMacOSUpdate: async (input) => {
      events.push(['prepare', input]);
      return { scriptPath: '/tmp/install.sh' };
    },
    launchMacOSInstaller: (update) => events.push(['launch', update]),
    schedule: (quit, delay) => {
      events.push(['schedule', delay]);
      quit();
    },
    quit: () => events.push('quit'),
  });
  assert.deepEqual(result, { success: true, restarting: true });
  assert.deepEqual(events, [
    ['prepare', { arch: 'arm64', executablePath: '/Applications/Fizzer.app/Contents/MacOS/fizzer' }],
    ['launch', { scriptPath: '/tmp/install.sh' }],
    ['schedule', 250],
    'quit',
  ]);
});

test('desktop repairs PATH before loading runner dependencies', () => {
  const events = [];
  const dependencies = bootstrapDesktopDependencies({
    packaged: true,
    installDesktopShellPath: (options) => events.push(['path', options]),
    loadModules: () => {
      events.push('load');
      return { runner: 'fake' };
    },
  });
  assert.deepEqual(dependencies, { runner: 'fake' });
  assert.deepEqual(events, [['path', { packaged: true }], 'load']);
});
