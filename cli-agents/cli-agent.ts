/**
 * Public local-agent facade.
 *
 * Provider adapters own protocol translation; the process supervisor owns
 * cancellation and durable leases; this module only selects an adapter and
 * preserves the historical runCliAgent interface.
 * @module cli-agents/cli-agent
 */
import type Database from 'better-sqlite3';
import {
  type AgentEmit,
  type CliImage,
  type CliAgentId,
  type CliAgentOpts,
  type CliAgentResult,
  assertCliAgentAvailable,
  getCliAgentBin,
  getCliAgentAvailability,
} from './cli-agent-common.js';
import { writeTempImages } from './cli-agent-common.js';
import {
  activeCliProcesses,
  cancelCliAgentRun,
  clearRunHelperEnv,
  reapOrphanedCliAgentProcesses,
  setRunHelperEnv,
} from './process-supervisor.js';
import { runCodex, shutdownPersistentCliAgents } from './codex-agent.js';
import { runGrok } from './grok-agent.js';
import { runAntigravity, cancelAntigravityRun } from './antigravity-agent.js';
import { runCopilot } from './copilot-agent.js';
import { runHermes, runAkronGrok } from './hermes-agent.js';
import { runOmp, runPi } from './pi-agent.js';
import { resolveAntigravityModelTier } from './antigravity-config.js';

export type { AgentEmit, CliImage, CliAgentId, CliAgentOpts, CliAgentResult } from './cli-agent-common.js';
export { getCliAgentBin, getCliAgentAvailability };
export {
  activeCliProcesses,
  cancelCliAgentRun,
  clearRunHelperEnv,
  reapOrphanedCliAgentProcesses,
  setRunHelperEnv,
  shutdownPersistentCliAgents,
  cancelAntigravityRun,
  resolveAntigravityModelTier,
};

/** Select and execute one provider while retaining the original call shape. */
export async function runCliAgent(opts: CliAgentOpts): Promise<CliAgentResult> {
  assertCliAgentAvailable(opts.agent);
  const prompt = opts.context ? `[Context: ${opts.context}]\n\n${opts.userPrompt}` : opts.userPrompt;
  switch (opts.agent) {
    case 'codex':
      return runCodex(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.reasoningEffort, opts.priorityServiceTier, opts.yolo, opts.sandbox, opts.env);
    case 'grok':
      return runGrok(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model, opts.env);
    case 'copilot':
      return runCopilot(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.model, opts.env);
    case 'hermes':
      return runHermes(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.env, opts.model, opts.hermesProfile, opts.hermesSafeMode, opts.yolo);
    case 'akron-grok':
      return runAkronGrok(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.env);
    case 'omp':
      return runOmp(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.env);
    case 'pi':
      return runPi(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.images || [], opts.runId, opts.model, opts.env);
    case 'antigravity':
      return runAntigravity(prompt, opts.cwd, opts.emit, opts.resumeSessionId, opts.runId, opts.db, opts.model, opts.yolo, opts.env);
  }
}

// Keep these named exports available to callers that previously imported the
// implementation module directly. They are intentionally only shared seams.
export { writeTempImages };
export type Db = Database.Database;
