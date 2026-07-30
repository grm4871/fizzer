/**
 * Read subscription usage from the locally authenticated agent CLIs.
 *
 * Credentials never leave the user's machine. Claude and Codex expose clean
 * non-interactive paths. Grok currently exposes plan usage only in its TUI, so
 * the Linux desktop drives `/usage` inside a short-lived pseudo-terminal and
 * parses the two labels Grok itself renders.
 */

const { spawn } = require('child_process');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const GROK_BIN = process.env.GROK_BIN || 'grok';
const COMMAND_TIMEOUT_MS = 15_000;

let grokProbeHasSession = false;

function isoFromUnixSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clampPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function durationLabel(minutes) {
  const value = Number(minutes);
  if (!Number.isFinite(value) || value <= 0) return 'usage';
  if (value % 1_440 === 0) return `${value / 1_440}d`;
  if (value % 60 === 0) return `${value / 60}h`;
  return `${value}m`;
}

function usageFromWindows(windows, extras = {}) {
  const clean = windows
    .map((window) => {
      const usedPercent = clampPercent(window.usedPercent);
      if (usedPercent == null) return null;
      return {
        label: String(window.label || 'usage'),
        usedPercent,
        ...(Number.isFinite(Number(window.windowMinutes))
          ? { windowMinutes: Number(window.windowMinutes) }
          : {}),
        ...(typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
        ...(typeof window.resetsLabel === 'string' ? { resetsLabel: window.resetsLabel } : {}),
      };
    })
    .filter(Boolean);
  if (!clean.length) throw new Error('CLI returned no plan usage windows');

  const worst = [...clean].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return {
    status: 'ok',
    usedPercent: worst.usedPercent,
    ...(worst.windowMinutes != null ? { windowMinutes: worst.windowMinutes } : {}),
    ...(worst.resetsAt ? { resetsAt: worst.resetsAt } : {}),
    ...(worst.resetsLabel ? { resetsLabel: worst.resetsLabel } : {}),
    windows: clean,
    ...extras,
    fetchedAt: new Date().toISOString(),
  };
}

function runCommand(bin, args, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(new Error(`${bin} usage probe timed out`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code === 0) finish(null, { stdout, stderr });
      else finish(new Error(`${bin} usage probe exited ${code}: ${(stderr || stdout).trim().slice(0, 300)}`));
    });
  });
}

function parseClaudeUsageText(text) {
  const windows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)%\s+used(?:\s+·\s+resets\s+(.+))?\s*$/i.exec(line);
    if (!match) continue;
    const rawLabel = match[1].replace(/^Current\s+/i, '').trim();
    const label = rawLabel
      .replace(/\s*\(all models\)\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    windows.push({
      label,
      usedPercent: Number(match[2]),
      ...(match[3] ? { resetsLabel: match[3].trim() } : {}),
    });
  }
  return usageFromWindows(windows);
}

async function collectClaudeUsage() {
  const { stdout } = await runCommand(
    CLAUDE_BIN,
    ['-p', '/usage', '--output-format', 'json'],
  );
  const payload = JSON.parse(stdout.trim());
  return parseClaudeUsageText(payload?.result);
}

function parseCodexRateLimits(payload) {
  const snapshot = payload?.rateLimits || payload;
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const window = snapshot?.[key];
    if (!window || clampPercent(window.usedPercent) == null) continue;
    const windowMinutes = Number(window.windowDurationMins);
    windows.push({
      label: durationLabel(windowMinutes),
      usedPercent: Number(window.usedPercent),
      ...(Number.isFinite(windowMinutes) ? { windowMinutes } : {}),
      ...(isoFromUnixSeconds(window.resetsAt) ? { resetsAt: isoFromUnixSeconds(window.resetsAt) } : {}),
    });
  }
  return usageFromWindows(windows, {
    ...(typeof snapshot?.planType === 'string' ? { planType: snapshot.planType } : {}),
  });
}

