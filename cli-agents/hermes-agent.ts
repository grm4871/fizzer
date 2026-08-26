/** Hermes and Akron provider adapters, including retry and idle semantics. */
import { HERMES_BIN, AKRON_BIN, HERMES_IDLE_TIMEOUT_MS, AKRON_IDLE_TIMEOUT_MS, HERMES_UPSTREAM_RETRIES, HERMES_UPSTREAM_BACKOFF_MS, HERMES_UPSTREAM_BACKOFF_CAP_MS, HERMES_REASONING_OPEN, HERMES_REASONING_CLOSE, type AgentEmit, type CliAgentResult, emitHarness } from './cli-agent-common.js';
import { CliIdleTimeoutError, driveHermesProcess } from './process-driver.js';
import { truncate } from './provider-utils.js';
import { setTimeout as sleepTimer } from 'node:timers/promises';

const HERMES_UPSTREAM_UNAVAILABLE = /^(?:API call failed after \d+ retr(?:y|ies)\b|HTTP 5\d\d\b|(?:The )?requested model is temporarily unavailable\b)/i;
function isHermesUpstreamFailure(output: string): boolean {
  const lines = output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 2) return false;
  return lines.every((line) => HERMES_UPSTREAM_UNAVAILABLE.test(line));
}
function sleep(ms: number): Promise<void> { return sleepTimer(ms); }

/**
 * Runs the Hermes CLI and translates its output into content blocks.
 *
 * Both fresh and resumed turns go through `hermes chat -Q -q`, which keeps
 * stdout to the final response only and reports `session_id:` on stderr.
 *
 * Oneshot (`-z`) is deliberately not used for fresh runs: it is equally quiet
 * on stdout but never reports a session id, so nothing could be resumed and
 * every turn restarted cold. Hermes oneshot also ignores `--resume`, so the
 * `chat` path is the only one that can both open and extend a session.
 *
 * With `HERMES_CASCADE_EVENTS=1` it also streams reasoning deltas as NDJSON on stderr.
 */
export async function runHermes(prompt: string, cwd: string, emit: AgentEmit, resumeId?: string, runId?: number, env?: NodeJS.ProcessEnv, model?: string, profile?: string, safeMode = false, yolo = false): Promise<CliAgentResult> {
  const modelArgs = model?.trim() ? ['-m', model.trim()] : [];
  const profileName = profile?.trim() || '';
  if (profileName && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(profileName)) {
    throw new Error('Hermes profile must use letters, numbers, dots, underscores, or dashes.');
  }
  const profileArgs = profileName ? ['-p', profileName] : [];
  const postureArgs = [...(yolo ? ['--yolo'] : []), ...(safeMode ? ['--safe-mode'] : [])];
  const args = resumeId
    ? [...profileArgs, 'chat', '-Q', '--resume', resumeId, '-q', prompt, ...modelArgs, ...postureArgs]
    : [...profileArgs, 'chat', '-Q', '-q', prompt, ...modelArgs, ...postureArgs];

  let text = '';
  let sessionId: string | undefined = resumeId;

  // `-Q` suppresses the banner, spinner and tool previews but still renders a
  // box-drawn "Reasoning" panel on stdout. Left alone it lands in the chat
  // message as if it were the model's answer, so route it to thinking blocks
  // and keep it out of the summary.
  let inReasoning = false;
  const onStdoutLine = (line: string, carriageReturn?: boolean) => {
    if (HERMES_REASONING_OPEN.test(line)) {
      inReasoning = true;
      return;
    }
    if (inReasoning) {
      // The panel's body lines are CR-terminated; the first LF-terminated line
      // (or an explicit bottom border) is the real answer resuming.
      if (HERMES_REASONING_CLOSE.test(line)) {
        inReasoning = false;
        return;
      }
      if (carriageReturn) {
        emit('text', { message: { content: [{ type: 'thinking', thinking: line + '\n' }] } });
        return;
      }
      inReasoning = false;
    }
    text += line + '\n';
    // Keep the line break so multi-line output doesn't collapse onto one line.
    emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
  };

  const onStderrLine = (line: string) => {
    const quietSession = /^session_id:\s*(\S+)$/i.exec(line);
    if (quietSession) {
      sessionId = quietSession[1];
      emit('session', { sessionId });
      return;
    }
    if (!line.startsWith('{')) return;
    const ev = JSON.parse(line) as { type?: string; text?: string; id?: string };
    if (ev.type === 'reasoning.delta' && ev.text) {
      emit('text', { message: { content: [{ type: 'thinking', thinking: ev.text }] } });
    } else if (ev.type === 'session_id' && ev.id) {
      sessionId = ev.id;
      emit('session', { sessionId });
    }
  };

  let summaryText = '';
  const maxAttempts = Math.max(3, HERMES_UPSTREAM_RETRIES + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      summaryText = await driveHermesProcess(
        HERMES_BIN,
        args,
        cwd,
        onStdoutLine,
        onStderrLine,
        () => text.trim() || '',
        'Hermes',
        runId,
        emit,
        env,
        HERMES_IDLE_TIMEOUT_MS,
      );
    } catch (error) {
      if (!(error instanceof CliIdleTimeoutError) || attempt >= 2 || text.trim()) throw error;
      // No model or tool output means the first request was never observable;
      // a fresh provider bridge is safe to retry without duplicating work.
      emitHarness(emit, `\x1b[2m# provider returned no bytes; retrying Hermes (${attempt + 1}/2) with a fresh bridge\x1b[0m\r\n`);
      continue;
    }
    // Hermes exits 0 even when it only managed to print an upstream 503 as its
    // "answer". Treat that as transient and retry the whole turn with backoff
    // rather than handing the capacity error back as the reply.
    const upstreamFailure = isHermesUpstreamFailure(summaryText) || isHermesUpstreamFailure(text);
    if (upstreamFailure && attempt < HERMES_UPSTREAM_RETRIES) {
      const backoff = Math.min(HERMES_UPSTREAM_BACKOFF_CAP_MS, HERMES_UPSTREAM_BACKOFF_MS * (attempt + 1));
      emitHarness(emit, `\x1b[33m# hermes hit a transient upstream error (503); retrying (${attempt + 1}/${HERMES_UPSTREAM_RETRIES}) after ${Math.round(backoff / 1000)}s\x1b[0m\r\n`);
      // Discard the failed turn's output so the retry starts from a clean slate.
      text = '';
      inReasoning = false;
      summaryText = '';
      await sleep(backoff);
      continue;
    }
    break;
  }
  return { summary: summaryText, sessionId };
}

