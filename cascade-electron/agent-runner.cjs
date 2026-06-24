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
let claudeSdkPromise = null;

// Claude (claude-code) runs locally via the Anthropic Agent SDK, authenticated
// by THIS machine's `claude` login / ANTHROPIC_API_KEY — never the server's.
// Mirrors the run options the server used to apply in server/runner.ts.
const CLAUDE_DEFAULT_MODEL = process.env.RUNNER_MODEL || 'claude-sonnet-4-6';
const CLAUDE_MAX_TURNS = Number(process.env.RUNNER_MAX_TURNS || 30);
const CLAUDE_THINKING_TOKENS = Number(process.env.RUNNER_THINKING ?? 4000);
const CLAUDE_AGENT_CONTEXT = 'Operate as a user-authorized local workspace assistant. Use normal local file operations in this vault, respect service terms, authentication boundaries, and rate limits, and do not handle secrets except when the user explicitly provides them for this local task. This working directory is a vault of interlinked markdown (.md) notes.';

// Live Claude SDK query streams, keyed by runId, so cancellation can close them.
const activeClaudeQueries = new Map();

async function loadClaudeSdk() {
  if (!claudeSdkPromise) {
    claudeSdkPromise = (async () => {
      try {
        return await import('@anthropic-ai/claude-agent-sdk');
      } catch {
        const p = path.join(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
        return import(pathToFileURL(p).href);
      }
    })();
  }
  return claudeSdkPromise;
}

// Same mapping the server applied: SDK message type → run_event type expected
// by the chat/AIPanel renderer.
function classifySdkMessage(message) {
  if (message.type === 'assistant') return 'text';
  if (message.type === 'result') return 'result';
  if (message.type === 'system') return 'system';
  return message.type || 'message';
}

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
 * Run Claude locally via the Agent SDK, translating the SDK message stream into
 * the same run_events the renderer already understands. Auth comes from this
 * machine's `claude` login / ANTHROPIC_API_KEY.
 */
async function runClaudeLocally(opts, emit) {
  const { query } = await loadClaudeSdk();
  const runId = Number(opts.runId);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);
  const model = (typeof opts.model === 'string' && opts.model.trim()) ? opts.model.trim() : CLAUDE_DEFAULT_MODEL;
  const resumeSessionId = (typeof opts.resumeSessionId === 'string' && opts.resumeSessionId) ? opts.resumeSessionId : undefined;
  const images = Array.isArray(opts.images)
    ? opts.images.filter((im) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
    : [];

  // With images, send a structured user message (text + image blocks);
  // otherwise a plain string prompt.
  const claudePrompt = images.length
    ? (async function* () {
        yield {
          type: 'user',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: opts.prompt },
              ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
            ],
          },
          parent_tool_use_id: null,
          session_id: '',
        };
      })()
    : opts.prompt;

  const stream = query({
    prompt: claudePrompt,
    options: {
      cwd,
      model,
      maxTurns: CLAUDE_MAX_TURNS,
      permissionMode: 'acceptEdits',
      // Electron's main process is not a Node runtime, so spawn a real `node`
      // from PATH to host the bundled Claude Code CLI.
      executable: 'node',
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      ...(CLAUDE_THINKING_TOKENS > 0
        ? { thinking: { type: 'enabled', budgetTokens: CLAUDE_THINKING_TOKENS } }
        : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: CLAUDE_AGENT_CONTEXT },
    },
  });

  activeClaudeQueries.set(runId, stream);
  let summary = '';
  let sessionId;
  try {
    for await (const message of stream) {
      emit(classifySdkMessage(message), message);
      if (message.session_id) sessionId = message.session_id;
      if (message.type === 'result') summary = message.result || message.subtype || summary;
    }
  } finally {
    activeClaudeQueries.delete(runId);
  }
  return { summary: summary || 'Completed note operations successfully.', sessionId };
}

/**
 * Start an agent run locally. Events are delivered via `sendEvent`.
 * Resolves when the run finishes (success or failure).
 */
async function startLocalAgentRun(opts, sendEvent) {
  const runId = Number(opts.runId);
  if (!Number.isFinite(runId)) throw new Error('Invalid run id');

  const agent = String(opts.agent || '').trim();
  const prompt = String(opts.prompt || '').trim();
  if (!agent) throw new Error('Agent is required');
  if (!prompt) throw new Error('Prompt is required');

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

  if (agent === 'claude-code') {
    try {
      const result = await runClaudeLocally({ ...opts, prompt }, emit);
      emit('status', { status: 'completed', summary: result.summary, sessionId: result.sessionId });
      return { sessionId: result.sessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('status', { status: 'failed', summary: message });
      throw error;
    }
  }

  const { runCliAgent } = await loadCliAgentModule();
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);

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
  const id = Number(runId);

  // Claude SDK runs: close the live query stream.
  const claudeStream = activeClaudeQueries.get(id);
  if (claudeStream) {
    try { claudeStream.close?.(); } catch { /* ignore */ }
    activeClaudeQueries.delete(id);
    return true;
  }

  const { activeCliProcesses } = await loadCliAgentModule();
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