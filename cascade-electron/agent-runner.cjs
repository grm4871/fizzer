/**
 * @file agent-runner.cjs — Local CLI agent execution for the Electron main process
 *
 * Spawns Codex/Grok/etc. on the user's machine (where CLIs are installed) instead
 * of relying on a remote Cascade server. Reuses the compiled server/cli-agent module.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

let cliAgentModulePromise = null;

function expandHome(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function resolveAgentCwd(inputCwd, vaultRoot) {
  const expanded = expandHome(inputCwd);
  if (expanded) {
    const resolved = path.resolve(expanded);
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    } catch {
      // fall through
    }
  }
  const root = String(vaultRoot || '').trim();
  if (root) {
    const resolvedRoot = path.resolve(root);
    try {
      if (fs.existsSync(resolvedRoot) && fs.statSync(resolvedRoot).isDirectory()) return resolvedRoot;
    } catch {
      // fall through
    }
  }
  return os.homedir();
}

async function loadCliAgentModule() {
  if (!cliAgentModulePromise) {
    const modPath = path.join(__dirname, '..', 'dist', 'server', 'cli-agent.js');
    cliAgentModulePromise = import(pathToFileURL(modPath).href);
  }
  return cliAgentModulePromise;
}

/**
 * Start a CLI agent run locally. Events are delivered via `sendEvent`.
 * Resolves when the run finishes (success or failure).
 */
async function startLocalAgentRun(opts, sendEvent) {
  const runId = Number(opts.runId);
  if (!Number.isFinite(runId)) throw new Error('Invalid run id');

  const agent = String(opts.agent || '').trim();
  const prompt = String(opts.prompt || '').trim();
  if (!agent) throw new Error('Agent is required');
  if (!prompt) throw new Error('Prompt is required');

  const { runCliAgent } = await loadCliAgentModule();
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);

  let seq = 0;
  const emit = (type, payload) => {
    sendEvent({
      runId,
      seq: ++seq,
      type,
      payload_json: JSON.stringify(payload),
    });
  };

  emit('status', { status: 'running' });

  try {
    const result = await runCliAgent({
      agent,
      context: '',
      userPrompt: prompt,
      cwd,
      resumeSessionId: typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined,
      images: Array.isArray(opts.images) ? opts.images : [],
      model: typeof opts.model === 'string' ? opts.model : undefined,
      runId,
      emit,
    });
    emit('status', {
      status: 'completed',
      summary: result.summary || 'Done.',
      sessionId: result.sessionId,
    });
    return { sessionId: result.sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emit('status', { status: 'failed', summary: message });
    throw error;
  }
}

async function cancelLocalAgentRun(runId) {
  const { activeCliProcesses } = await loadCliAgentModule();
  const id = Number(runId);
  const child = activeCliProcesses.get(id);
  if (!child) return false;
  try { child.kill('SIGTERM'); } catch { /* ignore */ }
  activeCliProcesses.delete(id);
  return true;
}

module.exports = {
  startLocalAgentRun,
  cancelLocalAgentRun,
  resolveAgentCwd,
};