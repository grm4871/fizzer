/** Shared activity model; parser and presentation modules depend on these contracts. */

export type ActivityKind = 'thinking' | 'tool' | 'text' | 'system' | 'meta';

export interface ActivityTool {
  id: string;
  name: string;
  input?: unknown;
  result?: string;
  isError?: boolean;
  /** running → done/error as result blocks arrive; finished runs close running tools. */
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
