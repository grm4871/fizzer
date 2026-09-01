#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http, { createServer } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { pickPort } from '../scripts/lib/test-ports.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(root, 'deploy/nginx.conf.template');
const nginxImage = process.env.CASCADE_NGINX_TEST_IMAGE
  || 'nginx:1.22-alpine@sha256:8745c93f1a1c33a8ec8c82707b9bb1c8fe9ebf2b5d82e9480e78625d809855a1';
const httpPort = await pickPort();
const httpsPort = await pickPort();
const backendPort = await pickPort();
const backupPort = await pickPort();
const domain = 'edge.test';
const temp = await mkdtemp(path.join(tmpdir(), 'cascade-nginx-edge-'));
const containerName = `cascade-nginx-edge-${process.pid}`;
const sockets = [];
let nginx;
let nginxErrors = '';
let primaryClosed = false;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function request({ secure = true, requestPath = '/', method = 'GET', headers = {}, body } = {}) {
  const transport = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: '127.0.0.1',
      port: secure ? httpsPort : httpPort,
      path: requestPath,
      method,
      rejectUnauthorized: false,
      servername: domain,
      headers: { Host: domain, ...headers },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

function openSocket(index, expectStatus = 101) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `wss://127.0.0.1:${httpsPort}/socket.io/?EIO=4&transport=websocket&probe=${index}`,
      {
        rejectUnauthorized: false,
        servername: domain,
        headers: {
          Host: domain,
          // Every claimed client address differs. nginx must still group all
          // connections by their genuine 127.0.0.1 TCP peer.
          'X-Forwarded-For': `198.51.100.${(index % 250) + 1}`,
        },
      },
    );

    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`WebSocket ${index} timed out`));
    }, 5_000);

    socket.once('open', () => {
      clearTimeout(timeout);
      if (expectStatus !== 101) {
        socket.terminate();
        reject(new Error(`WebSocket ${index} unexpectedly upgraded`));
      } else {
        resolve({ status: 101, socket });
      }
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      if (response.statusCode !== expectStatus) {
        reject(new Error(`WebSocket ${index} returned ${response.statusCode}, expected ${expectStatus}`));
      } else {
        resolve({ status: response.statusCode, headers: response.headers });
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      if (socket.readyState !== WebSocket.CLOSED) reject(error);
    });
  });
}

