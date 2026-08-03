import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Bot, Copy, Forward, Hash, ImagePlus, Paperclip, Reply, Send, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { api, type NoteSummary } from '../api';
import { DOC_EMBED_REGEX, findEmbeddedNote, NOTE_DND_TYPE, noteEmbedMarkdown, splitDocEmbeds } from '../docEmbeds';
import { escapeRegExp, normalizeMention } from '../chat/mentions';
import { highlightJSON } from './jsonHighlighter';
import { CascadeRunPanel } from './CascadeRunPanel';
import { ChatSidebarButtons } from './ChatSidebarButtons';
import { ChatWorkspacePanel } from './ChatWorkspacePanel';
import { hasRunActivity } from '../chat/harnessActivity';

export const CHAT_NOTE_MARKER = 'cascade://chat-channel';
export const CHAT_MEDIA_LIMIT = 8;
export const CHAT_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

const CUSTOM_MODEL_VALUE = '__custom__';

function resolveModelPicker(
  agent: ChatAgentOption | undefined,
  model: string,
): { choice: string; custom: string } {
  const trimmed = model.trim();
  if (!agent || agent.models.length === 0) {
    return { choice: CUSTOM_MODEL_VALUE, custom: trimmed };
  }
  if (!trimmed) return { choice: agent.models[0]?.id ?? '', custom: '' };
  if (agent.models.some((preset) => preset.id === trimmed)) {
    return { choice: trimmed, custom: '' };
  }
  return { choice: CUSTOM_MODEL_VALUE, custom: trimmed };
}

function modelFromPicker(choice: string, custom: string) {
  return (choice === CUSTOM_MODEL_VALUE ? custom : choice).trim();
}

export interface ChatMediaAttachment {
  media_type: string;
  data: string;
  url: string;
  name?: string;
}

type ElectronClipboardAPI = {
  readClipboardImage?: () => Promise<ChatMediaAttachment | null>;
};

export interface ChatReplyRef {
  messageId: string;
  author: string;
  mention: string;
  preview: string;
}

/** Provenance stamped on a message forwarded in from another channel. */
export interface ChatForwardRef {
  messageId: string;
  channelId: string;
  channelName: string;
  author: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  author: string;
  body: string;
  createdAt: string;
  /** Server persistence order (DB rowid); tiebreaks same-millisecond messages
   * so the client orders them exactly as the server does. Absent until the
   * message is persisted — optimistic messages sort last within a tie. */
  seq?: number;
  status?: 'sending' | 'running' | 'failed' | 'canceled';
  agentId?: string;
  registrationId?: string;
  runId?: number;
  blocks?: ChatBlock[];
  /** Full harness terminal transcript (raw process I/O / SDK stream). */
  harnessLog?: string;
  /** List API omitted harnessLog but server has one — expand fetches full message. */
  hasHarness?: boolean;
  /** List API stripped heavy data-URL images — hydrate full message to show them. */
  hasImages?: boolean;
  images?: string[];
  attachments?: Array<{ name: string; media_type: string; url: string }>;
  replyTo?: ChatReplyRef;
  forwardedFrom?: ChatForwardRef;
  changeRequest?: {
    files: Array<{ path: string; additions: number; deletions: number }>;
    commit?: string;
    ref?: string;
    approvals: Array<{ userId: number; username: string }>;
    mergedAt?: string;
    mergedBy?: string;
  };
  mission?: ChatMission;
  missionTaskId?: string;
}

export type ChatMissionTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked' | 'canceled';

export interface ChatMissionTask {
  id: string;
  title: string;
  assignee: string;
  assigneeMention: string;
  status: ChatMissionTaskStatus;
  summary: string;
  runId?: number;
  updatedAt: string;
}

export interface ChatMission {
  id: string;
  title: string;
  objective: string;
  status: 'active' | 'reviewing' | 'blocked' | 'completed' | 'canceled';
  coordinator: string;
  coordinatorMention: string;
  tasks: ChatMissionTask[];
  summary: string;
  createdAt: string;
  updatedAt: string;
}

/** Desktop runner health from GET /api/me/desktop-runner */
export interface PlanUsageWindow {
  label: string;
  usedPercent: number;
  windowMinutes?: number;
  resetsAt?: string | null;
  resetsLabel?: string | null;
}

export interface PlanUsage {
  status: 'ok' | 'unknown' | 'error';
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string | null;
  resetsLabel?: string | null;
  windows?: PlanUsageWindow[];
  planType?: string | null;
  detail?: string | null;
  fetchedAt?: string;
}

export interface DesktopRunnerHealth {
  online: boolean;
  activeRuns: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSeenAt: string | null;
  models: Record<string, string[]> | null;
  planUsage: Record<string, PlanUsage> | null;
}

export interface ChatBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  text?: string;
  redacted?: boolean;
  /** tool_use */
  id?: string;
  name?: string;
  input?: unknown;
  /** tool_result */
  toolUseId?: string;
  content?: string;
  isError?: boolean;
}

export interface ChatAgentRegistration {
  id: string;
  /** Persistent vault-level agent id (shared across channels). */
  vaultAgentId?: string;
  agentId: string;
  displayName: string;
  avatarUrl: string;
  mention: string;
  model: string;
  /** Optional per-channel Codex reasoning effort pin. Empty uses the CLI default. */
  reasoningEffort: string;
  cwd: string;
  contextPrompt: string;
  taggableByAgents: boolean;
  replyToEveryMessage: boolean;
  orchestrator: boolean;
  /** Allow users other than the owner to @mention/trigger this agent in a
   * shared channel. The run still executes on the owner's desktop runner. */
  pingableByOthers: boolean;
  /** Run this agent with permission prompts bypassed ("yolo"). Scoped to this
   * registration, applied on the machine that runs it. */
  yolo: boolean;
  /** Conversation id linking this member's runs into one resumable session.
   * Empty for a not-yet-persisted member; the server assigns/preserves it. */
  conversationId: string;
}

/** Persistent vault-scoped agent identity (shared across channels). */
export interface VaultAgent {
  id: string;
  vaultId: string;
  agentId: string;
  displayName: string;
  avatarUrl: string;
  mention: string;
  model: string;
  cwd: string;
  contextPrompt: string;
  ownerUserId: number;
  ownerUsername: string;
  channelIds?: string[];
  createdAt?: string;
  updatedAt?: string;
}

