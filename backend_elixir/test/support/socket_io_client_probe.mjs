#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Manager } = require('../../../node_modules/socket.io-client');

const [target, token, mode = 'upgrade'] = process.argv.slice(2);
if (!target || !token) throw new Error('target and token are required');

const transports = mode === 'polling' ? ['polling'] : mode === 'websocket' ? ['websocket'] : ['polling', 'websocket'];
const manager = new Manager(target, {
  path: '/socket.io/',
  transports,
  upgrade: mode === 'upgrade',
  reconnection: false,
  timeout: 10_000,
});

const vault = manager.socket('/vault', { auth: { token } });
const runs = manager.socket('/runs', { auth: { token } });
const runners = manager.socket('/runners', { auth: { token } });
const sockets = [vault, runs, runners];

const timeout = setTimeout(() => fail(new Error('socket.io-client probe timed out')), 30_000);
let connected = 0;
let ready = false;

function fail(error) {
  clearTimeout(timeout);
  console.error(error?.stack || error);
  manager._close();
  process.exitCode = 1;
}

for (const socket of sockets) {
  socket.on('connect_error', fail);
  socket.on('connect', () => {
    connected += 1;
    if (connected === sockets.length) startProbe();
  });
}

function startProbe() {
  vault.emit('joinVault', 'integration-vault');
  runners.on('run:cancel', (_payload, callback) => callback({ success: true, source: 'node-client' }));
  runners.on('probe:finish', () => {
    clearTimeout(timeout);
    console.log(JSON.stringify({ done: true, transport: manager.engine.transport.name }));
    for (const socket of sockets) socket.disconnect();
    manager._close();
  });

  vault.timeout(15_000).emit('probe:ack', 'node', (error, response) => {
    if (error) return fail(error);
    if (mode === 'upgrade' && manager.engine.transport.name !== 'websocket') {
      manager.engine.once('upgrade', () => announceReady(response));
    } else {
      announceReady(response);
    }
  });
}

function announceReady(response) {
  runners.emit('runner:register', { activeRunIds: [], runnerInstanceId: `elixir-${mode}` });
  ready = true;
  console.log(JSON.stringify({ ready, response, transport: manager.engine.transport.name }));
}

for (const socket of sockets) socket.connect();
