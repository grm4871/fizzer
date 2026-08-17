/**
 * Legacy local (renderer IPC) agent runs used negative run ids.
 * New runs go through the desktop-runner relay; these helpers only cancel
 * or recognize leftover local run ids from older sessions.
 */

type ElectronAgentAPI = {
  cancelAgentRun?: (runId: number) => Promise<{ success: boolean; error?: string }>;
};

function electronAgentAPI(): ElectronAgentAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronAgentAPI }).electronAPI;
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
