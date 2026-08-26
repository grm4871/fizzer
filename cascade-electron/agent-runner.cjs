/** Electron agent lifecycle facade. Provider loading, helper context, and Claude streaming live in dedicated modules. */
const { CLAUDE_AGENT_CONTEXT, buildRunHelperEnv, cleanupRunHelperConfig, chatTriggeringMessageId, helperAllowedTools, renderInlineSvgAttachments, setNoteApiConfig, isChatRun, noteCapabilityContext, emitTerminalStatus } = require('./agent-helper-context.cjs');
const { activeClaudeProcesses, canceledClaudeRuns, runClaudeLocally, normalizeClaudeEffort, formatToolHarnessPreview, isMissingClaudeSession, resolveAgentCwd } = require('./claude-stream-adapter.cjs');
const { activeCliAgentModules, loadCliAgentModule } = require('./cli-agent-loader.cjs');
const path = require('path');
function emitHarness(emit, data) {
  if (data) emit('harness', { data: String(data) });
}
/**
 * Start an agent run locally. Events are delivered via `sendEvent`.
 * Resolves when the run finishes (success or failure).
 */
async function startLocalAgentRun(opts, sendEvent) {
  const runId = Number(opts.runId);
  if (!Number.isFinite(runId)) throw new Error('Invalid run id');

  const agent = String(opts.agent || '').trim();
  const rawPrompt = String(opts.prompt || '').trim();
  if (!agent) throw new Error('Agent is required');
  if (!rawPrompt) throw new Error('Prompt is required');

  const preparedPrompt = renderInlineSvgAttachments(rawPrompt, opts.inlineSvgs);
  const prompt = preparedPrompt.prompt;
  const images = [
    ...(Array.isArray(opts.images) ? opts.images : []),
    ...preparedPrompt.images,
  ];

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
    let resume = typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined;
    let runPrompt = prompt;
    let startupRetries = 0;
    let staleSessionRetried = false;
    canceledClaudeRuns.delete(runId);
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          const result = await runClaudeLocally({ ...opts, prompt: runPrompt, images, resumeSessionId: resume }, emit);
          emitTerminalStatus(emit, runId, 'completed', result.summary, result.sessionId);
          return { sessionId: result.sessionId };
        } catch (error) {
          if (error?.cascadeCanceled || canceledClaudeRuns.has(runId)) {
            emitTerminalStatus(emit, runId, 'canceled', 'Run canceled.', error?.cascadeSessionId);
            return { canceled: true };
          }
          if (error?.cascadeStartupTimeout && startupRetries < 1) {
            startupRetries += 1;
            emitHarness(emit, '\x1b[2m# Claude did not start — retrying once\x1b[0m\r\n');
            continue;
          }
          // Session ids are local to the owner's Claude installation. If an
          // agent was previously misrouted to another machine, discard that
          // foreign id and start the requested turn fresh once.
          if (resume && !staleSessionRetried && isMissingClaudeSession(error)) {
            staleSessionRetried = true;
            resume = undefined;
            runPrompt = prompt;
            emitHarness(emit, '\x1b[2m# Claude session is not present on this machine — starting fresh\x1b[0m\r\n');
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          emitTerminalStatus(emit, runId, 'failed', message, error?.cascadeSessionId);
          throw error;
        }
      }
    } finally {
      canceledClaudeRuns.delete(runId);
      cleanupRunHelperConfig(runId);
      preparedPrompt.cleanup();
    }
  }

  const cliModule = await loadCliAgentModule();
  const { runCliAgent, setRunHelperEnv, clearRunHelperEnv } = cliModule;
  activeCliAgentModules.set(runId, cliModule);
  const selfContained = opts.contextMode === 'self-contained';
  const helperEnv = selfContained ? {} : buildRunHelperEnv(opts);
  setRunHelperEnv(runId, helperEnv);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);

  const env = { ...process.env, ...helperEnv };

  try {
    const result = await runCliAgent({
      agent,
      context: isChatRun(opts) || selfContained ? '' : `${CLAUDE_AGENT_CONTEXT} ${noteCapabilityContext(opts)}`,
      userPrompt: prompt,
      cwd,
      resumeSessionId: typeof opts.resumeSessionId === 'string' ? opts.resumeSessionId : undefined,
      images,
      model: typeof opts.model === 'string' ? opts.model : undefined,
      reasoningEffort: typeof opts.reasoningEffort === 'string' ? opts.reasoningEffort : undefined,
      priorityServiceTier: opts.priorityServiceTier === true,
      sandbox: selfContained && opts.sandbox === 'read-only' ? 'read-only' : undefined,
      yolo: opts.yolo === true,
      hermesProfile: typeof opts.hermesProfile === 'string' ? opts.hermesProfile : undefined,
      hermesSafeMode: opts.hermesSafeMode === true,
      runId,
      emit,
      env,
    });
    emitTerminalStatus(emit, runId, 'completed', result.summary || '', result.sessionId);
    return { sessionId: result.sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitTerminalStatus(emit, runId, 'failed', message);
    throw error;
  } finally {
    if (activeCliAgentModules.get(runId) === cliModule) activeCliAgentModules.delete(runId);
    clearRunHelperEnv(runId);
    cleanupRunHelperConfig(runId);
    preparedPrompt.cleanup();
  }
}

async function cancelLocalAgentRun(runId) {
  const id = Number(runId);

  // Claude CLI runs: terminate the live child process.
  const claudeProcess = activeClaudeProcesses.get(id);
  if (claudeProcess) {
    canceledClaudeRuns.add(id);
    try { claudeProcess.kill('SIGTERM'); } catch { /* ignore */ }
    activeClaudeProcesses.delete(id);
    return true;
  }

  const mod = activeCliAgentModules.get(id) || await loadCliAgentModule();
  // Antigravity keeps polling transcript.jsonl after agentapi exits — flag it.
  let flagged = false;
  if (typeof mod.cancelAntigravityRun === 'function') {
    try { mod.cancelAntigravityRun(id); flagged = true; } catch { /* ignore */ }
  }
  if (typeof mod.cancelCliAgentRun === 'function') {
    try {
      if (mod.cancelCliAgentRun(id)) return true;
    } catch { /* fall through to legacy direct-child cancellation */ }
  }
  const child = mod.activeCliProcesses?.get(id);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    mod.activeCliProcesses.delete(id);
    return true;
  }
  return flagged;
}

/** Reap detached CLI groups left behind by a prior crashed Electron main. */
async function reapOrphanedLocalAgentRuns() {
  await loadCliAgentModule();
}


module.exports = { startLocalAgentRun, cancelLocalAgentRun, reapOrphanedLocalAgentRuns, buildRunHelperEnv, cleanupRunHelperConfig, chatTriggeringMessageId, helperAllowedTools, normalizeClaudeEffort, formatToolHarnessPreview, renderInlineSvgAttachments, isMissingClaudeSession, resolveAgentCwd, setNoteApiConfig };
