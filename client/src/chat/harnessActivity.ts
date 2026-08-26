/**
 * Build a unified, harness-agnostic activity model for the chat run panel.
 *
 * Prefers structured ChatBlock[] from the agent adapters; falls back to
 * light parsing of harnessLog (command/cwd/exit, cascade-stats, and a few
 * JSONL shapes) so raw JSON dumps never have to be the primary UI.
 */

import type { ChatMessage } from './types';
import type { HarnessActivity, RunStats } from './harnessActivityTypes';
import { itemsFromBlocks, parseHarnessLog, extractHarnessMetaFast, type HarnessMeta } from './harnessActivityParsers';


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

