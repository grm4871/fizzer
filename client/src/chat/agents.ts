/**
 * Client-side agent catalog and chat prompt formatting.
 * Keep in sync with server AgentId / CLI agent lists where applicable.
 */

export type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes' | 'akron-grok' | 'omp' | 'pi';

export const CHAT_AGENTS: Array<{ id: AgentId; label: string }> = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'hermes', label: 'Hermes' },
  { id: 'akron-grok', label: 'Akron --grok' },
  { id: 'omp', label: 'OMP' },
  { id: 'pi', label: 'Pi' },
];

/** Preserve authoritative in-memory members across a transient hydration error. */
export function agentsAfterLoadFailure<T>(cached?: T[]): T[] {
  return cached ?? [];
}

/**
 * Curated model presets shown in the agent picker.
 * Prefer ids known to work with the local CLI; dead ids (e.g. retired grok-build)
 * are intentionally omitted. The picker also accepts a custom model ID.
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
  // agentapi --model= only accepts flash_lite|flash|pro; named models below are
  // normalized onto one of those execution tiers.
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
  // Nous-hosted ids from Hermes' model catalog. An explicit selection is passed
  // through as `-m`; otherwise Hermes may inherit its selected local profile.
  hermes: [
    { id: 'z-ai/glm-5.2', label: 'GLM 5.2 (Hermes default)' },
    { id: 'deepseek/deepseek-v4-flash-0731', label: 'DeepSeek V4 Flash 0731' },
    { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
    { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
    { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
    { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' },
    { id: 'x-ai/grok-4.5', label: 'Grok 4.5' },
    { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
    { id: 'qwen/qwen3.8-max', label: 'Qwen 3.8 Max' },
  ],
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
  pi: [],
};

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

/**
 * Coordinators keep a sticky channel conversation; delegated mission tasks get
 * a task-scoped provider session. A retry can resume its own evidence, while a
 * later task cannot inherit a worker's multi-day channel transcript.
 */
export function chatAgentConversation(
  registrationId: string,
  savedConversationId: string | undefined,
  missionTaskId: string | undefined,
) {
  const taskId = String(missionTaskId || '').trim();
  if (taskId) {
    const conversationId = `mission:${taskId}`;
    return { conversationId, watermarkKey: `${registrationId}:${conversationId}`, adoptConversation: false };
  }
  const conversationId = String(savedConversationId || '').trim() || undefined;
  return {
    conversationId,
    watermarkKey: `${registrationId}:${conversationId || ''}`,
    adoptConversation: !conversationId,
  };
}

/** True only when the request cannot stand on its own after reply/batch folding. */
export function needsRecentChatContext(request: string): boolean {
  const text = String(request || '').trim();
  if (!text) return false;
  // Quoted replies and folded same-author batches already carry their referent.
  if (/^Replying to .+?:\s*>/is.test(text)) return false;
  return /^(?:also\b|continue\b|go ahead\b|same\b|again\b|bump\b)|\b(?:as (?:i|we|you) said|earlier|above|the previous|that (?:one|thing|request)|this (?:one|thing|request)|do (?:this|that|it)|fix (?:this|that|it)|make (?:this|that|it)|try again|keep going|pick up where|how|what about now)\b/i.test(text);
}

/** Live-vault operations need Cascade's helper contract; ordinary repo work does not. */
export function needsCascadeWorkspaceContext(request: string): boolean {
  const text = String(request || '').trim();
  return /\bcascade-(?:note|chat|scratchpad)\b|\b(?:live|vault)\s+(?:note|folder|kanban|board|doc(?:umentation)?|workspace)\b|\b(?:note|folder|kanban|board|doc(?:umentation)?)\s+(?:for|in|inside|within)\s+cascade\b|\bthis cascade folder\b/i.test(text);
}

/**
 * Shared chat-facing brevity rule. Applied on every agent/provider path so
 * channel replies stay short while verification/work still happens in-run.
 * Process detail belongs in the run trace, not the bubble.
 */
