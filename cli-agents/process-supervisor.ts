/**
 * Durable process ownership and cancellation seam. Detached launchers carry a
 * lease so a replacement desktop can identify only its own descendants.
 * Cleanup always removes both in-memory maps and the durable lease.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
type AgentProcessLease = {
  version: 1;
  runId: number;
  ownerPid: number;
  ownerStartTicks: string;
  processGroupId: number;
  token: string;
  label: string;
};
export const activeCliProcesses = new Map<number, ChildProcess>();
export const activePersistentCancels = new Map<number, () => void>();
export const groupedCliProcesses = new Set<number>();
export const runHelperEnvByRunId = new Map<number, NodeJS.ProcessEnv>();
const agentProcessLeaseDir = process.env.CASCADE_AGENT_PROCESS_DIR
  || path.join(os.homedir(), '.cascade', 'agent-processes');

export function processStartTicks(pid: number): string {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return '';
  try {
    // The command name can contain spaces and parentheses. Field 22 starts
    // twenty fields after the final ')' in /proc/<pid>/stat.
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19] || '';
  } catch {
    return '';
  }
}

export function leasePath(runId: number): string {
  return path.join(agentProcessLeaseDir, `${runId}.json`);
}

export function writeAgentProcessLease(lease: AgentProcessLease): void {
  fs.mkdirSync(agentProcessLeaseDir, { recursive: true, mode: 0o700 });
  const target = leasePath(lease.runId);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(lease), { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function clearAgentProcessLease(runId: number): void {
  try { fs.unlinkSync(leasePath(runId)); } catch { /* already absent */ }
}

