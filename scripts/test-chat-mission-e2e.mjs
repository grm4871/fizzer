#!/usr/bin/env node
/** Real-server persistence/multiplayer test for chat-first missions. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { pickPort } from './lib/test-ports.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_PORT = Number(process.env.TEST_API_PORT) || await pickPort();
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const DB_PATH = `/tmp/cascade-chatmission-e2e-${API_PORT}.db`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

async function must(url, options = {}) {
  const result = await request(url, options);
  if (!result.ok) throw new Error(`${result.status} ${url}: ${result.data.error || 'request failed'}`);
  return result.data;
}

async function waitForHealth() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const result = await request(`${API_BASE}/api/health`);
      if (result.ok) return;
    } catch { /* booting */ }
    await sleep(150);
  }
  throw new Error('server did not become healthy');
}

async function register(username) {
  const { token } = await must(`${API_BASE}/api/auth/register`, {
    method: 'POST', body: JSON.stringify({ username, password: 'testpass12345' }),
  });
  return { token, auth: { authorization: `Bearer ${token}` } };
}

async function socketFor(token, vaultId) {
  const socket = io(`${API_BASE}/vault`, { auth: { token }, transports: ['websocket'] });
  const created = [];
  const updated = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket timeout')), 10_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.emit('joinVault', vaultId);
      resolve();
    });
    socket.on('connect_error', reject);
  });
  socket.on('vault:chatMessageCreated', (event) => created.push(event));
  socket.on('vault:chatMessageUpdated', (event) => updated.push(event));
  return { socket, created, updated };
}

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`[mission-e2e] OK  ${label}`);
  else { console.error(`[mission-e2e] FAIL ${label}`); failures += 1; }
}

