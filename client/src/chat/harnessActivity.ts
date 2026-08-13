/**
 * Build a unified, harness-agnostic activity model for the chat run panel.
 *
 * Prefers structured ChatBlock[] from the agent adapters; falls back to
 * light parsing of harnessLog (command/cwd/exit, cascade-stats, and a few
 * JSONL shapes) so raw JSON dumps never have to be the primary UI.
 */

import type { ChatBlock, ChatMessage } from './types';

export type ActivityKind = 'thinking' | 'tool' | 'text' | 'system' | 'meta';

export interface ActivityTool {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'done' | 'error';
}

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  /** Primary label (tool name, "Thinking", system tag, …). */
  title: string;
  /** Optional body / preview. */
  text?: string;
  tool?: ActivityTool;
  /** Dim meta lines (cwd, exit, model). */
  meta?: boolean;
}

export interface RateLimitWindow {
  utilization: number;
  resetsAt?: string | null;
}

export interface RunStats {
  model?: string;
  cwd?: string;
  command?: string;
  exitCode?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
  numTurns?: number;
  /** Configured max agent turns (when known). */
  maxTurns?: number;
  durationMs?: number;
  durationApiMs?: number;
  /** Tokens currently filling the model context window. */
  contextUsed?: number;
  /** Model context window size in tokens. */
  contextWindow?: number;
  /** 0–100 context fill percentage when reported by the harness. */
  contextPct?: number;
  maxOutputTokens?: number;
  autoCompactThreshold?: number;
  /** Plan rate-limit snapshot (claude.ai etc.). */
  rateLimitStatus?: string;
  rateLimitType?: string;
  rateLimitUtilization?: number;
  rateLimitResetsAt?: string;
  overageStatus?: string;
  overageInUse?: boolean;
  subscriptionType?: string;
  rateLimitWindows?: Record<string, RateLimitWindow>;
  toolCount: number;
  thinkingChars: number;
  hasThinking: boolean;
  hasTools: boolean;
  hasRaw: boolean;
}

