/** Shared event, option, telemetry, and temporary-media seams for local providers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type Database from 'better-sqlite3';

type Db = Database.Database;
export type AgentEmit = (type: 'text' | 'user' | 'harness' | 'session', payload: unknown) => void;
export type CliImage = { media_type: string; data: string };

/** Emit a raw harness/terminal chunk (stdout/stderr or formatted SDK lines). */
export function emitHarness(emit: AgentEmit | undefined, data: string): void {
  if (!emit || !data) return;
  emit('harness', { data });
}

/** Machine-readable stats line for the harness header (token/ctx/cost chips). */
export function emitCascadeStats(emit: AgentEmit | undefined, stats: Record<string, unknown>): void {
  if (!emit || !stats || typeof stats !== 'object') return;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(stats)) {
    if (value !== undefined && value !== null && value !== '') clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return;
  try {
    emitHarness(emit, `\x1b[2m# cascade-stats ${JSON.stringify(clean)}\x1b[0m\r\n`);
  } catch { /* ignore */ }
}

function numFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** Pull token fields from common CLI usage blobs. */
export function statsFromUsageBlob(
  usage: Record<string, unknown> | null | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (!usage && Object.keys(extra).length === 0) return extra;
  const u = usage || {};
  const input = numFromUnknown(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens);
  const cached = numFromUnknown(
    u.cached_input_tokens ?? u.cache_read_input_tokens ?? u.cacheReadTokens ?? u.cachedInputTokens,
  );
  const output = numFromUnknown(
    u.output_tokens
    ?? u.outputTokens
    ?? u.completion_tokens
    // Codex sometimes splits reasoning tokens out of output_tokens.
    ?? ((numFromUnknown(u.reasoning_output_tokens) != null || numFromUnknown(u.reasoningOutputTokens) != null)
      ? (numFromUnknown(u.output_tokens) || 0)
        + (numFromUnknown(u.reasoning_output_tokens) || numFromUnknown(u.reasoningOutputTokens) || 0)
      : undefined),
  );
  const total = numFromUnknown(u.total_tokens ?? u.totalTokens);
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cached,
    cacheWriteTokens: numFromUnknown(u.cache_creation_input_tokens ?? u.cacheWriteTokens),
    // Prefer explicit context totals; else input (+ cache) approximates window fill.
    contextUsed: total
      ?? (input != null || cached != null ? (input || 0) + (cached || 0) : undefined),
    totalCostUsd: numFromUnknown(u.total_cost_usd ?? u.cost_usd ?? u.cost),
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

/**
 * Inactivity timeout (ms): a CLI agent is killed only after this long with
 * **no output at all** — not after this long running.
 *
 * This was a fixed wall-clock cap, which killed healthy long runs mid-stream:
 * Codex routinely works well past 10 minutes on one task, and a run that was
 * actively printing progress still got SIGTERMed. Resetting the timer on every
 * stdout/stderr chunk keeps the guarantee that matters — a wedged process is
 * still reaped, because a wedged process emits nothing — without capping how
 * long useful work may take.
 *
 * `RUNNER_CLI_TIMEOUT` is still honoured as an override for compatibility.
 */
export const CLI_IDLE_TIMEOUT_MS = Number(
  process.env.RUNNER_CLI_IDLE_TIMEOUT || process.env.RUNNER_CLI_TIMEOUT || 1_800_000,
);
export const CLI_PROGRESS_HEARTBEAT_MS = Math.max(10, Number(
  process.env.RUNNER_CLI_HEARTBEAT_MS || 15_000,
));
// Akron's local Grok bridge can hold an upstream stream open forever without a
// response byte. A short provider-silence bound prevents one wedged request
// from monopolizing the coordinator's sticky slot for the generic 30 minutes.
export const AKRON_IDLE_TIMEOUT_MS = Math.max(1_000, Number(
  process.env.RUNNER_AKRON_IDLE_TIMEOUT_MS || 120_000,
));
// Hermes can spend meaningful time planning and initializing its provider
// bridge before its first byte. Keep a real wedge bound without making a
// substantial prompt look broken just because a greeting is much faster.
export const HERMES_IDLE_TIMEOUT_MS = Math.max(1_000, Number(
  process.env.RUNNER_HERMES_IDLE_TIMEOUT_MS || 180_000,
));

class CliIdleTimeoutError extends Error {}

/**
 * Idle-timeout handle: `bump()` on every chunk of child output, `clear()` once
 * the process settles. Fires `onIdle` after CLI_IDLE_TIMEOUT_MS of silence.
 */
export function createIdleTimer(
  onIdle: () => void,
  timeoutMs = CLI_IDLE_TIMEOUT_MS,
): { bump: () => void; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const bump = () => {
    clear();
    timer = setTimeout(onIdle, timeoutMs);
  };
  bump();
  return { bump, clear };
}

/** Binary names are overridable in case they are not on the runner machine's PATH. */
export const CODEX_BIN = process.env.CODEX_BIN || 'codex';
export const GROK_BIN = process.env.GROK_BIN || 'grok';
export const COPILOT_BIN = process.env.COPILOT_BIN || 'copilot';
export const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
/** Borders of the box-drawn reasoning panel Hermes prints on stdout under `-Q`. */
export const HERMES_REASONING_OPEN = /^┌─+\s*Reasoning\s*─/;
export const HERMES_REASONING_CLOSE = /^└─+┘?$/;
/**
 * Hermes exhausts its own internal retries and then exits 0 with a plain
 * "API call failed after N retries: HTTP 503 …" line as its answer. That is a
 * transient upstream-capacity error, not a real reply, so Cascade retries the
 * whole run rather than surfacing the 503 as the agent's message.
 */
const HERMES_UPSTREAM_UNAVAILABLE = /^(?:API call failed after \d+ retr(?:y|ies)\b|HTTP 5\d\d\b|(?:The )?requested model is temporarily unavailable\b)/i;
/**
 * True only when the upstream error *is* the entire reply.
 *
 * Matching the phrase anywhere would misfire on a real answer that discusses
 * HTTP 503 (a plausible question in this repo), silently discarding the model's
 * work and then spinning for the whole retry budget.
 */
function isHermesUpstreamFailure(output: string): boolean {
  const lines = output.trim().split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0 || lines.length > 2) return false;
  return lines.every((line) => HERMES_UPSTREAM_UNAVAILABLE.test(line));
}

