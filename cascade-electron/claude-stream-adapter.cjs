/** Claude stream adapter for local Claude CLI lifecycle and event translation. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { CLAUDE_DEFAULT_MODEL, CLAUDE_EFFORT, CLAUDE_CHAT_EFFORT, CLAUDE_AGENT_CONTEXT, CHAT_BREVITY_CONTEXT, CHAT_CONTEXT_TOOL_CONTEXT, buildRunHelperEnv, resolveWrapperDir, isChatRun, noteCapabilityContext, helperAllowedTools } = require('./agent-helper-context.cjs');
// Live Claude CLI processes, keyed by runId, so cancellation can stop them.
const activeClaudeProcesses = new Map();
const canceledClaudeRuns = new Set();
const CLAUDE_STARTUP_TIMEOUT_MS = 45_000;

// Map Claude CLI stream message types to the run_event types expected
// by the chat renderer.
function classifySdkMessage(message) {
  if (message.type === 'assistant') return 'text';
  if (message.type === 'result') return 'result';
  if (message.type === 'system') return 'system';
  return message.type || 'message';
}

/** Emit a harness/terminal chunk for the chat terminal pane. */
function emitHarness(emit, data) {
  if (!data) return;
  emit('harness', { data: String(data) });
}

function formatToolInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** One-line tool detail for the ordinary run trace (never raw protocol JSON). */
function formatToolHarnessPreview(input) {
  if (input == null) return '';
  let detail = '';
  if (typeof input === 'string') {
    detail = input;
  } else if (typeof input === 'object') {
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description']) {
      if (typeof input[key] === 'string' && input[key].trim()) {
        detail = input[key];
        break;
      }
    }
    if (!detail && !('_raw' in input)) detail = formatToolInput(input);
  } else {
    detail = String(input);
  }
  const oneLine = detail.replace(/\s+/g, ' ').trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
}

/**
 * Emit a machine-readable `# cascade-stats …` harness line for the chat UI.
 * Merges whatever fields we have (usage, context, rate limits) — the client
 * keeps the latest non-null values per field.
 */
function emitCascadeStats(emit, stats) {
  if (!emit || !stats || typeof stats !== 'object') return;
  // Drop undefined so the JSON stays compact and easy to merge.
  const clean = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    emitHarness(emit, `\x1b[2m# cascade-stats ${JSON.stringify(clean)}\x1b[0m\r\n`);
  } catch { /* ignore */ }
}

/** Pull context-window / turn / cost fields off a Claude CLI result message. */
function statsFromClaudeResult(message, model) {
  const usage = message.usage || {};
  const modelUsage = message.modelUsage && typeof message.modelUsage === 'object'
    ? message.modelUsage
    : {};
  // Prefer the entry matching the run model; else first modelUsage row.
  let mu = modelUsage[model];
  if (!mu) {
    const keys = Object.keys(modelUsage);
    mu = keys.length ? modelUsage[keys[0]] : null;
  }
  const contextWindow = numOrUndef(mu?.contextWindow);
  // Approximate filled context from last-turn API usage when the CLI doesn't
  // give an explicit total. Cache-read + input ≈ tokens in the window.
  const inputTokens = numOrUndef(usage.input_tokens) ?? numOrUndef(mu?.inputTokens);
  const outputTokens = numOrUndef(usage.output_tokens) ?? numOrUndef(mu?.outputTokens);
  const cacheRead = numOrUndef(usage.cache_read_input_tokens) ?? numOrUndef(mu?.cacheReadInputTokens);
  const cacheWrite = numOrUndef(usage.cache_creation_input_tokens) ?? numOrUndef(mu?.cacheCreationInputTokens);
  let contextUsed = null;
  if (inputTokens != null || cacheRead != null) {
    contextUsed = (inputTokens || 0) + (cacheRead || 0);
  }
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalCostUsd: numOrUndef(message.total_cost_usd) ?? numOrUndef(mu?.costUSD),
    numTurns: numOrUndef(message.num_turns),
    durationMs: numOrUndef(message.duration_ms),
    durationApiMs: numOrUndef(message.duration_api_ms),
    contextWindow,
    contextUsed: contextUsed ?? undefined,
    maxOutputTokens: numOrUndef(mu?.maxOutputTokens),
  };
}

