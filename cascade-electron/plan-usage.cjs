/**
 * Read subscription usage from the locally authenticated agent CLIs.
 *
 * Credentials never leave the user's machine except for the provider's own
 * authenticated usage endpoint. Grok currently exposes plan usage only in its
 * TUI, so the Linux desktop drives `/usage` inside a short-lived pseudo-terminal
 * and parses the two labels Grok itself renders.
 */

const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const GROK_BIN = process.env.GROK_BIN || 'grok';
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const COMMAND_TIMEOUT_MS = 15_000;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

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

function parseClaudeUsageJson(payload, extras = {}) {
  const windows = [
    ['five_hour', '5h', 300],
    ['seven_day', '7d', 10_080],
  ].flatMap(([key, label, windowMinutes]) => {
    const window = payload?.[key];
    if (!window || clampPercent(window.utilization) == null) return [];
    return [{
      label,
      windowMinutes,
      usedPercent: Number(window.utilization),
      ...(typeof window.resets_at === 'string' ? { resetsAt: window.resets_at } : {}),
    }];
  });

  // Newer Claude builds also expose the normalized limits array. Keep it as a
  // fallback so monitoring survives another response-field migration.
  if (windows.length === 0 && Array.isArray(payload?.limits)) {
    for (const limit of payload.limits) {
      const labels = {
        session: ['5h', 300],
        weekly_all: ['7d', 10_080],
      };
      const [label, windowMinutes] = labels[limit?.kind] || [];
      if (!label || clampPercent(limit?.percent) == null) continue;
      windows.push({
        label,
        windowMinutes,
        usedPercent: Number(limit.percent),
        ...(typeof limit.resets_at === 'string' ? { resetsAt: limit.resets_at } : {}),
      });
    }
  }

  const extraUsage = payload?.extra_usage;
  const extraUsageAvailable = extraUsage && typeof extraUsage === 'object'
    ? extraUsage.is_enabled === true
      && extraUsage.spend_limit_reached !== true
      && !extraUsage.disabled_reason
    : undefined;

  return usageFromWindows(windows, {
    ...extras,
    ...(typeof extraUsageAvailable === 'boolean' ? { extraUsageAvailable } : {}),
  });
}

async function readClaudeOAuthCredentials() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  for (const credentialPath of [
    path.join(configDir, '.credentials.json'),
    path.join(configDir, 'credentials.json'),
  ]) {
    try {
      const stored = JSON.parse(await fs.readFile(credentialPath, 'utf8'));
      const oauth = stored?.claudeAiOauth || stored;
      if (oauth?.accessToken) return oauth;
    } catch {
      // Claude stores credentials in the OS keychain when one is available.
    }
  }

  if (process.platform === 'darwin') {
    const { stdout } = await runCommand(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      5_000,
    );
    const stored = JSON.parse(stdout.trim());
    const oauth = stored?.claudeAiOauth || stored;
    if (oauth?.accessToken) return oauth;
  }

  throw new Error('Claude OAuth credentials unavailable');
}

