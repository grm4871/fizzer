/**
 * Build a unified, harness-agnostic activity model for the chat run panel.
 *
 * Prefers structured ChatBlock[] from the agent adapters; falls back to
 * light parsing of harnessLog (command/cwd/exit, cascade-stats, and a few
 * JSONL shapes) so raw JSON dumps never have to be the primary UI.
 */

import type { ChatBlock, ChatMessage } from '../components/ChatView';

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
  durationMs?: number;
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
  if (/cascade-note/i.test(n)) return 'Note';
  if (/cascade-memory/i.test(n)) return 'Memory';
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
    if (trimmed === '# thinking') {
      flushThinking();
      inThinking = true;
      continue;
    }
    if (trimmed.startsWith('# cascade-stats ')) {
      try {
        const json = JSON.parse(trimmed.slice('# cascade-stats '.length));
        meta.stats = {
          inputTokens: num(json.inputTokens ?? json.input_tokens),
          outputTokens: num(json.outputTokens ?? json.output_tokens),
          cacheReadTokens: num(json.cacheReadTokens ?? json.cache_read_input_tokens),
          cacheWriteTokens: num(json.cacheWriteTokens ?? json.cache_creation_input_tokens),
          totalCostUsd: num(json.totalCostUsd ?? json.total_cost_usd),
          numTurns: num(json.numTurns ?? json.num_turns),
          durationMs: num(json.durationMs ?? json.duration_ms),
          model: typeof json.model === 'string' ? json.model : undefined,
        };
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

export function buildHarnessActivity(message: ChatMessage): HarnessActivity {
  const rawLog = message.harnessLog || '';
  const fromBlocks = itemsFromBlocks(message.blocks);
  const hasStructuredTools = fromBlocks.tools.size > 0;
  const hasStructuredThinking = fromBlocks.thinkingText.trim().length > 0;
  const harness = parseHarnessLog(rawLog, hasStructuredTools, hasStructuredThinking);

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
  const stats: RunStats = {
    model: harness.model || harness.stats?.model,
    cwd: harness.cwd,
    command: harness.command,
    exitCode: harness.exitCode,
    inputTokens: harness.stats?.inputTokens,
    outputTokens: harness.stats?.outputTokens,
    cacheReadTokens: harness.stats?.cacheReadTokens,
    cacheWriteTokens: harness.stats?.cacheWriteTokens,
    totalCostUsd: harness.stats?.totalCostUsd,
    numTurns: harness.stats?.numTurns,
    durationMs: harness.stats?.durationMs,
    toolCount,
    thinkingChars: thinkingText.length,
    hasThinking: thinkingText.trim().length > 0,
    hasTools: toolCount > 0,
    hasRaw: rawLog.trim().length > 0,
  };

  return {
    items,
    thinkingText: thinkingText.trim(),
    stats,
    rawLog,
  };
}

/** True when the message has activity worth showing in the run panel. */
export function hasRunActivity(message: ChatMessage): boolean {
  if (message.status === 'running') return true;
  if (message.harnessLog?.trim()) return true;
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

export function summarizeActivity(activity: HarnessActivity, isRunning: boolean): string {
  const parts: string[] = [];
  if (isRunning) {
    const last = [...activity.items].reverse().find((item) => item.kind === 'tool' || item.kind === 'thinking');
    if (last?.kind === 'tool') parts.push(last.title);
    else if (last?.kind === 'thinking') parts.push('thinking');
    else parts.push('working');
  } else if (activity.stats.toolCount > 0) {
    parts.push(`${activity.stats.toolCount} tool${activity.stats.toolCount === 1 ? '' : 's'}`);
  }
  if (activity.stats.hasThinking && !isRunning) {
    const chars = activity.stats.thinkingChars;
    parts.push(chars >= 1000 ? `thought ${formatTokenCount(chars)}` : 'thought');
  }
  const tokIn = formatTokenCount(activity.stats.inputTokens);
  const tokOut = formatTokenCount(activity.stats.outputTokens);
  if (tokIn || tokOut) {
    parts.push([tokIn, tokOut].filter(Boolean).join('→') + ' tok');
  }
  const cost = formatCostUsd(activity.stats.totalCostUsd);
  if (cost) parts.push(cost);
  const dur = formatDurationMs(activity.stats.durationMs);
  if (dur) parts.push(dur);
  if (activity.stats.model && parts.length < 3) parts.push(activity.stats.model);
  return parts.join(' · ') || (isRunning ? 'Working…' : 'Activity');
}

export function toolResultPreview(result: string | undefined, max = 600): string {
  if (!result) return '';
  return truncate(stripAnsi(result).trim(), max);
}