export const HERMES_UPSTREAM_RETRIES = Math.max(0, Number(process.env.RUNNER_HERMES_UPSTREAM_RETRIES || 50));
export const HERMES_UPSTREAM_BACKOFF_MS = Math.max(250, Number(process.env.RUNNER_HERMES_UPSTREAM_BACKOFF_MS || 3_000));
// Cap the escalating backoff so a long retry streak keeps polling on a steady
// cadence instead of stretching to minutes between attempts.
export const HERMES_UPSTREAM_BACKOFF_CAP_MS = Math.max(HERMES_UPSTREAM_BACKOFF_MS, Number(process.env.RUNNER_HERMES_UPSTREAM_BACKOFF_CAP_MS || 30_000));
export const AKRON_BIN = process.env.AKRON_BIN || 'akron';
export const OMP_BIN = process.env.OMP_BIN || 'omp';
export const PI_BIN = process.env.PI_BIN || 'pi';

export type CliAgentId = 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'akron-grok' | 'omp' | 'pi';

const CLI_AGENT_LABELS: Record<CliAgentId, string> = {
  codex: 'Codex',
  grok: 'Grok',
  antigravity: 'Antigravity',
  copilot: 'Copilot',
  hermes: 'Hermes',
  'akron-grok': 'Akron --grok',
  omp: 'OMP',
  pi: 'Pi',
};

export function getCliAgentBin(agent: CliAgentId): string {
  switch (agent) {
    case 'codex':
      return CODEX_BIN;
    case 'grok':
      return GROK_BIN;
    case 'copilot':
      return COPILOT_BIN;
    case 'hermes':
      return HERMES_BIN;
    case 'akron-grok':
      return AKRON_BIN;
    case 'omp':
      return OMP_BIN;
    case 'pi':
      return PI_BIN;
    case 'antigravity':
      return process.env.ANTIGRAVITY_BIN || path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi');
  }
}