export function createChatAgentRegistrationId() {
  return `reg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface ChatAgentOption {
  id: string;
  label: string;
  models: Array<{ id: string; label: string }>;
}

export const REASONING_EFFORTS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
] as const;

export function ReasoningEffortSelect({
  agentId,
  value,
  onChange,
}: {
  agentId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const defaultLabel = agentId === 'claude-code' ? 'Use Claude Code default' : 'Use Codex CLI default';
  const efforts = agentId === 'claude-code'
    ? REASONING_EFFORTS.filter((effort) => effort.id !== 'ultra')
    : REASONING_EFFORTS;
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">{defaultLabel}</option>
      {efforts.map((effort) => (
        <option key={effort.id} value={effort.id}>{effort.label}</option>
      ))}
    </select>
  );
}

export interface ChatChannelPresence {
  participants: string[];
  online: string[];
  owner?: string;
}

export type SharedChatNote = {
  id: string;
  title: string;
  content: string;
  content_preview: string;
};

interface ChatViewProps {
  channelId: string;
  channelName: string;
  messages: ChatMessage[];
  isLoadingMessages?: boolean;
  currentUser: string;
  presence: ChatChannelPresence;
  availableAgents: ChatAgentOption[];
  registeredAgents: ChatAgentRegistration[];
  vaultAgents?: VaultAgent[];
  runnerHealth?: DesktopRunnerHealth | null;
  onRegisterAgent: (channelId: string, registration: ChatAgentRegistration) => void;
  onRemoveAgent: (channelId: string, registrationId: string) => void;
  onUpsertVaultAgent?: (agent: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent | void> | VaultAgent | void;
  onDeleteVaultAgent?: (vaultAgentId: string) => Promise<void> | void;
  onAddVaultAgentToChannel?: (channelId: string, vaultAgentId: string) => Promise<void> | void;
  onCreateInviteLink: (channelId: string) => Promise<string>;
  onInviteUser: (channelId: string, username: string) => Promise<void>;
  onRemoveParticipant?: (channelId: string, username: string) => Promise<void>;
  onLeaveChannel?: (channelId: string) => Promise<void>;
  onSendMessage: (channelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => void;
  /** Delete a message for everyone (own messages, or any when you host the channel). */
  onDeleteMessage?: (channelId: string, messageId: string) => Promise<void> | void;
  /** Copy a message into another channel. Resolves once the copy is posted. */
  onForwardMessage?: (channelId: string, messageId: string, targetChannelId: string) => Promise<void>;
  onCancelRun: (runId: number) => void;
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (channelId: string, messageId: string, title: string) => Promise<SharedChatNote | null>;
  /** When set, members panel open state is controlled by the app (workspace toolbar). */
  membersOpen?: boolean;
  onMembersOpenChange?: (open: boolean) => void;
  vaultId?: string;
  /** Merge a full message (e.g. harness log) after expand-fetch. */
  onHydrateMessage?: (message: ChatMessage) => void;
  /** When set, scroll to and highlight this message once it's in the list (e.g. from search). */
  jumpToMessageId?: string;
  /** Called after a jump target has been consumed so the parent can clear it. */
  onJumpHandled?: () => void;
}

// Stable fallback: an inline `= []` default would mint a new identity every
// render and defeat the notes-aware memo comparators below.
const EMPTY_NOTES: NoteSummary[] = [];

function isImageMediaType(mediaType: string) {
  return mediaType.startsWith('image/');
}

function readMediaFile(file: File): Promise<ChatMediaAttachment | null> {
  return new Promise((resolve) => {
    if (file.size > CHAT_MEDIA_MAX_BYTES) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const data = url.split(',')[1] || '';
      resolve({
        media_type: file.type || 'application/octet-stream',
        data,
        url,
        name: file.name,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function getElectronClipboardAPI(): ElectronClipboardAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronClipboardAPI }).electronAPI;
}

// Slightly generous: stream/harness growth often leaves a few px of lag for
// one frame; 24px was flapping sticky under fast agent output.
function isAtScrollBottom(element: HTMLElement, threshold = 48) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

// Reuse one formatter — creating Intl.DateTimeFormat per message was scroll noise.
const CHAT_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return CHAT_TIME_FORMATTER.format(date);
}

function planUsageProviderId(agentId: string) {
  return agentId === 'akron-grok' ? 'grok' : agentId;
}

function planUsageWindows(usage?: PlanUsage | null): PlanUsageWindow[] {
  if (!usage || usage.status !== 'ok') return [];
  if (usage.windows?.length) return usage.windows;
  if (typeof usage.usedPercent !== 'number') return [];
  return [{
    label: usage.windowMinutes ? `${Math.round(usage.windowMinutes / 60)}h` : 'usage',
    usedPercent: usage.usedPercent,
    ...(usage.windowMinutes ? { windowMinutes: usage.windowMinutes } : {}),
    ...(usage.resetsAt ? { resetsAt: usage.resetsAt } : {}),
    ...(usage.resetsLabel ? { resetsLabel: usage.resetsLabel } : {}),
  }];
}

function formatPlanUsageTitle(usage?: PlanUsage | null) {
  if (!usage) return '';
  if (usage.status !== 'ok') return usage.detail || 'Plan usage unavailable';
  const lines = planUsageWindows(usage).map((window) => {
    let reset = window.resetsLabel || '';
    if (!reset && window.resetsAt) {
      const date = new Date(window.resetsAt);
      if (!Number.isNaN(date.getTime())) reset = CHAT_TIME_FORMATTER.format(date);
    }
    return `${window.label}: ${Math.round(window.usedPercent)}% used${reset ? ` · resets ${reset}` : ''}`;
  });
  if (usage.planType) lines.push(`Plan: ${usage.planType}`);
  return lines.join('\n');
}

function PlanUsageMeters({
  usage,
  stacked = false,
}: {
  usage: PlanUsage;
  stacked?: boolean;
}) {
  const title = formatPlanUsageTitle(usage);
  if (usage.status !== 'ok') {
    return <span className="chat-plan-meters is-unavailable" title={title}>usage unavailable</span>;
  }
  const windows = planUsageWindows(usage).slice(0, 3);
  return (
    <span className={`chat-plan-meters${stacked ? ' is-stacked' : ''}`} title={title}>
      {windows.map((window, index) => {
        const percent = Math.round(window.usedPercent);
        return (
          <span
            className="chat-plan-meter"
            key={`${window.label}:${index}`}
            role="progressbar"
            aria-label={`${window.label} plan usage`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="chat-plan-meter-label">{window.label}</span>
            <span className="chat-plan-meter-track" aria-hidden="true">
              <span className="chat-plan-meter-fill" style={{ width: `${percent}%` }} />
            </span>
            <span className="chat-plan-meter-value">{percent}%</span>
          </span>
        );
      })}
    </span>
  );
}

function initialFor(name: string) {
  return (name.trim().charAt(0) || '?').toUpperCase();
}

function buildReplyPreview(message: ChatMessage) {
  const body = message.body.trim();
  if (body) return body.length > 120 ? `${body.slice(0, 119)}…` : body;
  if (message.images?.length) return `[${message.images.length} image${message.images.length === 1 ? '' : 's'}]`;
  if (message.attachments?.length) return message.attachments[0]?.name || '[attachment]';
  return '(message)';
}

export function resolveReplyMention(message: ChatMessage, registeredAgents: ChatAgentRegistration[]) {
  if (message.registrationId) {
    const registration = registeredAgents.find((item) => item.id === message.registrationId);
    if (registration) return normalizeMention(registration.mention || registration.agentId);
  }
  const byAuthor = registeredAgents.find((item) =>
    item.displayName === message.author
    || normalizeMention(item.mention) === normalizeMention(message.author),
  );
  if (byAuthor) return normalizeMention(byAuthor.mention || byAuthor.agentId);
  if (message.agentId) {
    const registration = registeredAgents.find((item) => item.agentId === message.agentId);
    if (registration) return normalizeMention(registration.mention || registration.agentId);
  }
  return normalizeMention(message.author);
}

export function buildReplyRef(message: ChatMessage, registeredAgents: ChatAgentRegistration[]): ChatReplyRef {
  return {
    messageId: message.id,
    author: message.author,
    mention: resolveReplyMention(message, registeredAgents),
    preview: buildReplyPreview(message),
  };
}

/** Keep the reply quote while suppressing its implicit agent mention. */
export function prepareReplyForSend(reply: ChatReplyRef, notifyAgent: boolean): ChatReplyRef {
  return notifyAgent ? reply : { ...reply, mention: '' };
}

const CHAT_MARKDOWN_PLUGINS = [remarkGfm, remarkBreaks];

function formatChatMentions(text: string, aliases: string[]): ReactNode[] {
  const mentionable = [...new Set(
    aliases.map((alias) => normalizeMention(alias)).filter(Boolean),
  )];
  if (mentionable.length === 0) return [text];
  const aliasPattern = mentionable
    .map((alias) => alias.split(/\s+/).map(escapeRegExp).join('[\\s-]*'))
    .join('|');
  const regex = new RegExp(`@\\s*(?:${aliasPattern})(?=$|[\\s.,:;!?\\])}])`, 'gi');
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    nodes.push(<span key={key++} className="chat-mention">{match[0]}</span>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : [text];
}

function aliasesEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

const ChatMessageText = memo(function ChatMessageText({
  messageId,
  body,
  mentionableAliases,
  notes = [],
  onOpenNote,
  onOpenSharedNote,
}: {
  messageId: string;
  body: string;
  mentionableAliases: string[];
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (messageId: string, title: string) => void;
}) {
  const withMentions = useCallback((children: ReactNode): ReactNode => {
    if (Array.isArray(children)) {
      return children.flatMap((child) =>
        typeof child === 'string' ? formatChatMentions(child, mentionableAliases) : [child]
      );
    }
    if (typeof children === 'string') return formatChatMentions(children, mentionableAliases);
    return children;
  }, [mentionableAliases]);

  const formattedBody = useMemo(() => {
    const processed = body.replace(/\\+`/g, '`');
    const trimmed = processed.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
        }
      } catch {
        // ignore
      }
    }
    return processed;
  }, [body]);

  const components = useMemo(() => ({
    p: ({ children }: { children?: ReactNode }) => <p>{withMentions(children)}</p>,
    li: ({ children }: { children?: ReactNode }) => <li>{withMentions(children)}</li>,
    code({ node, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      const isInline = !className;
      const value = String(children).replace(/\n$/, '');

      if (!isInline && (!match || match[1] === 'json')) {
        const trimmed = value.trim();
        if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
          try {
            JSON.parse(trimmed);
            return (
              <code className={className || 'language-json'} {...props}>
                {highlightJSON(value)}
              </code>
            );
          } catch {
            // ignore
          }
        }
      }

      if (!isInline && match && match[1] === 'json') {
        return (
          <code className={className} {...props}>
            {highlightJSON(value)}
          </code>
        );
      }
      return <code className={className} {...props}>{children}</code>;
    }
  }), [withMentions]);

  return (
    <>
      {splitDocEmbeds(formattedBody).map((part, index) => {
        if (part.type === 'text') {
          if (!part.value) return null;
          return (
            <ReactMarkdown key={index} remarkPlugins={CHAT_MARKDOWN_PLUGINS} components={components}>
              {part.value}
            </ReactMarkdown>
          );
        }
        const embedded = findEmbeddedNote(notes, part.value);
        return (
          <button
            key={index}
            type="button"
            className={`chat-doc-embed${embedded || onOpenSharedNote ? '' : ' is-missing'}`}
            onClick={() => embedded ? onOpenNote?.(embedded.id) : onOpenSharedNote?.(messageId, part.value)}
            disabled={!embedded && !onOpenSharedNote}
            title={embedded ? `Open ${embedded.title}` : 'Open shared note'}
            draggable={!!embedded}
            onDragStart={(event) => {
              if (!embedded) return;
              event.dataTransfer.setData(NOTE_DND_TYPE, embedded.id);
              event.dataTransfer.setData('text/plain', noteEmbedMarkdown(embedded));
              event.dataTransfer.effectAllowed = 'copyMove';
            }}
          >
            <span className="chat-doc-embed-title">
              {embedded?.title ?? (onOpenSharedNote ? part.value : `Missing note: ${part.value}`)}
            </span>
            {embedded?.content_preview?.trim() && (
              <span className="chat-doc-embed-preview">
                {embedded.content_preview.trim().length > 180
                  ? `${embedded.content_preview.trim().slice(0, 179)}…`
                  : embedded.content_preview.trim()}
              </span>
            )}
          </button>
        );
      })}
    </>
  );
}, (prev, next) =>
  prev.messageId === next.messageId
  && prev.onOpenSharedNote === next.onOpenSharedNote
  &&
  prev.body === next.body
  && aliasesEqual(prev.mentionableAliases, next.mentionableAliases)
  // The notes list only affects bodies that render `![[...]]` embeds; plain
  // messages must not re-parse their markdown every time any note changes.
  && (prev.notes === next.notes || !bodyHasDocEmbed(next.body))
);

function bodyHasDocEmbed(body: string): boolean {
  DOC_EMBED_REGEX.lastIndex = 0;
  return DOC_EMBED_REGEX.test(body);
}

export function canGroupChatMessages(a: ChatMessage, b: ChatMessage) {
  if (a.author.trim() !== b.author.trim()) return false;
  const aKey = a.registrationId ?? a.agentId ?? null;
  const bKey = b.registrationId ?? b.agentId ?? null;
  if (aKey !== bKey) return false;
  return true;
}

export function canMergeChatMessages(a: ChatMessage, b: ChatMessage) {
  if (!canGroupChatMessages(a, b)) return false;
  if (a.status === 'running' || b.status === 'running') return false;
  if (a.replyTo || b.replyTo) return false;
  // A forward carries its own provenance banner; merging would hide it.
  if (a.forwardedFrom || b.forwardedFrom) return false;
  if ((a.images?.length ?? 0) > 0 || (b.images?.length ?? 0) > 0) return false;
  if ((a.attachments?.length ?? 0) > 0 || (b.attachments?.length ?? 0) > 0) return false;
  return true;
}

export function shouldDetachStickyForWheel(deltaY: number) {
  return deltaY < 0;
}

export function shouldDetachStickyForTouch(startY: number | null, currentY: number | null) {
  return startY != null && currentY != null && currentY > startY + 4;
}

export function getRunningMessageState(messages: ChatMessage[]) {
  const byAgent = new Map<string, { latestId: string; count: number }>();
  for (const message of messages) {
    if (message.status !== 'running') continue;
    const key = message.registrationId || message.agentId;
    if (!key) continue;
    const previous = byAgent.get(key);
    byAgent.set(key, { latestId: message.id, count: (previous?.count || 0) + 1 });
  }
  return byAgent;
}

export function getSteeringPromptLabels(
  messages: ChatMessage[],
  registeredAgents: ChatAgentRegistration[],
  runningState = getRunningMessageState(messages),
) {
  const labels = new Map<string, string>();
  for (const [key, state] of runningState) {
    if (state.count <= 1) continue;
    const registration = registeredAgents.find((item) => item.id === key || item.agentId === key);
    if (!registration) continue;
    const mention = normalizeMention(registration.mention || registration.agentId);
    const latestIndex = messages.findIndex((message) => message.id === state.latestId);
    for (let index = latestIndex - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.agentId) continue;
      const explicitlyMentions = new RegExp(`(^|\\s)@${escapeRegExp(mention)}(?=\\s|$|[.,!?;:])`, 'i').test(message.body);
      const repliesToAgent = normalizeMention(message.replyTo?.mention || '') === mention;
      if (explicitlyMentions || repliesToAgent) labels.set(message.id, mention);
      break;
    }
  }
  return labels;
}

export function mediaToRunImages(media: ChatMediaAttachment[]) {
  return media
    .filter((item) => isImageMediaType(item.media_type))
    .map(({ media_type, data }) => ({ media_type, data }));
}

/** Images are stored on a message as data URLs. A reply points at that message
 * but carries none of its media, so the quoted screenshot has to be re-read
 * from the quoted message before a run can see it. */
export function dataUrlsToRunImages(sources: string[] | undefined) {
  const images: Array<{ media_type: string; data: string }> = [];
  for (const src of sources ?? []) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(src.trim());
    if (match && isImageMediaType(match[1])) images.push({ media_type: match[1], data: match[2] });
  }
  return images;
}

interface ChatMessageGroup {
  messages: ChatMessage[];
}

function groupChatMessages(messages: ChatMessage[]): ChatMessageGroup[] {
  const groups: ChatMessageGroup[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && canGroupChatMessages(last.messages[last.messages.length - 1], message)) {
      last.messages.push(message);
    } else {
      groups.push({ messages: [message] });
    }
  }
  return groups;
}

function ChatAvatar({
  name,
  kind,
  avatarUrl = '',
  size = 'md',
}: {
  name: string;
  kind: 'agent' | 'human';
  avatarUrl?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`chat-avatar chat-avatar-${size} chat-avatar-${kind}`} aria-hidden="true">
      {avatarUrl ? <img src={avatarUrl} alt="" /> : kind === 'agent' ? <Bot size={size === 'sm' ? 14 : 15} /> : initialFor(name)}
    </div>
  );
}

function hasExpandableTrace(message: ChatMessage): boolean {
  return hasRunActivity(message);
}

/**
 * Keep the live harness visible while work is happening and surface failures,
 * but let a successful final answer return to being a normal chat message.
 * Completed traces remain selectable, so none of the persisted run detail is
 * discarded or made inaccessible.
 */
export function shouldRenderRunPanel(
  message: ChatMessage,
  selected: boolean,
  isLatestRunningMessage: boolean,
): boolean {
  if (selected) return true;
  if (message.status === 'failed' || message.status === 'canceled') return true;
  return message.status === 'running' && isLatestRunningMessage;
}

function groupHasDocEmbed(group: ChatMessageGroup): boolean {
  return group.messages.some((message) => message.body && bodyHasDocEmbed(message.body));
}

/** Swipe-left → reply (mobile/touch). Touch/pen only so desktop drag-select stays clean. */
const SWIPE_REPLY_MAX = 72;
const SWIPE_REPLY_THRESHOLD = 52;
const SWIPE_AXIS_SLOP = 12;

/**
 * DOM-driven swipe: no React setState during vertical pan or per-frame drag.
 * Previous version set dragging=true on every pointerdown and setOffset on every
 * move — that re-rendered the whole message row and stuttered list scroll.
 */
