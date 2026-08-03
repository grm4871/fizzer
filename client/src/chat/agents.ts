/**
 * Client-side agent catalog and chat prompt formatting.
 * Keep in sync with server AgentId / CLI agent lists where applicable.
 */

export type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'akron-grok' | 'omp';

export const CHAT_AGENTS: Array<{ id: AgentId; label: string }> = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'akron-grok', label: 'Akron --grok' },
  { id: 'omp', label: 'OMP' },
];

/** Preserve authoritative in-memory members across a transient hydration error. */
export function agentsAfterLoadFailure<T>(cached?: T[], legacy?: T[]): T[] {
  return cached ?? legacy ?? [];
}

/**
 * Curated model presets shown in the agent picker.
 * Prefer ids known to work with the local CLI; dead ids (e.g. retired grok-build)
 * are intentionally omitted. Desktop may report additional live models via
 * `/api/me/desktop-runner` which the UI merges in.
 */
export const CHAT_AGENT_MODEL_PRESETS: Record<AgentId, { id: string; label: string }[]> = {
  'claude-code': [
    // Most capable first. Do not add speculative ids (e.g. a guessed
    // "claude-opus-5"): the CLI resolves an unknown alias to its default
    // instead of erroring, so the picker silently lies about what ran.
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  ],
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
    { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  ],
  grok: [
    { id: 'grok-4.5', label: 'Grok 4.5' },
    { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' },
  ],
  // agentapi --model= only accepts flash_lite|flash|pro; desktop merges the full
  // live catalog from GetAvailableModels (+ cascade config) on top.
  antigravity: [
    { id: 'flash_lite', label: 'Gemini Flash Lite (tier)' },
    { id: 'flash', label: 'Gemini Flash (tier)' },
    { id: 'pro', label: 'Gemini Pro (tier)' },
    { id: 'gemini-3.5-flash-extra-low', label: 'Gemini 3.5 Flash (Low)' },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Medium)' },
    { id: 'gemini-3-flash-agent', label: 'Gemini 3.5 Flash (High)' },
    { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite' },
    { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' },
    { id: 'gemini-3.1-pro-low', label: 'Gemini 3.1 Pro (Low)' },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
  copilot: [
    { id: 'auto', label: 'Auto' },
    { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
    { id: 'gpt-5.2', label: 'GPT-5.2' },
  ],
  hermes: [],
  'akron-grok': [],
  omp: [
    { id: 'openai-codex/gpt-5.6-sol', label: 'Codex · GPT-5.6 Sol' },
    { id: 'openai-codex/gpt-5.6-terra', label: 'Codex · GPT-5.6 Terra' },
    { id: 'openai-codex/gpt-5.6-luna', label: 'Codex · GPT-5.6 Luna' },
    { id: 'openai-codex/gpt-5.5', label: 'Codex · GPT-5.5' },
    { id: 'openai-codex/gpt-5.4', label: 'Codex · GPT-5.4' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Code · Sonnet 5' },
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Code · Opus 4.8' },
    { id: 'anthropic/claude-fable-5', label: 'Claude Code · Fable 5' },
    { id: 'anthropic/claude-haiku-4-5', label: 'Claude Code · Haiku 4.5' },
    { id: 'google-antigravity/gemini-3.5-flash', label: 'Antigravity · Gemini 3.5 Flash' },
    { id: 'google-antigravity/gemini-3.1-pro', label: 'Antigravity · Gemini 3.1 Pro' },
    { id: 'google-antigravity/gemini-3-flash', label: 'Antigravity · Gemini 3 Flash' },
    { id: 'google-antigravity/claude-sonnet-4-6', label: 'Antigravity · Claude Sonnet 4.6' },
    { id: 'google-antigravity/claude-opus-4-6', label: 'Antigravity · Claude Opus 4.6' },
    { id: 'xai-oauth/grok-build', label: 'Grok · Build' },
    { id: 'xai-oauth/grok-build-0.1', label: 'Grok · Build 0.1' },
    { id: 'xai-oauth/grok-4.3', label: 'Grok · 4.3' },
    { id: 'xai-oauth/grok-4.5', label: 'Grok · 4.5' },
    { id: 'xai-oauth/grok-4.20-multi-agent-0309', label: 'Grok · 4.20 Multi-Agent' },
    { id: 'xai-oauth/grok-4.20-0309-reasoning', label: 'Grok · 4.20 Reasoning' },
    { id: 'xai-oauth/grok-4.20-0309-non-reasoning', label: 'Grok · 4.20 Non-Reasoning' },
    { id: 'xai-oauth/grok-composer-2.5-fast', label: 'Grok · Composer 2.5 Fast' },
  ],
};

/**
 * Merge curated presets with live models reported by the desktop runner.
 * Live entries may be bare ids or `id|label`. For antigravity, live catalog
 * wins on label collisions (presets are only fallbacks / agentapi tiers).
 */
export function mergeAgentModelPresets(
  agentId: AgentId,
  liveModels: string[] | null | undefined,
): { id: string; label: string }[] {
  const presets = [...(CHAT_AGENT_MODEL_PRESETS[agentId] ?? [])];
  if (!liveModels?.length) return presets;

  const parsedLive: { id: string; label: string }[] = [];
  for (const item of liveModels) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.includes('|')) {
      const [idPart, ...rest] = trimmed.split('|');
      const id = idPart.trim();
      const label = rest.join('|').trim() || id;
      if (id) parsedLive.push({ id, label });
    } else {
      parsedLive.push({ id: trimmed, label: trimmed });
    }
  }
  if (!parsedLive.length) return presets;

  // Antigravity: prefer full live list; keep agentapi tiers pinned at top if present.
  if (agentId === 'antigravity') {
    const tierIds = new Set(['flash_lite', 'flash', 'pro']);
    const tiers = presets.filter((p) => tierIds.has(p.id));
    const byId = new Map<string, { id: string; label: string }>();
    for (const t of tiers) byId.set(t.id, t);
    for (const live of parsedLive) {
      // Prefer human slug ids over enum-only when both exist later — last write
      // for same id updates label if richer.
      const prev = byId.get(live.id);
      if (prev && prev.label.length >= live.label.length && prev.label !== live.id) continue;
      byId.set(live.id, live);
    }
    // Also fold preset non-tier entries not returned live (offline fallback).
    for (const p of presets) {
      if (!byId.has(p.id)) byId.set(p.id, p);
    }
    // Dedupe by label only when ids differ and one is a raw enum — keep slug.
    const out: { id: string; label: string }[] = [];
    const usedLabels = new Set<string>();
    const preferred = [...byId.values()].sort((a, b) => {
      const aTier = tierIds.has(a.id) ? 0 : 1;
      const bTier = tierIds.has(b.id) ? 0 : 1;
      if (aTier !== bTier) return aTier - bTier;
      return a.label.localeCompare(b.label);
    });
    for (const m of preferred) {
      const lk = m.label.toLowerCase();
      if (usedLabels.has(lk)) {
        // Prefer non-MODEL_ / non-tier human slug when labels collide.
        const existingIdx = out.findIndex((x) => x.label.toLowerCase() === lk);
        if (existingIdx < 0) continue;
        const existing = out[existingIdx];
        const existingIsEnum = /^MODEL_/i.test(existing.id) || tierIds.has(existing.id);
        const nextIsSlug = !/^MODEL_/i.test(m.id) && !tierIds.has(m.id);
        if (existingIsEnum && nextIsSlug) out[existingIdx] = m;
        continue;
      }
      usedLabels.add(lk);
      out.push(m);
    }
    return out;
  }

  const base = [...presets];
  const seenIds = new Set(base.map((m) => m.id));
  const seenLabels = new Set(base.map((m) => m.label.toLowerCase()));
  for (const live of parsedLive) {
    if (seenIds.has(live.id) || seenLabels.has(live.label.toLowerCase())) continue;
    seenIds.add(live.id);
    seenLabels.add(live.label.toLowerCase());
    base.push(live);
  }
  return base;
}

export function agentLabel(agentId: string) {
  return CHAT_AGENTS.find((agent) => agent.id === agentId)?.label ?? agentId;
}

/** Empty / vault-root aliases → '' so the server treats it as the vault root. */
export function normalizeChatCwd(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^(vault\s*root|root|\.\/?)$/i.test(trimmed)) return '';
  return trimmed;
}

export type AgentPromptRegistration = {
  agentId: string;
  mention: string;
  displayName: string;
  contextPrompt: string;
  orchestrator?: boolean;
};

/** True only when the request cannot stand on its own after reply/batch folding. */
export function needsRecentChatContext(request: string): boolean {
  const text = String(request || '').trim();
  if (!text) return false;
  // Quoted replies and folded same-author batches already carry their referent.
  if (/^Replying to .+?:\s*>/is.test(text)) return false;
  return /^(?:also\b|continue\b|go ahead\b|same\b|again\b)|\b(?:as (?:i|we|you) said|earlier|above|the previous|that (?:one|thing|request)|this (?:one|thing|request)|do (?:this|that|it)|fix (?:this|that|it)|make (?:this|that|it)|try again|keep going|pick up where)\b/i.test(text);
}

/** Live-vault operations need Cascade's helper contract; ordinary repo work does not. */
export function needsCascadeWorkspaceContext(request: string): boolean {
  const text = String(request || '').trim();
  return /\bcascade-(?:note|chat|scratchpad)\b|\b(?:live|vault)\s+(?:note|folder|kanban|board|doc(?:umentation)?|workspace)\b|\b(?:note|folder|kanban|board|doc(?:umentation)?)\s+(?:for|in|inside|within)\s+cascade\b|\bthis cascade folder\b/i.test(text);
}

/**
 * Build the system-ish header the agent receives for a channel reply.
 * When `continuation` is true the CLI session already holds earlier turns —
 * use a short header and skip re-stating helper docs / channel notes.
 */
export function formatAgentChatPrompt(
  channelName: string,
  registration: AgentPromptRegistration,
  request: string,
  triggeringAuthor: string,
  continuation = false,
) {
  const selfAgent = CHAT_AGENTS.find((candidate) => candidate.id === registration.agentId);
  const selfHandle = registration.mention || registration.agentId;
  const selfName = registration.displayName || selfAgent?.label || registration.agentId;
  const nativeScratchpad = registration.agentId === 'akron-grok';
  const compactNativeCli = registration.agentId === 'hermes' || registration.agentId === 'omp';
  const coordinatorGuidance = registration.orchestrator
    ? ' You are this channel’s coordinator. Handle simple requests directly with no delegation hop. When the user proposes an actionable change or says something should work differently, treat that as authorization to implement it within the stated scope unless they clearly ask only to discuss or explain. Do not stop at agreement, praise, or a proposal: make the change, verify it, and report the result. For genuinely parallel or long work, use `cascade-chat members`, then `cascade-chat mission start --title "..." --objective "..."` and one or more `cascade-chat mission delegate --mission <id> --to @agent --task "..." --message "..."`. Add `--after <task-id,...>` for dependencies, `--priority N` for ready-work ordering, and `--effort low|medium|high|xhigh|max|ultra` for supported Codex/Claude workers that need a non-default reasoning level. Cascade dispatches dependency-ready work automatically and limits each agent to one active task. Stay responsive to the user while workers run; steering should revise or cancel pending work without needless interruption. Reconcile worker evidence and finish with `cascade-chat mission finish --mission <id> --summary "..."`. Do not create a mission for routine conversation.'
    : '';

  // Keep persistence available without turning every task into extra tool turns.
  // Cold-start injection supplies the fuller policy only when a new session needs it.
  const scratchpadGuidance = nativeScratchpad
    ? ' Use the harness `scratchpad` only for a durable root cause, decision, or dead end; skip routine progress.'
    : ' Use `cascade-scratchpad` only for a durable root cause, decision, or dead end that would otherwise be re-derived; skip routine progress and simple Q&A.';

  if (continuation) {
    if (compactNativeCli) {
      const header = `Cascade #${channelName}: you are @${selfHandle}, replying to ${triggeringAuthor}. Complete and verify the request, then give a concise final answer. Keep progress in the run trace.${coordinatorGuidance}`;
      return `${header}\n\n${request}`;
    }
    const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, replying to ${triggeringAuthor}. Finish the request with judgment; don't over-research. Reply normally with the final answer. Keep progress in the run trace; do not post separate chat messages.${coordinatorGuidance}`;
    return `${header}\n\n${request}`;
  }

  const channelNote = registration.contextPrompt ? ` Channel note: ${registration.contextPrompt}` : '';
  if (compactNativeCli) {
    const header = `Cascade #${channelName}: you are @${selfHandle}, replying to ${triggeringAuthor}. Complete and verify the request, then give a concise final answer. Keep progress in the run trace.${coordinatorGuidance}${channelNote}`;
    return `${header}\n\n${request}`;
  }
  const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, replying to ${triggeringAuthor}. Use recent context; fetch more history only when needed. Complete requested work and verification before replying.${scratchpadGuidance} Reply normally with the final answer. Keep progress in the run trace; do not post separate chat messages.${coordinatorGuidance}${channelNote}`;
  return `${header}\n\n${request}`;
}