const CLI_AVAILABILITY_CACHE_MS = 60_000;
const cliAvailabilityCache = new Map<string, { available: boolean; checkedAt: number }>();

function cliBinaryExists(bin: string): boolean {
  const cached = cliAvailabilityCache.get(bin);
  if (cached && Date.now() - cached.checkedAt < CLI_AVAILABILITY_CACHE_MS) {
    return cached.available;
  }
  let available = false;
  if (path.isAbsolute(bin)) {
    try {
      available = fs.existsSync(bin) && fs.statSync(bin).isFile();
    } catch {
      available = false;
    }
  } else {
    const result = spawnSync('which', [bin], { stdio: 'ignore' });
    available = result.status === 0;
  }
  cliAvailabilityCache.set(bin, { available, checkedAt: Date.now() });
  return available;
}

function unavailableCliMessage(agent: CliAgentId, bin: string): string {
  const variable = agent === 'akron-grok'
    ? 'AKRON_BIN'
    : `${agent.toUpperCase().replace('-', '_')}_BIN`;
  return `${CLI_AGENT_LABELS[agent]} ('${bin}') is not installed or not on PATH. CLI agents run in the Cascade desktop app on this computer — install the CLI locally, or set ${variable} for the desktop app.`;
}

export function getCliAgentAvailability(): Record<CliAgentId, { available: boolean; bin: string; message?: string }> {
  const availability = {} as Record<CliAgentId, { available: boolean; bin: string; message?: string }>;
  for (const agent of Object.keys(CLI_AGENT_LABELS) as CliAgentId[]) {
    const bin = getCliAgentBin(agent);
    const available = cliBinaryExists(bin);
    availability[agent] = available
      ? { available: true, bin }
      : {
        available: false,
        bin,
        message: unavailableCliMessage(agent, bin),
      };
  }
  return availability;
}

export function assertCliAgentAvailable(agent: CliAgentId): void {
  // Launching one provider must not synchronously spawn `which` for every other
  // integration. Full availability remains available to the health endpoint.
  const bin = getCliAgentBin(agent);
  if (!cliBinaryExists(bin)) {
    throw new Error(unavailableCliMessage(agent, bin));
  }
}

export interface CliAgentOpts {
  agent: CliAgentId;
  /** Minimal IDE-style context (selected note + vault). Prepended to the prompt. */
  context: string;
  userPrompt: string;
  cwd: string;
  /** Prior backend session id to resume, for conversation continuity. */
  resumeSessionId?: string;
  /** Pasted images to attach (Codex via -i; Grok has no image support). */
  images?: CliImage[];
  emit: AgentEmit;
  runId?: number;
  db?: Db;
  model?: string;
  /** Codex-only reasoning effort override. */
  reasoningEffort?: string;
  /** Codex-only priority processing override. */
  priorityServiceTier?: boolean;
  /** Codex-only sandbox override for isolated assistants. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Run with permission prompts bypassed ("yolo"). For Codex this widens the
   * sandbox from workspace-write to danger-full-access. */
  yolo?: boolean;
  /** Hermes profile from the owner's local Hermes installation. */
  hermesProfile?: string;
  /** Ignore Hermes user configuration for this identity. */
  hermesSafeMode?: boolean;
  /** Explicit child-process environment from the desktop runner. */
  env?: NodeJS.ProcessEnv;
}

/** Maps MIME types to file extensions for temp image files. */
const IMG_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp',
};

export interface CliAgentResult {
  summary: string;
  /** Backend session id for this run, to resume on the next turn. */
  sessionId?: string;
}

// ═══════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Writes base64-encoded images to a temp directory for CLI flags like `-i`.
 *
 * @param images - Array of base64-encoded images with MIME types
 * @returns Object with file paths and a cleanup function to remove them
 */
export function writeTempImages(images: CliImage[]): { paths: string[]; cleanup: () => void } {
  if (!images.length) return { paths: [], cleanup: () => {} };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-img-'));
  const paths = images.map((img, i) => {
    const ext = IMG_EXT[img.media_type] || 'png';
    const file = path.join(dir, `image-${i}.${ext}`);
    fs.writeFileSync(file, Buffer.from(img.data, 'base64'));
    return file;
  });
  return { paths, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