export interface HarnessActivity {
  items: ActivityItem[];
  thinkingText: string;
  stats: RunStats;
  rawLog: string;
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function truncate(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function previewInput(input: unknown): string {
  if (input == null) return '';
  if (typeof input === 'string') return input.trim();
  if (typeof input !== 'object') return String(input);
  const rec = input as Record<string, unknown>;
  // Common tool shapes → one-line human preview
  if (typeof rec.command === 'string') return rec.command;
  if (typeof rec.file_path === 'string') return rec.file_path;
  if (typeof rec.path === 'string') return rec.path;
  if (typeof rec.pattern === 'string') return rec.pattern;
  if (typeof rec.query === 'string') return rec.query;
  if (typeof rec.message === 'string') return rec.message;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function friendlyToolName(name: string): string {
  const n = name.trim();
  if (!n) return 'Tool';
  // cascade helpers
  if (/cascade-chat/i.test(n)) return 'Chat';
  if (/cascade-scratchpad/i.test(n)) return 'Journal';
  if (/cascade-note/i.test(n)) return 'Note';
  // common CLI names
  const map: Record<string, string> = {
    Bash: 'Bash',
    bash: 'Bash',
    Shell: 'Bash',
    Read: 'Read',
    Write: 'Write',
    Edit: 'Edit',
    Grep: 'Search',
    Glob: 'Glob',
    WebSearch: 'Web search',
    WebFetch: 'Web fetch',
    Task: 'Task',
    TodoWrite: 'Todos',
  };
  if (map[n]) return map[n];
  // snake_case → Title Case
  if (n.includes('_') || n.includes('-')) {
    return n
      .split(/[_-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }
  return n;
}

function toolIdFrom(block: ChatBlock, index: number): string {
  if (block.id) return block.id;
  if (block.toolUseId) return block.toolUseId;
  return `tool-${index}`;
}

/** Build timeline items from structured blocks (primary source). */
function itemsFromBlocks(blocks: ChatBlock[] | undefined): {
  items: ActivityItem[];
  thinkingText: string;
  tools: Map<string, ActivityTool>;
} {
  const items: ActivityItem[] = [];
  const tools = new Map<string, ActivityTool>();
  let thinkingText = '';
  let i = 0;

  for (const block of blocks || []) {
    if (block.type === 'thinking') {
      const chunk = block.redacted ? '[redacted]' : (block.text || '');
      if (!chunk) continue;
      thinkingText += chunk;
      const last = items[items.length - 1];
      if (last?.kind === 'thinking') {
        last.text = (last.text || '') + chunk;
      } else {
        items.push({
          id: `thinking-${i++}`,
          kind: 'thinking',
          title: 'Thinking',
          text: chunk,
        });
      }
    } else if (block.type === 'tool_use') {
      const id = toolIdFrom(block, i++);
      const tool: ActivityTool = {
        id,
        name: block.name || 'tool',
        input: block.input,
        status: 'running',
      };
      const existing = tools.get(id);
      if (existing) {
        existing.input = block.input ?? existing.input;
        existing.name = block.name || existing.name;
      } else {
        tools.set(id, tool);
        items.push({
          id: `tool-${id}`,
          kind: 'tool',
          title: friendlyToolName(tool.name),
          text: previewInput(tool.input),
          tool,
        });
      }
    } else if (block.type === 'tool_result') {
      const id = block.toolUseId || toolIdFrom(block, i++);
      const content = typeof block.content === 'string'
        ? block.content
        : block.text || '';
      let tool = tools.get(id);
      if (!tool) {
        tool = {
          id,
          name: 'tool',
          status: block.isError ? 'error' : 'done',
          result: content,
          isError: block.isError,
        };
        tools.set(id, tool);
        items.push({
          id: `tool-${id}`,
          kind: 'tool',
          title: friendlyToolName(tool.name),
          text: previewInput(tool.input),
          tool,
        });
      } else {
        tool.result = content;
        tool.isError = block.isError;
        tool.status = block.isError ? 'error' : 'done';
      }
    } else if (block.type === 'text') {
      // Text usually lives in the chat body; skip huge dumps in the activity rail.
      const t = (block.text || '').trim();
      if (!t || t.length > 800) continue;
      // Only surface short mid-run status lines.
      if (/^(thinking|working|done)\b/i.test(t)) {
        items.push({
          id: `text-${i++}`,
          kind: 'text',
          title: 'Output',
          text: t,
        });
      }
    }
  }

  return { items, thinkingText, tools };
}

interface HarnessMeta {
  model?: string;
  cwd?: string;
  command?: string;
  exitCode?: string;
  stats?: Partial<RunStats>;
  /** Fallback tools scraped from harness when structured blocks lack them. */
  fallbackItems: ActivityItem[];
  fallbackThinking: string;
}

/**
 * Scan harnessLog for meta lines and light JSONL (only when structured
 * blocks are thin). Not a full multi-agent parser — just useful breadcrumbs.
 */
function parseHarnessLog(raw: string, hasStructuredTools: boolean, hasStructuredThinking: boolean): HarnessMeta {
  const plain = stripAnsi(raw || '');
  const lines = plain.split(/\r?\n/);
  const meta: HarnessMeta = { fallbackItems: [], fallbackThinking: '' };
  let inThinking = false;
  let thinkingBuf = '';
  const toolById = new Map<string, ActivityTool>();
  let seq = 0;

  const flushThinking = () => {
    if (!thinkingBuf.trim() || hasStructuredThinking) {
      thinkingBuf = '';
      inThinking = false;
      return;
    }
    meta.fallbackThinking += thinkingBuf;
    thinkingBuf = '';
    inThinking = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Meta comments we emit ourselves
    const claudeHdr = trimmed.match(/^#\s*claude-code\s+(\S+)(?:\s*·\s*(.+))?$/i);
    if (claudeHdr) {
      meta.model = claudeHdr[1];
      if (claudeHdr[2]) meta.cwd = claudeHdr[2].trim();
      continue;
    }
    if (trimmed.startsWith('# cwd ')) {
      meta.cwd = trimmed.slice(6).trim();
      continue;
    }
    if (trimmed.startsWith('# exit ')) {
      meta.exitCode = trimmed.slice(7).trim();
      continue;
    }
    if (trimmed.startsWith('$ ')) {
      meta.command = trimmed.slice(2).trim();
      continue;
    }
    // A provider can be healthy but quiet while it starts a bridge or waits
    // for its first inference byte. These are deliberate runner lifecycle
    // lines, not protocol noise, so retain them as structured activity.
    const lifecycle = trimmed.match(/^#\s*((?:launching\s+.+?\s+harness)|(?:.+?\s+still working\s*·\s*.+))$/i);
    if (lifecycle) {
      meta.fallbackItems.push({
        id: `system-${seq++}`,
        kind: 'system',
        title: 'Harness',
        text: lifecycle[1],
        meta: true,
      });
      continue;
    }
    if (trimmed === '# thinking') {
      flushThinking();
      inThinking = true;
      continue;
    }
    if (trimmed.startsWith('# cascade-stats ')) {
      try {
        const json = JSON.parse(trimmed.slice('# cascade-stats '.length)) as Record<string, unknown>;
        meta.stats = mergeRunStats(meta.stats, parseCascadeStatsJson(json));
      } catch { /* ignore */ }
      continue;
    }
    if (trimmed.startsWith('# result') || trimmed.startsWith('# system') || trimmed.startsWith('# ')) {
      flushThinking();
      continue;
    }

    // Tool markers from Claude harness tee: "▶ Name …" / "✓ tool_result" / "✗ tool_result"
    const toolStart = trimmed.match(/^[▶>]\s+(\S+)(?:\s+(.*))?$/);
    if (toolStart && !hasStructuredTools) {
      flushThinking();
      const name = toolStart[1];
      const id = `harness-tool-${seq++}`;
      const tool: ActivityTool = {
        id,
        name,
        input: toolStart[2] || undefined,
        status: 'running',
      };
      toolById.set(id, tool);
      meta.fallbackItems.push({
        id: `tool-${id}`,
        kind: 'tool',
        title: friendlyToolName(name),
        text: toolStart[2],
        tool,
      });
      continue;
    }
    const toolEnd = trimmed.match(/^[✓✗xX]\s*tool_result/i);
    if (toolEnd && !hasStructuredTools) {
      flushThinking();
      // Attach to last running tool
      for (const tool of [...toolById.values()].reverse()) {
        if (tool.status === 'running') {
          tool.status = /^[✗xX]/.test(trimmed) ? 'error' : 'done';
          tool.isError = tool.status === 'error';
          break;
        }
      }
      continue;
    }

    // JSONL fallback (Codex / Copilot / Grok) when we lack structured blocks
    if (trimmed.startsWith('{') && (!hasStructuredTools || !hasStructuredThinking)) {
      try {
        const ev = JSON.parse(trimmed) as Record<string, unknown>;
        parseJsonlEvent(ev, meta, toolById, hasStructuredTools, hasStructuredThinking, () => seq++);
      } catch {
        if (inThinking && !hasStructuredThinking) thinkingBuf += `${line}\n`;
      }
      continue;
    }

    if (inThinking && !hasStructuredThinking) {
      thinkingBuf += `${line}\n`;
    }
  }
  flushThinking();

  return meta;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

/** Parse one `# cascade-stats` JSON object into partial RunStats. */
function parseCascadeStatsJson(json: Record<string, unknown>): Partial<RunStats> {
  const windowsRaw = json.rateLimitWindows;
  let rateLimitWindows: Record<string, RateLimitWindow> | undefined;
  if (windowsRaw && typeof windowsRaw === 'object') {
    rateLimitWindows = {};
    for (const [key, win] of Object.entries(windowsRaw as Record<string, unknown>)) {
      if (!win || typeof win !== 'object') continue;
      const rec = win as Record<string, unknown>;
      const utilization = num(rec.utilization);
      if (utilization == null) continue;
      rateLimitWindows[key] = {
        utilization,
        resetsAt: rec.resetsAt == null ? null : String(rec.resetsAt),
      };
    }
    if (Object.keys(rateLimitWindows).length === 0) rateLimitWindows = undefined;
  }

  return {
    model: str(json.model),
    inputTokens: num(json.inputTokens ?? json.input_tokens),
    outputTokens: num(json.outputTokens ?? json.output_tokens),
    cacheReadTokens: num(json.cacheReadTokens ?? json.cache_read_input_tokens),
    cacheWriteTokens: num(json.cacheWriteTokens ?? json.cache_creation_input_tokens),
    totalCostUsd: num(json.totalCostUsd ?? json.total_cost_usd),
    numTurns: num(json.numTurns ?? json.num_turns),
    maxTurns: num(json.maxTurns ?? json.max_turns),
    durationMs: num(json.durationMs ?? json.duration_ms),
    durationApiMs: num(json.durationApiMs ?? json.duration_api_ms),
    contextUsed: num(json.contextUsed ?? json.context_used ?? json.totalTokens),
    contextWindow: num(json.contextWindow ?? json.context_window ?? json.maxTokens),
    contextPct: num(json.contextPct ?? json.context_pct ?? json.percentage),
    maxOutputTokens: num(json.maxOutputTokens ?? json.max_output_tokens),
    autoCompactThreshold: num(json.autoCompactThreshold),
    rateLimitStatus: str(json.rateLimitStatus),
    rateLimitType: str(json.rateLimitType),
    rateLimitUtilization: num(json.rateLimitUtilization),
    rateLimitResetsAt: str(json.rateLimitResetsAt),
    overageStatus: str(json.overageStatus),
    overageInUse: bool(json.overageInUse),
    subscriptionType: str(json.subscriptionType),
    rateLimitWindows,
  };
}

/** Merge stats patches; later non-null values win (multiple cascade-stats lines). */
function mergeRunStats(
  base: Partial<RunStats> | undefined,
  patch: Partial<RunStats> | undefined,
): Partial<RunStats> {
  if (!base) return { ...(patch || {}) };
  if (!patch) return { ...base };
  const next: Partial<RunStats> = { ...base };
  for (const [key, value] of Object.entries(patch) as Array<[keyof RunStats, RunStats[keyof RunStats]]>) {
    if (value === undefined || value === null || value === '') continue;
    if (key === 'rateLimitWindows' && base.rateLimitWindows && patch.rateLimitWindows) {
      next.rateLimitWindows = { ...base.rateLimitWindows, ...patch.rateLimitWindows };
      continue;
    }
    (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

function parseJsonlEvent(
  ev: Record<string, unknown>,
  meta: HarnessMeta,
  toolById: Map<string, ActivityTool>,
  hasStructuredTools: boolean,
  hasStructuredThinking: boolean,
  nextSeq: () => number,
) {
  const type = String(ev.type || '');

  // Grok
  if (type === 'thought' && !hasStructuredThinking) {
    meta.fallbackThinking += String(ev.data || '');
    return;
  }

  // Codex
  if (type === 'item.completed' || type === 'item.started') {
    const item = ev.item as Record<string, unknown> | undefined;
    if (!item) return;
    const itemType = String(item.type || '');
    if (itemType === 'reasoning' && !hasStructuredThinking) {
      meta.fallbackThinking += String(item.text || '');
      return;
    }
    if (!hasStructuredTools && itemType && itemType !== 'agent_message' && itemType !== 'reasoning') {
      const id = String(item.id || `codex-${nextSeq()}`);
      if (type === 'item.started' || !toolById.has(id)) {
        const name = itemType === 'command_execution' ? 'Bash'
          : itemType === 'file_change' ? 'Edit'
          : itemType;
        const tool: ActivityTool = {
          id,
          name,
          input: item.command || item.path || item,
          status: type === 'item.completed' ? 'done' : 'running',
        };
        toolById.set(id, tool);
        meta.fallbackItems.push({
          id: `tool-${id}`,
          kind: 'tool',
          title: friendlyToolName(name),
          text: previewInput(tool.input),
          tool,
        });
      }
      if (type === 'item.completed') {
        const tool = toolById.get(id);
        if (tool) {
          tool.result = String(item.aggregated_output ?? item.output ?? '');
          tool.status = typeof item.exit_code === 'number' && item.exit_code !== 0 ? 'error' : 'done';
          tool.isError = tool.status === 'error';
        }
      }
    }
    return;
  }

  // Copilot-ish
  if (!hasStructuredTools && (type === 'tool.execution_start' || type === 'tool.execution_complete')) {
    const data = (ev.data || {}) as Record<string, unknown>;
    const id = String(data.toolCallId || `copilot-${nextSeq()}`);
    if (type === 'tool.execution_start') {
      const tool: ActivityTool = {
        id,
        name: String(data.toolName || 'tool'),
        input: data.arguments,
        status: 'running',
      };
      toolById.set(id, tool);
      meta.fallbackItems.push({
        id: `tool-${id}`,
        kind: 'tool',
        title: friendlyToolName(tool.name),
        text: previewInput(tool.input),
        tool,
      });
    } else {
      const tool = toolById.get(id);
      if (tool) {
        const result = data.result as Record<string, unknown> | undefined;
        tool.result = String(result?.content ?? result?.detailedContent ?? '');
        tool.isError = data.success === false;
        tool.status = tool.isError ? 'error' : 'done';
      }
    }
  }

  // Usage on generic result objects
  if (type === 'result' || type === 'message_end') {
    const usage = (ev.usage || (ev.data as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
    if (usage) {
      meta.stats = {
        ...meta.stats,
        inputTokens: num(usage.input_tokens) ?? meta.stats?.inputTokens,
        outputTokens: num(usage.output_tokens) ?? meta.stats?.outputTokens,
        cacheReadTokens: num(usage.cache_read_input_tokens) ?? meta.stats?.cacheReadTokens,
        cacheWriteTokens: num(usage.cache_creation_input_tokens) ?? meta.stats?.cacheWriteTokens,
      };
    }
    if (num(ev.total_cost_usd) != null) meta.stats = { ...meta.stats, totalCostUsd: num(ev.total_cost_usd) };
    if (num(ev.duration_ms) != null) meta.stats = { ...meta.stats, durationMs: num(ev.duration_ms) };
    if (num(ev.num_turns) != null) meta.stats = { ...meta.stats, numTurns: num(ev.num_turns) };
  }
}

/** Pull only `# cascade-stats` / meta headers — O(tail lines), not full JSONL. */
function extractHarnessMetaFast(raw: string): Pick<HarnessMeta, 'model' | 'cwd' | 'command' | 'exitCode' | 'stats'> {
  const plain = stripAnsi(raw || '');
  // Prefer recent stats; keep a small head slice for model/cwd launch lines.
  const head = plain.length > 3_000 ? plain.slice(0, 3_000) : plain;
  const tail = plain.length > 8_000 ? plain.slice(-8_000) : plain;
  const sample = head === tail ? head : `${head}\n${tail}`;
  const meta: Pick<HarnessMeta, 'model' | 'cwd' | 'command' | 'exitCode' | 'stats'> = {};
  for (const line of sample.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const claudeHdr = trimmed.match(/^#\s*claude-code\s+(\S+)(?:\s*·\s*(.+))?$/i);
    if (claudeHdr) {
      meta.model = claudeHdr[1];
      if (claudeHdr[2]) meta.cwd = claudeHdr[2].trim();
      continue;
    }
    if (trimmed.startsWith('# cwd ')) {
      meta.cwd = trimmed.slice(6).trim();
      continue;
    }
    if (trimmed.startsWith('# exit ')) {
      meta.exitCode = trimmed.slice(7).trim();
      continue;
    }
    if (trimmed.startsWith('$ ') && !meta.command) {
      meta.command = trimmed.slice(2).trim();
      continue;
    }
    const statsIdx = trimmed.indexOf('# cascade-stats ');
    if (statsIdx >= 0) {
      try {
        const json = JSON.parse(trimmed.slice(statsIdx + '# cascade-stats '.length)) as Record<string, unknown>;
        meta.stats = mergeRunStats(meta.stats, parseCascadeStatsJson(json));
      } catch { /* ignore */ }
    }
  }
  return meta;
}

// Cache last activity per message id to skip re-parse when fingerprints match.
const activityCache = new Map<string, { fp: string; activity: HarnessActivity }>();
const ACTIVITY_CACHE_MAX = 40;

function activityFingerprint(message: ChatMessage): string {
  const blocks = message.blocks;
  const lastBlock = blocks && blocks.length ? blocks[blocks.length - 1] : null;
  const lastText = lastBlock?.text?.length ?? 0;
  const lastContent = typeof lastBlock?.content === 'string' ? lastBlock.content.length : 0;
  return [
    message.status || '',
    message.body?.length ?? 0,
    blocks?.length ?? 0,
    lastText,
    lastContent,
    message.harnessLog?.length ?? 0,
    // Sample end of harness so stats-only growth still invalidates.
    (message.harnessLog || '').slice(-120),
  ].join('|');
}

export function buildHarnessActivity(message: ChatMessage): HarnessActivity {
  const msgId = message.id || '';
  const fp = activityFingerprint(message);
  if (msgId) {
    const hit = activityCache.get(msgId);
    if (hit && hit.fp === fp) return hit.activity;
  }

  const rawLog = message.harnessLog || '';
  const fromBlocks = itemsFromBlocks(message.blocks);
  const hasStructuredTools = fromBlocks.tools.size > 0;
  const hasStructuredThinking = fromBlocks.thinkingText.trim().length > 0;
  // When structured blocks already carry thinking+tools (Claude stream path),
  // skip full JSONL/tool scrape — only harvest cascade-stats for header chips.
  // Otherwise parse a bounded head+tail of the harness transcript.
  const structuredEnough = hasStructuredThinking || hasStructuredTools;
  const harness: HarnessMeta = structuredEnough
    ? { ...extractHarnessMetaFast(rawLog), fallbackItems: [], fallbackThinking: '' }
    : (() => {
        const parseLog = rawLog.length > 48_000
          ? `${rawLog.slice(0, 3_000)}\n# older harness output omitted from structured parser\n${rawLog.slice(-40_000)}`
          : rawLog;
        return parseHarnessLog(parseLog, hasStructuredTools, hasStructuredThinking);
      })();

  let items = fromBlocks.items;
  let thinkingText = fromBlocks.thinkingText;

  if (!hasStructuredThinking && harness.fallbackThinking.trim()) {
    thinkingText = harness.fallbackThinking;
    items = [
      {
        id: 'thinking-fallback',
        kind: 'thinking',
        title: 'Thinking',
        text: harness.fallbackThinking,
      },
      ...items,
    ];
  }
  if (!hasStructuredTools && harness.fallbackItems.length > 0) {
    // Interleave tools after thinking if we only have fallback tools
    const thinkingItems = items.filter((item) => item.kind === 'thinking');
    const rest = items.filter((item) => item.kind !== 'thinking');
    items = [...thinkingItems, ...harness.fallbackItems, ...rest];
  }

  // Mark still-running tools when the overall run is finished
  if (message.status !== 'running') {
    for (const item of items) {
      if (item.tool?.status === 'running') {
        item.tool.status = item.tool.isError ? 'error' : 'done';
      }
    }
  }

  const toolCount = items.filter((item) => item.kind === 'tool').length;
  const hs = harness.stats || {};
  // Derive context % when harness only gave used/window.
  let contextUsed = hs.contextUsed;
  let contextWindow = hs.contextWindow;
  let contextPct = hs.contextPct;
  if (contextUsed == null && (hs.inputTokens != null || hs.cacheReadTokens != null)) {
    contextUsed = (hs.inputTokens || 0) + (hs.cacheReadTokens || 0);
  }
  if (contextPct == null && contextUsed != null && contextWindow != null && contextWindow > 0) {
    contextPct = Math.min(100, (contextUsed / contextWindow) * 100);
  }

  const stats: RunStats = {
    model: harness.model || hs.model,
    cwd: harness.cwd,
    command: harness.command,
    exitCode: harness.exitCode,
    inputTokens: hs.inputTokens,
    outputTokens: hs.outputTokens,
    cacheReadTokens: hs.cacheReadTokens,
    cacheWriteTokens: hs.cacheWriteTokens,
    totalCostUsd: hs.totalCostUsd,
    numTurns: hs.numTurns,
    maxTurns: hs.maxTurns,
    durationMs: hs.durationMs,
    durationApiMs: hs.durationApiMs,
    contextUsed,
    contextWindow,
    contextPct,
    maxOutputTokens: hs.maxOutputTokens,
    autoCompactThreshold: hs.autoCompactThreshold,
    rateLimitStatus: hs.rateLimitStatus,
    rateLimitType: hs.rateLimitType,
    rateLimitUtilization: hs.rateLimitUtilization,
    rateLimitResetsAt: hs.rateLimitResetsAt,
    overageStatus: hs.overageStatus,
    overageInUse: hs.overageInUse,
    subscriptionType: hs.subscriptionType,
    rateLimitWindows: hs.rateLimitWindows,
    toolCount,
    thinkingChars: thinkingText.length,
    hasThinking: thinkingText.trim().length > 0,
    hasTools: toolCount > 0,
    hasRaw: rawLog.trim().length > 0,
  };

  const activity: HarnessActivity = {
    items,
    thinkingText: thinkingText.trim(),
    stats,
    rawLog,
  };
  if (msgId) {
    activityCache.set(msgId, { fp, activity });
    if (activityCache.size > ACTIVITY_CACHE_MAX) {
      const oldest = activityCache.keys().next().value;
      if (oldest) activityCache.delete(oldest);
    }
  }
  return activity;
}

/** True when the message has activity worth showing in the run panel. */
export function hasRunActivity(message: ChatMessage): boolean {
  if (message.status === 'running') return true;
  if (message.harnessLog?.trim()) return true;
  if (message.hasHarness) return true;
  const blocks = message.blocks || [];
  if (blocks.some((b) => b.type === 'thinking' || b.type === 'tool_use' || b.type === 'tool_result')) {
    return true;
  }
  // Legacy: long text blocks used as "trace" before harnessLog
  const bodyLen = (message.body || '').trim().length;
  const traceLen = blocks
    .filter((b) => b.type === 'thinking' || b.type === 'text')
    .reduce((n, b) => n + (b.text?.length || 0), 0);
  return traceLen > bodyLen + 24;
}

export function formatTokenCount(n: number | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

export function formatCostUsd(n: number | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(3)}`;
}

export function formatDurationMs(ms: number | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function formatPct(n: number | undefined, digits = 0): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  return `${n.toFixed(digits)}%`;
}

/** Human label for rate-limit window keys. */
export function formatRateLimitType(type: string | undefined): string {
  if (!type) return 'limit';
  const map: Record<string, string> = {
    five_hour: '5h',
    seven_day: '7d',
    seven_day_opus: '7d opus',
    seven_day_sonnet: '7d sonnet',
    seven_day_oauth_apps: '7d apps',
    overage: 'overage',
  };
  return map[type] || type.replace(/_/g, ' ');
}

const RESET_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  month: 'short',
  day: 'numeric',
});

export function formatResetsAt(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return RESET_TIME_FORMATTER.format(d);
  } catch {
    return d.toISOString();
  }
}

/** Context window line: `ctx 42k/200k (21%)`. */
export function formatContextLine(stats: RunStats): string | null {
  const used = formatTokenCount(stats.contextUsed);
  const max = formatTokenCount(stats.contextWindow);
  const pct = formatPct(stats.contextPct, stats.contextPct != null && stats.contextPct < 10 ? 1 : 0);
  if (used && max) return `ctx ${used}/${max}${pct ? ` (${pct})` : ''}`;
  if (pct && max) return `ctx ${pct} of ${max}`;
  if (pct) return `ctx ${pct}`;
  if (used) return `ctx ${used}`;
  if (max) return `ctx max ${max}`;
  return null;
}

/** Turn length line: `turns 4/30` or `turns 4`. */
export function formatTurnsLine(stats: RunStats): string | null {
  if (stats.numTurns == null && stats.maxTurns == null) return null;
  if (stats.numTurns != null && stats.maxTurns != null) {
    return `turns ${stats.numTurns}/${stats.maxTurns}`;
  }
  if (stats.numTurns != null) return `turns ${stats.numTurns}`;
  return `max turns ${stats.maxTurns}`;
}

/** Primary usage-limit line when any rate-limit data exists. */
export function formatRateLimitLine(stats: RunStats): string | null {
  const parts: string[] = [];
  if (stats.rateLimitUtilization != null || stats.rateLimitType) {
    const label = formatRateLimitType(stats.rateLimitType);
    const pct = formatPct(stats.rateLimitUtilization, 0);
    parts.push(pct ? `${label} ${pct}` : label);
  }
  const resets = formatResetsAt(stats.rateLimitResetsAt);
  if (resets) parts.push(`resets ${resets}`);
  if (stats.rateLimitStatus && stats.rateLimitStatus !== 'allowed') {
    parts.push(stats.rateLimitStatus.replace(/_/g, ' '));
  }
  if (stats.overageInUse) parts.push('overage');
  else if (stats.overageStatus && stats.overageStatus !== 'allowed') {
    parts.push(`overage ${stats.overageStatus.replace(/_/g, ' ')}`);
  }
  if (stats.subscriptionType) parts.push(stats.subscriptionType);
  if (parts.length === 0 && stats.rateLimitWindows) {
    const entries = Object.entries(stats.rateLimitWindows);
    if (entries.length) {
      const [type, win] = entries.sort((a, b) => b[1].utilization - a[1].utilization)[0];
      parts.push(`${formatRateLimitType(type)} ${formatPct(win.utilization, 0)}`);
      const r = formatResetsAt(win.resetsAt);
      if (r) parts.push(`resets ${r}`);
    }
  }
  return parts.length ? `limit ${parts.join(' · ')}` : null;
}

/** Extra rate-limit window lines when multiple windows are present. */
export function formatRateLimitWindowLines(stats: RunStats): string[] {
  if (!stats.rateLimitWindows) return [];
  const entries = Object.entries(stats.rateLimitWindows);
  if (entries.length <= 1) return [];
  return entries
    .sort((a, b) => b[1].utilization - a[1].utilization)
    .map(([type, win]) => {
      const bits = [`${formatRateLimitType(type)} ${formatPct(win.utilization, 0) || '?'}`];
      const r = formatResetsAt(win.resetsAt);
      if (r) bits.push(`resets ${r}`);
      return `limit ${bits.join(' · ')}`;
    });
}

function compactLiveDetail(text: string | undefined, max = 88): string {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

function recentLiveSnippet(text: string | undefined, max = 88): string {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  if (collapsed.length <= max) return collapsed;
  return `…${collapsed.slice(-(max - 1))}`;
}

export type LiveActivityHeadline = {
  verb: string;
  detail: string;
};

/** Compact live header: current tool/thought plus the argument or latest snippet. */
export function liveActivityHeadline(activity: HarnessActivity): LiveActivityHeadline {
  const items = [...activity.items].reverse();
  const runningTool = items.find((item) => item.kind === 'tool' && item.tool?.status === 'running');
  const lastToolOrThought = items.find((item) => item.kind === 'tool' || item.kind === 'thinking');
  const last = runningTool || lastToolOrThought;
  if (last?.kind === 'tool') {
    return { verb: last.title, detail: compactLiveDetail(last.text) };
  }
  if (last?.kind === 'thinking') {
    return { verb: 'thinking', detail: recentLiveSnippet(last.text) };
  }
  const lastSystem = items.find((item) => item.kind === 'system' && item.text);
  if (lastSystem?.text) {
    return { verb: 'Harness', detail: compactLiveDetail(lastSystem.text) };
  }
  if (activity.stats.command) {
    return { verb: 'Bash', detail: compactLiveDetail(activity.stats.command) };
  }
  return { verb: 'working', detail: '' };
}

export function summarizeActivity(activity: HarnessActivity, isRunning: boolean): string {
  const parts: string[] = [];
  if (isRunning) {
    const live = liveActivityHeadline(activity);
    return live.detail ? `${live.verb} ${live.detail}` : live.verb;
  } else if (activity.stats.toolCount > 0) {
    parts.push(`${activity.stats.toolCount} tool${activity.stats.toolCount === 1 ? '' : 's'}`);
  }
  if (activity.stats.hasThinking && !isRunning) {
    const chars = activity.stats.thinkingChars;
    parts.push(chars >= 1000 ? `thought ${formatTokenCount(chars)}` : 'thought');
  }
  // Token / context / cost live in header chips when present; keep summary short.
  if (!formatTokenCount(activity.stats.inputTokens) && !formatTokenCount(activity.stats.outputTokens)) {
    const ctx = formatContextLine(activity.stats);
    if (ctx) parts.push(ctx);
  }
  const turns = formatTurnsLine(activity.stats);
  if (turns) parts.push(turns);
  const lim = formatRateLimitLine(activity.stats);
  if (lim && parts.length < 4) parts.push(lim.replace(/^limit /, ''));
  const dur = formatDurationMs(activity.stats.durationMs);
  if (dur) parts.push(dur);
  if (activity.stats.model && parts.length < 3) parts.push(activity.stats.model);
  return parts.join(' · ') || (isRunning ? 'Working…' : 'Activity');
}

export type HeaderStatChip = {
  id: string;
  label: string;
  title?: string;
  /** Highlight when context is getting full or rate limit is hot. */
  warn?: boolean;
};

/**
 * Compact chips for the click-to-expand harness header.
 * Prefer token + context + cost so usage is visible without opening the panel.
 */
export function buildHeaderStatChips(stats: RunStats): HeaderStatChip[] {
  const chips: HeaderStatChip[] = [];

  const tokIn = formatTokenCount(stats.inputTokens);
  const tokOut = formatTokenCount(stats.outputTokens);
  if (tokIn || tokOut) {
    chips.push({
      id: 'tok',
      label: `${tokIn || '—'}→${tokOut || '—'} tok`,
      title: [
        stats.inputTokens != null ? `in ${stats.inputTokens.toLocaleString()}` : null,
        stats.outputTokens != null ? `out ${stats.outputTokens.toLocaleString()}` : null,
        stats.cacheReadTokens != null && stats.cacheReadTokens > 0
          ? `cache read ${stats.cacheReadTokens.toLocaleString()}`
          : null,
      ].filter(Boolean).join(' · ') || 'tokens',
    });
  }

  const ctx = formatContextLine(stats);
  if (ctx) {
    chips.push({
      id: 'ctx',
      label: ctx,
      title: stats.contextUsed != null && stats.contextWindow != null
        ? `context ${stats.contextUsed.toLocaleString()} / ${stats.contextWindow.toLocaleString()}`
        : 'context window',
      warn: stats.contextPct != null && stats.contextPct >= 80,
    });
  }

  const cost = formatCostUsd(stats.totalCostUsd);
  if (cost) {
    chips.push({
      id: 'cost',
      label: cost,
      title: stats.totalCostUsd != null ? `$${stats.totalCostUsd.toFixed(6)}` : 'cost',
    });
  }

  const turns = formatTurnsLine(stats);
  if (turns) {
    chips.push({
      id: 'turns',
      label: turns,
      title: 'agent turns',
    });
  }

  if (stats.cacheReadTokens != null && stats.cacheReadTokens > 0 && !tokIn && !tokOut) {
    const cr = formatTokenCount(stats.cacheReadTokens);
    if (cr) chips.push({ id: 'cache', label: `cache ${cr}`, title: 'cache read tokens' });
  }

  const lim = formatRateLimitLine(stats);
  if (lim && chips.length < 5) {
    chips.push({
      id: 'limit',
      label: lim.replace(/^limit /, ''),
      title: 'rate limit',
      warn: (stats.rateLimitUtilization != null && stats.rateLimitUtilization >= 80)
        || (stats.rateLimitStatus != null && stats.rateLimitStatus !== 'allowed'),
    });
  }

  return chips;
}

export function hasUsageStats(stats: RunStats): boolean {
  return Boolean(
    stats.inputTokens != null
    || stats.outputTokens != null
    || stats.contextUsed != null
    || stats.contextWindow != null
    || stats.contextPct != null
    || stats.totalCostUsd != null
    || stats.numTurns != null,
  );
}

export function toolResultPreview(result: string | undefined, max = 600): string {
  if (!result) return '';
  return truncate(stripAnsi(result).trim(), max);
}