function numOrUndef(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Normalize a Claude rate_limit_event into cascade-stats fields. */
function statsFromRateLimitInfo(info) {
  if (!info || typeof info !== 'object') return null;
  const out = {
    rateLimitStatus: info.status || undefined,
    rateLimitType: info.rateLimitType || undefined,
    rateLimitUtilization: numOrUndef(info.utilization),
    rateLimitResetsAt: info.resetsAt != null
      ? (typeof info.resetsAt === 'number'
        ? new Date(info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1)).toISOString()
        : String(info.resetsAt))
      : undefined,
    overageStatus: info.overageStatus || undefined,
    overageInUse: info.isUsingOverage === true || info.overageInUse === true ? true : undefined,
  };
  if (Object.values(out).every((v) => v === undefined)) return null;
  return out;
}

function expandHome(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeClaudeEffort(value, fallback = 'medium') {
  const effort = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) ? effort : fallback;
}

function isMissingClaudeSession(error) {
  return /no conversation found with session id/i.test(error instanceof Error ? error.message : String(error || ''));
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


async function runClaudeLocally(opts, emit) {
  const runId = Number(opts.runId);
  const helperEnv = buildRunHelperEnv(opts);
  const cwd = resolveAgentCwd(opts.cwd, opts.vaultRoot);
  const model = (typeof opts.model === 'string' && opts.model.trim()) ? opts.model.trim() : CLAUDE_DEFAULT_MODEL;
  const chatRun = isChatRun(opts);
  const effort = normalizeClaudeEffort(
    opts.reasoningEffort,
    normalizeClaudeEffort(chatRun ? CLAUDE_CHAT_EFFORT : CLAUDE_EFFORT),
  );
  const resumeSessionId = (typeof opts.resumeSessionId === 'string' && opts.resumeSessionId) ? opts.resumeSessionId : undefined;
  const images = Array.isArray(opts.images)
    ? opts.images.filter((im) => im && typeof im.media_type === 'string' && typeof im.data === 'string')
    : [];

  // With images, send a structured user message (text + image blocks);
  // otherwise a plain string prompt.
  const claudePrompt = images.length
    ? [
        { type: 'text', text: opts.prompt },
        ...images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } })),
      ]
    : opts.prompt;

  const args = [
    '--print',
    '--verbose',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--model', model,
    '--effort', effort,
    '--permission-mode', opts.yolo ? 'bypassPermissions' : 'acceptEdits',
    '--allowedTools', helperAllowedTools().join(','),
    '--append-system-prompt', chatRun
      ? `${CHAT_BREVITY_CONTEXT} ${CHAT_CONTEXT_TOOL_CONTEXT}`
      : `${CLAUDE_AGENT_CONTEXT} ${noteCapabilityContext(opts)}`,
    ...(opts.yolo ? ['--allow-dangerously-skip-permissions'] : []),
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
  ];
  if (images.length) args.push('--input-format', 'stream-json');
  else args.push(String(claudePrompt));

  const child = spawn(process.env.CLAUDE_BIN || 'claude', args, {
    cwd,
    env: { ...process.env, ...helperEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeClaudeProcesses.set(runId, child);
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (images.length) {
    child.stdin.end(`${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: claudePrompt },
      parent_tool_use_id: null,
      session_id: resumeSessionId || '',
    })}\n`);
  } else {
    child.stdin.end();
  }
  const stream = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  let sawClaudeMessage = false;
  let startupTimedOut = false;
  const startupTimer = setTimeout(() => {
    if (sawClaudeMessage || canceledClaudeRuns.has(runId)) return;
    startupTimedOut = true;
    try { child.kill('SIGTERM'); } catch { /* best effort */ }
  }, CLAUDE_STARTUP_TIMEOUT_MS);
  let summary = '';
  let streamedText = '';
  let latestAssistantText = '';
  let sessionId;
  // Tracks whether the previous streamed block was text, so a new text block
  // (a fresh turn, typically split off by a tool call in between) gets a
  // paragraph break instead of being glued onto the prior turn's text.
  let lastBlockWasText = false;
  let harnessInThinking = false;
  // Accumulate tool_use JSON from stream deltas so the chat UI gets structured
  // tool cards (assistant complete messages are skipped to avoid double text).
  /** @type {{ id: string, name: string, json: string } | null} */
  let pendingTool = null;
  emitHarness(emit, `\x1b[2m# claude-code ${model} · ${cwd}\x1b[0m\r\n`);
  emitCascadeStats(emit, { model });
  try {
    for await (const line of stream) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { continue; }
      sawClaudeMessage = true;
      clearTimeout(startupTimer);
      if (message.session_id && message.session_id !== sessionId) {
        sessionId = message.session_id;
        emit('session', { sessionId });
      }

      // Subscription rate-limit telemetry (claude.ai plans). Sparse but useful.
      if (message.type === 'rate_limit_event') {
        const rl = statsFromRateLimitInfo(message.rate_limit_info);
        if (rl) emitCascadeStats(emit, rl);
        continue;
      }

      // Partial streaming: translate token-level deltas into the same
      // { message: { content: [...] } } shape the chat accumulators expect,
      // routing thinking_delta → a thinking block and text_delta → a text
      // block. The assembled `assistant` message is skipped below so its
      // content isn't appended a second time on top of these deltas.
      // Also tee a human-readable transcript into the harness terminal pane.
      if (message.type === 'stream_event') {
        const ev = message.event;
        if (ev?.type === 'message_start') {
          // Keep the latest inference's answer separate from earlier progress
          // narration. The terminal summary becomes the clean chat body.
          latestAssistantText = '';
        } else if (ev?.type === 'content_block_start') {
          const block = ev.content_block;
          const blockType = block?.type;
          if (blockType === 'thinking' || blockType === 'redacted_thinking') {
            if (!harnessInThinking) {
              emitHarness(emit, '\x1b[2m# thinking\x1b[0m\r\n');
              harnessInThinking = true;
            }
            if (blockType === 'redacted_thinking') {
              emit('text', { message: { content: [{ type: 'redacted_thinking' }] } });
              emitHarness(emit, '\x1b[2m[redacted]\x1b[0m');
              lastBlockWasText = false;
            }
          } else if (blockType === 'tool_use') {
            harnessInThinking = false;
            const name = block?.name || 'tool';
            const id = block?.id || `tool-${Date.now()}`;
            pendingTool = { id, name, json: '' };
            // Emit early so the timeline shows the tool while args stream in.
            emit('text', {
              message: {
                content: [{ type: 'tool_use', id, name, input: block?.input && Object.keys(block.input).length ? block.input : {} }],
              },
            });
            const inputPreview = formatToolInput(block?.input);
            emitHarness(emit, `\x1b[36m▶ ${name}\x1b[0m${inputPreview ? ` ${inputPreview.slice(0, 200)}` : ''}\r\n`);
            lastBlockWasText = false;
          } else if (blockType === 'text') {
            if (harnessInThinking) {
              emitHarness(emit, '\r\n');
              harnessInThinking = false;
            }
            if (lastBlockWasText) {
              // Separate this turn's text from the previous one.
              emit('text', { chatVisible: true, message: { content: [{ type: 'text', text: '\n\n' }] } });
              emitHarness(emit, '\r\n\r\n');
              streamedText += '\n\n';
            }
          }
        } else if (ev?.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            emit('text', { message: { content: [{ type: 'thinking', thinking: delta.thinking }] } });
            emitHarness(emit, `\x1b[2m${delta.thinking}\x1b[0m`);
            lastBlockWasText = false;
          } else if (delta?.type === 'text_delta' && delta.text) {
            // Thinking uses the distinct structured block above; text deltas
            // are assistant-visible prose and can stream into chat.
            emit('text', { chatVisible: true, message: { content: [{ type: 'text', text: delta.text }] } });
            emitHarness(emit, delta.text);
            streamedText += delta.text;
            latestAssistantText += delta.text;
            lastBlockWasText = true;
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            if (pendingTool) pendingTool.json += delta.partial_json;
            // Partial JSON is protocol framing, not a readable progress line.
            // The completed structured tool_use below owns the parsed input.
          }
        } else if (ev?.type === 'content_block_stop') {
          if (harnessInThinking) {
            emitHarness(emit, '\r\n');
            harnessInThinking = false;
          }
          if (pendingTool) {
            let input = {};
            if (pendingTool.json) {
              try {
                input = JSON.parse(pendingTool.json);
              } catch {
                input = { _raw: pendingTool.json };
              }
            }
            const inputPreview = formatToolHarnessPreview(input);
            if (inputPreview) {
              emitHarness(emit, `\r\n\x1b[36m▶ ${pendingTool.name}\x1b[0m ${inputPreview}\r\n`);
            }
            emit('text', {
              message: {
                content: [{
                  type: 'tool_use',
                  id: pendingTool.id,
                  name: pendingTool.name,
                  input,
                }],
              },
            });
            pendingTool = null;
          }
        }
        continue;
      }

      // The complete assistant message duplicates the streamed deltas above.
      if (message.type === 'assistant') continue;

      // Tool results and other non-streamed messages → harness + structured events.
      if (message.type === 'user' && message.message?.content) {
        const content = Array.isArray(message.message.content) ? message.message.content : [];
        for (const block of content) {
          if (block?.type === 'tool_result') {
            const body = typeof block.content === 'string'
              ? block.content
              : formatToolInput(block.content);
            const flag = block.is_error ? '\x1b[31m✗' : '\x1b[32m✓';
            const preview = String(body || '').slice(0, 4000);
            emitHarness(emit, `${flag} tool_result\x1b[0m\r\n${preview}\r\n`);
            if (block.is_error) {
              // Auto-capture tool friction into the scratchpad journal (papercut).
              void import(pathToFileURL(path.join(resolveWrapperDir(), 'auto-papercut.mjs')).href)
                .then((mod) => mod.autoPapercut(preview, { tool: 'tool_result' }))
                .catch(() => {});
            }
          }
        }
      } else if (message.type === 'result') {
        emitHarness(emit, `\x1b[2m# result ${message.subtype || message.result || 'done'}\x1b[0m\r\n`);
        emitCascadeStats(emit, statsFromClaudeResult(message, model));
      } else if (message.type === 'system') {
        emitHarness(emit, `\x1b[2m# system ${message.subtype || ''}\x1b[0m\r\n`);
      }

      emit(classifySdkMessage(message), message);
      if (message.type === 'result') summary = message.result || message.subtype || summary;
    }
    const { code, signal, error: launchError } = await exited;
    if (launchError) throw launchError;
    if (code !== 0 && !canceledClaudeRuns.has(runId) && !startupTimedOut) {
      throw new Error(stderr.trim() || `Claude CLI exited with ${signal || `code ${code}`}.`);
    }
  } catch (error) {
    throw error;
  } finally {
    clearTimeout(startupTimer);
    activeClaudeProcesses.delete(runId);
  }
  if (canceledClaudeRuns.has(runId)) {
    const error = new Error('Run canceled.');
    error.cascadeCanceled = true;
    throw error;
  }
  if (startupTimedOut) {
    const error = new Error('Claude produced no startup event; retrying the session.');
    error.cascadeStartupTimeout = true;
    throw error;
  }
  // Chat runs prefer streamed assistant text over the CLI's generic result.
  // Non-chat note runs keep the CLI result as the summary for the run list.
  if (chatRun && (latestAssistantText.trim() || streamedText.trim())) {
    return { summary: latestAssistantText.trim() || streamedText.trim(), sessionId };
  }
  return { summary: summary || streamedText.trim() || '', sessionId };
}


module.exports = { activeClaudeProcesses, canceledClaudeRuns, runClaudeLocally, formatToolHarnessPreview, normalizeClaudeEffort, isMissingClaudeSession, resolveAgentCwd };
