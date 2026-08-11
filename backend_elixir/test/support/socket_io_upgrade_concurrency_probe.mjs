#!/usr/bin/env node

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Manager } = require('../../../node_modules/socket.io-client');

const [target, token, rawAttempts = '100'] = process.argv.slice(2);
const attempts = Number(rawAttempts);

if (!target || !token || !Number.isInteger(attempts) || attempts < 1) {
  throw new Error('target, token, and a positive attempt count are required');
}

function waitFor(socket, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${socket.nsp} ${event} timeout`));
    }, timeoutMs);
    const onSuccess = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off(event, onSuccess);
      socket.off('connect_error', onError);
    };
    socket.on(event, onSuccess);
    socket.on('connect_error', onError);
  });
}

function waitForUpgrade(manager, timeoutMs) {
  if (manager.engine?.transport?.name === 'websocket') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('websocket upgrade timeout')), timeoutMs);
    manager.engine.once('upgrade', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function connect(index) {
  const manager = new Manager(target, {
    path: '/socket.io/',
    transports: ['polling', 'websocket'],
    upgrade: true,
    reconnection: false,
    timeout: 10_000,
    autoConnect: false,
  });
  const auth = { token };
  const sockets = ['/vault', '/runs', '/runners'].map((namespace) => (
    manager.socket(namespace, { auth })
  ));

  try {
    const connected = sockets.map((socket) => waitFor(socket, 'connect', 10_000));
    for (const socket of sockets) socket.connect();
    await Promise.all(connected);
    await waitForUpgrade(manager, 10_000);
  } catch (error) {
    throw new Error(`attempt ${index}: ${error?.message || error}`);
  } finally {
    for (const socket of sockets) socket.disconnect();
    manager._close();
  }
}

const results = await Promise.allSettled(
  Array.from({ length: attempts }, (_unused, index) => connect(index)),
);
const failures = results.flatMap((result) => (
  result.status === 'rejected' ? [result.reason?.message || String(result.reason)] : []
));

if (failures.length) {
  throw new Error(`${failures.length}/${attempts} upgrades failed: ${failures.slice(0, 10).join('; ')}`);
}

console.log(JSON.stringify({ attempts, connected: attempts, upgraded: attempts }));