async function waitForEdge() {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request({ requestPath: '/api/health' });
      if (response.status === 200) return response;
      lastError = new Error(`edge returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`nginx did not become ready: ${lastError?.message || lastError}`);
}

const websocketServer = new WebSocketServer({ noServer: true });
function createBackend(identity) {
  const server = createServer((req, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ backend: identity, headers: req.headers, method: req.method, url: req.url }));
  });
  server.on('upgrade', (req, socket, head) => {
    websocketServer.handleUpgrade(req, socket, head, (websocket) => {
      websocketServer.emit('connection', websocket, req);
    });
  });
  return server;
}
const backend = createBackend('primary');
const backupBackend = createBackend('backup');
try {
  const template = await readFile(templatePath, 'utf8');
  invariant(template.includes('limit_conn_zone $binary_remote_addr zone=cascade_connections_per_ip:10m;'),
    'connection zone must use the genuine nginx peer address');
  invariant(template.includes('location ^~ /socket.io/ {'), 'Socket.IO edge location is missing');
  invariant(!template.includes('127.0.0.1:9001'), 'superseded webhook listener is still exposed');
  invariant(template.includes('limit_conn cascade_connections_per_ip 40;'),
    'Socket.IO per-IP limit must remain exactly 40');
  invariant(template.includes('limit_conn_status 429;'), 'connection overflow must return 429');
  invariant(!/\b(?:real_ip_header|set_real_ip_from)\b/.test(template),
    'the edge must not rewrite remote_addr from client-supplied forwarding headers');

  const certificatePath = path.join(temp, 'cert.pem');
  const keyPath = path.join(temp, 'key.pem');
  const openssl = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${domain}`, '-keyout', keyPath, '-out', certificatePath,
  ], { stdio: 'ignore' });
  invariant(openssl.status === 0, 'failed to generate the local TLS certificate');

  const rendered = template
    .replaceAll('DOMAIN', domain)
    .replaceAll('CASCADE_PRIMARY_PORT', String(backendPort))
    .replaceAll(
      'CASCADE_BACKUP_SERVER',
      `server 127.0.0.1:${backupPort} backup max_fails=1 fail_timeout=2s;`,
    )
    .replaceAll('listen 80;', `listen ${httpPort};`)
    .replaceAll('listen [::]:80;', `listen [::]:${httpPort};`)
    .replaceAll('listen 443 ssl http2;', `listen ${httpsPort} ssl;`)
    .replaceAll('listen [::]:443 ssl http2;', `listen [::]:${httpsPort} ssl;`)
    .replace(/\s*include\s+\/etc\/letsencrypt\/options-ssl-nginx\.conf;\n/, '\n')
    .replace(/\s*ssl_dhparam\s+\/etc\/letsencrypt\/ssl-dhparams\.pem;\n/, '\n')
    .replace(/\/etc\/letsencrypt\/live\/edge\.test\/fullchain\.pem/g, '/edge/cert.pem')
    .replace(/\/etc\/letsencrypt\/live\/edge\.test\/privkey\.pem/g, '/edge/key.pem');
  const config = `
worker_processes 1;
events { worker_connections 1024; }
http {
  access_log /dev/stdout;
  error_log /dev/stderr notice;
  ${rendered}
}
`;
  await writeFile(path.join(temp, 'nginx.conf'), config);

  await new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.listen(backendPort, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => {
    backupBackend.once('error', reject);
    backupBackend.listen(backupPort, '127.0.0.1', resolve);
  });
  nginx = spawn('docker', [
    'run', '--rm', '--network', 'host', '--name', containerName,
    '--volume', `${temp}:/edge:ro`, nginxImage,
    'nginx', '-c', '/edge/nginx.conf', '-g', 'daemon off;',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  nginx.stderr.on('data', (chunk) => { nginxErrors += chunk.toString('utf8'); });

  const health = await waitForEdge();
  invariant(health.headers['strict-transport-security'] === 'max-age=31536000; includeSubDomains',
    'HTTPS responses must carry the production HSTS policy');
  const initial = JSON.parse(health.body);
  invariant(initial.backend === 'primary', `initial request reached ${initial.backend}`);
  const observed = initial.headers;
  invariant(observed.host === domain, `upstream Host mismatch: ${observed.host}`);
  invariant(observed['x-real-ip'] === '127.0.0.1', `X-Real-IP mismatch: ${observed['x-real-ip']}`);
  invariant(observed['x-forwarded-proto'] === 'https', 'X-Forwarded-Proto must reflect TLS');

  const spoof = await request({
    requestPath: '/api/health?forwarded=1',
    headers: { 'X-Forwarded-For': '198.51.100.200' },
  });
  const spoofHeaders = JSON.parse(spoof.body).headers;
  invariant(spoofHeaders['x-forwarded-for'] === '198.51.100.200, 127.0.0.1',
    `nginx did not append its genuine peer: ${spoofHeaders['x-forwarded-for']}`);

  const redirect = await request({ secure: false, requestPath: '/app?edge=1' });
  invariant(redirect.status === 301, `HTTP redirect returned ${redirect.status}`);
  invariant(redirect.headers.location === `https://${domain}/app?edge=1`,
    `HTTP redirect target mismatch: ${redirect.headers.location}`);

  const markerOn = spawnSync('docker', ['exec', containerName, 'touch', '/run/cascade-maintenance']);
  invariant(markerOn.status === 0, 'failed to create the local maintenance marker');
  const maintenance = await request({ requestPath: '/api/health' });
  invariant(maintenance.status === 503, `maintenance gate returned ${maintenance.status}`);
  invariant(maintenance.headers['strict-transport-security'] === 'max-age=31536000; includeSubDomains',
    'the maintenance response must retain HSTS');
  const markerOff = spawnSync('docker', ['exec', containerName, 'rm', '/run/cascade-maintenance']);
  invariant(markerOff.status === 0, 'failed to remove the local maintenance marker');
  invariant((await request({ requestPath: '/api/health' })).status === 200,
    'edge did not reopen after the maintenance marker was removed');

  await new Promise((resolve, reject) => {
    backend.close((error) => (error ? reject(error) : resolve()));
  });
  primaryClosed = true;
  const failoverPost = await request({ method: 'POST', requestPath: '/api/failover' });
  const failoverBody = JSON.parse(failoverPost.body);
  invariant(failoverPost.status === 200, `rolling failover POST returned ${failoverPost.status}`);
  invariant(failoverBody.backend === 'backup', `rolling failover reached ${failoverBody.backend}`);
  invariant(failoverBody.method === 'POST', `rolling failover changed method to ${failoverBody.method}`);

  let authAtSharedLimit;
  for (let index = 0; index < 40; index += 1) {
    const accepted = await openSocket(index);
    sockets.push(accepted.socket);
    if (sockets.length === 20) {
      authAtSharedLimit = await request({ requestPath: '/api/auth/probe' });
      invariant(authAtSharedLimit.status === 429,
        `auth connection above the shared 20-connection cap returned ${authAtSharedLimit.status}`);
    }
  }
  invariant(websocketServer.clients.size === 40,
    `upstream saw ${websocketServer.clients.size} sockets, expected 40`);

  const apiAtSharedLimit = await request({ requestPath: '/api/health' });
  invariant(apiAtSharedLimit.status === 429,
    `API connection above the shared 40-connection cap returned ${apiAtSharedLimit.status}`);

  const rejected = await openSocket(40, 429);
  invariant(rejected.headers['strict-transport-security'] === 'max-age=31536000; includeSubDomains',
    'the 429 overflow response must retain HSTS');
  invariant(websocketServer.clients.size === 40, 'the rejected 41st socket reached the upstream');

  await new Promise((resolve) => {
    sockets.pop().once('close', resolve).close();
  });
  const replacement = await openSocket(41);
  sockets.push(replacement.socket);
  invariant(websocketServer.clients.size === 40, 'the connection slot was not released after close');

  console.log(JSON.stringify({
    sourceIp: '127.0.0.1',
    spoofedForwardedAddresses: 42,
    acceptedPersistentSocketIoConnections: 40,
    rejectedConnection: 41,
    rejectionStatus: rejected.status,
    replacementAcceptedAfterClose: true,
    authRequestWith20ActiveSockets: authAtSharedLimit.status,
    apiRequestWith40ActiveSockets: apiAtSharedLimit.status,
    maintenanceGateStatus: maintenance.status,
    rollingFailoverStatus: failoverPost.status,
    rollingFailoverBackend: failoverBody.backend,
    hsts: health.headers['strict-transport-security'],
    forwardedForSeenUpstream: spoofHeaders['x-forwarded-for'],
    httpRedirect: redirect.headers.location,
  }, null, 2));
} catch (error) {
  if (nginxErrors) {
    console.error(`nginx probe stderr:\n${nginxErrors}`);
  }
  throw error;
} finally {
  for (const socket of sockets) socket.terminate();
  websocketServer.close();
  if (!primaryClosed) await new Promise((resolve) => backend.close(resolve));
  await new Promise((resolve) => backupBackend.close(resolve));
  if (nginx && nginx.exitCode === null) {
    spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
  }
  await rm(temp, { recursive: true, force: true });
}
