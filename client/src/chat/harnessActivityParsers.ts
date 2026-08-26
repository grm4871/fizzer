/**
 * Loss-tolerant harness parsers. Structured blocks are authoritative; log
 * parsing only recognizes bounded lifecycle/meta/JSONL shapes and intentionally
 * ignores unknown protocol records.
 */
import type { ChatBlock } from './types';
import type { ActivityItem, ActivityTool, RunStats, RateLimitWindow } from './harnessActivityTypes';

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

export function truncate(text: string, max = 4000): string {
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
export function itemsFromBlocks(blocks: ChatBlock[] | undefined): {
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

export interface HarnessMeta {
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
export function parseHarnessLog(raw: string, hasStructuredTools: boolean, hasStructuredThinking: boolean): HarnessMeta {
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
export function extractHarnessMetaFast(raw: string): Pick<HarnessMeta, 'model' | 'cwd' | 'command' | 'exitCode' | 'stats'> {
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
