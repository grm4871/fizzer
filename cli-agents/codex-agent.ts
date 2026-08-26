/** Codex app-server adapter and legacy JSONL fallback. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { CODEX_BIN, CLI_IDLE_TIMEOUT_MS, type AgentEmit, type CliImage, type CliAgentResult, emitHarness, emitCascadeStats, statsFromUsageBlob, writeTempImages } from './cli-agent-common.js';
import { activePersistentCancels, activeCliProcesses, spawnEnv } from './process-supervisor.js';
import { createIdleTimer } from './cli-agent-common.js';
import { driveProcess } from './process-driver.js';
import { truncate } from './provider-utils.js';

type JsonObject = Record<string, any>;
type CodexAppTurn = {
  threadId: string; turnId: string; runId?: number; emit: AgentEmit;
  resolve: (result: CliAgentResult) => void; reject: (error: Error) => void;
  summary: string; emittedText: boolean; emittedTools: Set<string>;
  idle: ReturnType<typeof createIdleTimer>;
};
/** Codex's stable signal that a requested resume target no longer exists. */
function isDeadCodexSession(stderr: string): boolean {
  return /no rollout found|thread\/resume failed|session not found/i.test(stderr);
}


/** Long-lived protocol peer; avoids rebuilding Codex's app-server every turn. */
export class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private stdout = '';
  private stderr = '';
  private nextId = 1;
  private initialized?: Promise<void>;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private turns = new Map<string, CodexAppTurn>();
  private earlyNotifications = new Map<string, JsonObject[]>();
  private threadQueues = new Map<string, Promise<void>>();
  async run(options: {
    prompt: string; cwd: string; emit: AgentEmit; resumeId?: string; imagePaths: string[];
    runId?: number; model?: string; reasoningEffort?: string;
    priorityServiceTier?: boolean; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    yolo?: boolean; env?: NodeJS.ProcessEnv;
  }): Promise<CliAgentResult> {
    const threadId = typeof options.resumeId === 'string' ? options.resumeId.trim() : '';
    if (!threadId) return this.runUnlocked(options);

    // Codex permits only one writer per resumed thread. Keep retries and
    // rapid cancel/restart actions serialized until the prior turn settles.
    const previous = this.threadQueues.get(threadId) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.threadQueues.set(threadId, current);
    await previous;
    try {
      return await this.runUnlocked(options);
    } finally {
      release();
      if (this.threadQueues.get(threadId) === current) this.threadQueues.delete(threadId);
    }
  }

  private async runUnlocked(options: {
    prompt: string; cwd: string; emit: AgentEmit; resumeId?: string; imagePaths: string[];
    runId?: number; model?: string; reasoningEffort?: string;
    priorityServiceTier?: boolean; sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
    yolo?: boolean; env?: NodeJS.ProcessEnv;
  }): Promise<CliAgentResult> {
    await this.ensureStarted();
    const sandbox = options.sandbox || (options.yolo ? 'danger-full-access' : 'workspace-write');
    const common: JsonObject = {
      cwd: options.cwd,
      model: options.model || null,
      serviceTier: options.priorityServiceTier ? 'priority' : null,
      approvalPolicy: 'never',
      sandbox,
      config: {
        ...(sandbox === 'workspace-write' ? { sandbox_workspace_write: { network_access: true } } : {}),
        shell_environment_policy: { inherit: 'all', set: this.environmentOverrides(options.env) },
      },
    };
    let response = await this.openThread(options, common);
    let threadId = String(response?.thread?.id || options.resumeId || '');
    if (!threadId) throw new Error('Codex app-server did not return a thread id.');
    const turnParams = {
      threadId,
      input: [
        { type: 'text', text: options.prompt, text_elements: [] },
        ...options.imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
      ],
      cwd: options.cwd,
      model: options.model || null,
      serviceTier: options.priorityServiceTier ? 'priority' : null,
      effort: normalizeCodexEffort(options.reasoningEffort),
      approvalPolicy: 'never',
    };
    let started: JsonObject;
    try {
      started = await this.request('turn/start', turnParams);
    } catch (error) {
      if (!this.isActiveWriterError(error)) throw error;
      emitHarness(options.emit, '\x1b[33m# Codex left this thread busy — interrupting its unfinished turn\x1b[0m\r\n');
      const interrupted = await this.interruptActiveTurn(threadId);
      try {
        if (!interrupted) throw error;
        started = await this.requestWithActiveWriterRetry('turn/start', turnParams);
      } catch (retryError) {
        if (!this.isActiveWriterError(retryError)) throw retryError;
        void this.request('thread/unsubscribe', { threadId }).catch(() => {});
        emitHarness(options.emit, '\x1b[33m# Codex did not release that thread — continuing in a fresh session\x1b[0m\r\n');
        response = await this.request('thread/start', common);
        threadId = String(response?.thread?.id || '');
        if (!threadId) throw new Error('Codex app-server did not return a replacement thread id.');
        started = await this.request('turn/start', { ...turnParams, threadId });
      }
    }
    options.emit('session', { sessionId: threadId });
    emitHarness(options.emit, `\x1b[2m# codex app-server · ${options.cwd}\x1b[0m\r\n`);
    if (options.model) emitCascadeStats(options.emit, { model: options.model });
    const turnId = String(started?.turn?.id || '');
    if (!turnId) throw new Error('Codex app-server did not return a turn id.');
    return new Promise<CliAgentResult>((resolve, reject) => {
      const idle = createIdleTimer(() => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        this.finishTurn(turnId, new Error(`Codex produced no output for ${CLI_IDLE_TIMEOUT_MS}ms and was stopped.`));
      });
      this.turns.set(turnId, {
        threadId, turnId, runId: options.runId, emit: options.emit, resolve, reject,
        summary: '', emittedText: false, emittedTools: new Set(), idle,
      });
      if (options.runId !== undefined) activePersistentCancels.set(options.runId, () => {
        void this.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      });
      const buffered = this.earlyNotifications.get(turnId) || [];
      this.earlyNotifications.delete(turnId);
      for (const message of buffered) this.onMessage(message);
    });
  }

  private async openThread(options: {
    resumeId?: string; emit: AgentEmit;
  }, common: JsonObject): Promise<JsonObject> {
    if (!options.resumeId) return this.request('thread/start', common);
    const resumeParams = { threadId: options.resumeId, excludeTurns: true, ...common };
    try {
      return await this.request('thread/resume', resumeParams);
    } catch (error) {
      if (isDeadCodexSession(String(error))) {
        emitHarness(options.emit, '\x1b[33m# that session is gone from Codex\'s store — starting a fresh one\x1b[0m\r\n');
        return this.request('thread/start', common);
      }
      if (!this.isActiveWriterError(error)) throw error;
      emitHarness(options.emit, '\x1b[33m# Codex left this thread busy — interrupting its unfinished turn\x1b[0m\r\n');
      const interrupted = await this.interruptActiveTurn(options.resumeId);
      if (interrupted) {
        try {
          return await this.requestWithActiveWriterRetry('thread/resume', resumeParams);
        } catch (retryError) {
          if (!this.isActiveWriterError(retryError)) throw retryError;
        }
      }
      emitHarness(options.emit, '\x1b[33m# Codex did not release that thread — continuing in a fresh session\x1b[0m\r\n');
      return this.request('thread/start', common);
    }
  }

  private async interruptActiveTurn(threadId: string): Promise<boolean> {
    try {
      const response = await this.request('thread/read', { threadId, includeTurns: true });
      const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
      const active = [...turns].reverse().find((turn) => turn?.status === 'inProgress' && turn?.id);
      if (!active) return false;
      await this.request('turn/interrupt', { threadId, turnId: active.id });
      return true;
    } catch {
      return false;
    }
  }

  private isActiveWriterError(error: unknown): boolean {
    return /active writer/i.test(String(error));
  }

  private async requestWithActiveWriterRetry(method: string, params: JsonObject): Promise<any> {
    let delayMs = 250;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await this.request(method, params);
      } catch (error) {
        if (!this.isActiveWriterError(error) || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs = Math.min(delayMs * 2, 2_000);
      }
    }
    throw new Error(`Codex ${method} did not become available.`);
  }

  private environmentOverrides(env?: NodeJS.ProcessEnv): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env || {})) {
      if (typeof value === 'string' && process.env[key] !== value) clean[key] = value;
    }
    return clean;
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(CODEX_BIN, ['app-server', '--stdio'], {
          cwd: os.homedir(), env: spawnEnv(), stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(new Error(`Failed to launch Codex app-server: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      this.child = child;
      child.stdout.on('data', (chunk) => this.onStdout(chunk.toString()));
      child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk.toString()).slice(-16_000); });
      child.on('error', (error) => this.onExit(child, new Error(`Codex app-server error: ${error.message}`)));
      child.on('exit', (code, signal) => this.onExit(child, new Error(`Codex app-server exited (${signal || code || 'unknown'}). ${this.stderr.trim()}`)));
      this.request('initialize', {
        clientInfo: { name: 'cascade-desktop', title: 'Cascade', version: '0.2.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }).then(() => { this.notify('initialized'); resolve(); }, reject);
    });
    try { await this.initialized; } catch (error) { this.initialized = undefined; throw error; }
  }

  private request(method: string, params?: JsonObject): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child?.stdin.writable) return reject(new Error('Codex app-server is not running.'));
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  private notify(method: string): void {
    if (this.child?.stdin.writable) this.child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  private onStdout(chunk: string): void {
    this.stdout += chunk;
    let newline = this.stdout.indexOf('\n');
    while (newline >= 0) {
      const line = this.stdout.slice(0, newline).trim();
      this.stdout = this.stdout.slice(newline + 1);
      if (line) try { this.onMessage(JSON.parse(line)); } catch { /* ignore non-protocol output */ }
      newline = this.stdout.indexOf('\n');
    }
  }

  private onMessage(message: JsonObject): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      return message.error
        ? pending.reject(new Error(message.error.message || JSON.stringify(message.error)))
        : pending.resolve(message.result);
    }
    if (message.id !== undefined && message.method) {
      const response = /requestApproval$/.test(message.method)
        ? { id: message.id, result: { decision: 'decline' } }
        : { id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } };
      this.child?.stdin.write(`${JSON.stringify(response)}\n`);
      return;
    }
    const params = message.params || {};
    const turnId = String(params.turnId || params.turn?.id || '');
    const turn = this.turns.get(turnId)
      || [...this.turns.values()].find((candidate) => candidate.threadId === params.threadId);
    if (!turn) {
      if (turnId && ['item/started', 'item/completed', 'turn/completed', 'error'].includes(message.method)) {
        const buffered = this.earlyNotifications.get(turnId) || [];
        buffered.push(message);
        this.earlyNotifications.set(turnId, buffered.slice(-100));
      }
      return;
    }
    turn.idle.bump();
    if (message.method === 'item/started') this.emitItem(turn, params.item, false);
    else if (message.method === 'item/completed') this.emitItem(turn, params.item, true);
    else if (message.method === 'thread/tokenUsage/updated') emitCascadeStats(turn.emit, statsFromUsageBlob(params.tokenUsage || params.usage));
    else if (message.method === 'turn/completed') {
      const status = params.turn?.status;
      this.finishTurn(turnId, status === 'completed' ? undefined : new Error(params.turn?.error?.message || `Codex turn ${status || 'failed'}.`));
    } else if (message.method === 'error') {
      this.finishTurn(turnId, new Error(params.error?.message || params.message || 'Codex app-server error.'));
    }
  }

  private emitItem(turn: CodexAppTurn, item: JsonObject | undefined, completed: boolean): void {
    if (!item?.type) return;
    if (item.type === 'agentMessage' && completed) {
      const text = String(item.text || '');
      if (text) {
        turn.summary = text;
        turn.emit('text', { chatVisible: true, message: { content: [{ type: 'text', text: `${turn.emittedText ? '\n\n' : ''}${text}` }] } });
        turn.emittedText = true;
      }
      return;
    }
    if (item.type === 'reasoning' && completed) {
      const text = [...(item.summary || []), ...(item.content || [])].filter(Boolean).join('\n');
      if (text) turn.emit('text', { message: { content: [{ type: 'thinking', text }] } });
      return;
    }
    if (['userMessage', 'plan', 'contextCompaction'].includes(item.type) || !item.id) return;
    if (!turn.emittedTools.has(item.id)) {
      turn.emittedTools.add(item.id);
      turn.emit('text', { message: { content: [codexAppToolUseBlock(item)] } });
    }
    if (completed) {
      const output = item.aggregatedOutput ?? item.result ?? item.error ?? '';
      const isError = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      turn.emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: truncate(typeof output === 'string' ? output : JSON.stringify(output), 8000), is_error: isError }] } });
    }
  }

  private finishTurn(turnId: string, error?: Error): void {
    const turn = this.turns.get(turnId);
    if (!turn) return;
    this.turns.delete(turnId);
    turn.idle.clear();
    if (turn.runId !== undefined) activePersistentCancels.delete(turn.runId);
    // A loaded app-server thread owns an exclusive writer lease even while it
    // is idle. Release it after every turn so a rebuilt desktop module or a
    // second Cascade window can resume the conversation later.
    void this.request('thread/unsubscribe', { threadId: turn.threadId }).catch(() => {});
    if (error) turn.reject(error); else turn.resolve({ summary: turn.summary, sessionId: turn.threadId });
  }

  private onExit(child: ChildProcessWithoutNullStreams, error: Error): void {
    // A deliberate shutdown can be followed immediately by a replacement.
    // Ignore the old child's late exit event instead of tearing down the new
    // app-server that now occupies this client.
    if (this.child !== child) return;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const id of [...this.turns.keys()]) this.finishTurn(id, error);
    this.child = undefined; this.initialized = undefined; this.stdout = ''; this.stderr = ''; this.earlyNotifications.clear();
  }

  shutdown(): void {
    this.child?.kill('SIGTERM');
    this.child = undefined;
    this.initialized = undefined;
  }
}

const codexAppServer = new CodexAppServerClient();

/** Used by desktop shutdown and protocol tests; normal turns share one server. */
export function shutdownPersistentCliAgents(): void {
  codexAppServer.shutdown();
}

function normalizeCodexEffort(value?: string): string | null {
  const effort = String(value || '').trim().toLowerCase();
  return ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort) ? effort : null;
}

function codexAppToolUseBlock(item: JsonObject): JsonObject {
  if (item.type === 'commandExecution') return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command || '' } };
  if (item.type === 'fileChange') return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: item.changes?.[0]?.path || '(files)' } };
  if (item.type === 'mcpToolCall') return { type: 'tool_use', id: item.id, name: `${item.server || 'mcp'}.${item.tool || 'tool'}`, input: item.arguments || {} };
  return { type: 'tool_use', id: item.id, name: String(item.tool || item.type), input: item.arguments || {} };
}

function persistentCodexEnabled(): boolean {
  return process.env.RUNNER_CODEX_PERSISTENT !== '0' && path.basename(CODEX_BIN) === 'codex';
}

/**
 * Runs the Codex CLI (`codex exec --json`) and translates its rich JSONL
 * event stream into Anthropic-style content blocks.
 *
 * Codex events → content block mapping:
 *   - `thread.started`              → captures session id
 *   - `item.started` (tool items)   → `{ type: 'tool_use', name, input }`
 *   - `item.completed` / agent_message → `{ type: 'text', text }`
 *   - `item.completed` / reasoning  → `{ type: 'thinking', text }`
 *   - `item.completed` / tool items → `{ type: 'tool_result', content, is_error }`
 *
 * @param prompt     - Full prompt (context + user prompt)
 * @param cwd        - Vault root path
 * @param emit       - Event emitter callback
 * @param resumeId   - Optional session id to resume a prior conversation
 * @param images     - Optional images to attach via `-i` flags
 * @returns Summary text and optional session id
 */
export async function runCodex(
  prompt: string,
  cwd: string,
  emit: AgentEmit,
  resumeId?: string,
  images: CliImage[] = [],
  runId?: number,
  model?: string,
  reasoningEffort?: string,
  priorityServiceTier?: boolean,
  yolo?: boolean,
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access',
  env?: NodeJS.ProcessEnv,
): Promise<CliAgentResult> {
  const { paths: imagePaths, cleanup } = writeTempImages(images);
  if (persistentCodexEnabled()) {
    try {
      return await codexAppServer.run({
        prompt,
        cwd,
        emit,
        resumeId,
        imagePaths,
        runId,
        model,
        reasoningEffort,
        priorityServiceTier,
        yolo,
        sandbox,
        env: env ? { ...spawnEnv(runId), ...env } : spawnEnv(runId),
      });
    } finally {
      cleanup();
    }
  }
  // `-i/--image` is variadic, so it must come AFTER the positional prompt (and
  // session id on resume) or it swallows them. `codex exec resume` rejects
  // --sandbox, so the sandbox mode is set via -c instead.
  const imageArgs = imagePaths.flatMap((p) => ['-i', p]);
  const modelArgs = model ? ['--model', model] : [];
  const normalizedEffort = typeof reasoningEffort === 'string'
    ? reasoningEffort.trim().toLowerCase()
    : '';
  const reasoningEffortArgs = normalizedEffort === 'low' || normalizedEffort === 'medium' || normalizedEffort === 'high' || normalizedEffort === 'xhigh' || normalizedEffort === 'max' || normalizedEffort === 'ultra'
    ? ['-c', `model_reasoning_effort="${normalizedEffort}"`]
    : [];
  const serviceTierArgs = priorityServiceTier ? ['-c', 'service_tier="priority"'] : [];
  const sandboxMode = sandbox || (yolo ? 'danger-full-access' : 'workspace-write');
  const sandboxConfigArgs = sandboxMode === 'workspace-write'
    ? ['-c', 'sandbox_workspace_write.network_access=true']
    : [];
  const buildArgs = (resume?: string) => (resume
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', `sandbox_mode=${sandboxMode}`, ...sandboxConfigArgs, ...reasoningEffortArgs, ...serviceTierArgs, ...modelArgs, resume, prompt, ...imageArgs]
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', sandboxMode, ...sandboxConfigArgs, ...reasoningEffortArgs, ...serviceTierArgs, ...modelArgs, prompt, ...imageArgs]);

  let summary = '';
  let sessionId: string | undefined;
  let emittedText = false; // prefix a paragraph break before later turns' text
  let turnCount = 0;
  const emittedTool = new Set<string>();
  const isToolItem = (type: string) => type !== 'agent_message' && type !== 'reasoning';

  if (model) emitCascadeStats(emit, { model });

  // Build a friendly tool_use block from a Codex item.
  const toolUseBlock = (item: any) => {
    if (item.type === 'command_execution') {
      return { type: 'tool_use', id: item.id, name: 'Bash', input: { command: item.command || '' } };
    }
    if (item.type === 'file_change') {
      const file = item.path || item.changes?.[0]?.path || '(files)';
      return { type: 'tool_use', id: item.id, name: 'Edit', input: { file_path: file } };
    }
    return { type: 'tool_use', id: item.id, name: String(item.type), input: {} };
  };

  const emitToolUse = (item: any) => {
    if (!item.id || emittedTool.has(item.id)) return;
    emittedTool.add(item.id);
    emit('text', { message: { content: [toolUseBlock(item)] } });
  };

  const onLine = (line: string) => {
    const ev = JSON.parse(line);
    const item = ev.item;
    // Usage can appear on turn.completed or nested event_msg token_count payloads.
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      turnCount += 1;
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, {
        model,
        numTurns: turnCount,
      }));
    } else if (ev.type === 'event_msg' && ev.payload && typeof ev.payload === 'object') {
      const payload = ev.payload as Record<string, unknown>;
      if (payload.type === 'token_count') {
        const info = (payload.info && typeof payload.info === 'object')
          ? payload.info as Record<string, unknown>
          : payload;
        // Resumed Codex sessions report both cumulative and per-turn usage.
        // Show the latter so Cascade is comparable to an equivalent CLI turn.
        const usage = (info.last_token_usage && typeof info.last_token_usage === 'object')
          ? info.last_token_usage as Record<string, unknown>
          : (info.total_token_usage && typeof info.total_token_usage === 'object')
            ? info.total_token_usage as Record<string, unknown>
            : info;
        emitCascadeStats(emit, statsFromUsageBlob(usage, { model, numTurns: turnCount || undefined }));
      }
    } else if (ev.usage && typeof ev.usage === 'object') {
      emitCascadeStats(emit, statsFromUsageBlob(ev.usage as Record<string, unknown>, { model }));
    }

    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) {
          sessionId = ev.thread_id;
          emit('session', { sessionId });
        }
        break;
      case 'item.started':
        if (item && isToolItem(item.type)) emitToolUse(item);
        break;
      case 'item.completed':
        if (!item) break;
        if (item.type === 'agent_message') {
          summary = item.text || summary;
          const text = item.text || '';
          // Codex reports reasoning separately as `reasoning` items. An
          // `agent_message` is therefore safe to render in chat immediately:
          // it is either an intentional progress update or the final answer,
          // not hidden chain-of-thought. Other adapters must opt in explicitly.
          emit('text', {
            chatVisible: true,
            message: { content: [{ type: 'text', text: (emittedText ? '\n\n' : '') + text }] },
          });
          if (text) emittedText = true;
        } else if (item.type === 'reasoning') {
          emit('text', { message: { content: [{ type: 'thinking', text: item.text || '' }] } });
        } else {
          emitToolUse(item); // ensure the card exists even if 'started' was missed
          const out = item.aggregated_output ?? item.output ?? '';
          const isError = typeof item.exit_code === 'number' && item.exit_code !== 0;
          emit('user', { message: { content: [{ type: 'tool_result', tool_use_id: item.id, content: truncate(String(out), 8000), is_error: isError }] } });
          if (isError) {
            void import('./auto-papercut.mjs')
              .then((mod) => mod.autoPapercut(String(out), { tool: String(item.type || item.name || 'tool') }))
              .catch(() => {});
          }
        }
        break;
      // turn.started handled above via usage path; no content blocks.
    }
  };

  // A resumable session lives in Codex's local rollout store, which Cascade
  // does not control: entries are pruned, absent on another machine, and gone
  // once `codex` state is cleared. Asking to resume one that is gone fails the
  // whole turn with "no rollout found for thread id …" — the agent answers
  // nothing at all, for a reason that has nothing to do with the request. The
  // session is an optimization, so lose it and start a new one instead.
  let stderrText = '';
  const collectStderr = (chunk: string) => { stderrText += chunk; };
  const drive = (attemptArgs: string[]) => driveProcess(
    CODEX_BIN, attemptArgs, cwd, onLine,
    () => summary || '',
    'Codex', runId, emit, env, collectStderr,
  );
  const retryFresh = async () => {
    emitHarness(emit, '\x1b[33m# that session is gone from Codex\'s store — starting a fresh one\x1b[0m\r\n');
    stderrText = '';
    return { summary: await drive(buildArgs(undefined)), sessionId };
  };

  try {
    let summaryText: string;
    try {
      summaryText = await drive(buildArgs(resumeId));
    } catch (error) {
      // The usual shape: codex exits non-zero and driveProcess rejects.
      if (resumeId && isDeadCodexSession(`${stderrText}\n${error instanceof Error ? error.message : String(error)}`)) {
        return await retryFresh();
      }
      throw error;
    }
    // The quieter shape: a zero exit with the complaint only on stderr, which
    // would otherwise complete the turn "successfully" with nothing said.
    if (resumeId && !sessionId && isDeadCodexSession(stderrText)) return await retryFresh();
    return { summary: summaryText, sessionId };
  } finally {
    cleanup();
  }
}

