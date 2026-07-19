/**
 * @file desktop-runner-host.cjs — Main-process helpers for the desktop runner
 *
 * The /runners Socket.IO client lives in the Chromium renderer (see
 * client/src/desktopRunnerHost.ts). Node/OpenSSL TLS to some hosts is broken
 * on middleboxed residential networks while Chromium still works, so the main
 * process must not own the relay socket.
 *
 * This module still:
 *  - stores the live API URL + JWT for cascade-note / cascade-chat child envs
 *  - probes locally installed CLI model lists for runner:register
 *  - tracks nothing about the socket (renderer owns connect/reconnect)
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { setNoteApiConfig } = require('./agent-runner.cjs');

let apiBase = 'https://cscd.online';
let currentToken = '';

function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'https://cscd.online';
  return raw.replace(/\/$/, '');
}

/**
 * Probe locally installed CLIs for model lists (best-effort).
 * Returns { agentId: string[] } for agents that report models.
 */
function probeLocalModels() {
  const models = {};
  try {
    const result = spawnSync('grok', ['models'], {
      encoding: 'utf8',
      timeout: 8000,
      env: process.env,
    });
    if (result.status === 0 && result.stdout) {
      const ids = [];
      for (const line of result.stdout.split(/\r?\n/)) {
        // Lines like "  * grok-4.5 (default)" or "  - grok-composer-2.5-fast"
        const m = line.match(/^\s*[*-]\s+([a-zA-Z0-9._-]+)/);
        if (m) ids.push(m[1]);
      }
      if (ids.length) models.grok = ids;
    }
  } catch {
    // grok not installed
  }

  // Antigravity: pull live IDE catalog via language_server (agentapi tiers + labels).
  try {
    // Prefer compiled dist (production); fall back when dist is missing.
    let listAntigravityModels = null;
    let listOmpModels = null;
    try {
      const cliAgentMod = require(path.join(__dirname, '..', 'dist', 'cli-agents', 'cli-agent.js'));
      listAntigravityModels = cliAgentMod.listAntigravityModels;
      listOmpModels = cliAgentMod.listOmpModels;
    } catch {
      listAntigravityModels = null;
    }
    if (typeof listAntigravityModels === 'function') {
      const agy = listAntigravityModels();
      if (Array.isArray(agy) && agy.length) models.antigravity = agy;
    } else {
      models.antigravity = ['flash_lite', 'flash', 'pro'];
    }
    if (typeof listOmpModels === 'function') {
      const ompModels = listOmpModels();
      if (Array.isArray(ompModels) && ompModels.length) models.omp = ompModels;
    } else {
      models.omp = ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'gemini-2.5-pro', 'gemini-3.5-flash'];
    }
  } catch {
    models.antigravity = ['flash_lite', 'flash', 'pro'];
    models.omp = ['claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022', 'gemini-2.5-pro', 'gemini-3.5-flash'];
  }
  return models;
}

/**
 * Configure child-process helper env (token/url). Socket ownership is renderer-side.
 * Kept name `connectDesktopRunner` for existing IPC callers.
 */
function connectDesktopRunner(token, nextApiBase) {
  const authToken = String(token || '').trim();
  if (!authToken) {
    disconnectDesktopRunner();
    return { success: false, error: 'Missing auth token' };
  }

  const nextBase = normalizeApiBase(nextApiBase);
  apiBase = nextBase;
  currentToken = authToken;
  setNoteApiConfig({ url: apiBase, token: authToken });
  return { success: true };
}

function disconnectDesktopRunner() {
  currentToken = '';
  apiBase = 'https://cscd.online';
  setNoteApiConfig({ url: '', token: '' });
}

module.exports = {
  connectDesktopRunner,
  disconnectDesktopRunner,
  // Socket is renderer-owned; main cannot observe it.
  isDesktopRunnerConnected: () => Boolean(currentToken),
  getActiveRunCount: () => 0,
  probeLocalModels,
};