function collectCodexUsage() {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let settled = false;
    const child = spawn(CODEX_BIN, ['app-server', '--stdio'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stopChild = () => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    };
    const finish = (error, usage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild();
      if (error) reject(error);
      else resolve(usage);
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const timer = setTimeout(
      () => finish(new Error(`${CODEX_BIN} usage probe timed out`)),
      COMMAND_TIMEOUT_MS,
    );

    child.once('error', (error) => finish(error));
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      let newline;
      while ((newline = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && message.result) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read', params: null });
        } else if (message.id === 2) {
          if (message.error) {
            finish(new Error(message.error.message || 'Codex rejected the usage request'));
          } else {
            try {
              finish(null, parseCodexRateLimits(message.result));
            } catch (error) {
              finish(error);
            }
          }
        }
      }
    });
    send({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'cascade', title: 'Cascade', version: '0.2.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function stripTerminalControls(value) {
  return String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function parseGrokUsageScreen(screen) {
  const text = stripTerminalControls(screen);
  const usage = /Weekly limit:\s*(\d+(?:\.\d+)?)%/i.exec(text);
  if (!usage) throw new Error('Grok /usage did not report a weekly limit');
  const reset = /Next reset:\s*([A-Za-z]+\s+\d{1,2},\s+\d{1,2}:\d{2})/i.exec(text);
  return usageFromWindows([{
    label: 'week',
    usedPercent: Number(usage[1]),
    windowMinutes: 10_080,
    ...(reset ? { resetsLabel: reset[1] } : {}),
  }]);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function collectGrokUsage(grokCwd) {
  if (process.platform !== 'linux') {
    return Promise.reject(new Error('Grok usage probing currently requires the Linux desktop'));
  }
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let settleTimer = null;
    let answeredCursorQuery = false;
    const mode = grokProbeHasSession ? '--continue ' : '';
    const command = `stty rows 30 cols 100; exec ${shellQuote(GROK_BIN)} ${mode}--minimal --no-alt-screen`;
    const child = spawn('script', ['-q', '-f', '-e', '-c', command, '/dev/null'], {
      cwd: grokCwd,
      env: { ...process.env, TERM: 'xterm-256color' },
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stopChild = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    };
    const finish = (error, usage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(sendUsage);
      if (settleTimer) clearTimeout(settleTimer);
      stopChild();
      if (error) reject(error);
      else {
        grokProbeHasSession = true;
        resolve(usage);
      }
    };
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.length > 1_000_000) output = output.slice(-1_000_000);
      // Ink asks the terminal for its cursor position before first render.
      if (!answeredCursorQuery && output.includes('\x1b[6n')) {
        answeredCursorQuery = true;
        try { child.stdin.write('\x1b[30;1R'); } catch { /* ignore */ }
      }
      const plain = stripTerminalControls(output);
      if (/Weekly limit:\s*\d+(?:\.\d+)?%/i.test(plain)) {
        if (/Next reset:/i.test(plain)) {
          finish(null, parseGrokUsageScreen(output));
        } else if (!settleTimer) {
          // The percentage can paint one frame before the reset label.
          settleTimer = setTimeout(() => finish(null, parseGrokUsageScreen(output)), 350);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (settled) return;
      try {
        finish(null, parseGrokUsageScreen(output));
      } catch (error) {
        finish(new Error(`Grok usage probe exited ${code}: ${error.message}`));
      }
    });
    const sendUsage = setTimeout(() => {
      try { child.stdin.write('/usage\r'); } catch { /* close handler reports it */ }
    }, 900);
    const timeout = setTimeout(() => {
      try {
        finish(null, parseGrokUsageScreen(output));
      } catch (error) {
        finish(error);
      }
    }, COMMAND_TIMEOUT_MS);
  });
}

function failedUsage(provider, reason) {
  const message = reason instanceof Error ? reason.message : String(reason);
  const missing = /ENOENT|not found|spawn .* ENOENT/i.test(message);
  return {
    status: missing ? 'unknown' : 'error',
    detail: `${provider}: ${message}`.slice(0, 300),
    fetchedAt: new Date().toISOString(),
  };
}

async function collectPlanUsage({ grokCwd } = {}) {
  const entries = await Promise.all([
    collectClaudeUsage().catch((error) => failedUsage('Claude', error)),
    collectCodexUsage().catch((error) => failedUsage('Codex', error)),
    collectGrokUsage(grokCwd || process.cwd()).catch((error) => failedUsage('Grok', error)),
  ]);
  return {
    'claude-code': entries[0],
    codex: entries[1],
    grok: entries[2],
  };
}

module.exports = {
  collectPlanUsage,
  parseClaudeUsageText,
  parseCodexRateLimits,
  parseGrokUsageScreen,
  stripTerminalControls,
};
