/** Child-process stream adapters used by every provider. */
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { activeCliProcesses, groupedCliProcesses, clearAgentProcessLease, processStartTicks, processGroupIdOf, writeAgentProcessLease, spawnEnv, terminateCliProcessWithEscalation } from './process-supervisor.js';
import { type AgentEmit, emitHarness, createIdleTimer, CLI_IDLE_TIMEOUT_MS, CLI_PROGRESS_HEARTBEAT_MS } from './cli-agent-common.js';

export class CliIdleTimeoutError extends Error {}
export function driveProcess(
  bin: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
  getSummary: () => string,
  label: string,
  runId?: number,
  emit?: AgentEmit,
  env?: NodeJS.ProcessEnv,
  /** Tee of stderr, for callers that must inspect a CLI's diagnostics after a
   *  zero-exit failure (e.g. Codex reporting a dead session). */
  onStderr?: (chunk: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ? { ...spawnEnv(runId), ...env } : spawnEnv(runId),
      });
      if (runId !== undefined) {
        activeCliProcesses.set(runId, child);
      }
    } catch (err) {
      reject(new Error(`Failed to launch ${label} ('${bin}'): ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const cleanUpProcess = () => {
      if (runId !== undefined) {
        activeCliProcesses.delete(runId);
      }
    };

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# cwd ${cwd}\x1b[0m\r\n`);

    let stderr = '';
    let stdoutBuf = '';
    let settled = false;
    const idle = createIdleTimer(() => {
      if (!settled) {
        settled = true;
        cleanUpProcess();
        child.kill('SIGTERM');
        reject(new Error(`${label} produced no output for ${CLI_IDLE_TIMEOUT_MS}ms and was stopped.`));
      }
    });

    // Single stdout consumer: tee raw bytes to the harness terminal and split
    // lines for JSONL parsing (readline would contend for the same stream).
    child.stdout.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      idle.bump();
      emitHarness(emit, chunk);
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const trimmed = line.trim();
        if (trimmed) {
          try { onLine(trimmed); } catch { /* ignore a single malformed line */ }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      idle.bump();
      stderr += chunk;
      onStderr?.(chunk);
      // Dim red for stderr so it is distinguishable in the terminal pane.
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      idle.clear();
      cleanUpProcess();
      reject(new Error(`${label} ('${bin}') could not be started: ${err.message}. Is it installed and on PATH?`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      idle.clear();
      cleanUpProcess();
      // Flush a trailing partial stdout line (no final newline).
      const trailing = stdoutBuf.trim();
      if (trailing) {
        try { onLine(trailing); } catch { /* ignore */ }
      }
      emitHarness(emit, `\x1b[2m# exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(getSummary());
      } else {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${label} exited with code ${code}.${detail ? `\n${detail}` : ''}`));
      }
    });
  });
}


