#!/usr/bin/env node

import { createRequire } from 'node:module';
import readline from 'node:readline';

const require = createRequire(import.meta.url);
const { Manager } = require('../../../node_modules/socket.io-client');

const [target, token, label = 'client'] = process.argv.slice(2);
if (!target || !token) throw new Error('target and token are required');

const manager = new Manager(target, {
  path: '/socket.io/',
  transports: ['websocket'],
  reconnection: false,
  timeout: 10_000,
});

const vault = manager.socket('/vault', { auth: { token } });
const runs = manager.socket('/runs', { auth: { token } });
const sockets = { vault, runs };
let connected = 0;

function write(value) {
  process.stdout.write(`${JSON.stringify({ label, ...value })}\n`);
}

function fail(error) {
  write({ type: 'error', message: error?.message || String(error) });
  manager._close();
  process.exitCode = 1;
}

for (const [namespace, socket] of Object.entries(sockets)) {
  socket.on('connect_error', fail);
  socket.onAny((event, ...args) => write({ type: 'event', namespace, event, args }));
  socket.on('disconnect', (reason) => write({ type: 'disconnect', namespace, reason }));
  socket.on('connect', () => {
    connected += 1;
    if (connected === Object.keys(sockets).length) write({ type: 'ready' });
  });
  socket.connect();
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', (line) => {
  try {
    const command = JSON.parse(line);
    const socket = sockets[command.namespace || 'vault'];
    if (!socket) throw new Error('unknown namespace');

    if (command.action === 'emit') {
      socket.emit(command.event, ...(command.args || []));
      write({ type: 'command', id: command.id || null });
    } else if (command.action === 'disconnect') {
      socket.disconnect();
      write({ type: 'command', id: command.id || null });
    } else if (command.action === 'close') {
      for (const current of Object.values(sockets)) current.disconnect();
      manager._close();
      write({ type: 'closed', id: command.id || null });
      input.close();
    } else {
      throw new Error('unknown action');
    }
  } catch (error) {
    fail(error);
  }
});

input.on('close', () => {
  manager._close();
  setTimeout(() => process.exit(process.exitCode || 0), 10);
});