export const CHAT_REPLY_BREVITY =
  'Keep the final chat reply short: outcome first; skip process narrative, restated questions, and unsolicited next steps.';

export const ORCHESTRATOR_VIRTUAL_WORKERS =
  ' Stay available as a lightweight control plane: answer trivial questions and coordinate directly, but never occupy your own turn with substantive execution. For actionable work, use `cascade-chat mission start` and dispatch one to three anonymous self-subagents with `cascade-chat mission delegate --anonymous`: one clone for cohesive or sequential work, parallel clones only for independent work. They are ephemeral task-scoped copies of your model, tools, authority, and safety policy—not vault agents. Give each a bounded task, then end without polling or waiting. Mission events wake you in a fresh turn to reconcile, verify, run `cascade-chat mission finish`, and reply.';

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
  const compactNativeCli = registration.agentId === 'hermes' || registration.agentId === 'omp' || registration.agentId === 'pi';
  const coordinatorGuidance = registration.orchestrator
    ? ` You coordinate this channel. Treat clear actionable requests as implementation authority. Clarify only a requested mission/kanban or a material scope, authority, or product choice.${ORCHESTRATOR_VIRTUAL_WORKERS} Use \`--after\`, \`--priority\`, or \`--effort\` when needed. Keep mission summaries short and stay responsive. Ship only after \`npm run build\` and green Deploy; open images with \`cascade-chat attachment --message-id <id>\`.`
    : '';
  // A resumed provider session already contains the full contract above. Do
  // not pay to restate it on every manager turn; retain only the behavioral
  // invariant that matters for the next request.
  const coordinatorContinuationGuidance = registration.orchestrator
    ? ` Continue coordinating: handle clear work directly; clarify only a user-requested mission/kanban or a genuinely material ambiguity.${ORCHESTRATOR_VIRTUAL_WORKERS} Keep replies short. Ship only after \`npm run build\` + green Deploy; open chat images via \`cascade-chat attachment\` (never “cannot see”).`
    : '';

  // Keep persistence available without turning every task into extra tool turns.
  // Cold-start injection supplies the fuller policy only when a new session needs it.
  const scratchpadGuidance = nativeScratchpad
    ? ' Use the harness `scratchpad` only for a durable root cause, decision, or dead end; skip routine progress.'
    : ' Use `cascade-scratchpad` only for a durable root cause, decision, or dead end that would otherwise be re-derived; skip routine progress and simple Q&A.';

  if (continuation) {
    if (compactNativeCli) {
      const header = `Cascade #${channelName}: you are @${selfHandle}, replying to ${triggeringAuthor}. Complete and verify the request. ${CHAT_REPLY_BREVITY} Keep progress in the run trace.${coordinatorContinuationGuidance}`;
      return `${header}\n\n${request}`;
    }
    const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, replying to ${triggeringAuthor}. Finish the request with judgment; don't over-research. ${CHAT_REPLY_BREVITY} Keep progress in the run trace; do not post separate chat messages.${coordinatorContinuationGuidance}`;
    return `${header}\n\n${request}`;
  }

  const channelNote = registration.contextPrompt ? ` Channel note: ${registration.contextPrompt}` : '';
  if (compactNativeCli) {
    const header = `Cascade #${channelName}: you are @${selfHandle}, replying to ${triggeringAuthor}. Complete and verify the request. ${CHAT_REPLY_BREVITY} Keep progress in the run trace.${coordinatorGuidance}${channelNote}`;
    return `${header}\n\n${request}`;
  }
  const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, replying to ${triggeringAuthor}. Use recent context; fetch more history only when needed. Complete requested work and verification before replying.${scratchpadGuidance} ${CHAT_REPLY_BREVITY} Keep progress in the run trace; do not post separate chat messages.${coordinatorGuidance}${channelNote}`;
  return `${header}\n\n${request}`;
}
