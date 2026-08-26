/** Pure presentation formatters for activity stats and live summaries. */
import { stripAnsi, truncate } from './harnessActivityParsers';
import type { HarnessActivity, RunStats } from './harnessActivityTypes';

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

/** System/user prompt blobs must not leak into the live header or thinking well. */
export function isHarnessPromptDump(text: string | undefined): boolean {
  const sample = String(text || '').slice(0, 4000);
  return /You are grok\b|\[Context:|Agent memory \(vault\)|Your POLICIES note:|Shared room (?:delta|state)|cascade-chat history --around-message-id/i.test(sample);
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
    if (isHarnessPromptDump(last.text)) return { verb: 'thinking', detail: '' };
    return { verb: 'thinking', detail: compactLiveDetail(last.text, 56) };
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