/** Like driveProcess, but also parses Hermes cascade NDJSON events from stderr. */
export function driveHermesProcess(
  bin: string,
  args: string[],
  cwd: string,
  onStdoutLine: (line: string, carriageReturn?: boolean) => void,
  onStderrLine: (line: string) => void,
  getSummary: () => string,
  label: string,
  runId?: number,
  emit?: AgentEmit,
  env?: NodeJS.ProcessEnv,
  idleTimeoutMs = CLI_IDLE_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    const leaseToken = randomBytes(16).toString('hex');
    // A launcher can spend time constructing its provider bridge before it
    // writes its first byte. Give the run panel an unambiguous lifecycle event
    // first, so a live process is never presented as a blank harness.
    emitHarness(emit, `\x1b[2m# launching ${label} harness\x1b[0m\r\n`);
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Akron's launcher owns a bridge plus Hermes/tool descendants. Give
        // Hermes-family runs their own process group so Stop reaches the whole
        // tree instead of only terminating the outer bash wrapper.
        detached: process.platform !== 'win32',
        env: {
          ...(env ? { ...spawnEnv(runId), ...env } : spawnEnv(runId)),
          HERMES_CASCADE_EVENTS: '1',
          CASCADE_AGENT_PROCESS_TOKEN: leaseToken,
          ...(runId !== undefined ? { CASCADE_RUN_ID: String(runId) } : {}),
        },
      });
      if (runId !== undefined) {
        activeCliProcesses.set(runId, child);
        if (process.platform !== 'win32') {
          groupedCliProcesses.add(runId);
          if (child.pid && process.platform === 'linux') {
            writeAgentProcessLease({
              version: 1,
              runId,
              ownerPid: process.pid,
              ownerStartTicks: processStartTicks(process.pid),
              processGroupId: child.pid,
              token: leaseToken,
              label,
            });
          }
        }
      }
    } catch (err) {
      if (child) terminateCliProcessWithEscalation(child, process.platform !== 'win32');
      if (runId !== undefined) {
        activeCliProcesses.delete(runId);
        groupedCliProcesses.delete(runId);
        clearAgentProcessLease(runId);
      }
      reject(new Error(`Failed to launch ${label} ('${bin}'): ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const cleanUpProcess = () => {
      if (runId !== undefined) {
        activeCliProcesses.delete(runId);
        groupedCliProcesses.delete(runId);
        clearAgentProcessLease(runId);
      }
    };

    emitHarness(emit, `\x1b[2m$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\x1b[0m\r\n`);
    emitHarness(emit, `\x1b[2m# cwd ${cwd}\x1b[0m\r\n`);

    let stderr = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    let quietSince = Date.now();
    const heartbeat = setInterval(() => {
      if (settled || Date.now() - quietSince < CLI_PROGRESS_HEARTBEAT_MS) return;
      const quietSeconds = Math.max(1, Math.round((Date.now() - quietSince) / 1_000));
      emitHarness(emit, `\x1b[2m# ${label} still working · ${quietSeconds}s without provider output\x1b[0m\r\n`);
    }, CLI_PROGRESS_HEARTBEAT_MS);
    const idle = createIdleTimer(() => {
      if (!settled) {
        settled = true;
        clearInterval(heartbeat);
        cleanUpProcess();
        terminateCliProcessWithEscalation(child, process.platform !== 'win32');
        reject(new CliIdleTimeoutError(`${label} produced no output for ${idleTimeoutMs}ms and was stopped.`));
      }
    }, idleTimeoutMs);

    child.stdout.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      quietSince = Date.now();
      idle.bump();
      emitHarness(emit, chunk);
      stdoutBuf += chunk;
      let nl = stdoutBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        // Hermes renders its reasoning box with CR-terminated lines (they are
        // meant to be redrawn in place) while the final answer ends with a bare
        // LF. trim() destroys that distinction, so report it separately.
        const carriageReturn = line.endsWith('\r');
        const trimmed = line.trim();
        if (trimmed) {
          try { onStdoutLine(trimmed, carriageReturn); } catch { /* ignore a single malformed line */ }
        }
        nl = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (d: Buffer | string) => {
      const chunk = d.toString();
      quietSince = Date.now();
      idle.bump();
      emitHarness(emit, `\x1b[31m${chunk}\x1b[0m`);
      stderrBuf += chunk;
      let nl = stderrBuf.indexOf('\n');
      while (nl >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed) {
          nl = stderrBuf.indexOf('\n');
          continue;
        }
        if (trimmed.startsWith('{') || /^session_id:\s*/i.test(trimmed)) {
          try { onStderrLine(trimmed); } catch { /* ignore a single malformed event */ }
        } else {
          stderr += trimmed + '\n';
        }
        nl = stderrBuf.indexOf('\n');
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      idle.clear();
      clearInterval(heartbeat);
      cleanUpProcess();
      reject(new Error(`${label} ('${bin}') could not be started: ${err.message}. Is it installed and on PATH?`));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      idle.clear();
      clearInterval(heartbeat);
      cleanUpProcess();
      const trailingOut = stdoutBuf.trim();
      if (trailingOut) {
        try { onStdoutLine(trailingOut); } catch { /* ignore */ }
      }
      const trailingErr = stderrBuf.trim();
      if (trailingErr) {
        if (trailingErr.startsWith('{') || /^session_id:\s*/i.test(trailingErr)) {
          try { onStderrLine(trailingErr); } catch { /* ignore */ }
        } else {
          stderr += trailingErr + '\n';
        }
      }
      emitHarness(emit, `\x1b[2m# exit ${code ?? '?'}\x1b[0m\r\n`);
      if (code === 0) {
        resolve(getSummary());
      } else {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${label} exited with code ${code}.${detail ? `\n${detail}` : ''}`));
      }
    });
  });
}
