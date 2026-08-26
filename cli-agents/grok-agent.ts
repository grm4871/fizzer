/** Grok streaming-json provider adapter. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GROK_BIN, type AgentEmit, type CliAgentResult, emitCascadeStats, statsFromUsageBlob } from './cli-agent-common.js';
import { driveProcess } from './process-driver.js';
import { extractGrokDiagnostic } from './provider-utils.js';
/**
 * Runs the Grok CLI (`grok --single --output-format streaming-json`) and
 * translates its streaming JSONL into Anthropic-style content blocks.
 *
 * Grok streams `thought` and `text` token chunks, then an `end` event.
 * Tool executions run silently (not surfaced in the stream), so we render
 * accumulated reasoning + the final answer. Disk changes are picked up by
 * the vault rescan afterwards.
 *
 * Grok events → content block mapping:
 *   - `thought` tokens → accumulated, flushed as `{ type: 'thinking', text }`
 *   - `text` tokens    → accumulated into the answer
 *   - `end`            → emits `{ type: 'text', text }`, captures session id
 *
 * @param prompt   - Full prompt (context + user prompt)
 * @param cwd      - Vault root path
 * @param emit     - Event emitter callback
 * @param resumeId - Optional session id to resume a prior conversation
 * @returns Summary text and optional session id
 */
export async function runGrok(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  runId?: number,
  model?: string,
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const modelArgs = model ? ['--model', model] : [];
  const debugFile = path.join(os.tmpdir(), `cascade-grok-${runId ?? process.pid}-${Date.now()}.jsonl`);
  const baseArgs = ['--single', prompt, '--output-format', 'streaming-json', '--debug-file', debugFile, '--always-approve', '--cwd', cwd, ...modelArgs];
  const args = resumeId ? ['--resume', resumeId, ...baseArgs] : baseArgs;

  let text = '';
  let sessionId: string | undefined;
  // Separate a turn's answer from the previous one. Grok tools run silently, so
  // a `thought` (or any non-text event) between answers marks the boundary.
  let emittedText = false;
  let lastWasText = false;
  let thoughtChars = 0;
  let textChars = 0;

  if (model) emitCascadeStats(emit, { model });

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    // Any usage blob mid-stream → surface for harness chips.
    if (ev.usage && typeof ev.usage === 'object') {
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, { model }));
    }
    if (ev.type === 'thought') {
      const chunk = String(ev.data || '');
      thoughtChars += chunk.length;
      emit('text', { message: { content: [{ type: 'thinking', thinking: chunk }] } });
      lastWasText = false;
    } else if (ev.type === 'text') {
      const chunk = ev.data || '';
      const sep = (!lastWasText && emittedText) ? '\n\n' : '';
      emit('text', { message: { content: [{ type: 'text', text: sep + chunk }] } });
      text += sep + chunk;
      textChars += String(chunk).length;
      if (chunk) { emittedText = true; lastWasText = true; }
    } else if (ev.type === 'end') {
      if (ev.sessionId) sessionId = ev.sessionId;
      const usage = (ev.usage && typeof ev.usage === 'object')
        ? ev.usage as Record<string, unknown>
        : (ev.stats && typeof ev.stats === 'object' ? ev.stats as Record<string, unknown> : null);
      if (usage) {
        emitCascadeStats(emit, statsFromUsageBlob(usage, { model }));
      } else if (thoughtChars > 0 || textChars > 0) {
        // Rough char-based estimate when the CLI omits usage — labeled approx in UI via raw counts.
        // ~4 chars/token is a common heuristic for Latin text.
        const approxIn = Math.max(1, Math.round((prompt.length) / 4));
        const approxOut = Math.max(0, Math.round((thoughtChars + textChars) / 4));
        emitCascadeStats(emit, {
          model,
          inputTokens: approxIn,
          outputTokens: approxOut,
        });
      }
    }
  };

  try {
    const summaryText = await driveProcess(GROK_BIN, args, cwd, onLine, () => text || '', 'Grok', runId, emit, env);
    return { summary: summaryText, sessionId };
  } catch (error) {
    const diagnostic = extractGrokDiagnostic(debugFile);
    const base = error instanceof Error ? error.message : String(error);
    throw new Error(diagnostic ? `${base}\n\nGrok diagnostic:\n${diagnostic}` : base);
  } finally {
    try { fs.unlinkSync(debugFile); } catch { /* ignore */ }
  }
}

