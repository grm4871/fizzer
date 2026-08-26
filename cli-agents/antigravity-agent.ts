/** Antigravity agentapi runner and transcript event adapter. */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
type Db = Database.Database;
import { type AgentEmit, type CliAgentResult, emitHarness, emitCascadeStats, assertCliAgentAvailable } from './cli-agent-common.js';
import { activeCliProcesses, spawnEnv } from './process-supervisor.js';
import { AGY_IDLE_AFTER_FINAL_POLLS, AGY_POLL_MS, AGY_STALL_POLLS, AGY_TRANSCRIPT_WAIT_MS, type AgyTranscriptStep, antigravityBin, antigravityTranscriptPath, agyIsPlannerMonologue, agyTryAutoApprove, resolveAntigravityProjectConfigPath, ensureAntigravityCascadeHookup, agyLsPost, discoverAntigravityEnv, resolveAntigravityModelTier, agyToolFriendlyName, agyPreviewInput, agyNormalizeToolArgs } from './antigravity-config.js';
import { truncate } from './provider-utils.js';

/** Spawn agentapi (or other) and capture stdout; tees to harness; tracks cancel. */
async function runCommand(
  bin: string,
  args: string[],
  cwd: string,
  runId?: number,
  emit?: AgentEmit,
  baseEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const discoveredEnv = discoverAntigravityEnv(cwd);
    const env = { ...(baseEnv || spawnEnv(runId)), ...discoveredEnv };

    if (!env.ANTIGRAVITY_LS_ADDRESS || !env.ANTIGRAVITY_CSRF_TOKEN) {
      reject(new Error(
        'Antigravity language server not found (ANTIGRAVITY_LS_ADDRESS / CSRF). '
        + 'Open the Antigravity app and sign in, then retry.',
      ));
      return;
    }

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# antigravity ls ${env.ANTIGRAVITY_LS_ADDRESS} · project ${env.ANTIGRAVITY_PROJECT_ID || '?'}\x1b[0m\r\n`);

    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`Failed to launch agentapi: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    if (runId !== undefined) activeCliProcesses.set(runId, child);

    let stdout = '';
    let stderr = '';
    let settled = false;
    const cleanup = () => {
      if (runId !== undefined) activeCliProcesses.delete(runId);
    };

    child.stdout?.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      stdout += chunk;
      // agentapi returns one JSON blob — keep harness tidy (no full prompt dump)
    });
    child.stderr?.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      stderr += chunk;
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`agentapi could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      emitHarness(emit, `\x1b[2m# agentapi exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(stdout);
      } else {
        const detail = (stderr || stdout).trim().slice(-800);
        reject(new Error(`agentapi exited ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

/**
 * Runs the Antigravity agent via agentapi + transcript.jsonl polling.
 * Emits structured text/thinking/tool blocks for the chat harness panel
 * (not raw JSONL dumps).
 */
export async function runAntigravity(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  runId?: number,
  db?: Db,
  model?: string,
  yolo?: boolean,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const bin = antigravityBin();
  assertCliAgentAvailable('antigravity');
  ensureAntigravityCascadeHookup(cwd, yolo);
  if (runId !== undefined) antigravityCancelFlags.delete(runId);

  // Snapshot line count before send-message so we only stream new turns.
  let processedLines = 0;
  if (resumeId) {
    const prior = antigravityTranscriptPath(resumeId);
    if (fs.existsSync(prior)) {
      processedLines = fs.readFileSync(prior, 'utf-8').split('\n').filter((l) => l.trim()).length;
    }
  }

  const tier = resolveAntigravityModelTier(model);
  const args: string[] = resumeId
    ? ['send-message', resumeId, prompt]
    : (() => {
        const a = ['new-conversation'];
        if (tier) a.push(`--model=${tier}`);
        a.push(prompt);
        return a;
      })();

  if (model && tier && model !== tier) {
    emitHarness(emit, `\x1b[2m# model ${model} → agentapi tier ${tier}\x1b[0m\r\n`);
  } else if (tier) {
    emitCascadeStats(emit, { model: tier });
  }

  let stdoutStr: string;
  try {
    stdoutStr = await runCommand(bin, args, cwd, runId, emit, env ? { ...spawnEnv(runId), ...env } : undefined);
  } catch (err) {
    throw new Error(`Failed to run agentapi: ${err instanceof Error ? err.message : String(err)}`);
  }

  let conversationId = '';
  try {
    const res = JSON.parse(stdoutStr) as {
      error?: string;
      response?: {
        newConversation?: { conversationId?: string };
        sendMessage?: { recipientId?: string };
      };
    };
    if (res.error) throw new Error(res.error);
    conversationId = res.response?.newConversation?.conversationId
      || res.response?.sendMessage?.recipientId
      || '';
  } catch (err) {
    if (err instanceof Error && !err.message.includes('JSON')) throw err;
    throw new Error(`Failed to parse agentapi JSON output: ${stdoutStr.slice(0, 500)}`);
  }
  if (!conversationId) {
    throw new Error(`No conversationId returned by agentapi: ${stdoutStr.slice(0, 500)}`);
  }

  emit('session', { sessionId: conversationId });

  emitHarness(emit, `\x1b[2m# conversation ${conversationId}\x1b[0m\r\n`);
  const transcriptPath = antigravityTranscriptPath(conversationId);

  // Wait for transcript file
  const waitDeadline = Date.now() + AGY_TRANSCRIPT_WAIT_MS;
  while (!fs.existsSync(transcriptPath)) {
    if (Date.now() > waitDeadline) {
      throw new Error(`Transcript file was not created at ${transcriptPath}`);
    }
    if (runId !== undefined && isAntigravityRunCanceled(runId, db)) {
      return { summary: 'Run canceled by user.', sessionId: conversationId };
    }
    await sleep(AGY_POLL_MS);
  }

  let summary = '';
  let done = false;
  let sawFinalPlanner = false;
  let idleAfterFinal = 0;
  let stallPolls = 0;
  let approvePolls = 0;
  const pendingToolIds: string[] = [];
  const emittedTools = new Set<string>();
  let emittedText = false;

  const checkTranscript = (): void => {
    let content: string;
    try {
      content = fs.readFileSync(transcriptPath, 'utf-8');
    } catch {
      return;
    }
    const lines = content.split('\n').filter((l) => l.trim());
    if (lines.length <= processedLines) {
      stallPolls += 1;
      if (sawFinalPlanner) {
        idleAfterFinal += 1;
        if (idleAfterFinal >= AGY_IDLE_AFTER_FINAL_POLLS) done = true;
      } else if (stallPolls >= AGY_STALL_POLLS) {
        emitHarness(emit, `\x1b[33m# stall timeout after ${Math.round((AGY_STALL_POLLS * AGY_POLL_MS) / 1000)}s with no transcript progress\x1b[0m\r\n`);
        done = true;
      }
      return;
    }

    stallPolls = 0;
    idleAfterFinal = 0;

    for (let i = processedLines; i < lines.length; i++) {
      let step: AgyTranscriptStep;
      try {
        step = JSON.parse(lines[i]) as AgyTranscriptStep;
      } catch {
        continue;
      }

      const source = step.source || '';
      const type = (step.type || '').toUpperCase();
      const status = (step.status || '').toUpperCase();

      // Skip system noise in structured stream (still ignore raw dump).
      if (type === 'CONVERSATION_HISTORY' || type === 'USER_INPUT' || type === 'SYSTEM_MESSAGE') {
        continue;
      }

      if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
        const text = (step.content || '').trim();
        const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        const isThinking = toolCalls.length > 0 || agyIsPlannerMonologue(text);

        if (text) {
          if (isThinking) {
            // Monologue before tools → thinking only (never chat body / summary).
            emit('text', {
              message: { content: [{ type: 'thinking', thinking: text }] },
            });
            emitHarness(emit, `\x1b[2m# thinking\x1b[0m\r\n\x1b[2m${text.slice(0, 500)}\x1b[0m\r\n`);
          } else {
            summary = text;
            const sep = emittedText ? '\n\n' : '';
            emit('text', {
              message: { content: [{ type: 'text', text: sep + text }] },
            });
            emittedText = true;
            emitHarness(emit, `${text}\r\n`);
          }
        }

        for (const tc of toolCalls) {
          const toolId = tc.id || `agy-${conversationId}-${step.step_index ?? i}-${pendingToolIds.length}`;
          if (emittedTools.has(toolId)) continue;
          emittedTools.add(toolId);
          pendingToolIds.push(toolId);
          const name = agyToolFriendlyName(tc.name || 'tool');
          const input = agyNormalizeToolArgs(tc.args);
          emit('text', {
            message: {
              content: [{ type: 'tool_use', id: toolId, name, input }],
            },
          });
          const preview = agyPreviewInput(input);
          emitHarness(emit, `\x1b[36m▶ ${name}\x1b[0m${preview ? ` ${preview}` : ''}\r\n`);
        }

        // True completion: planner finished with no more tools.
        if (status === 'DONE' && toolCalls.length === 0) {
          sawFinalPlanner = true;
        } else {
          sawFinalPlanner = false;
        }
        continue;
      }

      // Tool results and other model steps
      if (source === 'MODEL' || source === 'SYSTEM') {
        if (type === 'ERROR_MESSAGE' || status === 'ERROR') {
          const msg = String(step.content || 'Antigravity error').slice(0, 2000);
          if (/denied permission|pending review|user interaction|awaiting approval/i.test(msg)) {
            agyTryAutoApprove(conversationId);
          }
          emitHarness(emit, `\x1b[31m✖ ${msg}\x1b[0m\r\n`);
          const toolId = pendingToolIds.shift();
          if (toolId) {
            emit('user', {
              message: {
                content: [{
                  type: 'tool_result',
                  tool_use_id: toolId,
                  content: truncate(msg, 8000),
                  is_error: true,
                }],
              },
            });
          }
          continue;
        }

        // Tool execution result steps (VIEW_FILE, RUN_COMMAND, …)
        if (type !== 'PLANNER_RESPONSE' && type !== 'EPHEMERAL_MESSAGE' && type !== 'CHECKPOINT') {
          const outText = String(step.content || '');
          const toolId = pendingToolIds.shift() || `agy-result-${step.step_index ?? i}`;
          const isError = status === 'ERROR';
          emit('user', {
            message: {
              content: [{
                type: 'tool_result',
                tool_use_id: toolId,
                content: truncate(outText, 8000),
                is_error: isError,
              }],
            },
          });
          if (isError) {
            void import('./auto-papercut.mjs')
              .then((mod) => mod.autoPapercut(outText, { tool: String(type || 'tool') }))
              .catch(() => {});
          }
          const preview = outText.replace(/\s+/g, ' ').trim().slice(0, 160);
          emitHarness(emit, `${isError ? '\x1b[31m' : '\x1b[2m'}◀ ${type}${preview ? `: ${preview}` : ''}\x1b[0m\r\n`);
          sawFinalPlanner = false;
        }
      }
    }
    processedLines = lines.length;

    // If we already saw final planner and drained new lines, allow settle.
    if (sawFinalPlanner && pendingToolIds.length === 0) {
      idleAfterFinal = Math.max(idleAfterFinal, 1);
    }
  };

  while (!done) {
    if (runId !== undefined && isAntigravityRunCanceled(runId, db)) {
      return { summary: summary || 'Run canceled by user.', sessionId: conversationId };
    }
    // Desktop cancel kills the agentapi child; after that we only poll. Also
    // treat explicit cancel flag on the process map absence mid-wait as soft.
    try {
      checkTranscript();
    } catch { /* ignore single poll errors */ }
    approvePolls += 1;
    if (approvePolls % 15 === 0) agyTryAutoApprove(conversationId);
    if (!done) await sleep(AGY_POLL_MS);
  }

  if (!emittedText || !summary.trim() || agyIsPlannerMonologue(summary)) {
    // No user-visible success placeholder — empty summary drops the chat shell.
    summary = '';
  }

  emitHarness(emit, `\x1b[2m# done · ${processedLines} transcript lines\x1b[0m\r\n`);
  if (runId !== undefined) antigravityCancelFlags.delete(runId);
  return { summary, sessionId: conversationId };
}


function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAntigravityRunCanceled(runId: number, db?: Db): boolean {
  // Cancel path: cancelLocalAgentRun kills the child; desktop also finishes
  // the run as canceled. Check DB when available; otherwise check process map
  // was force-cleared with a sentinel — we use a side map.
  if (antigravityCancelFlags.has(runId)) return true;
  if (!db) return false;
  try {
    const row = db.prepare('SELECT status FROM runs WHERE id = ?').get(runId) as { status?: string } | undefined;
    return row?.status === 'canceled' || row?.status === 'failed';
  } catch {
    return false;
  }
}

/** Set by cancel hooks so transcript polling stops promptly. */
const antigravityCancelFlags = new Set<number>();

/** Allow desktop cancel to stop transcript polling without a live child. */
export function cancelAntigravityRun(runId: number): void {
  antigravityCancelFlags.add(runId);
  const child = activeCliProcesses.get(runId);
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    activeCliProcesses.delete(runId);
  }
}

