#!/usr/bin/env node

const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function intArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const args = readArgs(process.argv.slice(2));
const name = String(args.name || process.env.CASCADE_INSTANCE_NAME || 'dev').replace(/[^a-zA-Z0-9_-]/g, '-');
const apiPort = intArg(args.apiPort || process.env.API_PORT, 3000);
const clientPort = intArg(args.clientPort || process.env.VITE_PORT, 5173);
const dataRoot = path.resolve(
  String(args.dataDir || process.env.CASCADE_INSTANCE_DATA_DIR || path.join(os.homedir(), '.config', 'cascade-instances', name))
);
const appUrl = String(args.appUrl || process.env.APP_URL || `http://localhost:${clientPort}`);
const autoRefresh = args.autoRefresh === true || args.autoRefresh === 'true';
const sharedBackend = args.sharedBackend === true || args.sharedBackend === 'true';

const env = {
  ...process.env,
  API_PORT: String(apiPort),
  VITE_PORT: String(clientPort),
  VITE_API_URL: `http://localhost:${apiPort}`,
  APP_URL: appUrl,
  CASCADE_APP_URL: appUrl,
  CASCADE_INSTANCE_NAME: name,
  CASCADE_INSTANCE_DATA_DIR: dataRoot,
  CASCADE_USER_DATA_DIR: path.join(dataRoot, 'electron'),
  CASCADE_ELECTRON_DATA_DIR: path.join(dataRoot, 'electron'),
  DOCS_DB_PATH: path.join(dataRoot, 'docs.db'),
  JWT_SECRET: process.env.JWT_SECRET || `cascade-dev-secret-${name}`,
};

if (!autoRefresh) {
  env.CASCADE_DISABLE_AUTO_REFRESH = 'true';
  env.VITE_DISABLE_AUTO_REFRESH = 'true';
}

const commands = [
  ['client', autoRefresh ? 'npm run dev-client' : 'npm run dev-client-no-refresh'],
  ['electron', 'npm run sub:electron'],
];

if (!sharedBackend) {
  commands.unshift(['api', 'npm run dev-backend']);
}

console.log(`[dev-instance] ${name}`);
console.log(`[dev-instance] app: ${appUrl}`);
console.log(`[dev-instance] api: http://localhost:${apiPort}`);
console.log(`[dev-instance] backend: ${sharedBackend ? 'shared' : 'dedicated'}`);
console.log(`[dev-instance] data: ${dataRoot}`);
console.log(`[dev-instance] auto-refresh: ${autoRefresh ? 'on' : 'off'}`);

if (args.dryRun) {
  console.log(`[dev-instance] electron data: ${env.CASCADE_USER_DATA_DIR}`);
  console.log(`[dev-instance] docs db: ${env.DOCS_DB_PATH}`);
  process.exit(0);
}

const child = spawn(
  'npx',
  [
    'concurrently',
    '--names',
    commands.map(([label]) => label).join(','),
    '--prefix-colors',
    'cyan,magenta,yellow',
    ...commands.map(([, command]) => command),
  ],
  {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  }
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