export function processHasLeaseToken(pid: number, runId: number, token: string): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`);
    const entries = env.toString().split('\0');
    return entries.includes(`CASCADE_RUN_ID=${runId}`)
      && entries.includes(`CASCADE_AGENT_PROCESS_TOKEN=${token}`);
  } catch {
    return false;
  }
}

export function processGroupIdOf(pid: number): number {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return 0;
  try {
    // Field 5 (pgrp) is the fourth whitespace-separated field after the
    // final ')' of /proc/<pid>/stat (comm may contain spaces/parens).
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const pgid = Number(fields[3]);
    return Number.isInteger(pgid) && pgid > 1 ? pgid : 0;
  } catch {
    return 0;
  }
}

/**
 * Find a live process that still carries this run's ownership token.
 *
 * Prefer members of the recorded process group. The group leader can die while
 * hermes/bridge descendants remain (still token-bearing), so a leader-only
 * environ check would drop the lease and leave orphans.
 */
export function findLeaseTokenProcess(runId: number, token: string, preferredPgid?: number): number {
  if (process.platform !== 'linux') return 0;
  if (preferredPgid && preferredPgid > 1 && processHasLeaseToken(preferredPgid, runId, token)) {
    return preferredPgid;
  }
  let names: string[] = [];
  try { names = fs.readdirSync('/proc'); } catch { return 0; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 1) continue;
    if (preferredPgid && preferredPgid > 1) {
      const pgid = processGroupIdOf(pid);
      if (pgid !== preferredPgid) continue;
    }
    if (processHasLeaseToken(pid, runId, token)) return pid;
  }
  // Preferred group emptied or leader-only PID reused: any token holder still
  // proves this run is live (and supplies a group to kill).
  if (preferredPgid && preferredPgid > 1) {
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (processHasLeaseToken(pid, runId, token)) return pid;
    }
  }
  return 0;
}

export function readAgentProcessLease(runId: number): AgentProcessLease | null {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath(runId), 'utf8')) as AgentProcessLease;
    const valid = lease?.version === 1
      && Number.isInteger(lease.runId) && lease.runId === runId
      && Number.isInteger(lease.ownerPid) && lease.ownerPid > 1
      && Number.isInteger(lease.processGroupId) && lease.processGroupId > 1
      && typeof lease.ownerStartTicks === 'string' && lease.ownerStartTicks.length > 0
      && typeof lease.token === 'string' && lease.token.length >= 16;
    return valid ? lease : null;
  } catch {
    return null;
  }
}

export function processIsSameOwner(lease: AgentProcessLease): boolean {
  const currentStart = processStartTicks(lease.ownerPid);
  return Boolean(currentStart && currentStart === lease.ownerStartTicks);
}

export function terminateProcessGroup(pgid: number): void {
  if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === 'win32') return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  const forceKill = setTimeout(() => {
    try { process.kill(-pgid, 0); process.kill(-pgid, 'SIGKILL'); } catch { /* settled */ }
  }, 5_000);
  forceKill.unref?.();
}

export async function terminateProcessGroupHard(pgid: number): Promise<void> {
  if (!Number.isInteger(pgid) || pgid <= 1 || process.platform === 'win32') return;
  try { process.kill(-pgid, 'SIGTERM'); } catch { /* already gone */ }
  await new Promise((resolve) => setTimeout(resolve, 250));
  try { process.kill(-pgid, 0); process.kill(-pgid, 'SIGKILL'); } catch { /* settled */ }
}

/**
 * Kill detached CLI groups whose owning Electron main process crashed.
 *
 * Detached launchers survive a hard Electron exit and are adopted by PID 1.
 * The token check prevents a stale/forged lease from targeting an unrelated
 * process group after PID reuse.
 */
export async function reapOrphanedCliAgentProcesses(): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  let files: string[] = [];
  try { files = fs.readdirSync(agentProcessLeaseDir).filter((name) => name.endsWith('.json')); } catch { return []; }
  const reaped: number[] = [];
  for (const file of files) {
    const target = path.join(agentProcessLeaseDir, file);
    let lease: AgentProcessLease | null = null;
    try { lease = JSON.parse(fs.readFileSync(target, 'utf8')) as AgentProcessLease; } catch { /* invalid lease */ }
    const valid = lease?.version === 1
      && Number.isInteger(lease.runId) && lease.runId > 0
      && Number.isInteger(lease.ownerPid) && lease.ownerPid > 1
      && Number.isInteger(lease.processGroupId) && lease.processGroupId > 1
      && typeof lease.ownerStartTicks === 'string' && lease.ownerStartTicks.length > 0
      && typeof lease.token === 'string' && lease.token.length >= 16;
    if (!valid || !lease) {
      try { fs.unlinkSync(target); } catch { /* ignore */ }
      continue;
    }
    if (processIsSameOwner(lease)) continue;
    const tokenPid = findLeaseTokenProcess(lease.runId, lease.token, lease.processGroupId);
    if (!tokenPid) {
      try { fs.unlinkSync(target); } catch { /* stale */ }
      continue;
    }
    const pgid = processGroupIdOf(tokenPid) || lease.processGroupId;
    await terminateProcessGroupHard(pgid);
    try { fs.unlinkSync(target); } catch { /* ignore */ }
    reaped.push(lease.runId);
  }
  return reaped;
}

export function terminateCliProcess(child: ChildProcess, processGroup: boolean): void {
  if (processGroup && process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGTERM');
      return;
    } catch { /* Fall through if the group already disappeared. */ }
  }
  try { child.kill('SIGTERM'); } catch { /* already settled */ }
}

export function terminateCliProcessWithEscalation(child: ChildProcess, processGroup: boolean): void {
  terminateCliProcess(child, processGroup);
  const forceKill = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (processGroup && process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* fall through */ }
    }
    try { child.kill('SIGKILL'); } catch { /* already settled */ }
  }, 5_000);
  forceKill.unref?.();
}

/**
 * Stop a run using only its durable lease — used when module reload lost the
 * in-memory ChildProcess map, or when cancel races a reaped map entry.
 */
export function cancelCliAgentRunFromLease(runId: number): boolean {
  if (process.platform !== 'linux') return false;
  const lease = readAgentProcessLease(runId);
  if (!lease) return false;
  const tokenPid = findLeaseTokenProcess(lease.runId, lease.token, lease.processGroupId);
  if (!tokenPid) {
    clearAgentProcessLease(runId);
    return false;
  }
  const pgid = processGroupIdOf(tokenPid) || lease.processGroupId;
  terminateProcessGroup(pgid);
  activeCliProcesses.delete(runId);
  groupedCliProcesses.delete(runId);
  clearAgentProcessLease(runId);
  return true;
}

/** Cancel one CLI run, including descendants of launchers such as Akron. */
export function cancelCliAgentRun(runId: number): boolean {
  const persistentCancel = activePersistentCancels.get(runId);
  if (persistentCancel) {
    persistentCancel();
    activePersistentCancels.delete(runId);
    return true;
  }
  const child = activeCliProcesses.get(runId);
  if (!child) return cancelCliAgentRunFromLease(runId);
  const processGroup = groupedCliProcesses.has(runId);
  terminateCliProcessWithEscalation(child, processGroup);
  activeCliProcesses.delete(runId);
  groupedCliProcesses.delete(runId);
  clearAgentProcessLease(runId);
  return true;
}

export function setRunHelperEnv(runId: number, env: NodeJS.ProcessEnv): void {
  runHelperEnvByRunId.set(runId, env);
}

export function clearRunHelperEnv(runId: number): void {
  runHelperEnvByRunId.delete(runId);
}

export function spawnEnv(runId?: number): NodeJS.ProcessEnv {
  if (runId !== undefined) {
    const runEnv = runHelperEnvByRunId.get(runId);
    if (runEnv) return { ...process.env, ...runEnv };
  }
  return process.env;
}

