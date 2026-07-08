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
    { id: 'gpt-5.5', label: 'GPT-5.5' },
    { id: 'gpt-5.4', label: 'GPT-5.4' },
  ],
  grok: [
    { id: 'grok-4.5', label: 'Grok 4.5' },
    { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' },
  ],
  antigravity: [
    { id: 'flash_lite', label: 'Gemini 3.5 Flash (Low)' },
    { id: 'flash', label: 'Gemini 3.5 Flash (Medium)' },
    { id: 'pro', label: 'Gemini 3.1 Pro (Low)' },
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
 * Live ids not already in the preset list are appended as-is.
 */
export function mergeAgentModelPresets(
  agentId: AgentId,
  liveModels: string[] | null | undefined,
): { id: string; label: string }[] {
  const base = [...(CHAT_AGENT_MODEL_PRESETS[agentId] ?? [])];
  if (!liveModels?.length) return base;
  const seen = new Set(base.map((m) => m.id));
  for (const id of liveModels) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    base.push({ id: trimmed, label: trimmed });
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
    // Session already has identity + prior turns. Keep the nudge short.
    const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, responding to ${triggeringAuthor}. Continuation — session already has earlier turns. Reply briefly. Prefer \`cascade-chat send\` for mid-run updates.`;
    return `${header}\n\n${request}`;
  }

  const channelNote = registration.contextPrompt ? ` Channel note: ${registration.contextPrompt}` : '';
  const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, responding to ${triggeringAuthor}. Reply briefly. Run \`cascade-chat history --include-reply-context\` for full channel context. Use \`cascade-chat send --message "text"\` to send a standalone message in chat during your run, especially after tool calls. Notes: \`cascade-note\` + \`![[Title]]\` embeds.${channelNote}`;
  return `${header}\n\n${request}`;
}