function SwipeToReply({
  onReply,
  children,
  className = '',
  messageId,
  onClick,
  onContextMenu,
}: {
  onReply: () => void;
  children: ReactNode;
  className?: string;
  messageId?: string;
  onClick?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const hintRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const axisRef = useRef<'h' | 'v' | null>(null);
  const offsetRef = useRef(0);
  const armedRef = useRef(false);

  const paint = useCallback((offset: number, dragging: boolean) => {
    const content = contentRef.current;
    const hint = hintRef.current;
    const root = rootRef.current;
    if (content) {
      content.style.transition = dragging ? 'none' : 'transform 160ms ease-out';
      content.style.transform = offset ? `translate3d(${-offset}px, 0, 0)` : '';
    }
    if (hint) {
      const progress = Math.min(1, offset / SWIPE_REPLY_THRESHOLD);
      hint.style.opacity = String(progress);
      hint.style.transform = `scale(${0.75 + progress * 0.25})`;
    }
    if (root) {
      root.classList.toggle('is-dragging', dragging);
      const armed = offset >= SWIPE_REPLY_THRESHOLD;
      if (armed !== armedRef.current) {
        armedRef.current = armed;
        root.classList.toggle('is-armed', armed);
      }
    }
  }, []);

  const reset = useCallback((animate: boolean) => {
    startRef.current = null;
    axisRef.current = null;
    offsetRef.current = 0;
    if (!animate) {
      paint(0, false);
      return;
    }
    paint(0, true);
    requestAnimationFrame(() => paint(0, false));
  }, [paint]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, select, .cascade-run-panel, pre, code')) return;
    // Track only — no setState (vertical list scroll must stay free).
    startRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    axisRef.current = null;
    offsetRef.current = 0;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start || event.pointerId !== start.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!axisRef.current) {
      if (Math.abs(dx) < SWIPE_AXIS_SLOP && Math.abs(dy) < SWIPE_AXIS_SLOP) return;
      if (Math.abs(dy) >= Math.abs(dx)) {
        axisRef.current = 'v';
        startRef.current = null;
        return;
      }
      axisRef.current = 'h';
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }
    if (axisRef.current !== 'h') return;
    const next = Math.max(0, Math.min(SWIPE_REPLY_MAX, -dx));
    offsetRef.current = next;
    paint(next, true);
    event.preventDefault();
  };

  const finish = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start || event.pointerId !== start.pointerId) {
      // Vertical pan may have cleared start — still release capture if any.
      try {
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      } catch { /* ignore */ }
      return;
    }
    const committed = axisRef.current === 'h' && offsetRef.current >= SWIPE_REPLY_THRESHOLD;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // ignore
    }
    reset(true);
    if (committed) {
      try {
        navigator.vibrate?.(12);
      } catch {
        // ignore
      }
      onReply();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`chat-swipe-row ${className}`}
      data-message-id={messageId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      <div ref={hintRef} className="chat-swipe-reply-hint" aria-hidden="true">
        <Reply size={16} />
      </div>
      <div ref={contentRef} className="chat-swipe-content">
        {children}
      </div>
    </div>
  );
}