/**
 * Runs Akron's Grok-backed Hermes loop through its native launcher.
 *
 * Akron's `-z` path keeps stdout machine-readable while the launcher's local
 * Grok bridge supplies inference. The native Akron toolset exposes its typed
 * `scratchpad` adapter exactly once; Cascade's prompt formatter omits its
 * parallel cascade-scratchpad instructions for this provider.
 */
export async function runAkronGrok(prompt: string, cwd: string, emit: AgentEmit, _resumeId?: string, runId?: number, env?: NodeJS.ProcessEnv): Promise<CliAgentResult> {
  const baseArgs = [
    '--grok',
    '-z',
    prompt,
    '--yolo',
  ];
  // Hermes oneshot owns a fresh session. Cascade injects recent channel
  // context on each cold run, so do not claim resumability that -z lacks.
  const args = baseArgs;

  let text = '';
  const onStdoutLine = (line: string) => {
    text += line + '\n';
    emit('text', { message: { content: [{ type: 'text', text: line + '\n' }] } });
  };

  const onStderrLine = (line: string) => {
    if (!line.startsWith('{')) return;
    const ev = JSON.parse(line) as { type?: string; text?: string };
    if (ev.type === 'reasoning.delta' && ev.text) {
      emit('text', { message: { content: [{ type: 'thinking', thinking: ev.text }] } });
    }
  };

  let summaryText = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      summaryText = await driveHermesProcess(
        AKRON_BIN,
        args,
        cwd,
        onStdoutLine,
        onStderrLine,
        () => text.trim() || '',
        'Akron --grok',
        runId,
        emit,
        env,
        AKRON_IDLE_TIMEOUT_MS,
      );
      break;
    } catch (error) {
      if (!(error instanceof CliIdleTimeoutError) || attempt > 0) throw error;
      // Grok Build occasionally accepts a request but never returns its first
      // response byte. A fresh bridge/request succeeds in practice. Retrying is
      // safe here because Hermes emitted no provider or tool event whatsoever.
      emitHarness(emit, '\x1b[2m# provider returned no bytes; retrying Akron once with a fresh bridge\x1b[0m\r\n');
      text = '';
    }
  }
  return { summary: summaryText };
}

