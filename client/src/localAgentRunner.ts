/**
 * Client-side CLI agent execution via Electron IPC.
 * CLI agents (Grok, Codex, etc.) run on the user's machine, not the remote server.
 */

export type CliAgentId = 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes';

export type LocalAgentRunEvent = {
  runId: number;
  seq?: number;
  type: string;
  payload_json: string;
};

export type LocalAgentRunOptions = {
  runId: number;
  agent: CliAgentId;
  prompt: string;
  cwd?: string;
  vaultRoot?: string;
  model?: string;
  resumeSessionId?: string;
  images?: Array<{ media_type: string; data: string }>;
};

type ElectronAgentAPI = {
  startAgentRun?: (opts: LocalAgentRunOptions) => Promise<{ success: boolean; error?: string }>;
  cancelAgentRun?: (runId: number) => Promise<{ success: boolean; error?: string }>;
  onAgentEvent?: (callback: (event: LocalAgentRunEvent) => void) => () => void;
};

function electronAgentAPI(): ElectronAgentAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAgentAPI }).electronAPI;
}

export function isCliAgentId(agent: string): agent is CliAgentId {
  return agent === 'codex' || agent === 'grok' || agent === 'antigravity' || agent === 'copilot' || agent === 'hermes';
}

/** True when this shell can host delegated CLI runs (Electron with runner relay). */
export function canRunCliAgentsLocally(): boolean {
  const api = electronAgentAPI();
  return Boolean(api?.setRunnerToken || (api?.startAgentRun && api?.onAgentEvent));
}

/** Allocate a negative run id reserved for local (client-side) agent runs. */
export function createLocalRunId(): number {
  return -Math.abs(Date.now());
}

export async function startLocalAgentRun(
  opts: LocalAgentRunOptions,
  onEvent: (event: LocalAgentRunEvent) => void,
): Promise<() => void> {
  const api = electronAgentAPI();
  if (!api?.startAgentRun || !api.onAgentEvent) {
    throw new Error('Local agent execution is only available in the Cascade desktop app.');
  }

  const unsubscribe = api.onAgentEvent((event) => {
    if (event.runId !== opts.runId) return;
    onEvent(event);
  });

  const res = await api.startAgentRun(opts);
  if (!res.success) {
    unsubscribe();
    throw new Error(res.error || 'Could not start local agent run.');
  }

  return unsubscribe;
}

export async function cancelLocalAgentRun(runId: number): Promise<boolean> {
  const api = electronAgentAPI();
  if (!api?.cancelAgentRun) return false;
  const res = await api.cancelAgentRun(runId);
  return Boolean(res.success);
}

export function isLocalRunId(runId: number | undefined): boolean {
  return typeof runId === 'number' && runId < 0;
}