function ChatMissionCard({ mission }: { mission: ChatMission }) {
  const [open, setOpen] = useState(mission.status === 'blocked');
  useEffect(() => {
    if (mission.status === 'blocked') setOpen(true);
  }, [mission.status]);
  const done = mission.tasks.filter((task) => task.status === 'completed' || task.status === 'canceled').length;
  const total = mission.tasks.length;
  const statusLabel = mission.status === 'active'
    ? (total ? `${done}/${total} done` : 'planning')
    : mission.status;
  return (
    <details
      className={`chat-mission-card is-${mission.status}`}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="chat-mission-state" aria-hidden="true" />
        <strong>{mission.title}</strong>
        <span>{statusLabel}</span>
      </summary>
      <div className="chat-mission-content">
        {mission.objective && <p>{mission.objective}</p>}
        {mission.tasks.length > 0 ? (
          <div className="chat-mission-tasks">
            {mission.tasks.map((task) => (
              <div className={`chat-mission-task is-${task.status}`} key={task.id}>
                <span className="chat-mission-task-state" aria-label={task.status}>
                  {task.status === 'completed' ? '✓' : task.status === 'failed' || task.status === 'blocked' ? '!' : task.status === 'running' ? '●' : '○'}
                </span>
                <div>
                  <strong>{task.title}</strong>
                  <span>@{task.assigneeMention || task.assignee} · {task.status}</span>
                  {task.summary && <small>{task.summary}</small>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <span className="chat-mission-empty">{mission.coordinator} is deciding how to handle this.</span>
        )}
        {mission.summary && <div className="chat-mission-summary">{mission.summary}</div>}
      </div>
    </details>
  );
}

/**
 * One author-run of messages. Memoized so keystrokes in the composer, agent
 * panel state, and stream ticks in *other* groups don't re-render the whole
 * transcript — only the group whose message objects actually changed.
 *
 * Offscreen rows collapse to a height placeholder (IntersectionObserver) so
 * scroll doesn't paint/parse markdown + harness for the entire history.
 */
const ChatGroupRow = memo(function ChatGroupRow({
  group,
  selectedMessageId,
  avatarKind,
  avatarUrl,
  ownerLabel,
  planUsage,
  latestRunningMessageId,
  runningSiblingCount,
  steeringPromptLabels,
  mentionableAliases,
  notes,
  onOpenNote,
  onOpenSharedNote,
  onCancelRun,
  onToggleSelect,
  onContextMenu,
  onReply,
  onLightbox,
  onImageLoad,
  scrollRootRef,
  vaultId,
  onHydrateMessage,
}: {
  group: ChatMessageGroup;
  /** Pre-filtered by the parent: non-null only when the selection is inside this group. */
  selectedMessageId: string | null;
  avatarKind: 'agent' | 'human';
  avatarUrl?: string;
  ownerLabel?: string;
  planUsage?: PlanUsage | null;
  latestRunningMessageId?: string;
  runningSiblingCount: number;
  steeringPromptLabels: ReadonlyMap<string, string>;
  mentionableAliases: string[];
  notes: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (messageId: string, title: string) => void;
  onCancelRun: ChatViewProps['onCancelRun'];
  onToggleSelect: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onReply: (message: ChatMessage) => void;
  onLightbox: (src: string) => void;
  onImageLoad: () => void;
  /** Chat scroller element — used as IntersectionObserver root. */
  scrollRootRef: RefObject<HTMLDivElement | null>;
  vaultId?: string;
  onHydrateMessage?: (message: ChatMessage) => void;
}) {
  const head = group.messages[0];
  const tail = group.messages[group.messages.length - 1];
  const groupHasRunWidget = group.messages.some((message) => message.status === 'running' || hasExpandableTrace(message));
  const groupSelected = group.messages.some((message) => message.id === selectedMessageId);
  const articleRef = useRef<HTMLElement | null>(null);
  const heightRef = useRef(0);
  // Start mounted so first paint / stick-to-bottom has real content; IO then unmounts offscreen.
  const [inView, setInView] = useState(true);
  const forceMounted = groupSelected
    || group.messages.some((message) => message.status === 'running');

  useEffect(() => {
    const el = articleRef.current;
    const root = scrollRootRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        if (entry.isIntersecting) {
          setInView(true);
        } else if (!forceMounted) {
          // Preserve height so scroll position doesn't jump when unmounting markdown.
          heightRef.current = el.offsetHeight || heightRef.current;
          setInView(false);
        }
      },
      {
        root: root || null,
        // Large margin keeps a buffer of mounted rows above/below the viewport.
        rootMargin: '600px 0px',
        threshold: 0,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRootRef, forceMounted, group.messages.length]);

  useLayoutEffect(() => {
    if (inView && articleRef.current) {
      heightRef.current = articleRef.current.offsetHeight || heightRef.current;
    }
  });

  const showBody = inView || forceMounted;
  const placeholderH = heightRef.current || (groupHasRunWidget ? 120 : 72);

  return (
    <article
      ref={articleRef}
      className={`chat-message-group ${tail.status ? `status-${tail.status}` : ''} ${groupHasRunWidget ? 'has-run-widget' : ''} ${groupSelected ? 'selected' : ''} ${showBody ? '' : 'is-offscreen'}`}
      style={showBody ? undefined : { height: placeholderH, minHeight: placeholderH }}
      aria-hidden={showBody ? undefined : true}
    >
      {showBody ? (
        <>
          <ChatAvatar name={head.author} kind={avatarKind} avatarUrl={avatarUrl} />
          <div className="chat-message-body">
            <div className="chat-message-meta">
              <strong>{head.author}</strong>
              {planUsage && <PlanUsageMeters usage={planUsage} />}
              {ownerLabel && <span className="chat-agent-owner">{ownerLabel}'s agent</span>}
              <time dateTime={tail.createdAt}>{formatTime(tail.createdAt)}</time>
              {tail.status === 'running' && latestRunningMessageId === tail.id && runningSiblingCount > 1 && (
                <span className="chat-message-status is-steering">steering · latest</span>
              )}
              {tail.status === 'running' && latestRunningMessageId === tail.id && runningSiblingCount <= 1 && <span className="chat-message-status">working</span>}
              {tail.status === 'running' && latestRunningMessageId !== tail.id && <span className="chat-message-status is-steered">continued below</span>}
              {tail.status === 'failed' && <span className="chat-message-status is-error">failed</span>}
              {tail.status === 'canceled' && <span className="chat-message-status is-error">canceled</span>}
            </div>
            {group.messages.map((message) => {
              const hasRunWidget = message.status === 'running';
              const hasThoughtBlocks = hasExpandableTrace(message);
              const isLatestRunningMessage = message.status !== 'running' || latestRunningMessageId === message.id;
              const isTappable = hasRunWidget || hasThoughtBlocks;
              const selected = selectedMessageId === message.id;
              return (
                <SwipeToReply
                  key={message.id}
                  messageId={message.id}
                  className={`chat-message-chunk ${isTappable ? 'has-run-widget' : ''} ${selected ? 'selected' : ''}`}
                  onReply={() => onReply(message)}
                  onClick={() => {
                    if (isTappable) onToggleSelect(message.id);
                  }}
                  onContextMenu={(event) => onContextMenu(event, message)}
                >
                  {message.replyTo && (
                    <div className="chat-reply-quote">
                      <Reply size={12} />
                      <strong>{message.replyTo.author}</strong>
                      <span>{message.replyTo.preview}</span>
                    </div>
                  )}
                  {message.forwardedFrom && (
                    <div className="chat-forward-quote">
                      <Forward size={12} />
                      <span>
                        Forwarded from <strong>#{message.forwardedFrom.channelName}</strong>
                        {' · '}
                        {message.forwardedFrom.author}
                      </span>
                    </div>
                  )}
                  {steeringPromptLabels.has(message.id) && (
                    <div className="chat-steering-prompt">
                      ↳ Steering @{steeringPromptLabels.get(message.id)} into the active session
                    </div>
                  )}
                  {message.images && message.images.length > 0 && (
                    <div className="chat-msg-images">
                      {message.images.map((src, imageIndex) => (
                        <a
                          key={imageIndex}
                          href={src}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(event) => {
                            event.preventDefault();
                            onLightbox(src);
                          }}
                        >
                          <img src={src} alt="" className="chat-msg-image" onLoad={onImageLoad} />
                        </a>
                      ))}
                    </div>
                  )}
                  {message.hasImages && !message.images?.length && (
                    <div className="chat-msg-media-loading" role="status">
                      Loading media…
                    </div>
                  )}
                  {message.attachments && message.attachments.length > 0 && (
                    <div className="chat-msg-attachments">
                      {message.attachments.map((attachment, attachmentIndex) => (
                        <a
                          key={attachmentIndex}
                          className="chat-msg-attachment"
                          href={attachment.url}
                          download={attachment.name}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Paperclip size={13} />
                          <span>{attachment.name}</span>
                        </a>
                      ))}
                    </div>
                  )}
                  {message.body
                    && !(message.status === 'running' && /^Thinking(?:\.{3}|…)$/.test(message.body.trim()))
                    && <ChatMessageText messageId={message.id} body={message.body} mentionableAliases={mentionableAliases} notes={notes} onOpenNote={onOpenNote} onOpenSharedNote={onOpenSharedNote} />}
                  {message.mission && <ChatMissionCard mission={message.mission} />}
                  {message.changeRequest && (
                    <div className="chat-change-request">
                      <div className="chat-change-files">
                        {message.changeRequest.files.map((file) => (
                          <button type="button" className="chat-change-chip" key={file.path} title="Copy file path"
                            onClick={(event) => { event.stopPropagation(); void navigator.clipboard.writeText(file.path); }}>
                            <span>{file.path}</span>
                            <b className="is-add">+{file.additions}</b>
                            <b className="is-delete">−{file.deletions}</b>
                          </button>
                        ))}
                      </div>
                      <div className="chat-change-actions">
                        {message.changeRequest.commit && <code>{message.changeRequest.commit.slice(0, 8)}</code>}
                        {message.changeRequest.approvals.map((approval) => (
                          <span key={approval.userId} className="chat-change-approved">✓ {approval.username}</span>
                        ))}
                        {message.changeRequest.mergedAt ? (
                          <span className="chat-change-merged">Merged by {message.changeRequest.mergedBy}</span>
                        ) : vaultId ? (
                          <>
                            <button type="button" onClick={(event) => {
                              event.stopPropagation();
                              void api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/approve`, { method: 'POST' });
                            }}>Approve</button>
                            <button type="button" onClick={(event) => {
                              event.stopPropagation();
                              void api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/merge`, { method: 'POST' });
                            }}>Merge</button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  )}
                  {shouldRenderRunPanel(message, selected, isLatestRunningMessage) && (
                    <CascadeRunPanel
                      message={message}
                      onCancelRun={onCancelRun}
                      forceOpen={selected}
                      onContentGrow={onImageLoad}
                      vaultId={vaultId}
                      onHydrateMessage={onHydrateMessage}
                    />
                  )}
                </SwipeToReply>
              );
            })}
          </div>
        </>
      ) : (
        <div className="chat-message-offscreen-stub" />
      )}
    </article>
  );
}, (prev, next) =>
  prev.group === next.group
  && prev.selectedMessageId === next.selectedMessageId
  && prev.avatarKind === next.avatarKind
  && prev.ownerLabel === next.ownerLabel
  && prev.planUsage === next.planUsage
  && prev.latestRunningMessageId === next.latestRunningMessageId
  && prev.runningSiblingCount === next.runningSiblingCount
  && prev.steeringPromptLabels === next.steeringPromptLabels
  && prev.mentionableAliases === next.mentionableAliases
  // Same trick as ChatMessageText: note churn only invalidates groups that
  // actually render an embed.
  && (prev.notes === next.notes || !groupHasDocEmbed(next.group))
  && prev.onOpenNote === next.onOpenNote
  && prev.onOpenSharedNote === next.onOpenSharedNote
  && prev.onCancelRun === next.onCancelRun
  && prev.onToggleSelect === next.onToggleSelect
  && prev.onContextMenu === next.onContextMenu
  && prev.onReply === next.onReply
  && prev.onLightbox === next.onLightbox
  && prev.onImageLoad === next.onImageLoad
  && prev.scrollRootRef === next.scrollRootRef
  && prev.vaultId === next.vaultId
  && prev.onHydrateMessage === next.onHydrateMessage
);

export const ChatView = memo(function ChatView({
  channelId,
  channelName,
  messages,
  isLoadingMessages = false,
  currentUser,
  presence,
  availableAgents,
  registeredAgents,
  vaultAgents = [],
  runnerHealth = null,
  onRegisterAgent,
  onRemoveAgent,
  onUpsertVaultAgent,
  onDeleteVaultAgent,
  onAddVaultAgentToChannel,
  onCreateInviteLink,
  onInviteUser,
  onRemoveParticipant,
  onLeaveChannel,
  onSendMessage,
  onDeleteMessage,
  onForwardMessage,
  onCancelRun,
  notes = EMPTY_NOTES,
  onOpenNote,
  onOpenSharedNote,
  membersOpen: membersOpenProp,
  onMembersOpenChange,
  vaultId,
  onHydrateMessage,
  jumpToMessageId,
  onJumpHandled,
}: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const [usersCollapsedLocal, setUsersCollapsedLocal] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('cascade_chat_users_collapsed') === '1'
  );
  // Controlled from App toolbar when provided; otherwise local desktop rail state.
  const usersCollapsed = onMembersOpenChange
    ? !(membersOpenProp ?? false)
    : usersCollapsedLocal;
  const setUsersCollapsed = useCallback((value: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof value === 'function' ? value(usersCollapsed) : value;
    if (onMembersOpenChange) {
      onMembersOpenChange(!next);
    } else {
      setUsersCollapsedLocal(next);
    }
  }, [onMembersOpenChange, usersCollapsed]);
  /** Agent panel flow: pick existing vault agent, create, or edit membership/identity. */
  const [agentPanelMode, setAgentPanelMode] = useState<'picker' | 'create' | 'edit-member' | 'edit-identity'>('picker');
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteStatus, setInviteStatus] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteLinkBusy, setInviteLinkBusy] = useState(false);
  const [editingRegistrationId, setEditingRegistrationId] = useState<string | null>(null);
  const [agentFormError, setAgentFormError] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [customModel, setCustomModel] = useState('');
  // Channel-wide working directory: when set, every agent in the channel runs
  // from here (overrides each agent's own cwd, enforced server-side).
  const [channelCwd, setChannelCwd] = useState('');
  const [channelCwdSaved, setChannelCwdSaved] = useState(false);
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);

  useEffect(() => {
    if (!vaultId || !channelId) return;
    let alive = true;
    api<{ settings: { cwd: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`)
      .then((d) => { if (alive) setChannelCwd(d.settings?.cwd ?? ''); })
      .catch(() => { /* keep current value */ });
    return () => { alive = false; };
  }, [vaultId, channelId]);

  // `override` lets the workspace panel repoint the channel at a worktree path
  // without waiting for the input's state round-trip.
  const saveChannelCwd = useCallback(async (override?: string) => {
    if (!vaultId) return;
    const next = (override ?? channelCwd).trim();
    if (override !== undefined) setChannelCwd(next);
    try {
      const d = await api<{ settings: { cwd: string } }>(
        `/api/vaults/${vaultId}/channels/${channelId}/settings`,
        { method: 'PUT', body: JSON.stringify({ cwd: next }) },
      );
      setChannelCwd(d.settings?.cwd ?? '');
      setChannelCwdSaved(true);
      window.setTimeout(() => setChannelCwdSaved(false), 1500);
    } catch { /* ignore — transient save failure */ }
  }, [vaultId, channelId, channelCwd]);
  const createDefaultAgentForm = useCallback((): ChatAgentRegistration => {
    const agent = availableAgents[0];
    return {
      id: createChatAgentRegistrationId(),
      agentId: agent?.id ?? '',
      displayName: agent?.label ?? '',
      avatarUrl: '',
      mention: agent?.label.toLowerCase().replace(/\s+/g, '-') ?? '',
      model: agent?.models[0]?.id ?? '',
      reasoningEffort: '',
      cwd: '',
      contextPrompt: '',
      taggableByAgents: false,
      replyToEveryMessage: false,
      orchestrator: false,
      pingableByOthers: false,
      yolo: false,
      conversationId: '',
    };
  }, [availableAgents]);
  const [agentForm, setAgentForm] = useState<ChatAgentRegistration>(() => ({
    id: createChatAgentRegistrationId(),
    agentId: availableAgents[0]?.id ?? '',
    displayName: availableAgents[0]?.label ?? '',
    avatarUrl: '',
    mention: availableAgents[0]?.label.toLowerCase().replace(/\s+/g, '-') ?? '',
    model: availableAgents[0]?.models[0]?.id ?? '',
    reasoningEffort: '',
    cwd: '',
    contextPrompt: '',
    taggableByAgents: false,
    replyToEveryMessage: false,
    orchestrator: false,
    pingableByOthers: false,
    yolo: false,
    conversationId: '',
  }));
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatReplyRef | null>(null);
  const [replyNotifiesAgent, setReplyNotifiesAgent] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: ChatMessage } | null>(null);
  /** Delete is two-step in the context menu rather than a native confirm dialog. */
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<ChatMediaAttachment[]>([]);
  const [mediaError, setMediaError] = useState('');
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [sharedNote, setSharedNote] = useState<SharedChatNote | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  /** Inner content wrapper — ResizeObserver watches height growth (harness, thinking). */
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  // null so the first mount counts as a channel change and force-scrolls to bottom.
  const previousChannelIdRef = useRef<string | null>(null);
  // True while we scroll programmatically, so the resulting scroll events aren't
  // mistaken for the user scrolling away from the bottom (which would unstick).
  const programmaticScrollRef = useRef(false);
  const programmaticClearRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const mentionCycleRef = useRef<{ matches: string[]; index: number; start: number } | null>(null);
  const sortedMessages = useMemo(() => {
    // Index-stable sort: never invent order for messages missing seq. Treating
    // missing seq as MAX_SAFE_INTEGER put an already-persisted agent shell
    // (has seq) *before* the optimistic user prompt (no seq yet) — classic
    // "response then prompt" flip while idle/network races.
    const indexed = messages.map((message, index) => ({ message, index }));
    return indexed
      .filter(({ message }) => {
        if (message.status === 'running' || message.status === 'sending') return true;
        if (message.status === 'failed' || message.status === 'canceled') return true;
        if (message.body?.trim()) return true;
        if (message.images?.length || message.attachments?.length) return true;
        if (hasRunActivity(message)) return true;
        if (message.agentId || message.registrationId || message.runId != null) return false;
        return true;
      })
      .sort((a, b) => {
        const byTime = new Date(a.message.createdAt).getTime() - new Date(b.message.createdAt).getTime();
        if (byTime !== 0) return byTime;
        const seqA = a.message.seq;
        const seqB = b.message.seq;
        if (typeof seqA === 'number' && typeof seqB === 'number' && seqA !== seqB) {
          return seqA - seqB;
        }
        // Incomplete seq pair: keep append order (user is pushed before agent).
        return a.index - b.index;
      })
      .map(({ message }) => message);
  }, [messages]);
  // Grouping recomputes on every message change, but unchanged groups must
  // keep their object identity or ChatGroupRow's memo never hits: reuse the
  // previous group object when the exact same message refs compose it.
  const groupIdentityCacheRef = useRef<Map<string, ChatMessageGroup>>(new Map());
  // Lazily hydrate messages whose data-URL images the list payload stripped.
  // Track only in-flight work, not "ever hydrated": a reconnect can replace a
  // full message with another slim copy and must be allowed to hydrate it again.
  const hydratingImageIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!vaultId || !onHydrateMessage) return;
    for (const message of sortedMessages) {
      if (!message.hasImages || message.images?.length || hydratingImageIdsRef.current.has(message.id)) continue;
      hydratingImageIdsRef.current.add(message.id);
      void api<{ message: ChatMessage }>(
        `/api/vaults/${vaultId}/channels/${message.channelId}/messages/${encodeURIComponent(message.id)}`,
      )
        .then((data) => { if (data.message) onHydrateMessage(data.message); })
        .catch(() => {})
        .finally(() => { hydratingImageIdsRef.current.delete(message.id); });
    }
  }, [sortedMessages, vaultId, onHydrateMessage]);

  const messageGroups = useMemo(() => {
    const fresh = groupChatMessages(sortedMessages);
    const cache = groupIdentityCacheRef.current;
    const nextCache = new Map<string, ChatMessageGroup>();
    const stable = fresh.map((group) => {
      const key = group.messages[0].id;
      const prev = cache.get(key);
      const reusable = prev
        && prev.messages.length === group.messages.length
        && prev.messages.every((message, index) => message === group.messages[index]);
      const chosen = reusable ? prev : group;
      nextCache.set(key, chosen);
      return chosen;
    });
    groupIdentityCacheRef.current = nextCache;
    return stable;
  }, [sortedMessages]);
  const runningMessageState = useMemo(() => {
    return getRunningMessageState(sortedMessages);
  }, [sortedMessages]);
  const steeringPromptLabels = useMemo(() => {
    return getSteeringPromptLabels(sortedMessages, registeredAgents, runningMessageState);
  }, [registeredAgents, runningMessageState, sortedMessages]);
  const registeredAgentRows = useMemo(() => registeredAgents.map((registration) => {
    const agent = availableAgents.find((option) => option.id === registration.agentId);
    return agent ? { ...agent, registration } : null;
  }).filter((agent): agent is ChatAgentOption & { registration: ChatAgentRegistration } => Boolean(agent)), [availableAgents, registeredAgents]);
  const agentAuthors = useMemo(() => new Set(
    registeredAgentRows.flatMap((agent) => [agent.label, agent.registration.displayName].filter(Boolean)),
  ), [registeredAgentRows]);
  const registrationById = useMemo(() => {
    const byId = new Map<string, ChatAgentRegistration>();
    const byAgentOrName = new Map<string, ChatAgentRegistration>();
    for (const agent of registeredAgents) {
      byId.set(agent.id, agent);
      if (agent.agentId) byAgentOrName.set(agent.agentId, agent);
      if (agent.displayName) byAgentOrName.set(agent.displayName, agent);
    }
    return { byId, byAgentOrName };
  }, [registeredAgents]);
  const vaultAgentById = useMemo(() => {
    const map = new Map<string, VaultAgent>();
    for (const agent of vaultAgents) map.set(agent.id, agent);
    return map;
  }, [vaultAgents]);
  const resolveMessageRegistration = (message: ChatMessage) =>
    message.registrationId
      ? registrationById.byId.get(message.registrationId)
      : registrationById.byAgentOrName.get(message.agentId ?? '') ?? registrationById.byAgentOrName.get(message.author);
  const getMessageAvatarKind = (message: ChatMessage): 'agent' | 'human' =>
    message.agentId || agentAuthors.has(message.author) ? 'agent' : 'human';
  const getMessageAvatarUrl = (message: ChatMessage) => {
    return resolveMessageRegistration(message)?.avatarUrl || '';
  };
  const getMessageOwnerLabel = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const identity = registration?.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    return identity?.ownerUsername || '';
  };
  const getMessagePlanUsage = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const agentId = message.agentId || registration?.agentId || '';
    return runnerHealth?.planUsage?.[planUsageProviderId(agentId)] || null;
  };
  const onlineUsers = useMemo(() => new Set(presence.online), [presence.online]);
  const humanMessageAuthors = useMemo(() => {
    const names = new Set<string>();
    for (const message of messages) {
      if (message.author === 'Cascade') continue;
      if (message.agentId || agentAuthors.has(message.author)) continue;
      if (message.author) names.add(message.author);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b)).join('\n');
  }, [agentAuthors, messages]);
  const humanUsers = useMemo(() => {
    const names = new Set<string>(presence.participants);
    if (currentUser) names.add(currentUser);
    for (const name of humanMessageAuthors.split('\n')) {
      if (name) names.add(name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [currentUser, humanMessageAuthors, presence.participants]);
  const mentionableAliases = useMemo(() => {
    const aliases = new Set<string>();
    for (const registration of registeredAgents) {
      const mention = normalizeMention(registration.mention || registration.agentId);
      if (mention) aliases.add(mention);
    }
    for (const name of humanUsers) {
      if (name) aliases.add(name);
    }
    return Array.from(aliases);
  }, [humanUsers, registeredAgents]);
  const activeFormAgent = availableAgents.find((agent) => agent.id === agentForm.agentId);
  const openSharedNote = useCallback(async (messageId: string, title: string) => {
    const note = await onOpenSharedNote?.(channelId, messageId, title);
    if (note) setSharedNote(note);
  }, [channelId, onOpenSharedNote]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    // Only persist local (desktop) preference — mobile toolbar state is App-owned.
    if (!onMembersOpenChange) {
      localStorage.setItem('cascade_chat_users_collapsed', usersCollapsed ? '1' : '0');
    }
    if (usersCollapsed) {
      setAgentMenuOpen(false);
      setInviteOpen(false);
      setEditingRegistrationId(null);
    }
  }, [usersCollapsed, onMembersOpenChange]);

  /** Suppress sticky pin for a short window after the user scrolls (RO noise). */
  const userScrollQuietUntilRef = useRef(0);
  /** Only trusted user gestures may detach sticky-bottom; layout scroll events may not. */
  const userScrollIntentUntilRef = useRef(0);

  /** Pin the scroller to the bottom now, flagging it as a programmatic scroll. */
  const scrollToBottom = useCallback(() => {
    const el = messagesRef.current;
    if (!el) return;
    // Never yank the list while the user is actively scrolling history.
    if (performance.now() < userScrollQuietUntilRef.current) return;
    if (!wasAtBottomRef.current && previousChannelIdRef.current === channelId) return;
    programmaticScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
    // Content often grows in the same frame as the pin (stream tokens, harness).
    // One follow-up rAF catches the race without a second RO cycle.
    requestAnimationFrame(() => {
      const scroller = messagesRef.current;
      if (!scroller) return;
      if (performance.now() < userScrollQuietUntilRef.current) return;
      if (!wasAtBottomRef.current && previousChannelIdRef.current === channelId) return;
      if (!isAtScrollBottom(scroller)) {
        programmaticScrollRef.current = true;
        scroller.scrollTop = scroller.scrollHeight;
      }
    });
    if (programmaticClearRef.current != null) clearTimeout(programmaticClearRef.current);
    programmaticClearRef.current = window.setTimeout(() => {
      programmaticClearRef.current = null;
      programmaticScrollRef.current = false;
    }, 120);
  }, [channelId]);

  const scrollToBottomIfSticky = useCallback(() => {
    if (!wasAtBottomRef.current) return;
    if (performance.now() < userScrollQuietUntilRef.current) return;
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (wasAtBottomRef.current && performance.now() >= userScrollQuietUntilRef.current) {
        scrollToBottom();
      }
    });
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (previousChannelIdRef.current !== channelId) {
      // New channel (or first mount): force the view to the bottom, re-pinning
      // across a few frames because markdown/images/widgets settle after paint.
      previousChannelIdRef.current = channelId;
      wasAtBottomRef.current = true;
      userScrollQuietUntilRef.current = 0;
      scrollToBottom();
      requestAnimationFrame(scrollToBottom);
      const t1 = window.setTimeout(scrollToBottom, 60);
      const t2 = window.setTimeout(scrollToBottom, 200);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
    scrollToBottomIfSticky();
  }, [sortedMessages.length, channelId, scrollToBottom, scrollToBottomIfSticky]);

  // Jump to a specific message (e.g. clicked from search). Waits until the
  // target is in this channel's list, force-mounts + highlights its group via
  // the selection state, then scrolls it to center. Auto-pin-to-bottom is
  // suppressed so the freshly-opened channel doesn't yank us back down.
  const jumpHandledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jumpToMessageId) { jumpHandledRef.current = null; return; }
    if (jumpHandledRef.current === jumpToMessageId) return;
    if (!sortedMessages.some((message) => message.id === jumpToMessageId)) return;
    jumpHandledRef.current = jumpToMessageId;
    setSelectedMessageId(jumpToMessageId);
    wasAtBottomRef.current = false;
    userScrollQuietUntilRef.current = performance.now() + 1200;
    const targetId = jumpToMessageId;
    const scrollToTarget = () => {
      const scroller = messagesRef.current;
      if (!scroller) return false;
      const selector = `[data-message-id="${(window.CSS?.escape ?? String)(targetId)}"]`;
      const el = scroller.querySelector<HTMLElement>(selector);
      if (!el) return false;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    };
    // The group may still be mounting from its offscreen placeholder; retry a
    // few frames so scrollIntoView runs against the settled layout.
    let tries = 0;
    let timer = 0;
    const tick = () => {
      const done = scrollToTarget();
      tries += 1;
      if (!done || tries < 4) timer = window.setTimeout(tick, 90);
    };
    const raf = requestAnimationFrame(tick);
    onJumpHandled?.();
    return () => { cancelAnimationFrame(raf); if (timer) clearTimeout(timer); };
  }, [jumpToMessageId, sortedMessages, onJumpHandled]);

  // Keep a bottom-following chat pinned when either its content grows or the
  // viewport shrinks (for example, when the reply banner mounts above the
  // composer). Watching content alone leaves the last rows below the fold.
  useEffect(() => {
    const content = messagesContentRef.current;
    const viewport = messagesRef.current;
    if ((!content && !viewport) || typeof ResizeObserver === 'undefined') return;
    let roFrame: number | null = null;
    const ro = new ResizeObserver(() => {
      // Coalesce RO storms (markdown/images/fonts) to one rAF — was a scroll jank source.
      if (roFrame != null) return;
      roFrame = requestAnimationFrame(() => {
        roFrame = null;
        scrollToBottomIfSticky();
      });
    });
    if (content) ro.observe(content);
    if (viewport) ro.observe(viewport);
    return () => {
      if (roFrame != null) cancelAnimationFrame(roFrame);
      ro.disconnect();
    };
  }, [channelId, scrollToBottomIfSticky]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
    if (programmaticClearRef.current != null) clearTimeout(programmaticClearRef.current);
  }, []);

  const updateBottomStickiness = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    const atBottom = isAtScrollBottom(element);
    // Programmatic pins set scrollTop then fire scroll events. Content can also
    // grow mid-pin (agent stream / harness), leaving !atBottom without any user
    // gesture — that must NOT clear wasAtBottom or sticky follow dies for the
    // rest of the run. Only detach mid-pin when a real user intent is active.
    if (programmaticScrollRef.current) {
      if (!atBottom && performance.now() < userScrollIntentUntilRef.current) {
        programmaticScrollRef.current = false;
        wasAtBottomRef.current = false;
        userScrollQuietUntilRef.current = performance.now() + 220;
      }
      return;
    }
    // Content growth, scroll anchoring, and virtualization can emit scroll
    // events without user input. Those must not silently detach a bottom-pinned
    // desktop viewport before the agent response arrives.
    if (performance.now() >= userScrollIntentUntilRef.current) {
      if (atBottom) wasAtBottomRef.current = true;
      return;
    }
    wasAtBottomRef.current = atBottom;
    // While reading history, ignore ResizeObserver sticky pins briefly.
    if (!atBottom) {
      userScrollQuietUntilRef.current = performance.now() + 220;
    }
  }, []);

  // Native passive scroll listener — React's onScroll isn't passive and can
  // block compositor scrolling on long threads.
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateBottomStickiness, { passive: true });
    return () => el.removeEventListener('scroll', updateBottomStickiness);
  }, [channelId, updateBottomStickiness]);

  useEffect(() => {
    setReplyTarget(null);
    setReplyNotifiesAgent(true);
    setContextMenu(null);
  }, [channelId]);

  useEffect(() => {
    if (!lightboxSrc) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLightboxSrc(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightboxSrc]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const close = () => {
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentFormError('');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [agentMenuOpen]);

  function openAgentEditor(registration?: ChatAgentRegistration) {
    setAgentFormError('');
    if (registration) {
      const agent = availableAgents.find((option) => option.id === registration.agentId);
      const { choice, custom } = resolveModelPicker(agent, registration.model);
      setModelChoice(choice);
      setCustomModel(custom);
      setAgentForm({ ...registration, model: modelFromPicker(choice, custom) });
      setEditingRegistrationId(registration.id);
    } else {
      const form = createDefaultAgentForm();
      const agent = availableAgents.find((option) => option.id === form.agentId);
      const { choice, custom } = resolveModelPicker(agent, form.model);
      setModelChoice(choice);
      setCustomModel(custom);
      setAgentForm(form);
      setEditingRegistrationId(null);
    }
    setAgentMenuOpen(true);
  }

  function openAgentMenu() {
    setUsersCollapsed(false);
    // sidebarMode was removed when the activity panel moved to the top-bar
    // session manager (0352fd6e) — calling setSidebarMode here threw and
    // silently killed the Add-agent button.
    if (agentMenuOpen) {
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentFormError('');
      setAgentPanelMode('picker');
      return;
    }
    // Prefer picker of vault agents; fall back to create form.
    setAgentPanelMode(vaultAgents.length > 0 || onAddVaultAgentToChannel ? 'picker' : 'create');
    openAgentEditor();
  }

  function toggleInvite() {
    setUsersCollapsed(false);
    setInviteStatus('');
    setInviteOpen((value) => !value);
  }

  function editRegisteredAgent(event: React.MouseEvent, registration: ChatAgentRegistration) {
    event.stopPropagation();
    // Channel membership edit: flags + session. Identity via edit-identity.
    setAgentPanelMode('edit-member');
    openAgentEditor(registration);
  }

  function editVaultIdentity(event: React.MouseEvent, registration: ChatAgentRegistration) {
    event.stopPropagation();
    setAgentPanelMode('edit-identity');
    openAgentEditor(registration);
  }

  const channelVaultAgentIds = useMemo(
    () => new Set(registeredAgents.map((r) => r.vaultAgentId).filter(Boolean) as string[]),
    [registeredAgents],
  );

  async function addVaultAgentFromPicker(vaultAgentId: string) {
    setAgentFormError('');
    try {
      if (onAddVaultAgentToChannel) {
        await onAddVaultAgentToChannel(channelId, vaultAgentId);
      } else {
        const va = vaultAgents.find((a) => a.id === vaultAgentId);
        if (!va) return;
        onRegisterAgent(channelId, {
          id: createChatAgentRegistrationId(),
          vaultAgentId: va.id,
          agentId: va.agentId,
          displayName: va.displayName,
          avatarUrl: va.avatarUrl,
          mention: va.mention,
          model: va.model,
          reasoningEffort: '',
          cwd: va.cwd,
          contextPrompt: va.contextPrompt,
          taggableByAgents: false,
          replyToEveryMessage: false,
          orchestrator: false,
          pingableByOthers: false,
          yolo: false,
          conversationId: '',
        });
      }
      setAgentMenuOpen(false);
      setAgentPanelMode('picker');
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : 'Could not add agent');
    }
  }

  const startReply = useCallback((message: ChatMessage) => {
    setReplyTarget(buildReplyRef(message, registeredAgents));
    setReplyNotifiesAgent(true);
    setContextMenu(null);
    // Focus after paint so the reply bar is mounted first (esp. mobile keyboard).
    requestAnimationFrame(() => draftRef.current?.focus());
  }, [registeredAgents]);

  const openMessageContextMenu = useCallback((event: React.MouseEvent, message: ChatMessage) => {
    event.preventDefault();
    event.stopPropagation();
    setDeleteArmed(false);
    setContextMenu({ x: event.clientX, y: event.clientY, message });
  }, []);

  /** Message queued for forwarding; drives the channel picker overlay. */
  const [forwardSource, setForwardSource] = useState<ChatMessage | null>(null);
  const [forwardQuery, setForwardQuery] = useState('');
  const [forwardError, setForwardError] = useState('');
  const [forwardingTo, setForwardingTo] = useState<string | null>(null);

  /** Chat channels in this vault, minus the one we are already reading. */
  const forwardTargets = useMemo(() => {
    const query = forwardQuery.trim().toLowerCase();
    return notes
      .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
      .filter((note) => note.id !== channelId)
      .filter((note) => !query || note.title.toLowerCase().includes(query))
      .slice(0, 50);
  }, [notes, channelId, forwardQuery]);

  const startForward = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    setForwardQuery('');
    setForwardError('');
    setForwardSource(message);
  }, []);

  const forwardTo = useCallback(async (targetChannelId: string) => {
    if (!forwardSource || !onForwardMessage) return;
    setForwardingTo(targetChannelId);
    setForwardError('');
    try {
      await onForwardMessage(forwardSource.channelId || channelId, forwardSource.id, targetChannelId);
      setForwardSource(null);
    } catch (error) {
      setForwardError(error instanceof Error ? error.message : 'Could not forward message');
    } finally {
      setForwardingTo(null);
    }
  }, [forwardSource, onForwardMessage, channelId]);

  const deleteMessage = useCallback((message: ChatMessage) => {
    setContextMenu(null);
    setDeleteArmed(false);
    void onDeleteMessage?.(message.channelId || channelId, message.id);
  }, [onDeleteMessage, channelId]);

  const toggleMessageSelection = useCallback((id: string) => {
    setSelectedMessageId((current) => (current === id ? null : id));
  }, []);

  const openLightbox = useCallback((src: string) => setLightboxSrc(src), []);

  async function submitAgentRegistration(event: React.FormEvent) {
    event.preventDefault();
    if (!agentForm.agentId) return;
    const mention = normalizeMention(agentForm.mention || '');
    if (!mention && agentPanelMode !== 'edit-member') {
      setAgentFormError('Choose a unique @ handle.');
      return;
    }
    if (agentPanelMode !== 'edit-member' && mention) {
      // Vault-wide uniqueness (not just this channel) — every agent is a persistent entity.
      const vaultClash = vaultAgents.some((va) =>
        va.id !== agentForm.vaultAgentId
        && normalizeMention(va.mention) === mention,
      );
      if (vaultClash) {
        setAgentFormError(`@${mention} is already used by another vault agent.`);
        return;
      }
      const channelClash = registeredAgents.some((registration) =>
        registration.id !== agentForm.id
        && registration.vaultAgentId !== agentForm.vaultAgentId
        && normalizeMention(registration.mention) === mention,
      );
      if (channelClash) {
        setAgentFormError(`@${mention} is already used in this channel.`);
        return;
      }
    }
    const model = modelFromPicker(modelChoice, customModel);
    if (!model && agentPanelMode !== 'edit-member') {
      setAgentFormError('Choose a model or enter a custom model ID.');
      return;
    }

    try {
      if (agentPanelMode === 'edit-identity' && onUpsertVaultAgent && agentForm.vaultAgentId) {
        await onUpsertVaultAgent({
          id: agentForm.vaultAgentId,
          agentId: agentForm.agentId,
          displayName: agentForm.displayName.trim(),
          mention,
          model,
          cwd: agentForm.cwd.trim(),
          contextPrompt: agentForm.contextPrompt.trim(),
        });
        // Also refresh this channel membership copy
        onRegisterAgent(channelId, {
          ...agentForm,
          displayName: agentForm.displayName.trim(),
          mention,
          model,
          cwd: agentForm.cwd.trim(),
          contextPrompt: agentForm.contextPrompt.trim(),
        });
      } else if (agentPanelMode === 'create' && onUpsertVaultAgent) {
        const va = await onUpsertVaultAgent({
          agentId: agentForm.agentId,
          displayName: agentForm.displayName.trim() || agentForm.agentId,
          mention,
          model,
          cwd: agentForm.cwd.trim(),
          contextPrompt: agentForm.contextPrompt.trim(),
        });
        const vaultAgentId = va?.id || agentForm.vaultAgentId || '';
        if (vaultAgentId && onAddVaultAgentToChannel) {
          await onAddVaultAgentToChannel(channelId, vaultAgentId);
          // Persist membership-only flags selected in the create form. Adding
          // the vault identity alone intentionally starts with safe defaults.
          onRegisterAgent(channelId, {
            ...agentForm,
            id: agentForm.id || createChatAgentRegistrationId(),
            vaultAgentId,
            displayName: agentForm.displayName.trim(),
            mention,
            model,
            cwd: agentForm.cwd.trim(),
            contextPrompt: agentForm.contextPrompt.trim(),
          });
        } else {
          onRegisterAgent(channelId, {
            ...agentForm,
            id: agentForm.id || createChatAgentRegistrationId(),
            vaultAgentId,
            displayName: agentForm.displayName.trim(),
            mention,
            model,
            cwd: agentForm.cwd.trim(),
            contextPrompt: agentForm.contextPrompt.trim(),
          });
        }
      } else {
        // edit-member (or fallback create without vault-agent API).
        // Model is canonical on the vault identity — the membership PUT echoes
        // it back from vault_agents — so a model change here must go through
        // onUpsertVaultAgent, else it silently reverts. Membership-only flags
        // (taggable/reply/pingable/yolo) still persist via onRegisterAgent.
        if (agentForm.vaultAgentId && onUpsertVaultAgent && model) {
          await onUpsertVaultAgent({
            id: agentForm.vaultAgentId,
            agentId: agentForm.agentId,
            displayName: agentForm.displayName.trim(),
            mention: mention || agentForm.mention,
            model,
            cwd: agentForm.cwd.trim(),
            contextPrompt: agentForm.contextPrompt.trim(),
          });
        }
        onRegisterAgent(channelId, {
          ...agentForm,
          id: agentForm.id || createChatAgentRegistrationId(),
          displayName: agentForm.displayName.trim(),
          mention: mention || agentForm.mention,
          model: model || agentForm.model,
          cwd: agentForm.cwd.trim(),
          contextPrompt: agentForm.contextPrompt.trim(),
        });
      }
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentPanelMode('picker');
      setAgentFormError('');
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : 'Could not save agent');
    }
  }

  async function submitInvite(event: React.FormEvent) {
    event.preventDefault();
    const username = inviteUsername.trim().replace(/^@+/, '').toLowerCase();
    if (!username) {
      setInviteStatus('Enter a username.');
      return;
    }
    setInviteBusy(true);
    setInviteStatus('');
    try {
      await onInviteUser(channelId, username);
      setInviteUsername('');
      setInviteStatus(`Invited @${username}.`);
    } catch (error) {
      setInviteStatus(error instanceof Error ? error.message : 'Could not invite user');
    } finally {
      setInviteBusy(false);
    }
  }

  async function copyInviteLink() {
    setInviteLinkBusy(true);
    setInviteStatus('');
    try {
      const url = await onCreateInviteLink(channelId);
      await navigator.clipboard.writeText(url);
      setInviteStatus('Invite link copied.');
    } catch (error) {
      setInviteStatus(error instanceof Error ? error.message : 'Could not copy invite link');
    } finally {
      setInviteLinkBusy(false);
    }
  }

  const addMediaFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    const next: ChatMediaAttachment[] = [];
    for (const file of files) {
      const item = await readMediaFile(file);
      if (!item) {
        setMediaError(`"${file.name}" is too large (max ${CHAT_MEDIA_MAX_BYTES / (1024 * 1024)}MB).`);
        continue;
      }
      next.push(item);
    }
    if (next.length === 0) return;
    setMediaError('');
    setPendingMedia((prev) => [...prev, ...next].slice(0, CHAT_MEDIA_LIMIT));
  }, []);

  const addDesktopClipboardImage = useCallback(async () => {
    const image = await getElectronClipboardAPI()?.readClipboardImage?.();
    if (!image?.data || !isImageMediaType(image.media_type)) return false;
    setMediaError('');
    setPendingMedia((prev) => [...prev, image].slice(0, CHAT_MEDIA_LIMIT));
    return true;
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.items || [])
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    if (files.length === 0) {
      const types = Array.from(event.clipboardData?.types || []);
      if (types.some((type) => type === 'text/plain' || type === 'text/html' || type === 'text/uri-list')) return;
      void addDesktopClipboardImage();
      return;
    }
    event.preventDefault();
    void addMediaFiles(files);
  }, [addDesktopClipboardImage, addMediaFiles]);

  const handleUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    void addMediaFiles(files);
  }, [addMediaFiles]);

  const insertEmbedInDraft = useCallback((noteId: string, textarea: HTMLTextAreaElement) => {
    const embedded = notes.find((note) => note.id === noteId);
    if (!embedded) return false;
    const insert = noteEmbedMarkdown(embedded);
    const start = textarea.selectionStart ?? draft.length;
    const end = textarea.selectionEnd ?? start;
    const needsPrefix = start > 0 && !/\s/.test(draft.slice(start - 1, start)) ? ' ' : '';
    const needsSuffix = end < draft.length && !/\s/.test(draft.slice(end, end + 1)) ? ' ' : '';
    const text = `${needsPrefix}${insert}${needsSuffix}`;
    setDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + text.length;
      textarea.setSelectionRange(cursor, cursor);
    });
    return true;
  }, [draft, notes]);

  function submit() {
    const body = draft.trim();
    if (!body && pendingMedia.length === 0) return;
    const reply = replyTarget
      ? prepareReplyForSend(replyTarget, replyNotifiesAgent)
      : undefined;
    onSendMessage(channelId, body, pendingMedia, reply);
    setDraft('');
    setPendingMedia([]);
    setMediaError('');
    setReplyTarget(null);
  }

  // Tab-complete an "@handle" from the mentionable list. Repeated Tab cycles
  // through the matches for the same partial. Returns true when it handled the key.
  function completeMention(textarea: HTMLTextAreaElement): boolean {
    const value = textarea.value;
    const cursor = textarea.selectionStart ?? value.length;
    const cycle = mentionCycleRef.current;
    const cycleToken = cycle ? `@${cycle.matches[cycle.index]} ` : '';
    const canCycle = Boolean(cycle
      && cursor === cycle.start + cycleToken.length
      && value.slice(cycle.start, cursor) === cycleToken);
    let next: { matches: string[]; index: number; start: number };
    if (canCycle && cycle) {
      next = { matches: cycle.matches, index: (cycle.index + 1) % cycle.matches.length, start: cycle.start };
    } else {
      const match = /@([\w-]*)$/.exec(value.slice(0, cursor));
      if (!match) return false;
      const start = cursor - match[0].length;
      const partial = match[1].toLowerCase();
      const matches = mentionableAliases.filter((alias) => alias.toLowerCase().startsWith(partial));
      if (matches.length === 0) return false;
      next = { matches, index: 0, start };
    }
    mentionCycleRef.current = next;
    // Append a trailing space so the caret lands ready for the message text.
    const chosen = `@${next.matches[next.index]} `;
    const caret = next.start + chosen.length;
    setDraft(`${value.slice(0, next.start)}${chosen}${value.slice(cursor)}`);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
    return true;
  }

  function isCompletingMention(textarea: HTMLTextAreaElement): boolean {
    const cursor = textarea.selectionStart ?? textarea.value.length;
    const value = textarea.value;
    if (/@[\w-]*$/.test(value.slice(0, cursor))) return true;
    // Keep Tab-cycling alive right after we inserted "@handle " (with its space).
    const cycle = mentionCycleRef.current;
    if (!cycle) return false;
    const cycleToken = `@${cycle.matches[cycle.index]} `;
    return cursor === cycle.start + cycleToken.length
      && value.slice(cycle.start, cursor) === cycleToken;
  }
  const canSend = draft.trim().length > 0 || pendingMedia.length > 0;

  useLayoutEffect(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 180);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, [draft]);

  return (
    <section className="chat-view">
      <div className="chat-main">
        <header className="chat-header">
          <div className="chat-header-copy">
            <h2>{channelName}</h2>
            <span>{sortedMessages.length} messages</span>
          </div>
        </header>

        <div
          ref={messagesRef}
          className="chat-messages"
          role="log"
          aria-label={`${channelName} messages`}
          onTouchStart={(event) => {
            touchStartYRef.current = event.touches[0]?.clientY ?? null;
          }}
          onTouchMove={(event) => {
            const startY = touchStartYRef.current;
            const currentY = event.touches[0]?.clientY;
            // Only a finger moving down means "read older messages". A touch
            // at the bottom or an upward swipe must not disarm sticky-follow
            // just before a new agent row changes the layout.
            if (shouldDetachStickyForTouch(startY, currentY)) {
              programmaticScrollRef.current = false;
              userScrollIntentUntilRef.current = performance.now() + 500;
            }
          }}
          onTouchEnd={() => { touchStartYRef.current = null; }}
          onWheel={(event) => {
            // Scrolling upward is the only wheel gesture that intentionally
            // detaches from the live edge. Downward wheel noise at the bottom
            // previously caused intermittent missed agent auto-scrolls.
            if (shouldDetachStickyForWheel(event.deltaY)) {
              programmaticScrollRef.current = false;
              userScrollIntentUntilRef.current = performance.now() + 180;
            }
          }}
        >
          <div ref={messagesContentRef} className="chat-messages-content">
          {/* Never blank an already-loaded transcript for a background refresh. */}
          {isLoadingMessages && sortedMessages.length === 0 ? (
            <div className="chat-empty" aria-live="polite">
              <span className="chat-loading-dot" aria-hidden="true" />
              <strong>Loading messages…</strong>
            </div>
          ) : sortedMessages.length === 0 ? (
            <div className="chat-empty">
              <Hash size={24} />
              <strong>#{channelName}</strong>
            </div>
          ) : (
            messageGroups.map((group) => {
              const head = group.messages[0];
              const groupSelected = selectedMessageId != null
                && group.messages.some((message) => message.id === selectedMessageId);
              const runKey = head.registrationId || head.agentId || '';
              const runState = runKey ? runningMessageState.get(runKey) : undefined;
              return (
                <ChatGroupRow
                  key={head.id}
                  group={group}
                  selectedMessageId={groupSelected ? selectedMessageId : null}
                  avatarKind={getMessageAvatarKind(head)}
                  avatarUrl={getMessageAvatarUrl(head)}
                  ownerLabel={getMessageOwnerLabel(head)}
                  planUsage={getMessagePlanUsage(head)}
                  latestRunningMessageId={runState?.latestId}
                  runningSiblingCount={runState?.count || 0}
                  steeringPromptLabels={steeringPromptLabels}
                  mentionableAliases={mentionableAliases}
                  notes={notes}
                  onOpenNote={onOpenNote}
                  onOpenSharedNote={openSharedNote}
                  onCancelRun={onCancelRun}
                  onToggleSelect={toggleMessageSelection}
                  onContextMenu={openMessageContextMenu}
                  onReply={startReply}
                  onLightbox={openLightbox}
                  onImageLoad={scrollToBottomIfSticky}
                  scrollRootRef={messagesRef}
                  vaultId={vaultId}
                  onHydrateMessage={onHydrateMessage}
                />
              );
            })
          )}
          <div ref={endRef} />
          </div>
        </div>

        <footer
          className="chat-composer"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(e) => {
            const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
            const textarea = draftRef.current;
            if (!noteId || !textarea) return;
            e.preventDefault();
            insertEmbedInDraft(noteId, textarea);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="chat-media-input"
            accept="image/*,video/*,audio/*,.pdf,.txt,.md"
            multiple
            onChange={handleUpload}
          />
          <button
            type="button"
            className="btn-icon chat-upload-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Upload media"
          >
            <ImagePlus size={17} />
          </button>
          <div className="chat-composer-main">
            {replyTarget && (
              <div className="chat-reply-bar">
                <div className="chat-reply-bar-copy">
                  <span className="chat-reply-bar-label">
                    Replying to <strong>@{replyTarget.mention}</strong>
                  </span>
                  <span className="chat-reply-bar-preview">{replyTarget.preview}</span>
                </div>
                {registeredAgents.some((agent) => normalizeMention(agent.mention) === normalizeMention(replyTarget.mention)) && (
                  <button
                    type="button"
                    className={`chat-reply-mention-toggle${replyNotifiesAgent ? ' active' : ''}`}
                    aria-pressed={replyNotifiesAgent}
                    title={replyNotifiesAgent ? `Turn off notification for @${replyTarget.mention}` : `Notify @${replyTarget.mention}`}
                    onClick={() => setReplyNotifiesAgent((value) => !value)}
                  >
                    @{replyNotifiesAgent ? 'ON' : 'OFF'}
                  </button>
                )}
                <button
                  type="button"
                  className="chat-reply-bar-close"
                  title="Cancel reply"
                  onClick={() => {
                    setReplyTarget(null);
                    setReplyNotifiesAgent(true);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            {pendingMedia.length > 0 && (
              <div className="chat-paste-previews">
                {pendingMedia.map((item, index) => (
                  <div key={`${item.name || 'media'}-${index}`} className="chat-paste-thumb">
                    {isImageMediaType(item.media_type) ? (
                      <img src={item.url} alt="" />
                    ) : (
                      <div className="chat-paste-file">
                        <Paperclip size={14} />
                        <span>{item.name || 'file'}</span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="chat-paste-remove"
                      title="Remove"
                      onClick={() => setPendingMedia((prev) => prev.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <textarea
              ref={draftRef}
              value={draft}
              placeholder={replyTarget ? `Reply to @${replyTarget.mention}` : `Message #${channelName}`}
              spellCheck
              rows={1}
              onChange={(e) => {
                setDraft(e.target.value);
                mentionCycleRef.current = null;
              }}
              onPaste={handlePaste}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(NOTE_DND_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(e) => {
                const noteId = e.dataTransfer.getData(NOTE_DND_TYPE);
                if (!noteId) return;
                e.preventDefault();
                e.stopPropagation();
                insertEmbedInDraft(noteId, e.currentTarget);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey && isCompletingMention(e.currentTarget)) {
                  e.preventDefault();
                  completeMention(e.currentTarget);
                  return;
                }
                if (e.key === 'Escape' && replyTarget) {
                  e.preventDefault();
                  setReplyTarget(null);
                  setReplyNotifiesAgent(true);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <button className="btn-icon" onClick={submit} title="Send message" disabled={!canSend}>
            <Send size={17} />
          </button>
          {mediaError && <span className="chat-media-error">{mediaError}</span>}
        </footer>
      </div>

      {contextMenu && (
        <div
          className="chat-context-menu"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => startReply(contextMenu.message)}>
            <Reply size={14} />
            Reply
          </button>
          {onForwardMessage && (
            <button type="button" onClick={() => startForward(contextMenu.message)}>
              <Forward size={14} />
              Forward
            </button>
          )}
          {onDeleteMessage && (
            <button
              type="button"
              className={`is-danger${deleteArmed ? ' is-armed' : ''}`}
              onClick={() => (deleteArmed ? deleteMessage(contextMenu.message) : setDeleteArmed(true))}
            >
              <Trash2 size={14} />
              {deleteArmed ? 'Delete for everyone?' : 'Delete message'}
            </button>
          )}
        </div>
      )}

      <aside
        className={`chat-users${usersCollapsed ? ' is-collapsed' : ''}`}
        aria-label="Chat users"
      >
        <ChatSidebarButtons
          collapsed={usersCollapsed}
          inviteSelected={inviteOpen}
          agentSelected={agentMenuOpen}
          settingsSelected={channelSettingsOpen}
          onToggleCollapsed={() => setUsersCollapsed((value) => !value)}
          onInvite={toggleInvite}
          onAgent={openAgentMenu}
          onSettings={() => {
            setUsersCollapsed(false);
            setChannelSettingsOpen((open) => !open);
          }}
        />

        {!usersCollapsed && channelSettingsOpen && (
          <div className="chat-channel-settings-panel">
            <div className="chat-channel-settings-heading">
              <strong>Agent settings</strong>
              <button type="button" onClick={() => setChannelSettingsOpen(false)} aria-label="Close settings"><X size={12} /></button>
            </div>
            <label htmlFor={`chat-cwd-${channelId}`}>Working directory</label>
            <div className="chat-channel-cwd">
              <input
                id={`chat-cwd-${channelId}`}
                value={channelCwd}
                onChange={(e) => setChannelCwd(e.target.value)}
                onBlur={() => void saveChannelCwd()}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                placeholder="~/project"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              {channelCwdSaved && <span className="chat-channel-cwd-saved">saved</span>}
            </div>
            <p>Overrides each agent's own working directory in this channel.</p>
            <ChatWorkspacePanel
              channelId={channelId}
              channelName={channelName}
              cwd={channelCwd}
              onUseWorkspace={(path) => { void saveChannelCwd(path); }}
            />
          </div>
        )}

        {!usersCollapsed && (
          <>
        {inviteOpen && (
          <form className="chat-invite-menu" onSubmit={submitInvite} onClick={(event) => event.stopPropagation()}>
            <button type="button" className="chat-copy-invite-btn" onClick={copyInviteLink} disabled={inviteLinkBusy}>
              <Copy size={13} />
              {inviteLinkBusy ? 'Copying' : 'Copy invite link'}
            </button>
            <label>
              Username
              <input
                value={inviteUsername}
                placeholder="username"
                autoFocus
                spellCheck={false}
                onChange={(event) => {
                  setInviteStatus('');
                  setInviteUsername(event.target.value.replace(/^@+/, ''));
                }}
              />
            </label>
            {inviteStatus && <div className="chat-invite-status">{inviteStatus}</div>}
            <div className="chat-agent-menu-actions">
              <button type="button" onClick={() => setInviteOpen(false)}>Cancel</button>
              <button type="submit" disabled={inviteBusy}>{inviteBusy ? 'Inviting' : 'Invite'}</button>
            </div>
          </form>
        )}

        <div className="chat-users-title">People</div>
        {humanUsers.map((name) => {
          const isSelf = name === currentUser;
          const isOnline = isSelf || onlineUsers.has(name);
          const isOwner = name === presence.owner;
          return (
          <div className={`chat-user chat-human${isOnline ? '' : ' is-offline'}`} key={name}>
            <div className="chat-user-row">
              <ChatAvatar name={name} kind="human" size="sm" />
              <div className="chat-user-copy">
                <strong>{name}</strong>
                <span>{isOwner ? 'owner' : isSelf ? 'you' : isOnline ? 'online' : 'offline'}</span>
              </div>
            </div>
            {presence.owner === currentUser && !isSelf && onRemoveParticipant && (
              <button type="button" className="chat-remove-agent" title={`Remove @${name}`} onClick={() => void onRemoveParticipant(channelId, name)}>
                <X size={12} />
              </button>
            )}
            {isSelf && !isOwner && onLeaveChannel && (
              <button type="button" className="chat-remove-agent" title="Leave channel" onClick={() => void onLeaveChannel(channelId)}>
                <X size={12} />
              </button>
            )}
          </div>
          );
        })}

        <div className="chat-agent-section">
          <div className="chat-users-title">Agents in this channel</div>
          {registeredAgentRows.length === 0 && (
            <div className="chat-runs-empty">No agents yet — add from vault</div>
          )}
          {registeredAgentRows.map((agent) => {
          const selectedModel = agent.registration.model || agent.models[0]?.id || '';
          const isEditing = editingRegistrationId === agent.registration.id && agentMenuOpen;
          const planUsage = runnerHealth?.planUsage?.[planUsageProviderId(agent.registration.agentId)] || null;
          return (
            <div
              className={`chat-user chat-agent-user${isEditing ? ' is-editing' : ''}`}
              key={agent.registration.id}
            >
              <button
                type="button"
                className="chat-agent-edit-btn"
                onClick={(event) => editRegisteredAgent(event, agent.registration)}
                title="Channel settings for this agent"
              >
                <ChatAvatar name={agent.registration.displayName || agent.label} kind="agent" avatarUrl={agent.registration.avatarUrl} size="sm" />
                <div className="chat-user-copy">
                  <strong>{agent.registration.displayName || agent.label}</strong>
                  <span>@{agent.registration.mention || agent.id} · {selectedModel || 'no model'}</span>
                  {planUsage && <PlanUsageMeters usage={planUsage} stacked />}
                </div>
              </button>
              <button
                type="button"
                className="chat-remove-agent"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemoveAgent(channelId, agent.registration.id);
                }}
                title="Remove agent from channel"
              >
                <X size={12} />
              </button>
            </div>
          );
          })}

          {agentMenuOpen && agentPanelMode === 'picker' && (
          <div className="chat-agent-menu" onClick={(event) => event.stopPropagation()}>
            <div className="chat-agent-menu-heading">Add agent to #{channelName}</div>
            {vaultAgents.length === 0 ? (
              <div className="chat-runs-empty">No vault agents yet</div>
            ) : (
              vaultAgents.map((va) => {
                const inChannel = channelVaultAgentIds.has(va.id);
                const nCh = va.channelIds?.length ?? 0;
                return (
                  <div key={va.id} className={`chat-vault-pick-row${inChannel ? ' is-in-channel' : ''}`}>
                    <button
                      type="button"
                      className="chat-vault-pick-btn"
                      disabled={inChannel}
                      onClick={() => {
                        if (!inChannel) void addVaultAgentFromPicker(va.id);
                      }}
                      title={inChannel ? 'Already in this channel' : 'Add to this channel'}
                    >
                      <ChatAvatar name={va.displayName || va.mention} kind="agent" avatarUrl={va.avatarUrl} size="sm" />
                      <span className="chat-user-copy">
                        <strong>{va.displayName || va.mention}</strong>
                        <span>
                          @{va.mention} · {va.model || va.agentId}
                          {va.ownerUsername ? ` · ${va.ownerUsername}'s agent` : ''}
                          {inChannel ? ' · already here' : nCh > 0 ? ` · ${nCh} ch` : ''}
                        </span>
                      </span>
                    </button>
                    {onDeleteVaultAgent && (
                      <button
                        type="button"
                        className="chat-remove-agent"
                        title="Delete vault agent (all channels)"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (window.confirm(`Delete vault agent @${va.mention}? Removes from ${nCh || 'all'} channel(s).`)) {
                            void onDeleteVaultAgent(va.id);
                          }
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
            {agentFormError && <div className="chat-agent-form-error">{agentFormError}</div>}
            <div className="chat-agent-menu-actions">
              <button
                type="button"
                onClick={() => {
                  setAgentMenuOpen(false);
                  setAgentPanelMode('picker');
                  setAgentFormError('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setAgentPanelMode('create');
                  openAgentEditor();
                }}
              >
                Create new…
              </button>
            </div>
          </div>
          )}

          {agentMenuOpen && agentPanelMode !== 'picker' && (
          <form className="chat-agent-menu" onSubmit={(e) => void submitAgentRegistration(e)} onClick={(event) => event.stopPropagation()}>
            <div className="chat-agent-menu-heading">
              {agentPanelMode === 'edit-member' && 'Channel membership'}
              {agentPanelMode === 'edit-identity' && 'Vault identity (all channels)'}
              {agentPanelMode === 'create' && 'New vault agent'}
            </div>
            {agentPanelMode !== 'edit-member' && (
              <>
            <label>
              Backend
              <select
                value={agentForm.agentId}
                onChange={(event) => {
                  const agent = availableAgents.find((option) => option.id === event.target.value);
                  setAgentFormError('');
                  const nextPreset = agent?.models[0]?.id ?? '';
                  const { choice, custom } = resolveModelPicker(agent, nextPreset);
                  setModelChoice(choice);
                  setCustomModel(custom);
                  setAgentForm((value) => ({
                    ...value,
                    agentId: event.target.value,
                    displayName: value.displayName || agent?.label || event.target.value,
                    model: modelFromPicker(choice, custom),
                  }));
                }}
              >
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.label}</option>
                ))}
              </select>
            </label>
            <label>
              Display name
              <input
                value={agentForm.displayName}
                placeholder={activeFormAgent?.label || 'Agent'}
                onChange={(event) => setAgentForm((value) => ({ ...value, displayName: event.target.value }))}
              />
            </label>
            <label>
              @ handle
              <input
                value={agentForm.mention}
                placeholder="grok"
                spellCheck={false}
                onChange={(event) => setAgentForm((value) => ({ ...value, mention: event.target.value.replace(/^@+/, '') }))}
              />
            </label>
            <label>
              Cwd
              <input
                value={agentForm.cwd}
                placeholder="Vault root or relative path"
                spellCheck={false}
                onChange={(event) => setAgentForm((value) => ({ ...value, cwd: event.target.value }))}
              />
            </label>
            <label>
              Persona / context
              <textarea
                value={agentForm.contextPrompt}
                placeholder="Standing instructions for this agent"
                rows={3}
                onChange={(event) => setAgentForm((value) => ({ ...value, contextPrompt: event.target.value }))}
              />
            </label>
              </>
            )}
            <label>
              Model
              {activeFormAgent && activeFormAgent.models.length > 0 ? (
                <>
                  <select
                    value={modelChoice}
                    onChange={(event) => {
                      const choice = event.target.value;
                      setModelChoice(choice);
                      if (choice !== CUSTOM_MODEL_VALUE) setCustomModel('');
                      setAgentForm((value) => ({
                        ...value,
                        model: modelFromPicker(choice, choice === CUSTOM_MODEL_VALUE ? customModel : ''),
                      }));
                    }}
                  >
                    {activeFormAgent.models.map((model) => (
                      <option key={model.id} value={model.id}>{model.label}</option>
                    ))}
                    <option value={CUSTOM_MODEL_VALUE}>Custom model ID…</option>
                  </select>
                  {modelChoice === CUSTOM_MODEL_VALUE && (
                    <input
                      className="chat-model-custom-input"
                      value={customModel}
                      placeholder="e.g. sonnet-4-6"
                      spellCheck={false}
                      onChange={(event) => {
                        const next = event.target.value;
                        setCustomModel(next);
                        setAgentForm((value) => ({ ...value, model: next.trim() }));
                      }}
                    />
                  )}
                </>
              ) : (
                <input
                  value={customModel}
                  placeholder="Model ID"
                  spellCheck={false}
                  onChange={(event) => {
                    const next = event.target.value;
                    setCustomModel(next);
                    setModelChoice(CUSTOM_MODEL_VALUE);
                    setAgentForm((value) => ({ ...value, model: next.trim() }));
                  }}
                />
              )}
            </label>
            {(agentForm.agentId === 'codex' || agentForm.agentId === 'claude-code') && (agentPanelMode === 'edit-member' || agentPanelMode === 'create') && (
              <label>
                Reasoning effort
                <ReasoningEffortSelect
                  agentId={agentForm.agentId}
                  value={agentForm.reasoningEffort || ''}
                  onChange={(reasoningEffort) => setAgentForm((value) => ({ ...value, reasoningEffort }))}
                />
                <span className="chat-agent-field-hint">Default follows the local CLI configuration on the agent owner's desktop.</span>
              </label>
            )}
            {(agentPanelMode === 'edit-member' || agentPanelMode === 'create') && (
              <>
            <label className="chat-agent-toggle">
              <input
                type="checkbox"
                checked={agentForm.taggableByAgents}
                onChange={(event) => setAgentForm((value) => ({ ...value, taggableByAgents: event.target.checked }))}
              />
              Taggable by other agents
            </label>
            <label className="chat-agent-toggle">
              <input
                type="checkbox"
                checked={agentForm.orchestrator}
                onChange={(event) => setAgentForm((value) => ({
                  ...value,
                  orchestrator: event.target.checked,
                  replyToEveryMessage: event.target.checked,
                }))}
              />
              Coordinate this channel
            </label>
            <span className="chat-agent-field-hint">Receives human messages, may create durable missions, and can dispatch other channel agents.</span>
            <label className="chat-agent-toggle">
              <input
                type="checkbox"
                checked={agentForm.replyToEveryMessage}
                disabled={agentForm.orchestrator}
                onChange={(event) => setAgentForm((value) => ({ ...value, replyToEveryMessage: event.target.checked }))}
              />
              Reply to every human message
            </label>
            <label className="chat-agent-toggle">
              <input
                type="checkbox"
                checked={agentForm.pingableByOthers}
                onChange={(event) => setAgentForm((value) => ({ ...value, pingableByOthers: event.target.checked }))}
              />
              Allow other users to ping this agent
            </label>
            <label className="chat-agent-toggle">
              <input
                type="checkbox"
                checked={agentForm.yolo}
                onChange={(event) => setAgentForm((value) => ({ ...value, yolo: event.target.checked }))}
              />
              Yolo mode (skip permission prompts)
            </label>
              </>
            )}
            {agentPanelMode === 'edit-member' && agentForm.vaultAgentId && (
              <button
                type="button"
                className="chat-agent-identity-link"
                onClick={(event) => editVaultIdentity(event, agentForm)}
              >
                Edit vault identity (name, model, persona)…
              </button>
            )}
            {agentFormError && <div className="chat-agent-form-error">{agentFormError}</div>}
            <div className="chat-agent-menu-actions">
              <button
                type="button"
                onClick={() => {
                  setAgentMenuOpen(false);
                  setEditingRegistrationId(null);
                  setAgentPanelMode('picker');
                  setAgentFormError('');
                }}
              >
                Cancel
              </button>
              <button type="submit">
                {agentPanelMode === 'create' ? 'Create & add' : 'Save'}
              </button>
            </div>
          </form>
          )}
        </div>
          </>
        )}
      </aside>

      {forwardSource && (
        <div
          className="chat-forward-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Forward message"
          onClick={() => setForwardSource(null)}
        >
          <div className="chat-forward-panel" onClick={(event) => event.stopPropagation()}>
            <div className="chat-forward-head">
              <strong>Forward message</strong>
              <button type="button" title="Cancel" onClick={() => setForwardSource(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="chat-forward-preview">
              <strong>{forwardSource.author}</strong>
              <span>{buildReplyPreview(forwardSource)}</span>
            </div>
            <input
              className="chat-forward-search"
              value={forwardQuery}
              autoFocus
              placeholder="Search channels…"
              onChange={(event) => setForwardQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setForwardSource(null);
                if (event.key === 'Enter' && forwardTargets[0]) void forwardTo(forwardTargets[0].id);
              }}
            />
            <div className="chat-forward-list">
              {forwardTargets.length === 0 && (
                <div className="chat-forward-empty">No other channels</div>
              )}
              {forwardTargets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  className="chat-forward-target"
                  disabled={forwardingTo !== null}
                  onClick={() => void forwardTo(target.id)}
                >
                  <Hash size={13} />
                  <span>{target.title}</span>
                  {forwardingTo === target.id && <em>sending…</em>}
                </button>
              ))}
            </div>
            {forwardError && <div className="chat-forward-error">{forwardError}</div>}
          </div>
        </div>
      )}

      {lightboxSrc && (
        <div
          className="chat-lightbox"
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxSrc(null)}
        >
          <button
            type="button"
            className="chat-lightbox-close"
            title="Close"
            onClick={() => setLightboxSrc(null)}
          >
            <X size={20} />
          </button>
          <img
            src={lightboxSrc}
            alt=""
            className="chat-lightbox-image"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}
      {sharedNote && (
        <div className="chat-lightbox" role="dialog" aria-modal="true" onClick={() => setSharedNote(null)}>
          <article className="chat-shared-note" onClick={(event) => event.stopPropagation()}>
            <header>
              <h2>{sharedNote.title}</h2>
              <button type="button" className="btn-icon" title="Close" onClick={() => setSharedNote(null)}>
                <X size={18} />
              </button>
            </header>
            <div className="chat-shared-note-body">
              <ReactMarkdown remarkPlugins={CHAT_MARKDOWN_PLUGINS}>{sharedNote.content}</ReactMarkdown>
            </div>
          </article>
        </div>
      )}
    </section>
  );
});