async function requestClaudeUsage(accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        'User-Agent': 'Fizzer usage monitor',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`Claude usage endpoint returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function collectClaudeUsage() {
  try {
    let credentials = await readClaudeOAuthCredentials();
    let payload;
    try {
      payload = await requestClaudeUsage(credentials.accessToken);
    } catch (error) {
      if (error?.status !== 401) throw error;
      // Let Claude refresh an expired key, then reload the keychain entry.
      await runCommand(CLAUDE_BIN, ['-p', '/usage', '--output-format', 'json']);
      credentials = await readClaudeOAuthCredentials();
      payload = await requestClaudeUsage(credentials.accessToken);
    }
    return parseClaudeUsageJson(payload, {
      ...(typeof credentials.subscriptionType === 'string'
        ? { planType: credentials.subscriptionType }
        : {}),
    });
  } catch (oauthError) {
    // Older Claude versions rendered the windows directly in headless output.
    try {
      const { stdout } = await runCommand(
        CLAUDE_BIN,
        ['-p', '/usage', '--output-format', 'json'],
      );
      const payload = JSON.parse(stdout.trim());
      return parseClaudeUsageText(payload?.result);
    } catch {
      throw oauthError;
    }
  }
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
  const credits = snapshot?.credits;
  const extraUsageAvailable = credits && typeof credits === 'object'
    ? snapshot.spendControlReached !== true
      && (credits.unlimited === true || credits.hasCredits === true)
    : undefined;

  return usageFromWindows(windows, {
    ...(typeof snapshot?.planType === 'string' ? { planType: snapshot.planType } : {}),
    ...(typeof extraUsageAvailable === 'boolean' ? { extraUsageAvailable } : {}),
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

function collectGrokUsageAttempt(grokCwd, continueSession) {
  if (process.platform !== 'linux') {
    return Promise.reject(new Error('Grok usage probing currently requires the Linux desktop'));
  }
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    let settleTimer = null;
    let answeredCursorQuery = false;
    const mode = continueSession ? '--continue ' : '';
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
      else resolve(usage);
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
        const tail = stripTerminalControls(output).replace(/\s+/g, ' ').trim().slice(-180);
        finish(new Error(`Grok usage probe exited ${code}: ${error.message}${tail ? ` · ${tail}` : ''}`));
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

async function collectGrokUsage(grokCwd) {
  const firstMode = grokProbeHasSession;
  try {
    const usage = await collectGrokUsageAttempt(grokCwd, firstMode);
    grokProbeHasSession = true;
    return usage;
  } catch (firstError) {
    // Grok can exit during its first leader/session handshake even though the
    // next launch succeeds immediately. Retry once using the opposite session
    // mode: fresh after a stale --continue, or --continue after a fresh launch
    // got far enough to create its probe session.
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const usage = await collectGrokUsageAttempt(grokCwd, !firstMode);
      grokProbeHasSession = true;
      return usage;
    } catch (secondError) {
      const first = firstError instanceof Error ? firstError.message : String(firstError);
      const second = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`${second}; initial attempt: ${first}`);
    }
  }
}

// ── Nous credits ─────────────────────────────────────────────────────
//
// Hermes stores Nous Portal account info locally and exposes it via the
// `account_usage` Python module.  We shell out to the Hermes venv to pull a
// structured snapshot, then map it to the same PlanUsage shape the other
// providers use so the existing meter components render it unchanged.

function parseNousUsageJson(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('Hermes returned no Nous usage');
  const windows = Array.isArray(payload.windows) ? payload.windows : [];
  const clean = windows
    .map((window) => {
      const usedPercent = clampPercent(window.usedPercent);
      if (usedPercent == null) return null;
      return {
        label: String(window.label || 'usage'),
        usedPercent,
        ...(typeof window.detail === 'string' ? { resetsLabel: window.detail } : {}),
      };
    })
    .filter(Boolean);
  const details = Array.isArray(payload.details) ? payload.details : [];
  const planType = typeof payload.plan === 'string' && payload.plan ? payload.plan : null;
  if (clean.length === 0) {
    // No usage windows (e.g. no subscription denominator) — still report ok
    // so the details (top-up credits, total usable) surface in the title.
    return {
      status: 'ok',
      ...(planType ? { planType } : {}),
      windows: [],
      detail: details.length ? details.join('\n') : null,
      fetchedAt: new Date().toISOString(),
    };
  }
  const worst = [...clean].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  return {
    status: 'ok',
    usedPercent: worst.usedPercent,
    ...(worst.resetsLabel ? { resetsLabel: worst.resetsLabel } : {}),
    windows: clean,
    ...(planType ? { planType } : {}),
    detail: details.length ? details.join('\n') : null,
    fetchedAt: new Date().toISOString(),
  };
}

async function collectNousUsage() {
  // Resolve the Hermes venv python from the `hermes` launcher symlink so
  // this works regardless of install path.  The launcher lives at
  // <hermes-home>/hermes-agent/venv/bin/hermes, so:
  //   realpath → .../hermes-agent/venv/bin/hermes
  //   venvPython → .../hermes-agent/venv/bin/python3
  //   sourceDir  → .../hermes-agent          (parent of venv)
  //   hermesHome → .../.hermes                (parent of hermes-agent)
  const hermesPath = await resolveHermesPath();
  const binDir = path.dirname(hermesPath);          // .../venv/bin
  const venvDir = path.dirname(binDir);             // .../venv
  const sourceDir = path.dirname(venvDir);          // .../hermes-agent
  const hermesHome = path.dirname(sourceDir);       // .../.hermes
  const venvPython = path.join(binDir, 'python3');

  const script = `
import sys, json, os
sys.path.insert(0, ${JSON.stringify(sourceDir)})
os.environ.setdefault("HERMES_HOME", ${JSON.stringify(hermesHome)})
from agent.account_usage import build_nous_credits_snapshot
from hermes_cli.nous_account import get_nous_portal_account_info
import concurrent.futures
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
    account = pool.submit(get_nous_portal_account_info, force_fresh=True).result(timeout=10)
snapshot = build_nous_credits_snapshot(account)
if snapshot is None:
    print(json.dumps({"status": "unknown", "detail": "Not logged into Nous"}))
else:
    print(json.dumps({
        "provider": snapshot.provider,
        "plan": snapshot.plan,
        "windows": [{"label": w.label, "usedPercent": w.used_percent, "detail": w.detail} for w in snapshot.windows],
        "details": list(snapshot.details),
    }))
`;

  const { stdout } = await runCommand(venvPython, ['-c', script], 20_000);
  const match = stdout.trim().match(/\{[\s\S]*\}/);
  if (!match) throw new Error('Hermes did not return JSON for Nous usage');
  return parseNousUsageJson(JSON.parse(match[0]));
}

function resolveHermesPath() {
  return new Promise((resolve, reject) => {
    const child = spawn('which', [HERMES_BIN], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => {
      const bin = stdout.trim().split('\n')[0];
      if (!bin || code !== 0) return reject(new Error('hermes not found in PATH'));
      // Resolve symlinks — `which` returns the symlink, we need the real path.
      try {
        const fs = require('fs');
        resolve(fs.realpathSync(bin));
      } catch {
        resolve(bin); // fall back to the symlink path
      }
    });
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
    collectNousUsage().catch((error) => failedUsage('Nous', error)),
  ]);
  return {
    'claude-code': entries[0],
    codex: entries[1],
    grok: entries[2],
    nous: entries[3],
  };
}

module.exports = {
  collectPlanUsage,
  collectGrokUsage,
  parseClaudeUsageJson,
  parseClaudeUsageText,
  parseCodexRateLimits,
  parseGrokUsageScreen,
  parseNousUsageJson,
  stripTerminalControls,
};
