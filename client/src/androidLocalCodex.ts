import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

type NativeEvent = {
  kind: 'login-started' | 'login-output' | 'login-completed' | 'login-failed'
    | 'run-started' | 'run-output' | 'run-completed' | 'run-failed';
  runId?: number;
  line?: string;
  exitCode?: number;
};

export type LocalCodexStatus = {
  supported: boolean;
  authenticated: boolean;
  enabled?: boolean;
  version?: string;
  workspace?: string;
  error?: string;
};

type NativeLocalCodex = {
  getStatus(): Promise<LocalCodexStatus>;
  login(): Promise<{ requestId: string }>;
  setEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  startAgentRun(options: Record<string, unknown>): Promise<{ success: boolean }>;
  cancelAgentRun(options: { runId: number }): Promise<{ success: boolean }>;
  getState(): Promise<{ instanceId: string; activeRunIds: number[] }>;
  addListener(eventName: 'localCodexEvent', listener: (event: NativeEvent) => void): Promise<PluginListenerHandle>;
};

const plugin = registerPlugin<NativeLocalCodex>('LocalCodex');
const eventListeners = new Set<(event: NativeEvent) => void>();
let listenerReady: Promise<PluginListenerHandle> | null = null;
let bridgeSeq = 0;
const lastAnswer = new Map<number, string>();

function ensureNativeListener(): void {
  if (listenerReady || Capacitor.getPlatform() !== 'android') return;
  listenerReady = plugin.addListener('localCodexEvent', (event) => {
    for (const listener of eventListeners) listener(event);
  });
}

export function parseAndroidCodexOutputLine(line: string): { sessionId?: string; answer?: string } {
  try {
    const event = JSON.parse(line) as {
      type?: string;
      thread_id?: string;
      item?: { type?: string; text?: string };
    };
    if (event.type === 'thread.started' && event.thread_id) return { sessionId: event.thread_id };
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      return { answer: String(event.item.text || '') };
    }
  } catch { /* raw diagnostics remain harness output */ }
  return {};
}

export function isAndroidLocalCodexAvailable(): boolean {
  return Capacitor.getPlatform() === 'android';
}

export async function getAndroidLocalCodexStatus(): Promise<LocalCodexStatus> {
  if (!isAndroidLocalCodexAvailable()) return { supported: false, authenticated: false };
  return plugin.getStatus();
}

export function startAndroidLocalCodexLogin(onEvent: (event: NativeEvent) => void): Promise<() => void> {
  ensureNativeListener();
  eventListeners.add(onEvent);
  return plugin.login().then(() => () => eventListeners.delete(onEvent));
}

export async function setAndroidLocalCodexEnabled(enabled: boolean): Promise<LocalCodexStatus> {
  await plugin.setEnabled({ enabled });
  return plugin.getStatus();
}

export function androidRunnerAPI() {
  if (!isAndroidLocalCodexAvailable()) return undefined;
  ensureNativeListener();
  return {
    setRunnerToken: async () => {
      const status = await plugin.getStatus();
      return status.supported && status.authenticated && status.enabled
        ? { success: true }
        : { success: false, error: 'Local Codex is not enabled on this phone.' };
    },
    clearRunnerToken: async () => ({ success: true }),
    startAgentRun: (options: Record<string, unknown>) => plugin.startAgentRun(options),
    cancelAgentRun: (runId: number) => plugin.cancelAgentRun({ runId }),
    getAgentRunState: async () => ({ ...(await plugin.getState()), events: [], cursor: bridgeSeq }),
    onAgentEvent: (callback: (event: { runId?: number; type?: string; payload_json?: string; bridgeSeq?: number }) => void) => {
      const listener = (event: NativeEvent) => {
        const runId = Number(event.runId);
        if (!Number.isFinite(runId)) return;
        const emit = (type: string, payload: unknown) => callback({
          runId,
          type,
          payload_json: JSON.stringify(payload),
          bridgeSeq: ++bridgeSeq,
        });
        if (event.kind === 'run-started') {
          emit('status', { status: 'running' });
        } else if (event.kind === 'run-output' && event.line) {
          emit('harness', { data: `${event.line}\r\n` });
          const parsed = parseAndroidCodexOutputLine(event.line);
          if (parsed.sessionId) emit('session', { sessionId: parsed.sessionId });
          if (parsed.answer) {
            lastAnswer.set(runId, parsed.answer);
            emit('text', {
              chatVisible: true,
              message: { content: [{ type: 'text', text: parsed.answer }] },
            });
          }
        } else if (event.kind === 'run-completed') {
          emit('status', { status: 'completed', summary: lastAnswer.get(runId) || 'Completed on Android.' });
          lastAnswer.delete(runId);
        } else if (event.kind === 'run-failed') {
          emit('status', {
            status: 'failed',
            summary: event.line || `Local Codex exited ${event.exitCode ?? 'unexpectedly'}.`,
          });
          lastAnswer.delete(runId);
        }
      };
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
  };
}