async function main() {
  try { fs.unlinkSync(DB_PATH); } catch { /* clean */ }
  const server = spawn('node', ['dist/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      API_PORT: String(API_PORT),
      API_HOST: '127.0.0.1',
      DOCS_DB_PATH: DB_PATH,
      JWT_SECRET: 'mission-e2e-secret',
      CASCADE_ALLOW_OPEN_REGISTRATION: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server-err] ${chunk}`));

  try {
    await waitForHealth();
    const stamp = Date.now();
    const owner = await register(`owner_${stamp}`);
    const guest = await register(`guest_${stamp}`);
    const { vault } = await must(`${API_BASE}/api/vaults`, {
      method: 'POST', headers: owner.auth, body: JSON.stringify({ name: 'Mission vault' }),
    });
    const { note: channel } = await must(`${API_BASE}/api/vaults/${vault.id}/notes`, {
      method: 'POST', headers: owner.auth,
      body: JSON.stringify({ title: 'dev', content: 'cascade://chat-channel' }),
    });
    const solIdentity = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
      method: 'PUT', headers: owner.auth,
      body: JSON.stringify({ agentId: 'codex', displayName: 'Sol', mention: 'sol', model: 'gpt-5.6-sol' }),
    });
    const terraIdentity = await must(`${API_BASE}/api/vaults/${vault.id}/vault-agents`, {
      method: 'PUT', headers: owner.auth,
      body: JSON.stringify({ agentId: 'codex', displayName: 'Terra', mention: 'terra', model: 'gpt-5.6-terra' }),
    });
    const { registration: sol } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
      method: 'POST', headers: owner.auth,
      body: JSON.stringify({ vaultAgentId: solIdentity.agent.id, orchestrator: true, pingableByOthers: true }),
    });
    const { registration: terra } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents/from-vault`, {
      method: 'POST', headers: owner.auth,
      body: JSON.stringify({ vaultAgentId: terraIdentity.agent.id, taggableByAgents: false }),
    });
    check('coordinator implies reply-to-every-human-message', sol.orchestrator && sol.replyToEveryMessage);
    check('worker remains closed to ordinary agent chaining', !terra.taggableByAgents);
    const { token: agentToken } = await must(`${API_BASE}/api/auth/agent-token`, {
      method: 'POST', headers: owner.auth,
    });
    const agentAuth = { authorization: `Bearer ${agentToken}` };
    const helperMembers = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agents`, {
      headers: agentAuth,
    });
    check('restricted helper token can list mission teammates', helperMembers.agents?.length === 2);
    const helperFolder = await must(`${API_BASE}/api/vaults/${vault.id}/folders`, {
      method: 'POST', headers: agentAuth, body: JSON.stringify({ name: 'agent-created' }),
    });
    check('restricted helper token can create a live-note folder', helperFolder.folder?.name === 'agent-created');

    const { token: invite } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/invite-link`, {
      method: 'POST', headers: owner.auth,
    });
    const guestLink = await must(`${API_BASE}/api/chat-invites/${encodeURIComponent(invite)}/accept`, {
      method: 'POST', headers: guest.auth,
    });
    const ownerSocket = await socketFor(owner.token, vault.id);
    const guestSocket = await socketFor(guest.token, guestLink.vaultId);
    await sleep(150);

    const guestPost = await must(`${API_BASE}/api/vaults/${guestLink.vaultId}/channels/${guestLink.channelId}/messages`, {
      method: 'POST', headers: guest.auth,
      body: JSON.stringify({
        id: `guest-${stamp}`, channelId: guestLink.channelId, author: `guest_${stamp}`,
        body: 'Coordinate this shared-channel request.', createdAt: new Date().toISOString(),
      }),
    });
    check('an opted-in coordinator receives ordinary multiplayer turns', guestPost.dispatches?.[0]?.registration?.id === sol.id);

    const rootMessage = {
      id: `root-${stamp}`, channelId: channel.id, author: `owner_${stamp}`,
      body: 'Investigate and verify multiplayer orchestration.', createdAt: new Date().toISOString(),
    };
    const posted = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages`, {
      method: 'POST', headers: owner.auth, body: JSON.stringify(rootMessage),
    });
    check('human message creates a durable coordinator dispatch', posted.dispatches?.[0]?.registration?.id === sol.id);

    const { mission } = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({
        rootMessageId: rootMessage.id,
        coordinatorRegistrationId: sol.id,
        title: 'Multiplayer orchestration',
        objective: rootMessage.body,
      }),
    });
    const delegated = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/tasks`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({
        coordinatorRegistrationId: sol.id,
        title: 'Verify guest reload',
        assignee: '@terra',
        prompt: 'Verify the guest can reload and retain mission state.',
      }),
    });
    check('coordinator can dispatch an opt-out worker explicitly', delegated.task?.assigneeMention === 'terra');
    check('delegation message is linked to its durable task', delegated.message?.missionTaskId === delegated.task?.id);
    const dependent = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/tasks`, {
      method: 'POST', headers: agentAuth,
      body: JSON.stringify({
        coordinatorRegistrationId: sol.id,
        title: 'Recheck after guest verification',
        assignee: '@terra',
        prompt: 'Recheck only after the guest reload evidence is ready.',
        dependsOn: [delegated.task.id],
        priority: 5,
        reasoningEffort: 'high',
      }),
    });
    check('dependent work stays undispatched while prerequisites run', dependent.scheduled === false && !dependent.message);
    check('mission projection exposes dependency waiting state', dependent.task?.waitingFor?.[0] === delegated.task.id);
    const helperStatus = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}`, {
      headers: agentAuth,
    });
    check('restricted helper token can read mission state', helperStatus.mission?.id === mission.id);
    const helperUpdate = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${delegated.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'running', summary: 'Accepted by the worker queue.' }),
    });
    check('restricted helper token can update a mission task', helperUpdate.mission?.tasks?.[0]?.status === 'running');
    const completedFirst = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${delegated.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'completed', summary: 'Guest reload verified.' }),
    });
    check('completing a prerequisite automatically dispatches its dependent', (
      completedFirst.mission?.tasks?.find((task) => task.id === dependent.task.id)?.queueReason === 'queued'
    ));

    await sleep(300);
    check('owner received the inline mission update', ownerSocket.updated.some((event) => event.message?.mission?.id === mission.id));
    check('linked guest received the same mission projection', guestSocket.updated.some((event) => (
      event.channelId === guestLink.channelId && event.message?.mission?.id === mission.id
    )));
    check('worker dispatch reached owner clients as a durable outbox event', ownerSocket.created.some((event) => (
      event.message?.missionTaskId === delegated.task.id
      && event.dispatches?.[0]?.registration?.id === terra.id
    )));
    check('automatic dependent dispatch reached owner clients', ownerSocket.created.some((event) => (
      event.message?.missionTaskId === dependent.task.id
      && event.dispatches?.[0]?.reasoningEffort === 'high'
    )));
    check('private worker dispatch is not offered to guest renderers', !guestSocket.created.some((event) => (
      event.message?.missionTaskId === delegated.task.id && (event.dispatches?.length || 0) > 0
    )));

    const ownerReload = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/messages?detail=list`, { headers: owner.auth });
    const guestReload = await must(`${API_BASE}/api/vaults/${guestLink.vaultId}/channels/${guestLink.channelId}/messages?detail=list`, { headers: guest.auth });
    check('owner reload retains the scheduled task graph', ownerReload.messages.find((message) => message.id === rootMessage.id)?.mission?.tasks?.length === 2);
    check('guest reload retains the scheduled task graph through linked ids', guestReload.messages.find((message) => message.id === rootMessage.id)?.mission?.tasks?.length === 2);

    const pending = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agent-dispatches/pending`, { headers: owner.auth });
    check('pending outbox survives without a renderer', pending.dispatches.some((dispatch) => (
      dispatch.message?.missionTaskId === dependent.task.id && dispatch.registration?.id === terra.id
    )));

    const failedDependent = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${dependent.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'failed', summary: 'Transient provider failure.' }),
    });
    check('worker failure asks for attention without closing the mission', failedDependent.mission?.status === 'attention');
    const retriedDependent = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/tasks/${dependent.task.id}`, {
      method: 'PATCH', headers: agentAuth,
      body: JSON.stringify({ status: 'pending', summary: 'Retry with the same task and workspace.' }),
    });
    check('retry keeps task identity and increments its attempt', (
      retriedDependent.mission?.tasks?.find((task) => task.id === dependent.task.id)?.attempt === 1
    ));
    const retryOutbox = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/agent-dispatches/pending`, { headers: owner.auth });
    check('retry gets a fresh durable dispatch instead of reusing the settled one', retryOutbox.dispatches.some((dispatch) => (
      dispatch.message?.id === `mission-task-${dependent.task.id}-1`
    )));
    const history = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions/${mission.id}/history`, { headers: agentAuth });
    check('append-only history retains the retry transition', history.events?.some((event) => (
      event.kind === 'task_retried' && event.taskId === dependent.task.id
    )));
    const archive = await must(`${API_BASE}/api/vaults/${vault.id}/channels/${channel.id}/missions`, { headers: agentAuth });
    check('mission archive is independent of the transcript window', archive.missions?.some((item) => item.id === mission.id));

    ownerSocket.socket.disconnect();
    guestSocket.socket.disconnect();
    if (failures) throw new Error(`${failures} mission check(s) failed`);
    console.log('[mission-e2e] All chat-first mission checks passed');
  } finally {
    server.kill('SIGTERM');
    await sleep(250);
    try { fs.unlinkSync(DB_PATH); } catch { /* clean */ }
  }
}

main().catch((error) => {
  console.error('[mission-e2e] FAILED:', error.message || error);
  process.exit(1);
});
