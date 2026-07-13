/**
 * Client-side agent catalog and chat prompt formatting.
 * Keep in sync with server AgentId / CLI agent lists where applicable.
 */

export type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes';

export const CHAT_AGENTS: Array<{ id: AgentId; label: string }> = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'hermes', label: 'Hermes' },
];

/**
 * Curated model presets shown in the agent picker.
 * Prefer ids known to work with the local CLI; dead ids (e.g. retired grok-build)
 * are intentionally omitted. Desktop may report additional live models via
 * `/api/me/desktop-runner` which the UI merges in.
 */
export const CHAT_AGENT_MODEL_PRESETS: Record<AgentId, { id: string; label: string }[]> = {
  'claude-code': [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
    { id: 'claude-fable-5', label: 'Claude Fable 5' },
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
};

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

  if (continuation) {
    const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, replying to ${triggeringAuthor}. Continue until the request is complete. Use \`cascade-chat send\` for brief progress updates, but do not stop after an update. Send the final response there. Any stdout after \`cascade-chat send\` is discarded, so do not write a closing summary.`;
    return `${header}\n\n${request}`;
  }

  const channelNote = registration.contextPrompt ? ` Channel note: ${registration.contextPrompt}` : '';
  const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, replying to ${triggeringAuthor}. Run \`cascade-chat history --include-reply-context\`, then complete the request. Use \`cascade-chat send --message "text"\` for brief progress updates, but do not stop after an update. Send the final response there. Any stdout after \`cascade-chat send\` is discarded, so do not write a closing summary. Notes you create via cascade-note are unlisted by default (chat/search only); use \`--listed\` only if the user asks to put them in the sidebar.${channelNote}`;
  return `${header}\n\n${request}`;
}
