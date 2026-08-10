import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Bot, ChevronRight, ClipboardList, Flag, Forward, Hash, History, ImagePlus, Loader2, Paperclip, Reply, Send, Smile, Square, Trash2, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { api, type NoteSummary } from '../api';
import {
  bodyHasNoteRefs,
  findEmbeddedNote,
  NOTE_DND_TYPE,
  noteEmbedMarkdown,
  splitDocEmbeds,
  splitWikilinks,
} from '../docEmbeds';
import { escapeRegExp, normalizeMention } from '../chat/mentions';
import { createChannelWorkItem, patchWorkItem } from '../chat/workItems';
import { reportWorkItemGitState, workspaceBridge } from '../chat/workspaces';
import { usePopupMenu } from '../ui/popupMenu';
import { highlightJSON } from './jsonHighlighter';
import { CascadeRunPanel } from './CascadeRunPanel';
import { ChatSidebarButtons } from './ChatSidebarButtons';
import { ChatWorkspacePanel } from './ChatWorkspacePanel';
import { ChatTaskReview } from './ChatTaskReview';
import { ChatWorkTrace } from './ChatWorkTrace';
import { ChatAgentToggle } from './ChatAgentToggle';
import { ChatQuoteRefs } from './ChatQuoteRefs';
import {
  CHAT_RELATIONSHIPS,
  CHAT_RELATIONSHIP_INSTRUCTIONS,
  CHAT_RELATIONSHIP_LABELS,
  type ChatRelationship,
} from '../chat/relationships';
import { ThinkingSpinner } from './ThinkingSpinner';
import { ReportDialog } from './ReportDialog';
import { hasRunActivity } from '../chat/harnessActivity';
import { isSteeringContinuationMessage, segmentTranscript, workTracePeek } from '../chat/workTrace';
import { useChannelMessages } from '../chat/messageStore';
import {
  canGroupChatMessages,
  CHAT_NOTE_MARKER,
  createChatAgentRegistrationId,
} from '../chat/shared';
import {
  chatMediaLink,
  youtubeVideoId,
  YOUTUBE_EMBED_CONTROL_EVENT,
  YOUTUBE_EMBED_STATE_EVENT,
  type YouTubeEmbedControlDetail,
  type YouTubeEmbedStateDetail,
} from '../mediaLinks';

export {
  canGroupChatMessages,
  canMergeChatMessages,
  CHAT_NOTE_MARKER,
  createChatAgentRegistrationId,
  dataUrlsToRunImages,
  mediaToRunImages,
  mergeChatPresence,
} from '../chat/shared';
export const CHAT_MEDIA_LIMIT = 8;
export const CHAT_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
const CHAT_EMOJIS = ['😀', '😂', '😍', '🥳', '😎', '🤔', '👍', '👎', '❤️', '🔥', '🎉', '✅', '👀', '🙏', '💎', '🚀'];

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
  relationship?: ChatRelationship;
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
  /** Pre-work Q&A; accept → work-item contract + mission the orchestrator drives. */
  clarification?: {
    title: string;
    questions: Array<{
      id: string;
      prompt: string;
      kind?: 'text' | 'single' | 'multi';
      options?: string[];
      answer?: string;
    }>;
    status: 'pending' | 'accepted' | 'canceled';
    tokenBudget?: number;
    assigneeRegistrationId?: string;
    workItemId?: string;
    missionId?: string;
    acceptedAt?: string;
    acceptedBy?: string;
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
  assigneeModel: string;
  status: ChatMissionTaskStatus;
  summary: string;
  dependsOn: string[];
  waitingFor: string[];
  priority: number;
  reasoningEffort: string;
  anonymous?: boolean;
  queueReason: 'dependency' | 'dependency-attention' | 'agent-busy' | 'queued' | '';
  attempt: number;
  runId?: number;
  /** Durable work-item twin (workspace / lease / PR). */
  workItemId?: string;
  workItemStatus?: string;
  workspaceMode?: string;
  baseCommit?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  prState?: string;
  verification?: string;
  reviewState?: 'none' | 'requested' | 'in_review' | 'ready';
  gitState?: { changedFiles: number; dirty: boolean; behind: number; updatedAt: string };
  reviewReady?: boolean;
  reviewBlockers?: string[];
  updatedAt: string;
}

export interface ChatMission {
  id: string;
  rootMessageId: string;
  title: string;
  objective: string;
  status: 'active' | 'reviewing' | 'attention' | 'blocked' | 'completed' | 'canceled';
  coordinator: string;
  coordinatorMention: string;
  tasks: ChatMissionTask[];
  summary: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMissionEvent {
  id: number;
  missionId: string;
  taskId?: string;
  kind: string;
  title: string;
  fromStatus: string;
  toStatus: string;
  summary: string;
  runId?: number;
  attempt: number;
  createdAt: string;
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
  /** Server-authoritative owner of this personal assistant. */
  ownerUserId?: number;
  agentId: string;
  displayName: string;
  avatarUrl: string;
  mention: string;
  model: string;
  /** Optional per-channel Codex reasoning effort pin. Empty uses the CLI default. */
  reasoningEffort: string;
  /** Codex-only priority processing override for this channel membership. */
  priorityServiceTier: boolean;
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
  profiles?: Record<string, { id: number; username: string; displayName: string; avatarUrl: string }>;
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
  /** Create a typed, single-agent handoff linked to an existing chat message. */
  onCollaborateMessage?: (
    channelId: string,
    sourceMessageId: string,
    targetRegistrationId: string,
    relationship: ChatRelationship,
    instruction: string,
  ) => Promise<void>;
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
  /** Mount the shared vault rail outside the channel content, or suppress the inline copy. */
  sidebarMode?: 'inline' | 'only' | 'hidden';
}

// Stable fallback: an inline `= []` default would mint a new identity every
// render and defeat the notes-aware memo comparators below.
const EMPTY_NOTES: NoteSummary[] = [];

function isImageMediaType(mediaType: string) {
  return mediaType.startsWith('image/');
}

export function isVideoMediaType(mediaType: string) {
  return mediaType.startsWith('video/');
}

export function isMp4Attachment(attachment: { name?: string; media_type?: string; url?: string }) {
  const type = String(attachment.media_type || '').toLowerCase();
  if (isVideoMediaType(type) || type === 'video/mp4') return true;
  const name = String(attachment.name || '').toLowerCase();
  const url = String(attachment.url || '').toLowerCase();
  return name.endsWith('.mp4') || url.includes('video/mp4') || /\.mp4(\?|$)/.test(url);
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
  if (agentId === 'akron-grok') return 'grok';
  if (agentId === 'hermes') return 'nous';
  return agentId;
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
    return `${window.label}: ${Math.round(window.usedPercent)}% used${reset ? ` · ${reset}` : ''}`;
  });
  if (usage.planType) lines.push(`Plan: ${usage.planType}`);
  if (usage.detail) lines.push(usage.detail);
  return lines.join('\n');
}

function PlanUsageMeters({
  usage,
  stacked = false,
  decal = false,
}: {
  usage: PlanUsage;
  stacked?: boolean;
  /** Compact right-rail chips — no row growth. */
  decal?: boolean;
}) {
  const title = formatPlanUsageTitle(usage);
  if (usage.status !== 'ok') {
    if (decal) return null;
    return <span className="chat-plan-meters is-unavailable" title={title}>usage unavailable</span>;
  }
  const windows = planUsageWindows(usage).slice(0, 3);
  if (windows.length === 0) return null;
  return (
    <span
      className={`chat-plan-meters${stacked ? ' is-stacked' : ''}${decal ? ' is-decal' : ''}`}
      title={title}
    >
      {windows.map((window, index) => {
        const percent = Math.round(window.usedPercent);
        const shortLabel = window.label.length > 5
          ? window.label.replace(/session/i, 'sess').replace(/week/i, 'wk').slice(0, 4)
          : window.label;
        return (
          <span
            className="chat-plan-meter"
            key={`${window.label}:${index}`}
            role="progressbar"
            aria-label={`${window.label} plan usage ${percent}%`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className="chat-plan-meter-label">{decal ? shortLabel : window.label}</span>
            <span className="chat-plan-meter-track" aria-hidden="true">
              <span className="chat-plan-meter-fill" style={{ width: `${percent}%` }} />
            </span>
            {!decal && <span className="chat-plan-meter-value">{percent}%</span>}
          </span>
        );
      })}
      {!decal && usage.detail && (() => {
        const topUpMatch = usage.detail.match(/Top-up credits:\s*\$?([\d.]+)/i);
        const totalMatch = usage.detail.match(/Total usable:\s*\$?([\d.]+)/i);
        if (!topUpMatch && !totalMatch) return null;
        const label = topUpMatch ? `top-up $${topUpMatch[1]}` : `usable $${totalMatch![1]}`;
        return <span className="chat-plan-meter-detail">{label}</span>;
      })()}
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

/** Inline `[[Title]]` cites → clickable note chips (embeds `![[…]]` stay cards). */
function formatChatWikilinks(
  text: string,
  notes: NoteSummary[],
  messageId: string,
  onOpenNote?: (id: string) => void,
  onOpenSharedNote?: (messageId: string, title: string) => void,
): ReactNode[] {
  const parts = splitWikilinks(text);
  if (parts.length === 1 && parts[0].type === 'text') return [text];
  let key = 0;
  const nodes: ReactNode[] = [];
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.value) nodes.push(part.value);
      continue;
    }
    const target = part.value;
    if (!target) continue;
    const embedded = findEmbeddedNote(notes, target);
    const canOpen = Boolean(embedded ? onOpenNote : onOpenSharedNote);
    nodes.push(
      <button
        key={`wiki-${key++}`}
        type="button"
        className={`chat-wikilink${embedded ? '' : ' is-missing'}`}
        onClick={() => {
          if (embedded) onOpenNote?.(embedded.id);
          else onOpenSharedNote?.(messageId, target);
        }}
        disabled={!canOpen}
        title={embedded ? `Open ${embedded.title}` : `Note: ${target}`}
      >
        {embedded?.title ?? target}
      </button>,
    );
  }
  return nodes.length > 0 ? nodes : [text];
}

function aliasesEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

// While an agent message streams, its body grows by a token at a time and
// react-markdown re-parses the *entire* body on every keystroke-sized update —
// the dominant main-thread cost during a live run. Paint a throttled snapshot
// (matching ThinkingBlock's 90ms) so the full markdown parse runs a few times a
// second instead of per token; the final settle always flushes the exact body.
const STREAM_BODY_PAINT_MS = 120;

export function ChatMediaEmbed({ href, label }: { href: string; label: ReactNode }) {
  const media = chatMediaLink(href);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const youtubeInfoRef = useRef({ currentTime: 0, title: 'YouTube video' });
  useEffect(() => {
    if (media?.provider !== 'youtube') return;
    const frameWindow = frameRef.current?.contentWindow;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://www.youtube.com' || event.source !== frameWindow) return;
      let payload: { event?: string; info?: number | { currentTime?: number; videoData?: { title?: string } } } = {};
      try { payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data; } catch { return; }
      if (payload.event === 'infoDelivery' && typeof payload.info === 'object') {
        if (Number.isFinite(payload.info.currentTime)) youtubeInfoRef.current.currentTime = payload.info.currentTime || 0;
        const title = payload.info.videoData?.title?.trim();
        if (title) youtubeInfoRef.current.title = title;
      }
      if (payload.event === 'onStateChange' && typeof payload.info === 'number') {
        const videoId = youtubeVideoId(href);
        if (!videoId) return;
        window.dispatchEvent(new CustomEvent<YouTubeEmbedStateDetail>(YOUTUBE_EMBED_STATE_EVENT, {
          detail: {
            videoId,
            url: href,
            title: youtubeInfoRef.current.title,
            currentTime: youtubeInfoRef.current.currentTime,
            state: payload.info,
          },
        }));
      }
    };
    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<YouTubeEmbedControlDetail>).detail;
      const videoId = youtubeVideoId(href);
      if (!videoId || detail?.videoId !== videoId) return;
      frameWindow?.postMessage(JSON.stringify({ event: 'command', func: detail.func, args: [] }), '*');
    };
    window.addEventListener('message', onMessage);
    window.addEventListener(YOUTUBE_EMBED_CONTROL_EVENT, onControl);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener(YOUTUBE_EMBED_CONTROL_EVENT, onControl);
    };
  }, [href, media?.provider]);
  if (!media) return <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>;
  return (
    <span className={`chat-media-embed is-${media.aspect}`}>
      <a href={href} target="_blank" rel="noopener noreferrer">{label}</a>
      <iframe
        ref={frameRef}
        src={media.embedUrl}
        title={media.title}
        loading="lazy"
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
        referrerPolicy="strict-origin-when-cross-origin"
        allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
        allowFullScreen
        onLoad={() => {
          if (media.provider !== 'youtube') return;
          const player = frameRef.current?.contentWindow;
          player?.postMessage(JSON.stringify({ event: 'listening' }), '*');
          player?.postMessage(JSON.stringify({ event: 'command', func: 'addEventListener', args: ['onStateChange'] }), '*');
        }}
      />
    </span>
  );
}

function useThrottledStreamBody(body: string, streaming: boolean): string {
  const [paintBody, setPaintBody] = useState(body);
  const lastPaintRef = useRef(0);
  useEffect(() => {
    if (!streaming) {
      // Settled (or never streaming): show the exact body immediately.
      setPaintBody(body);
      return;
    }
    const now = Date.now();
    const since = now - lastPaintRef.current;
    if (since >= STREAM_BODY_PAINT_MS) {
      lastPaintRef.current = now;
      setPaintBody(body);
      return;
    }
    // Trailing edge — guarantees the latest chunk lands even if tokens keep
    // arriving faster than the interval (a debounce would starve steady streams).
    const timer = window.setTimeout(() => {
      lastPaintRef.current = Date.now();
      setPaintBody(body);
    }, STREAM_BODY_PAINT_MS - since);
    return () => window.clearTimeout(timer);
  }, [body, streaming]);
  return paintBody;
}

// The actual markdown parse lives in its own memoized child so a throttled-away
// body update (parent re-render with an unchanged `formattedBody`) bails out
// here instead of re-parsing the whole message.
const ChatMarkdownBody = memo(function ChatMarkdownBody({
  messageId,
  formattedBody,
  components,
  notes,
  onOpenNote,
  onOpenSharedNote,
}: {
  messageId: string;
  formattedBody: string;
  components: Record<string, unknown>;
  notes: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (messageId: string, title: string) => void;
}) {
  return (
    <>
      {splitDocEmbeds(formattedBody).map((part, index) => {
        if (part.type === 'text') {
          if (!part.value) return null;
          return (
            <ReactMarkdown key={index} remarkPlugins={CHAT_MARKDOWN_PLUGINS} components={components as any}>
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
});

// ChatMessageText stays module-local; work-trace uses its own lightweight markdown.
const ChatMessageText = memo(function ChatMessageText({
  messageId,
  body,
  streaming = false,
  mentionableAliases,
  notes = [],
  onOpenNote,
  onOpenSharedNote,
}: {
  messageId: string;
  body: string;
  streaming?: boolean;
  mentionableAliases: string[];
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onOpenSharedNote?: (messageId: string, title: string) => void;
}) {
  const paintBody = useThrottledStreamBody(body, streaming);

  const withInlineMarkup = useCallback((children: ReactNode): ReactNode => {
    const decorate = (value: string): ReactNode[] => {
      // Wikilinks first so mention highlighting runs on surrounding prose only.
      const wikiNodes = formatChatWikilinks(
        value,
        notes,
        messageId,
        onOpenNote,
        onOpenSharedNote,
      );
      return wikiNodes.flatMap((node) => (
        typeof node === 'string'
          ? formatChatMentions(node, mentionableAliases)
          : [node]
      ));
    };
    if (Array.isArray(children)) {
      return children.flatMap((child) =>
        typeof child === 'string' ? decorate(child) : [child]
      );
    }
    if (typeof children === 'string') return decorate(children);
    return children;
  }, [mentionableAliases, messageId, notes, onOpenNote, onOpenSharedNote]);

  const formattedBody = useMemo(() => {
    const processed = paintBody.replace(/\\+`/g, '`');
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
  }, [paintBody]);

  const components = useMemo(() => ({
    a: ({ href = '', children }: { href?: string; children?: ReactNode }) => (
      <ChatMediaEmbed href={href} label={children} />
    ),
    p: ({ children }: { children?: ReactNode }) => <p>{withInlineMarkup(children)}</p>,
    li: ({ children }: { children?: ReactNode }) => <li>{withInlineMarkup(children)}</li>,
    td: ({ children }: { children?: ReactNode }) => <td>{withInlineMarkup(children)}</td>,
    th: ({ children }: { children?: ReactNode }) => <th>{withInlineMarkup(children)}</th>,
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
  }), [withInlineMarkup]);

  return (
    <ChatMarkdownBody
      messageId={messageId}
      formattedBody={formattedBody}
      components={components}
      notes={notes}
      onOpenNote={onOpenNote}
      onOpenSharedNote={onOpenSharedNote}
    />
  );
}, (prev, next) =>
  prev.messageId === next.messageId
  && prev.streaming === next.streaming
  && prev.onOpenSharedNote === next.onOpenSharedNote
  &&
  prev.body === next.body
  && aliasesEqual(prev.mentionableAliases, next.mentionableAliases)
  // Notes list only matters for bodies with `![[…]]` embeds or `[[…]]` cites.
  && (prev.notes === next.notes || !bodyHasNoteRefs(next.body))
  && prev.onOpenNote === next.onOpenNote
);

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
  // Once the interrupted response settles as canceled, there is no longer a
  // pair of simultaneously running bubbles and the live-only decal above used
  // to disappear. Preserve it from the durable transcript shape: canceled
  // agent response, human correction, then the same agent's continuation.
  for (let index = 1; index < messages.length - 1; index += 1) {
    const prompt = messages[index];
    if (prompt.agentId || labels.has(prompt.id)) continue;
    const before = messages[index - 1];
    const after = messages[index + 1];
    const beforeKey = before.registrationId || before.agentId;
    const afterKey = after.registrationId || after.agentId;
    if (!beforeKey || beforeKey !== afterKey || before.status !== 'canceled') continue;
    if (!isSteeringContinuationMessage(before)) continue;
    const registration = registeredAgents.find((item) => item.id === afterKey || item.agentId === afterKey);
    if (!registration) continue;
    labels.set(prompt.id, normalizeMention(registration.mention || registration.agentId));
  }
  return labels;
}

interface ChatMessageGroup {
  messages: ChatMessage[];
}

function ChatAvatar({
  name,
  kind,
  avatarUrl = '',
  size = 'md',
  onClick,
  title,
}: {
  name: string;
  kind: 'agent' | 'human';
  avatarUrl?: string;
  size?: 'sm' | 'md';
  /** When set, the avatar is a button (e.g. open agent settings from a message). */
  onClick?: (event: React.MouseEvent) => void;
  title?: string;
}) {
  const className = `chat-avatar chat-avatar-${size} chat-avatar-${kind}${onClick ? ' is-clickable' : ''}`;
  const content = avatarUrl
    ? <img src={avatarUrl} alt="" />
    : kind === 'agent'
      ? <Bot size={size === 'sm' ? 14 : 15} />
      : initialFor(name);
  if (onClick) {
    return (
      <button
        type="button"
        className={className}
        onClick={onClick}
        title={title}
        aria-label={title || `Open settings for ${name}`}
      >
        {content}
      </button>
    );
  }
  return (
    <div className={className} aria-hidden="true">
      {content}
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
  return group.messages.some((message) => message.body && bodyHasNoteRefs(message.body));
}

/** Swipe-left → reply (mobile/touch). Touch/pen only so desktop drag-select stays clean. */
const SWIPE_REPLY_MAX = 72;
const SWIPE_REPLY_THRESHOLD = 52;
const SWIPE_AXIS_SLOP = 12;

/** Active horizontal swipe count — virtualization must not unmount mid-capture. */
let activeSwipeGestures = 0;
function beginSwipeGesture(): void {
  activeSwipeGestures += 1;
}
function endSwipeGesture(): void {
  activeSwipeGestures = Math.max(0, activeSwipeGestures - 1);
}
function swipeGestureActive(): boolean {
  return activeSwipeGestures > 0;
}

/**
 * DOM-driven swipe: no React setState during vertical pan or per-frame drag.
 * Previous version set dragging=true on every pointerdown and setOffset on every
 * move — that re-rendered the whole message row and stuttered list scroll.
 *
 * Horizontal capture must always release: unmount mid-swipe (list virtualization)
 * or a lost pointerup left the app unclickable until restart.
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
  const capturingRef = useRef(false);
  const finishedRef = useRef(false);
  const windowEndRef = useRef<(() => void) | null>(null);

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

  const releaseCapture = useCallback((pointerId?: number) => {
    const root = rootRef.current;
    if (!root || pointerId == null) return;
    try {
      if (root.hasPointerCapture?.(pointerId)) {
        root.releasePointerCapture(pointerId);
      }
    } catch { /* ignore */ }
  }, []);

  const detachWindowEnd = useCallback(() => {
    windowEndRef.current?.();
    windowEndRef.current = null;
  }, []);

  const completeGesture = useCallback((committed: boolean, animate: boolean) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const pointerId = startRef.current?.pointerId;
    releaseCapture(pointerId);
    if (capturingRef.current) {
      capturingRef.current = false;
      endSwipeGesture();
    }
    detachWindowEnd();
    startRef.current = null;
    axisRef.current = null;
    offsetRef.current = 0;
    if (!animate) {
      paint(0, false);
    } else {
      paint(0, true);
      requestAnimationFrame(() => paint(0, false));
    }
    if (committed) {
      try { navigator.vibrate?.(12); } catch { /* ignore */ }
      onReply();
    }
  }, [detachWindowEnd, onReply, paint, releaseCapture]);

  // If virtualization unmounts this row mid-swipe, release capture + gesture flag.
  useEffect(() => () => {
    // Do not let the release below turn into a late lostpointercapture reply
    // while React is removing this virtualized row.
    finishedRef.current = true;
    const start = startRef.current;
    releaseCapture(start?.pointerId);
    if (capturingRef.current) {
      capturingRef.current = false;
      endSwipeGesture();
    }
    detachWindowEnd();
  }, [detachWindowEnd, releaseCapture]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('a, button, input, textarea, select, .cascade-run-panel, pre, code')) return;
    // Track only — no setState (vertical list scroll must stay free).
    finishedRef.current = false;
    startRef.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    axisRef.current = null;
    offsetRef.current = 0;
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (!start || event.pointerId !== start.pointerId || finishedRef.current) return;
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
      if (!capturingRef.current) {
        capturingRef.current = true;
        beginSwipeGesture();
      }
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // ignore
      }
      // Window-level end: survives if the row unmounts under the finger.
      detachWindowEnd();
      const pointerId = event.pointerId;
      const onWinEnd = (ev: Event) => {
        const pe = ev as PointerEvent;
        if ('pointerId' in pe && pe.pointerId !== pointerId) return;
        // `pointercancel` and `blur` are interruption paths, never a reply.
        // Some Android webviews cancel a pointer when a scroll/context gesture
        // takes over, often after it has crossed the horizontal threshold.
        const committed = ev.type === 'pointerup'
          && axisRef.current === 'h'
          && offsetRef.current >= SWIPE_REPLY_THRESHOLD;
        completeGesture(committed, true);
      };
      window.addEventListener('pointerup', onWinEnd, true);
      window.addEventListener('pointercancel', onWinEnd, true);
      window.addEventListener('blur', onWinEnd);
      windowEndRef.current = () => {
        window.removeEventListener('pointerup', onWinEnd, true);
        window.removeEventListener('pointercancel', onWinEnd, true);
        window.removeEventListener('blur', onWinEnd);
      };
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
      releaseCapture(event.pointerId);
      return;
    }
    const committed = axisRef.current === 'h' && offsetRef.current >= SWIPE_REPLY_THRESHOLD;
    completeGesture(committed, true);
  };

  const cancel = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    if (start && event.pointerId === start.pointerId) completeGesture(false, true);
    else releaseCapture(event.pointerId);
  };

  return (
    <div
      ref={rootRef}
      className={`chat-swipe-row ${className}`}
      data-message-id={messageId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={cancel}
      onLostPointerCapture={() => {
        // Chromium Android may drop pointer capture immediately after the
        // first horizontal move, before the swipe has crossed the reply
        // threshold. Keep the window-level end listener alive in that case;
        // ending here makes every longer swipe stop at its first move.
        if (!windowEndRef.current && !finishedRef.current && (capturingRef.current || startRef.current)) {
          completeGesture(false, false);
        }
      }}
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

function ChatClarificationCard({
  message,
  vaultId,
}: {
  message: ChatMessage;
  vaultId?: string;
}) {
  const clarification = message.clarification!;
  const [answers, setAnswers] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const q of clarification.questions) init[q.id] = q.answer || '';
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [budgetEditing, setBudgetEditing] = useState(false);
  const [tokenBudget, setTokenBudget] = useState(clarification.tokenBudget || 0);
  const [budgetDraft, setBudgetDraft] = useState(String(clarification.tokenBudget || ''));
  const pending = clarification.status === 'pending';
  const answeredCount = clarification.questions.filter((q) => String(answers[q.id] || '').trim()).length;
  const allAnswered = answeredCount === clarification.questions.length;

  const runBusy = async (fallback: string, work: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  };

  async function saveAnswers() {
    if (!vaultId || !pending) return;
    await runBusy('Could not save answers', async () => {
      await api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/clarification/answer`, {
        method: 'POST',
        body: JSON.stringify({
          answers: clarification.questions.map((q) => ({ id: q.id, answer: answers[q.id] || '' })),
        }),
      });
    });
  }

  async function acceptContract() {
    if (!vaultId || !pending) return;
    await runBusy('Could not accept contract', async () => {
      await api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/clarification/answer`, {
        method: 'POST',
        body: JSON.stringify({
          answers: clarification.questions.map((q) => ({ id: q.id, answer: answers[q.id] || '' })),
        }),
      });
      await api(`/api/vaults/${vaultId}/channels/${message.channelId}/messages/${message.id}/clarification/accept`, {
        method: 'POST',
        body: JSON.stringify({
          tokenBudget: clarification.tokenBudget || 0,
        }),
      });
    });
  }

  async function saveBudget(nextValue = budgetDraft) {
    if (!clarification.workItemId) return;
    const next = Math.max(0, Math.floor(Number(nextValue) || 0));
    await runBusy('Could not update token budget', async () => {
      await patchWorkItem(clarification.workItemId, { tokenBudget: next });
      setTokenBudget(next);
      setBudgetDraft(next > 0 ? String(next) : '');
      setBudgetEditing(false);
    });
  }

  return (
    <div className={`chat-clarification is-${clarification.status}`} role="form" aria-label="Scope questionnaire">
      <div className="chat-clarification-head">
        <span className="chat-clarification-kicker">Questionnaire</span>
        <strong>{clarification.title}</strong>
        <span className="chat-clarification-status">
          {clarification.status === 'accepted'
            ? (clarification.missionId ? 'mission live' : 'contract live')
            : `${answeredCount}/${clarification.questions.length}`}
        </span>
      </div>
      <p className="chat-clarification-lead">
        {pending
          ? (allAnswered
            ? 'Prefilled — change only disagreements, then Accept → mission.'
            : 'Answer, then Accept → mission.')
          : 'Accepted scope is frozen; the mission drives agents from here.'}
      </p>
      <div className="chat-clarification-questions">
        {clarification.questions.map((q, index) => {
          const options = Array.isArray(q.options) ? q.options.filter(Boolean) : [];
          const kind = q.kind || (options.length ? 'single' : 'text');
          const value = answers[q.id] || '';
          const selected = new Set(
            value.split(/\s*\|\s*|\n/).map((s) => s.trim()).filter(Boolean),
          );
          const toggle = (option: string) => {
            if (!pending || busy) return;
            setAnswers((prev) => {
              if (kind === 'single') return { ...prev, [q.id]: option };
              const cur = new Set(
                String(prev[q.id] || '')
                  .split(/\s*\|\s*|\n/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              );
              if (cur.has(option)) cur.delete(option);
              else cur.add(option);
              return { ...prev, [q.id]: Array.from(cur).join(' | ') };
            });
          };
          return (
            <fieldset key={q.id} className={`chat-clarification-q is-${kind}`} disabled={!pending || busy}>
              <legend>
                <span className="chat-clarification-q-num">{index + 1}</span>
                <span>{q.prompt}</span>
              </legend>
              {!pending ? (
                <small>{q.answer || '—'}</small>
              ) : kind !== 'text' && options.length > 0 ? (
                <div
                  className="chat-clarification-choices"
                  role={kind === 'single' ? 'radiogroup' : 'group'}
                  aria-label={q.prompt}
                >
                  {options.map((option) => {
                    const isOn = selected.has(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        role={kind === 'single' ? 'radio' : 'checkbox'}
                        aria-checked={isOn}
                        className={`chat-clarification-choice${kind === 'multi' ? ' is-check' : ''}${isOn ? ' is-selected' : ''}`}
                        onClick={() => toggle(option)}
                      >
                        <span className="chat-clarification-choice-mark" aria-hidden="true" />
                        <span>{option}</span>
                      </button>
                    );
                  })}
                  {kind === 'single' && (
                    <label className="chat-clarification-other">
                      <span>Other</span>
                      <input
                        type="text"
                        value={options.includes(value) ? '' : value}
                        placeholder="Write your own…"
                        onChange={(event) => setAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))}
                      />
                    </label>
                  )}
                </div>
              ) : (
                <textarea
                  value={value}
                  onChange={(event) => setAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))}
                  rows={2}
                  placeholder="Your answer…"
                />
              )}
            </fieldset>
          );
        })}
      </div>
      {clarification.workItemId ? (
        <div className="chat-clarification-budget">
          {budgetEditing ? (
            <>
              <label>Token budget <input type="number" min="0" step="1000" autoFocus value={budgetDraft} placeholder="No budget" onChange={(event) => setBudgetDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveBudget(); if (event.key === 'Escape') setBudgetEditing(false); }} /></label>
              <button type="button" disabled={busy} onClick={() => void saveBudget()}>Save</button>
              <button type="button" disabled={busy} onClick={() => void saveBudget('0')}>No budget</button>
            </>
          ) : (
            <button type="button" className="chat-clarification-budget-value" onClick={() => setBudgetEditing(true)} title="Change token budget">
              Token budget: {tokenBudget > 0 ? tokenBudget.toLocaleString() : 'No budget'}
            </button>
          )}
        </div>
      ) : clarification.tokenBudget ? <div className="chat-clarification-budget">Token budget: {clarification.tokenBudget.toLocaleString()}</div> : null}
      {(clarification.workItemId || clarification.missionId) && (
        <div className="chat-clarification-contract">
          {clarification.workItemId ? <>Contract <code>{clarification.workItemId.slice(0, 8)}</code></> : null}
          {clarification.workItemId && clarification.missionId ? ' · ' : null}
          {clarification.missionId ? <>Mission <code>{clarification.missionId.slice(0, 8)}</code></> : null}
          {clarification.acceptedBy ? ` · accepted by ${clarification.acceptedBy}` : ''}
        </div>
      )}
      {error && <div className="chat-clarification-error">{error}</div>}
      {pending && vaultId && (
        <div className="chat-clarification-actions">
          <button type="button" disabled={busy} onClick={() => void saveAnswers()}>Save draft</button>
          <button
            type="button"
            className="is-primary"
            disabled={busy || !allAnswered}
            title={allAnswered ? 'Accept scope and open mission' : 'Answer every question first'}
            onClick={() => void acceptContract()}
          >
            Accept → mission
          </button>
        </div>
      )}
    </div>
  );
}

function missionTaskChangeChips(task: ChatMissionTask, fileCount?: number): Array<{ label: string; tone?: 'ok' | 'warn' | 'idle'; title?: string; href?: string }> {
  const chips: Array<{ label: string; tone?: 'ok' | 'warn' | 'idle'; title?: string; href?: string }> = [];
  if (task.branch || task.baseCommit) {
    const base = task.baseCommit ? task.baseCommit.slice(0, 7) : task.workspaceMode || 'base unknown';
    chips.push({ label: `${task.branch || 'workspace'} → ${base}`, tone: 'idle', title: task.worktreePath || undefined });
  }
  const reportedFiles = task.gitState?.changedFiles;
  const files = fileCount ?? reportedFiles;
  if (files != null) chips.push({ label: `${files} file${files === 1 ? '' : 's'}`, tone: files ? 'idle' : 'ok' });
  if (task.verification) chips.push({ label: 'verified', tone: 'ok', title: task.verification });
  else if (task.workItemStatus === 'review' || task.workItemStatus === 'done') chips.push({ label: 'unverified', tone: 'warn' });
  if (task.reviewState === 'in_review') chips.push({ label: task.prState ? `PR ${task.prState}` : 'in review', tone: 'ok', href: task.prUrl });
  else if (task.reviewState === 'requested') chips.push({ label: 'review requested', tone: 'warn' });
  else if (task.reviewState === 'ready') chips.push({ label: 'reviewed', tone: 'ok' });
  if (task.workItemStatus === 'review' || task.workItemStatus === 'done') {
    chips.push(task.reviewReady
      ? { label: 'review ready', tone: 'ok' }
      : { label: 'review blocked', tone: 'warn', title: task.reviewBlockers?.join('\n') });
  }
  return chips;
}

function missionEventLabel(event: ChatMissionEvent) {
  if (event.kind === 'mission_created') return 'Mission opened';
  if (event.kind === 'task_added') return 'Task added';
  if (event.kind === 'task_dispatched') return 'Task dispatched';
  if (event.kind === 'task_started') return 'Task started';
  if (event.kind === 'task_retried') return 'Task retried';
  if (event.kind === 'mission_completed') return 'Mission completed';
  if (event.kind === 'mission_canceled') return 'Mission canceled';
  if (event.fromStatus && event.toStatus && event.fromStatus !== event.toStatus) {
    return `${event.fromStatus} → ${event.toStatus}`;
  }
  return event.toStatus || event.kind.replace(/_/g, ' ');
}

function ChatMissionCard({
  mission,
  vaultId,
  channelId,
  traceContent,
  tracePeek,
  replyMessage,
  onContextMenu,
}: {
  mission: ChatMission;
  vaultId?: string;
  channelId?: string;
  /** Full work stream, rendered only while the mission is expanded. */
  traceContent?: ReactNode;
  /** Always-visible activity strip (collapsed + expanded). */
  tracePeek?: {
    live: boolean;
    summary: string;
    author: string;
    label: string;
    decals: Array<{ phase: string; label: string; mark: string }>;
    phase: string;
  } | null;
  /** Originating message for right-click reply (same as any other chat row). */
  replyMessage?: ChatMessage;
  onContextMenu?: (event: React.MouseEvent, message: ChatMessage) => void;
}) {
  const needsAttention = mission.status === 'attention' || mission.status === 'blocked';
  const [open, setOpen] = useState(needsAttention);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [events, setEvents] = useState<ChatMissionEvent[] | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [stopping, setStopping] = useState(false);
  const [fileCounts, setFileCounts] = useState<ReadonlyMap<string, number>>(() => new Map());
  const bridge = useMemo(workspaceBridge, []);
  useEffect(() => {
    if (mission.status === 'attention' || mission.status === 'blocked') setOpen(true);
  }, [mission.status]);
  useEffect(() => {
    setEvents(null);
    setTimelineOpen(false);
    setHistoryError('');
  }, [mission.id]);
  useEffect(() => {
    if (!open || !bridge) return;
    const paths = [...new Set(mission.tasks
      .map((task) => task.worktreePath)
      .filter((path): path is string => Boolean(path)))];
    if (!paths.length) return;
    let cancelled = false;
    void Promise.all(paths.map(async (path) => {
      const result = await bridge.getWorktreeStatus(path);
      if (!result.ok) return null;
      const task = mission.tasks.find((candidate) => candidate.worktreePath === path);
      if (task?.workItemId) void reportWorkItemGitState(task.workItemId, result).catch(() => {});
      return [path, result.changedFiles.length] as const;
    })).then((results) => {
      if (cancelled) return;
      setFileCounts((previous) => {
        const next = new Map(previous);
        for (const result of results) if (result) next.set(result[0], result[1]);
        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [bridge, mission.tasks, open]);
  const done = mission.tasks.filter((task) => task.status === 'completed' || task.status === 'canceled').length;
  const total = mission.tasks.length;
  const terminal = mission.status === 'completed' || mission.status === 'canceled';
  const live = !terminal && (
    mission.status === 'active'
      || mission.status === 'reviewing'
      || mission.tasks.some((task) => task.status === 'running' || task.status === 'pending')
      || Boolean(tracePeek?.live)
  );
  const statusLabel = mission.status === 'active'
    ? (total ? `${done}/${total} tasks` : 'planning')
    : needsAttention ? 'needs review' : mission.status;
  const lead = mission.coordinatorMention || mission.coordinator;
  const runningTask = mission.tasks.find((task) => task.status === 'running');
  const peekLive = Boolean(tracePeek?.live || (live && mission.status === 'active'));
  const peekAuthor = tracePeek?.author
    || (runningTask ? (runningTask.assigneeMention || runningTask.assignee) : '')
    || '';
  const peekLabel = (terminal ? mission.summary : '')
    || tracePeek?.label
    || (runningTask ? runningTask.title : '')
    || (mission.status === 'active' && total === 0 ? 'deciding approach…' : '')
    || (mission.status === 'active' ? `${done}/${total} tasks in flight` : '');
  // Peek is collapsed-only activity exposure. When open, the stream/tasks are the UI.
  // Settled missions without useful activity text skip the second rail entirely.
  const showPeek = !open && Boolean(peekLabel) && (terminal || peekLive || Boolean(tracePeek || runningTask));
  async function toggleTimeline() {
    const next = !timelineOpen;
    setTimelineOpen(next);
    if (!next || events || !vaultId || !channelId) return;
    setHistoryError('');
    try {
      const result = await api<{ events: ChatMissionEvent[] }>(
        `/api/vaults/${vaultId}/channels/${channelId}/missions/${mission.id}/history`,
      );
      setEvents(result.events || []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not load mission history');
    }
  }
  async function stopMission() {
    if (!vaultId || !channelId || stopping) return;
    setStopping(true);
    setHistoryError('');
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/missions/${mission.id}/finish`, {
        method: 'POST',
        body: JSON.stringify({
          coordinatorRegistrationId: mission.coordinatorMention || mission.coordinator,
          status: 'canceled',
          summary: 'Stopped by user.',
        }),
      });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not stop mission');
    } finally {
      setStopping(false);
    }
  }
  // Treat the mission chrome like a normal message: right-click opens the same
  // context menu (Reply/Forward/…) targeting the originating chat message.
  // Wire it on buttons too — some browsers only fire contextmenu on the target.
  const openMissionContextMenu = replyMessage && onContextMenu
    ? (event: React.MouseEvent) => onContextMenu(event, replyMessage)
    : undefined;
  return (
    <div
      className={`chat-mission-card is-${mission.status}${live ? ' is-live' : ''}${open ? ' is-open' : ''}`}
      data-open={open ? 'true' : 'false'}
      data-message-id={replyMessage?.id}
      onContextMenu={openMissionContextMenu}
    >
      <div className="chat-mission-head">
        <button
          type="button"
          className="chat-mission-toggle"
          onClick={() => setOpen((value) => !value)}
          onContextMenu={openMissionContextMenu}
          aria-expanded={open}
        >
          {live
            ? <ThinkingSpinner className="chat-mission-whirl" title="Mission working" />
            : <span className="chat-mission-state" aria-hidden="true" />}
          <span className="chat-mission-kicker">Mission</span>
          <strong>{mission.title}</strong>
          <span className="chat-mission-status">{statusLabel}</span>
          <ChevronRight size={13} className={`chat-mission-chevron${open ? ' open' : ''}`} aria-hidden="true" />
        </button>
        {live && vaultId && channelId && (
          <button
            type="button"
            className="chat-mission-stop"
            onClick={() => void stopMission()}
            onContextMenu={openMissionContextMenu}
            disabled={stopping}
            title="Stop mission"
          >
            {stopping ? <Loader2 className="is-spinning" size={11} /> : <Square size={10} fill="currentColor" />}
            {stopping ? 'Stopping' : 'Stop'}
          </button>
        )}
        {showPeek && (
          <button
            type="button"
            className={`chat-mission-peek${peekLive ? ' is-live' : ''}`}
            onClick={() => setOpen((value) => !value)}
            onContextMenu={openMissionContextMenu}
            aria-expanded={false}
            aria-label={`Mission activity: ${peekAuthor ? `${peekAuthor} — ` : ''}${peekLabel}`}
          >
            {/* Empty gutter matches the status-dot column; header owns the spinner. */}
            <span className="chat-mission-peek-gutter" aria-hidden="true" />
            {peekAuthor && <span className="chat-mission-peek-author">{peekAuthor}</span>}
            <span className="chat-mission-peek-label">{peekLabel}</span>
          </button>
        )}
      </div>
      {open && (
        <div className="chat-mission-content" onContextMenu={openMissionContextMenu}>
          <div className="chat-mission-stream">
            {traceContent && (
              <div className="chat-mission-trace">{traceContent}</div>
            )}
            <div className="chat-mission-plan">
              {lead && (
                <p className="chat-mission-lead">
                  Led by <strong>@{lead}</strong>
                  {total > 0 ? ` · ${done}/${total} agent tasks` : ''}
                </p>
              )}
              {mission.objective && <p className="chat-mission-objective">{mission.objective}</p>}
              {mission.tasks.length > 0 ? (
                <div className="chat-mission-tasks">
                  {mission.tasks.map((task) => (
                    <div className={`chat-mission-task is-${task.status}`} key={task.id}>
                      <span className="chat-mission-task-state" aria-label={task.status}>
                        {task.status === 'completed' ? '✓'
                          : task.status === 'failed' || task.status === 'blocked' ? '!'
                            : task.status === 'running' ? (
                              <ThinkingSpinner className="chat-mission-task-whirl" title="Task running" />
                            ) : '○'}
                      </span>
                      <div>
                        <strong>{task.title}</strong>
                        <span>
                          @{task.assigneeMention || task.assignee} · {task.status}
                          {task.anonymous ? ' · subagent' : ''}
                          {task.attempt > 0 ? ` · attempt ${task.attempt + 1}` : ''}
                          {task.queueReason === 'dependency' ? ` · waiting for ${task.waitingFor.length}` : ''}
                          {task.queueReason === 'dependency-attention' ? ' · waiting on review' : ''}
                          {task.queueReason === 'agent-busy' ? ' · agent busy' : ''}
                          {task.queueReason === 'queued' ? ' · queued' : ''}
                          {task.assigneeModel ? ` · ${task.assigneeModel}` : ''}
                          {task.reasoningEffort ? ` · ${task.reasoningEffort} effort` : ''}
                        </span>
                        {task.workItemId && (
                          <div className="chat-mission-chips">
                            {missionTaskChangeChips(task, task.worktreePath ? fileCounts.get(task.worktreePath) : undefined).map((chip, index) => (
                              chip.href ? (
                                <a key={`${chip.label}:${index}`} className={`chat-mission-chip is-${chip.tone || 'idle'}`} href={chip.href} target="_blank" rel="noreferrer" title={chip.title}>
                                  {chip.label}
                                </a>
                              ) : (
                                <span key={`${chip.label}:${index}`} className={`chat-mission-chip is-${chip.tone || 'idle'}`} title={chip.title}>
                                  {chip.label}
                                </span>
                              )
                            ))}
                          </div>
                        )}
                        {task.summary && <small>{task.summary}</small>}
                        {task.workItemId && task.worktreePath && (
                          <ChatTaskReview workItemId={task.workItemId} worktreePath={task.worktreePath} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="chat-mission-empty">@{lead || mission.coordinator} is deciding how to handle this.</span>
              )}
              {mission.summary && <div className="chat-mission-summary">{mission.summary}</div>}
            </div>
          </div>
          {vaultId && channelId && (
            <div className="chat-mission-history">
              <button type="button" onClick={() => void toggleTimeline()}>
                <History size={12} />
                {timelineOpen ? 'Hide timeline' : 'Timeline'}
              </button>
              {timelineOpen && (
                <div className="chat-mission-timeline">
                  {events === null && !historyError && <span>Loading history…</span>}
                  {historyError && <span className="is-error">{historyError}</span>}
                  {events?.length === 0 && <span>No recorded events.</span>}
                  {events?.map((event) => (
                    <div className="chat-mission-event" key={event.id}>
                      <i aria-hidden="true" />
                      <div>
                        <strong>{missionEventLabel(event)}</strong>
                        <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                        {event.title && event.title !== mission.title && <span>{event.title}</span>}
                        {event.attempt > 0 && <span>Attempt {event.attempt + 1}</span>}
                        {event.summary && <small>{event.summary}</small>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
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
  jumpHighlightMessageId,
  avatarKind,
  avatarUrl,
  authorLabel,
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
  onJumpToMessage,
  loadedMessageIds,
  onLightbox,
  onImageLoad,
  onAgentAvatarClick,
  scrollRootRef,
  vaultId,
  onHydrateMessage,
  traceContent,
  traceAfterFirstMessage = false,
  contextMenuMessage,
}: {
  group: ChatMessageGroup;
  /** Pre-filtered by the parent: non-null only when the selection is inside this group. */
  selectedMessageId: string | null;
  /** Pre-filtered by the parent: briefly pulses the exact row reached by a jump. */
  jumpHighlightMessageId: string | null;
  avatarKind: 'agent' | 'human';
  avatarUrl?: string;
  authorLabel?: string;
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
  /** Scrolls to and selects a message in this channel (reply-quote click). */
  onJumpToMessage: (messageId: string) => void;
  /** Ids currently rendered, so a quote only offers a jump it can honour. */
  loadedMessageIds: ReadonlySet<string>;
  onLightbox: (src: string) => void;
  onImageLoad: () => void;
  /** Open channel membership settings for this agent (message avatar click). */
  onAgentAvatarClick?: (event: React.MouseEvent) => void;
  /** Chat scroller element — used as IntersectionObserver root. */
  scrollRootRef: RefObject<HTMLDivElement | null>;
  vaultId?: string;
  onHydrateMessage?: (message: ChatMessage) => void;
  /** A collapsed workflow trace carried by this agent row. */
  traceContent?: ReactNode;
  /** Keep later user-facing updates under this author header, after the mission/work trace. */
  traceAfterFirstMessage?: boolean;
  /** Mission origin targeted when the user right-clicks anywhere on this row. */
  contextMenuMessage?: ChatMessage;
}) {
  const head = group.messages[0];
  const tail = group.messages[group.messages.length - 1];
  const groupHasRunWidget = Boolean(traceContent)
    || group.messages.some((message) => message.status === 'running' || hasExpandableTrace(message));
  const groupSelected = group.messages.some((message) => message.id === selectedMessageId);
  const articleRef = useRef<HTMLElement | null>(null);
  const heightRef = useRef(0);
  // Start mounted so first paint / stick-to-bottom has real content; IO then unmounts offscreen.
  const [inView, setInView] = useState(true);
  const forceMounted = groupSelected
    || group.messages.some((message) => message.status === 'running')
    // Never unmount mid-swipe: orphan pointer capture freezes clicks until restart.
    || swipeGestureActive();

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
        } else if (!forceMounted && !swipeGestureActive()) {
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
      onContextMenu={contextMenuMessage
        ? (event) => onContextMenu(event, contextMenuMessage)
        : undefined}
    >
      {showBody ? (
        <>
          <ChatAvatar
            name={authorLabel || head.author}
            kind={avatarKind}
            avatarUrl={avatarUrl}
            onClick={avatarKind === 'agent' ? onAgentAvatarClick : undefined}
            title={avatarKind === 'agent' && onAgentAvatarClick
              ? `Open settings for ${authorLabel || head.author}`
              : undefined}
          />
          <div className="chat-message-body">
            <div className="chat-message-meta">
              <strong>{authorLabel || head.author}</strong>
              {avatarKind === 'agent' && planUsage && <PlanUsageMeters usage={planUsage} />}
              {avatarKind === 'agent' && ownerLabel && <span className="chat-agent-owner">{ownerLabel}'s agent</span>}
              <time dateTime={tail.createdAt}>{formatTime(tail.createdAt)}</time>
              {avatarKind === 'agent' && tail.status === 'running' && latestRunningMessageId === tail.id && runningSiblingCount > 1 && (
                <span className="chat-message-status is-steering">steering · latest</span>
              )}
              {avatarKind === 'agent' && tail.status === 'running' && latestRunningMessageId === tail.id && runningSiblingCount <= 1 && <span className="chat-message-status">working</span>}
              {avatarKind === 'agent' && tail.status === 'running' && latestRunningMessageId !== tail.id && <span className="chat-message-status is-steered">continued below</span>}
              {avatarKind === 'agent' && tail.status === 'sending' && <span className="chat-message-status">queued</span>}
              {avatarKind === 'agent' && tail.status === 'failed' && <span className="chat-message-status is-error">failed</span>}
              {avatarKind === 'agent' && tail.status === 'canceled' && isSteeringContinuationMessage(tail) && (
                <span className="chat-message-status is-steered">steered</span>
              )}
              {avatarKind === 'agent' && tail.status === 'canceled' && !isSteeringContinuationMessage(tail) && (
                <span className="chat-message-status is-error">canceled</span>
              )}
            </div>
            {group.messages.map((message, messageIndex) => {
              const hasRunWidget = message.status === 'running';
              const hasThoughtBlocks = hasExpandableTrace(message);
              const isLatestRunningMessage = message.status !== 'running' || latestRunningMessageId === message.id;
              const isTappable = hasRunWidget || hasThoughtBlocks;
              const selected = selectedMessageId === message.id;
              const jumpHighlighted = jumpHighlightMessageId === message.id;
              return (<Fragment key={message.id}>
                <SwipeToReply
                  messageId={message.id}
                  className={`chat-message-chunk ${isTappable ? 'has-run-widget' : ''} ${selected ? 'selected' : ''} ${jumpHighlighted ? 'is-jump-highlighted' : ''}`}
                  onReply={() => onReply(message)}
                  onClick={() => {
                    if (isTappable) onToggleSelect(message.id);
                  }}
                  onContextMenu={(event) => onContextMenu(event, message)}
                >
                  <ChatQuoteRefs
                    message={message}
                    onJumpToMessage={onJumpToMessage}
                    canJumpToReply={Boolean(
                      message.replyTo && loadedMessageIds.has(message.replyTo.messageId),
                    )}
                  />
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
                        isMp4Attachment(attachment) ? (
                          <div key={attachmentIndex} className="chat-msg-video">
                            <video
                              className="chat-msg-video-el"
                              controls
                              playsInline
                              preload="metadata"
                              src={attachment.url}
                              onLoadedData={onImageLoad}
                            >
                              <a href={attachment.url} download={attachment.name} target="_blank" rel="noreferrer">
                                {attachment.name || 'video.mp4'}
                              </a>
                            </video>
                            {attachment.name && <span className="chat-msg-video-label">{attachment.name}</span>}
                          </div>
                        ) : (
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
                        )
                      ))}
                    </div>
                  )}
                  {message.body
                    && !isSteeringContinuationMessage(message)
                    && !(message.status === 'running' && /^Thinking(?:\.{3}|…)$/.test(message.body.trim()))
                    && <ChatMessageText messageId={message.id} body={message.body} streaming={message.status === 'running'} mentionableAliases={mentionableAliases} notes={notes} onOpenNote={onOpenNote} onOpenSharedNote={onOpenSharedNote} />}
                  {message.mission && (
                    <ChatMissionCard
                      mission={message.mission}
                      vaultId={vaultId}
                      channelId={message.channelId}
                      replyMessage={message}
                      onContextMenu={onContextMenu}
                    />
                  )}
                  {message.clarification && (
                    <ChatClarificationCard message={message} vaultId={vaultId} />
                  )}
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
                {traceAfterFirstMessage && messageIndex === 0 && traceContent}
              </Fragment>);
            })}
            {!traceAfterFirstMessage && traceContent}
          </div>
        </>
      ) : (
        <div className="chat-message-offscreen-stub" />
      )}
    </article>
  );
}, (prev, next) => {
  // segmentTranscript rebuilds group wrappers every stream tick — compare the
  // underlying message refs so settled groups skip re-render.
  const prevMsgs = prev.group.messages;
  const nextMsgs = next.group.messages;
  if (prevMsgs.length !== nextMsgs.length) return false;
  for (let i = 0; i < prevMsgs.length; i += 1) {
    if (prevMsgs[i] !== nextMsgs[i]) return false;
  }
  return prev.selectedMessageId === next.selectedMessageId
  && prev.jumpHighlightMessageId === next.jumpHighlightMessageId
  && prev.avatarKind === next.avatarKind
  && prev.avatarUrl === next.avatarUrl
  && prev.authorLabel === next.authorLabel
  && prev.ownerLabel === next.ownerLabel
  && prev.planUsage === next.planUsage
  && prev.latestRunningMessageId === next.latestRunningMessageId
  && prev.runningSiblingCount === next.runningSiblingCount
  && prev.steeringPromptLabels === next.steeringPromptLabels
  && prev.mentionableAliases === next.mentionableAliases
  // Same trick as ChatMessageText: note churn only invalidates groups that
  // actually render an embed.
  && (prev.notes === next.notes || !groupHasDocEmbed(next.group))
  && prev.onJumpToMessage === next.onJumpToMessage
  && prev.loadedMessageIds === next.loadedMessageIds
  && prev.onOpenNote === next.onOpenNote
  && prev.onOpenSharedNote === next.onOpenSharedNote
  && prev.onCancelRun === next.onCancelRun
  && prev.onToggleSelect === next.onToggleSelect
  && prev.onContextMenu === next.onContextMenu
  && prev.onReply === next.onReply
  && prev.onLightbox === next.onLightbox
  && prev.onImageLoad === next.onImageLoad
  && prev.onAgentAvatarClick === next.onAgentAvatarClick
  && prev.scrollRootRef === next.scrollRootRef
  && prev.vaultId === next.vaultId
  && prev.onHydrateMessage === next.onHydrateMessage
  && prev.traceAfterFirstMessage === next.traceAfterFirstMessage
  && prev.contextMenuMessage === next.contextMenuMessage
  && prev.traceContent === next.traceContent;
});

export const ChatView = memo(function ChatView({
  channelId,
  channelName,
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
  onCollaborateMessage,
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
  sidebarMode = 'inline',
}: ChatViewProps) {
  // Messages come from an external per-channel store, not props: streaming tokens
  // then re-render only this ChatView, never the App shell. See messageStore.ts.
  const messages = useChannelMessages(channelId);
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
  const [editingRegistrationId, setEditingRegistrationId] = useState<string | null>(null);
  const [agentFormError, setAgentFormError] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [customModel, setCustomModel] = useState('');
  // Channel-wide working directory: when set, every agent in the channel runs
  // from here (overrides each agent's own cwd, enforced server-side).
  const [channelCwd, setChannelCwd] = useState('');
  const [channelCwdSaved, setChannelCwdSaved] = useState(false);
  const [channelKanbanNoteId, setChannelKanbanNoteId] = useState('');
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false);

  useEffect(() => {
    if (!vaultId || !channelId) return;
    let alive = true;
    api<{ settings: { cwd: string; kanbanNoteId?: string } }>(`/api/vaults/${vaultId}/channels/${channelId}/settings`)
      .then((d) => {
        if (!alive) return;
        setChannelCwd(d.settings?.cwd ?? '');
        setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
      })
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
      const d = await api<{ settings: { cwd: string; kanbanNoteId?: string } }>(
        `/api/vaults/${vaultId}/channels/${channelId}/settings`,
        { method: 'PUT', body: JSON.stringify({ cwd: next }) },
      );
      setChannelCwd(d.settings?.cwd ?? '');
      setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
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
      priorityServiceTier: false,
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
    priorityServiceTier: false,
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
  const [jumpHighlightMessageId, setJumpHighlightMessageId] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatReplyRef | null>(null);
  const [replyNotifiesAgent, setReplyNotifiesAgent] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: ChatMessage } | null>(null);
  const [collaborationSource, setCollaborationSource] = useState<ChatMessage | null>(null);
  const [collaborationTargetId, setCollaborationTargetId] = useState('');
  const [collaborationRelationship, setCollaborationRelationship] = useState<ChatRelationship>('review_request');
  const [collaborationInstruction, setCollaborationInstruction] = useState(CHAT_RELATIONSHIP_INSTRUCTIONS.review_request);
  const [collaborationBusy, setCollaborationBusy] = useState(false);
  const [collaborationError, setCollaborationError] = useState('');
  const [participantMenu, setParticipantMenu] = useState<{ x: number; y: number; username: string; action: 'remove' | 'leave' } | null>(null);
  const [reportMessage, setReportMessage] = useState<ChatMessage | null>(null);
  const contextMenuRef = usePopupMenu<HTMLDivElement>(contextMenu);
  const participantMenuRef = usePopupMenu<HTMLDivElement>(participantMenu);
  /** Delete is two-step in the context menu rather than a native confirm dialog. */
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<ChatMediaAttachment[]>([]);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [sharedNote, setSharedNote] = useState<SharedChatNote | null>(null);
  const [missionArchiveOpen, setMissionArchiveOpen] = useState(false);
  const [missionArchive, setMissionArchive] = useState<ChatMission[]>([]);
  const [missionArchiveBusy, setMissionArchiveBusy] = useState(false);
  const [missionArchiveError, setMissionArchiveError] = useState('');
  const loadMissionArchive = useCallback(async () => {
    if (!vaultId) return;
    setMissionArchiveBusy(true);
    setMissionArchiveError('');
    try {
      const result = await api<{ missions: ChatMission[] }>(
        `/api/vaults/${vaultId}/channels/${channelId}/missions`,
      );
      setMissionArchive(result.missions || []);
    } catch (error) {
      setMissionArchiveError(error instanceof Error ? error.message : 'Could not load missions');
    } finally {
      setMissionArchiveBusy(false);
    }
  }, [vaultId, channelId]);
  useEffect(() => {
    setMissionArchiveOpen(false);
    setMissionArchive([]);
    setMissionArchiveError('');
    setCollaborationSource(null);
    setCollaborationError('');
  }, [channelId]);
  const collaborationTargets = useMemo(() => {
    const profile = Object.values(presence.profiles || {}).find((item) => (
      item.username.toLowerCase() === currentUser.toLowerCase()
    ));
    const currentUserId = profile?.id;
    const seen = new Set<string>();
    return registeredAgents.filter((registration) => {
      if (
        currentUserId != null
        && registration.ownerUserId != null
        && registration.ownerUserId !== currentUserId
        && !registration.pingableByOthers
      ) return false;
      const key = registration.vaultAgentId || registration.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [currentUser, presence.profiles, registeredAgents]);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  /** Inner content wrapper — ResizeObserver watches height growth (harness, thinking). */
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const jumpHighlightTimerRef = useRef<number | null>(null);
  // null so the first mount counts as a channel change and force-scrolls to bottom.
  const previousChannelIdRef = useRef<string | null>(null);
  // True while we scroll programmatically, so the resulting scroll events aren't
  // mistaken for the user scrolling away from the bottom (which would unstick).
  const programmaticScrollRef = useRef(false);
  const programmaticClearRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
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
  // Grouping identity cache removed: transcript segments are recomputed with
  // message-ref equality via sortedMessages + segmentTranscript.
  // Lazily hydrate messages whose data-URL images the list payload stripped.
  // Track only in-flight work, not "ever hydrated": a reconnect can replace a
  // full message with another slim copy and must be allowed to hydrate it again.
  const hydratingImageIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!vaultId || !onHydrateMessage) return;
    for (const message of sortedMessages) {
      if (!message.hasImages || message.images?.length || hydratingImageIdsRef.current.has(message.id)) continue;
      // A dispatch shell exists before its run is accepted and therefore has no
      // persisted message to hydrate. Waiting for the server-owned replacement
      // avoids a noisy 404 when an offline desktop rejects the dispatch.
      if (message.id.startsWith('agent-dispatch-')) continue;
      hydratingImageIdsRef.current.add(message.id);
      void api<{ message: ChatMessage }>(
        `/api/vaults/${vaultId}/channels/${message.channelId}/messages/${encodeURIComponent(message.id)}`,
      )
        .then((data) => { if (data.message) onHydrateMessage(data.message); })
        .catch(() => {})
        .finally(() => { hydratingImageIdsRef.current.delete(message.id); });
    }
  }, [sortedMessages, vaultId, onHydrateMessage]);

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
  // Collapse multi-agent chatter into TUI-style work traces between human turns.
  const transcriptSegments = useMemo(
    () => segmentTranscript(sortedMessages, { agentAuthors }),
    [agentAuthors, sortedMessages],
  );
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
  const canManageRegistration = useCallback((registration: ChatAgentRegistration) => {
    const identity = registration.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    return Boolean(identity && identity.ownerUsername === currentUser);
  }, [currentUser, vaultAgentById]);
  const resolveMessageRegistration = (message: ChatMessage) =>
    message.registrationId
      ? registrationById.byId.get(message.registrationId)
      : registrationById.byAgentOrName.get(message.agentId ?? '') ?? registrationById.byAgentOrName.get(message.author);
  const getMessageAvatarKind = (message: ChatMessage): 'agent' | 'human' =>
    message.agentId || agentAuthors.has(message.author) ? 'agent' : 'human';
  const resolveHumanProfile = (author: string) => {
    const profiles = presence.profiles || {};
    if (profiles[author]) return profiles[author];
    // Profiles are keyed by username; some older rows used display names as author.
    return Object.values(profiles).find((profile) => profile.displayName === author);
  };
  const getMessageAvatarUrl = (message: ChatMessage) => {
    return resolveMessageRegistration(message)?.avatarUrl
      || resolveHumanProfile(message.author)?.avatarUrl
      || '';
  };
  const getMessageAuthorLabel = (message: ChatMessage) =>
    resolveMessageRegistration(message)?.displayName
      || resolveHumanProfile(message.author)?.displayName
      || message.author;
  const getMessageOwnerLabel = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const identity = registration?.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    return identity?.ownerUsername || '';
  };
  const getMessagePlanUsage = (message: ChatMessage) => {
    const registration = resolveMessageRegistration(message);
    const identity = registration?.vaultAgentId ? vaultAgentById.get(registration.vaultAgentId) : undefined;
    // Runner usage is private to the assistant owner's local account. Do not
    // paint the viewer's limits onto another person's agent in a shared chat.
    if (!identity || identity.ownerUsername !== currentUser) return null;
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
  const jumpTimersRef = useRef<{ raf: number; timer: number }>({ raf: 0, timer: 0 });

  // Select (which force-mounts the group out of its offscreen placeholder),
  // then centre it. Auto-pin-to-bottom is suppressed so a freshly opened
  // channel does not yank us back down.
  const runJumpToMessage = useCallback((targetId: string) => {
    setSelectedMessageId(targetId);
    setJumpHighlightMessageId(targetId);
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
    jumpHighlightTimerRef.current = window.setTimeout(() => {
      jumpHighlightTimerRef.current = null;
      setJumpHighlightMessageId((current) => current === targetId ? null : current);
    }, 1300);
    wasAtBottomRef.current = false;
    userScrollQuietUntilRef.current = performance.now() + 1200;
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
    const tick = () => {
      const done = scrollToTarget();
      tries += 1;
      if (!done || tries < 4) jumpTimersRef.current.timer = window.setTimeout(tick, 90);
    };
    cancelAnimationFrame(jumpTimersRef.current.raf);
    if (jumpTimersRef.current.timer) clearTimeout(jumpTimersRef.current.timer);
    jumpTimersRef.current.raf = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => {
    cancelAnimationFrame(jumpTimersRef.current.raf);
    if (jumpTimersRef.current.timer) clearTimeout(jumpTimersRef.current.timer);
  }, []);

  // Jump to a specific message opened from elsewhere (e.g. clicked from
  // search). Waits until the target is in this channel's list.
  useEffect(() => {
    if (!jumpToMessageId) { jumpHandledRef.current = null; return; }
    if (jumpHandledRef.current === jumpToMessageId) return;
    if (!sortedMessages.some((message) => message.id === jumpToMessageId)) return;
    jumpHandledRef.current = jumpToMessageId;
    runJumpToMessage(jumpToMessageId);
    onJumpHandled?.();
  }, [jumpToMessageId, sortedMessages, onJumpHandled, runJumpToMessage]);

  // Which reply quotes can actually scroll somewhere.
  const loadedMessageIds = useMemo(
    () => new Set(sortedMessages.map((message) => message.id)),
    [sortedMessages],
  );

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
    if (jumpHighlightTimerRef.current != null) clearTimeout(jumpHighlightTimerRef.current);
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
    setParticipantMenu(null);
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
    if (!participantMenu) return;
    const close = () => setParticipantMenu(null);
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
  }, [participantMenu]);

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
    setUsersCollapsed(false);
    setChannelSettingsOpen(false);
    setAgentPanelMode('edit-member');
    openAgentEditor(registration);
  }

  /** Message-row avatar → same settings surface as the members rail. */
  const openAgentSettingsFromMessage = useCallback((message: ChatMessage, event: React.MouseEvent) => {
    event.stopPropagation();
    const registration = message.registrationId
      ? registrationById.byId.get(message.registrationId)
      : registrationById.byAgentOrName.get(message.agentId ?? '')
        ?? registrationById.byAgentOrName.get(message.author);
    if (!registration) return;
    if (!canManageRegistration(registration)) return;
    setUsersCollapsed(false);
    setChannelSettingsOpen(false);
    setAgentFormError('');
    const agent = availableAgents.find((option) => option.id === registration.agentId);
    const { choice, custom } = resolveModelPicker(agent, registration.model);
    setModelChoice(choice);
    setCustomModel(custom);
    setAgentForm({ ...registration, model: modelFromPicker(choice, custom) });
    setEditingRegistrationId(registration.id);
    setAgentPanelMode('edit-member');
    setAgentMenuOpen(true);
  }, [availableAgents, canManageRegistration, registrationById, setUsersCollapsed]);

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
          priorityServiceTier: false,
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

  const targetsForCollaboration = useCallback((message: ChatMessage) => (
    collaborationTargets.filter((registration) => (
      registration.id !== message.registrationId
      && (!message.registrationId || registration.vaultAgentId !== registeredAgents.find((item) => item.id === message.registrationId)?.vaultAgentId)
    ))
  ), [collaborationTargets, registeredAgents]);

  const startCollaboration = useCallback((message: ChatMessage) => {
    const targets = targetsForCollaboration(message);
    if (!onCollaborateMessage || targets.length === 0) return;
    setContextMenu(null);
    setCollaborationSource(message);
    setCollaborationTargetId(targets[0].id);
    setCollaborationRelationship('review_request');
    setCollaborationInstruction(CHAT_RELATIONSHIP_INSTRUCTIONS.review_request);
    setCollaborationError('');
  }, [onCollaborateMessage, targetsForCollaboration]);

  const submitCollaboration = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    if (!collaborationSource || !collaborationTargetId || !collaborationInstruction.trim() || !onCollaborateMessage) return;
    setCollaborationBusy(true);
    setCollaborationError('');
    try {
      await onCollaborateMessage(
        channelId,
        collaborationSource.id,
        collaborationTargetId,
        collaborationRelationship,
        collaborationInstruction.trim(),
      );
      setCollaborationSource(null);
    } catch (error) {
      setCollaborationError(error instanceof Error ? error.message : 'Could not ask agent');
    } finally {
      setCollaborationBusy(false);
    }
  }, [channelId, collaborationInstruction, collaborationRelationship, collaborationSource, collaborationTargetId, onCollaborateMessage]);

  const openMessageContextMenu = useCallback((event: React.MouseEvent, message: ChatMessage) => {
    event.preventDefault();
    event.stopPropagation();
    setDeleteArmed(false);
    setContextMenu({ x: event.clientX, y: event.clientY, message });
  }, []);

  const openParticipantContextMenu = useCallback((event: React.MouseEvent, username: string, action: 'remove' | 'leave') => {
    event.preventDefault();
    event.stopPropagation();
    setParticipantMenu({ x: event.clientX, y: event.clientY, username, action });
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
      setInviteStatus(`Added @${username} to the vault.`);
    } catch (error) {
      setInviteStatus(error instanceof Error ? error.message : 'Could not invite user');
    } finally {
      setInviteBusy(false);
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

  useEffect(() => {
    if (!emojiPickerOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(event.target as Node)) {
        setEmojiPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [emojiPickerOpen]);

  const insertEmoji = useCallback((emoji: string) => {
    const textarea = draftRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart ?? draft.length;
    const end = textarea.selectionEnd ?? start;
    setDraft(`${draft.slice(0, start)}${emoji}${draft.slice(end)}`);
    setEmojiPickerOpen(false);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursor = start + emoji.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }, [draft]);

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
    resetHistory();
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

  // Undo/redo history for the composer. A controlled textarea loses the browser's
  // native undo stack, so we keep our own snapshots and coalesce rapid typing into
  // a single step (commit fires 350ms after the last keystroke).
  const historyRef = useRef<{ stack: { v: string; s: number; e: number }[]; index: number }>({
    stack: [{ v: '', s: 0, e: 0 }],
    index: 0,
  });
  const historyTimerRef = useRef<number | null>(null);
  const historySelRef = useRef<{ s: number; e: number } | null>(null);

  const commitHistory = useCallback(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    const history = historyRef.current;
    const top = history.stack[history.index];
    if (top && top.v === textarea.value) {
      top.s = textarea.selectionStart;
      top.e = textarea.selectionEnd;
      return;
    }
    history.stack = history.stack.slice(0, history.index + 1);
    history.stack.push({ v: textarea.value, s: textarea.selectionStart, e: textarea.selectionEnd });
    history.index = history.stack.length - 1;
  }, []);

  const scheduleHistoryCommit = useCallback(() => {
    if (historyTimerRef.current) window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null;
      commitHistory();
    }, 350);
  }, [commitHistory]);

  const resetHistory = useCallback(() => {
    if (historyTimerRef.current) { window.clearTimeout(historyTimerRef.current); historyTimerRef.current = null; }
    historyRef.current = { stack: [{ v: '', s: 0, e: 0 }], index: 0 };
  }, []);

  const stepHistory = useCallback((dir: -1 | 1) => {
    if (historyTimerRef.current) { window.clearTimeout(historyTimerRef.current); historyTimerRef.current = null; }
    commitHistory();
    const history = historyRef.current;
    const target = history.index + dir;
    if (target < 0 || target >= history.stack.length) return;
    history.index = target;
    const entry = history.stack[target];
    historySelRef.current = { s: entry.s, e: entry.e };
    setDraft(entry.v);
  }, [commitHistory]);

  // Restore the caret after an undo/redo swap re-renders the textarea.
  useLayoutEffect(() => {
    const sel = historySelRef.current;
    if (!sel) return;
    historySelRef.current = null;
    const textarea = draftRef.current;
    if (textarea) { textarea.focus(); textarea.setSelectionRange(sel.s, sel.e); }
  }, [draft]);

  useLayoutEffect(() => {
    const textarea = draftRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 180);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
  }, [draft]);

  return (
    <section className={`chat-view${sidebarMode === 'only' ? ' is-sidebar-only' : ''}${sidebarMode === 'hidden' ? ' is-sidebar-hidden' : ''}`}>
      {sidebarMode !== 'only' && <div className="chat-main">
        <header className="chat-header">
          <div className="chat-header-copy">
            <h2>{channelName}</h2>
            <span>{sortedMessages.length} messages</span>
          </div>
          {vaultId && (
            <button
              type="button"
              className="chat-mission-archive-button"
              title="Mission history"
              aria-label="Open mission history"
              onClick={() => {
                setMissionArchiveOpen(true);
                void loadMissionArchive();
              }}
            >
              <History size={15} />
              <span>Missions</span>
            </button>
          )}
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
              <Hash size={28} className="chat-empty-icon" />
              <strong>#{channelName}</strong>
              <span className="chat-empty-hint">No messages yet — say hello or @mention an agent to start.</span>
            </div>
          ) : (
            transcriptSegments.flatMap((segment, segmentIndex) => {
              const renderGroupRow = (group: ChatMessageGroup) => {
                const head = group.messages[0];
                const groupSelected = selectedMessageId != null
                  && group.messages.some((message) => message.id === selectedMessageId);
                const groupJumpHighlighted = jumpHighlightMessageId != null
                  && group.messages.some((message) => message.id === jumpHighlightMessageId);
                const runKey = head.registrationId || head.agentId || '';
                const runState = runKey ? runningMessageState.get(runKey) : undefined;
                return (
                  <ChatGroupRow
                    key={head.id}
                    group={group}
                    selectedMessageId={groupSelected ? selectedMessageId : null}
                    jumpHighlightMessageId={groupJumpHighlighted ? jumpHighlightMessageId : null}
                    avatarKind={getMessageAvatarKind(head)}
                    avatarUrl={getMessageAvatarUrl(head)}
                    authorLabel={getMessageAuthorLabel(head)}
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
                    onJumpToMessage={runJumpToMessage}
                    loadedMessageIds={loadedMessageIds}
                    onLightbox={openLightbox}
                    onImageLoad={scrollToBottomIfSticky}
                    onAgentAvatarClick={
                      resolveMessageRegistration(head)
                        ? (event) => openAgentSettingsFromMessage(head, event)
                        : undefined
                    }
                    scrollRootRef={messagesRef}
                    vaultId={vaultId}
                    onHydrateMessage={onHydrateMessage}
                    contextMenuMessage={group.messages.find((message) => Boolean(message.mission))}
                  />
                );
              };
              if (segment.kind === 'work') {
                // A trace is always nested in an agent row. System notices
                // that start a run are attributed when persisted; older
                // unowned notices deliberately stay out of the transcript
                // instead of looking like progress on the human message.
                // Anchor a completed mission clump to its user-facing update,
                // not to an empty worker shell that happened to start the run.
                // This keeps the mission, mixed-agent trace, and outcome under
                // one coordinator header while preserving each trace author.
                const updateHost = segment.updateGroups.at(-1)?.messages.at(-1);
                const host = updateHost
                  || segment.carrier
                  || segment.trace.find((message) => message.registrationId || message.agentId);
                if (!host) return [];
                // A real carrier is persisted for system-only work. Existing
                // agent traces use the same empty shell shape at render time.
                const carrier = updateHost || !segment.carrier ? {
                  ...host,
                  id: `agent-trace-${segment.id}`,
                  body: '',
                  status: undefined,
                } : segment.carrier;
                const traceSelected = selectedMessageId != null
                  && segment.trace.some((message) => message.id === selectedMessageId);
                const traceJumpHighlighted = jumpHighlightMessageId != null
                  && segment.trace.some((message) => message.id === jumpHighlightMessageId);
                const previousSegment = transcriptSegments[segmentIndex - 1];
                const missionArtifacts = [
                  ...(previousSegment?.kind === 'group'
                    ? previousSegment.group.messages.filter((message) => Boolean(message.mission))
                    : []),
                  ...(carrier.mission ? [carrier] : []),
                  ...segment.fullGroups
                  .flatMap((group) => group.messages)
                  .filter((message) => Boolean(message.mission)),
                ];
                const displayCarrier = carrier.mission ? { ...carrier, mission: undefined } : carrier;
                const carrierKey = displayCarrier.registrationId || displayCarrier.agentId || displayCarrier.author;
                const clumpedUpdateMessages: ChatMessage[] = [];
                const separateUpdateGroups: ChatMessageGroup[] = [];
                for (const group of segment.updateGroups) {
                  const head = group.messages[0];
                  const headKey = head.registrationId || head.agentId || head.author;
                  if (headKey === carrierKey) clumpedUpdateMessages.push(...group.messages);
                  else separateUpdateGroups.push(group);
                }
                const clumpedSelected = selectedMessageId != null
                  && clumpedUpdateMessages.some((message) => message.id === selectedMessageId);
                const missionHasTrace = missionArtifacts.length > 0 && segment.trace.length > 0;
                const workTrace = (
                  <ChatWorkTrace
                    trace={segment.trace}
                    selectedMessageId={traceSelected || clumpedSelected ? selectedMessageId : null}
                    onCancelRun={onCancelRun}
                    onContextMenu={openMessageContextMenu}
                    vaultId={vaultId}
                    onHydrateMessage={onHydrateMessage}
                    runningMessageState={runningMessageState}
                    embedded={missionHasTrace}
                  />
                );
                const peek = workTracePeek(segment.trace);
                const unifiedMission = missionArtifacts.length > 0
                  ? missionArtifacts.map((message) => (
                    <ChatMissionCard
                      key={message.id}
                      mission={message.mission!}
                      vaultId={vaultId}
                      channelId={message.channelId}
                      traceContent={workTrace}
                      tracePeek={peek}
                      replyMessage={message}
                      onContextMenu={openMessageContextMenu}
                    />
                  ))
                  : workTrace;
                const nodes: ReactNode[] = [
                  <ChatGroupRow
                    key={`work-${segment.id}`}
                    group={{ messages: [displayCarrier, ...clumpedUpdateMessages] }}
                    selectedMessageId={traceSelected ? selectedMessageId : null}
                    jumpHighlightMessageId={traceJumpHighlighted ? jumpHighlightMessageId : null}
                    avatarKind="agent"
                    avatarUrl={getMessageAvatarUrl(displayCarrier)}
                    authorLabel={getMessageAuthorLabel(displayCarrier)}
                    ownerLabel={getMessageOwnerLabel(displayCarrier)}
                    planUsage={getMessagePlanUsage(displayCarrier)}
                    latestRunningMessageId={undefined}
                    runningSiblingCount={0}
                    steeringPromptLabels={steeringPromptLabels}
                    mentionableAliases={mentionableAliases}
                    notes={notes}
                    onOpenNote={onOpenNote}
                    onOpenSharedNote={openSharedNote}
                    onCancelRun={onCancelRun}
                    onToggleSelect={toggleMessageSelection}
                    onContextMenu={openMessageContextMenu}
                    onReply={startReply}
                    onJumpToMessage={runJumpToMessage}
                    loadedMessageIds={loadedMessageIds}
                    onLightbox={openLightbox}
                    onImageLoad={scrollToBottomIfSticky}
                    onAgentAvatarClick={
                      resolveMessageRegistration(displayCarrier)
                        ? (event) => openAgentSettingsFromMessage(displayCarrier, event)
                        : undefined
                    }
                    scrollRootRef={messagesRef}
                    vaultId={vaultId}
                    onHydrateMessage={onHydrateMessage}
                    traceContent={unifiedMission}
                    traceAfterFirstMessage={clumpedUpdateMessages.length > 0}
                    contextMenuMessage={missionArtifacts[0]}
                  />,
                ];
                for (const group of segment.fullGroups) {
                  const messagesWithoutMissions = group.messages.filter((message) => !message.mission);
                  if (messagesWithoutMissions.length) nodes.push(renderGroupRow({ messages: messagesWithoutMissions }));
                }
                for (const group of separateUpdateGroups) nodes.push(renderGroupRow(group));
                return nodes;
              }

              const nextSegment = transcriptSegments[segmentIndex + 1];
              if (nextSegment?.kind === 'work' && segment.group.messages.some((message) => message.mission)) {
                return renderGroupRow({
                  messages: segment.group.messages.map((message) => (
                    message.mission ? { ...message, mission: undefined } : message
                  )),
                });
              }
              return renderGroupRow(segment.group);
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
          <div className="chat-emoji-picker-wrap" ref={emojiPickerRef}>
            <button
              type="button"
              className="btn-icon chat-emoji-btn"
              aria-label="Choose emoji"
              aria-expanded={emojiPickerOpen}
              title="Choose emoji"
              onClick={() => setEmojiPickerOpen((open) => !open)}
            >
              <Smile size={17} />
            </button>
            {emojiPickerOpen && (
              <div className="chat-emoji-picker" role="dialog" aria-label="Emoji picker">
                {CHAT_EMOJIS.map((emoji) => (
                  <button key={emoji} type="button" className="chat-emoji-option" onClick={() => insertEmoji(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
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
                    ) : isVideoMediaType(item.media_type) || isMp4Attachment(item) ? (
                      <video className="chat-paste-video" src={item.url} muted playsInline preload="metadata" />
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
                scheduleHistoryCommit();
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
                const mod = e.metaKey || e.ctrlKey;
                if (mod && (e.key === 'z' || e.key === 'Z')) {
                  e.preventDefault();
                  stepHistory(e.shiftKey ? 1 : -1);
                  return;
                }
                if (mod && !e.shiftKey && (e.key === 'y' || e.key === 'Y')) {
                  e.preventDefault();
                  stepHistory(1);
                  return;
                }
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
          <button className="btn-icon chat-send-btn" onClick={submit} title="Send message" disabled={!canSend}>
            <Send size={17} />
          </button>
          {mediaError && <span className="chat-media-error">{mediaError}</span>}
        </footer>
      </div>}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="chat-context-menu"
          role="menu"
          aria-label="Message options"
          style={{ top: contextMenu.y, left: contextMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => startReply(contextMenu.message)}>
            <Reply size={14} />
            Reply
          </button>
          {onCollaborateMessage
            && Boolean(contextMenu.message.agentId || contextMenu.message.registrationId)
            && targetsForCollaboration(contextMenu.message).length > 0 && (
            <button type="button" role="menuitem" onClick={() => startCollaboration(contextMenu.message)}>
              <Bot size={14} />
              Ask agent…
            </button>
          )}
          {onForwardMessage && (
            <button type="button" role="menuitem" onClick={() => startForward(contextMenu.message)}>
              <Forward size={14} />
              Forward
            </button>
          )}
          {vaultId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const message = contextMenu.message;
                setContextMenu(null);
                void createChannelWorkItem(vaultId, {
                  title: (message.body || 'Work item').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Work item',
                  brief: message.body || '',
                  channelId,
                  sourceKind: 'message',
                  sourceId: message.id,
                  repository: channelCwd || '',
                  workspaceMode: channelCwd ? 'isolated' : 'shared',
                }).catch(() => {
                  /* settings panel shows work items on next open */
                });
              }}
            >
              <ClipboardList size={14} />
              Add to kanban
            </button>
          )}
          {vaultId && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setReportMessage(contextMenu.message);
                setContextMenu(null);
              }}
            >
              <Flag size={14} />
              Report
            </button>
          )}
          {onDeleteMessage && (
            <>
              <div className="menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className={`is-danger${deleteArmed ? ' is-armed' : ''}`}
                onClick={() => (deleteArmed ? deleteMessage(contextMenu.message) : setDeleteArmed(true))}
              >
                <Trash2 size={14} />
                {deleteArmed ? 'Delete for everyone?' : 'Delete'}
              </button>
            </>
          )}
        </div>
      )}

      {participantMenu && (
        <div
          ref={participantMenuRef}
          className="chat-context-menu"
          role="menu"
          aria-label="Participant options"
          style={{ top: participantMenu.y, left: participantMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => {
              const { action, username } = participantMenu;
              setParticipantMenu(null);
              if (action === 'remove') void onRemoveParticipant?.(channelId, username);
              else void onLeaveChannel?.(channelId);
            }}
          >
            {participantMenu.action === 'remove' ? <Trash2 size={14} /> : <X size={14} />}
            {participantMenu.action === 'remove' ? `Remove @${participantMenu.username} from vault` : 'Leave vault'}
          </button>
        </div>
      )}

      {sidebarMode !== 'hidden' && <aside
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
              <strong>Project setup</strong>
              <button type="button" onClick={() => setChannelSettingsOpen(false)} aria-label="Close settings"><X size={12} /></button>
            </div>
            <label htmlFor={`chat-cwd-${channelId}`}>Project folder</label>
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
            <p>Where agents work in this channel. You can add this later.</p>
            <details className="chat-project-tools" open={Boolean(channelCwd || channelKanbanNoteId)}>
              <summary>Developer tools <span>board, work items, and isolated workspaces</span></summary>
              <label htmlFor={`chat-board-${channelId}`}>Project board</label>
              <div className="chat-channel-board-row">
              <select
                id={`chat-board-${channelId}`}
                value={channelKanbanNoteId}
                onChange={(event) => {
                  const next = event.target.value;
                  setChannelKanbanNoteId(next);
                  if (!vaultId) return;
                  void api(`/api/vaults/${vaultId}/channels/${channelId}/settings`, {
                    method: 'PUT',
                    body: JSON.stringify({ kanbanNoteId: next || null }),
                  }).then((d: { settings?: { kanbanNoteId?: string } }) => {
                    setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
                  }).catch(() => { /* keep local */ });
                }}
              >
                <option value="">None — pointer only when set</option>
                {notes
                  .filter((note) => /kanban-plugin\s*:/.test(note.content_preview || ''))
                  .map((note) => (
                    <option key={note.id} value={note.id}>{note.title}</option>
                  ))}
              </select>
              {channelKanbanNoteId && onOpenNote && (
                <button
                  type="button"
                  className="chat-channel-board-link"
                  onClick={() => onOpenNote(channelKanbanNoteId)}
                >
                  Open
                </button>
              )}
              <button
                type="button"
                className="chat-channel-board-link"
                onClick={() => {
                  if (!vaultId) return;
                  void api(`/api/vaults/${vaultId}/channels/${channelId}/settings`, {
                    method: 'PUT',
                    body: JSON.stringify({ createInternalKanban: true }),
                  }).then((d: { settings?: { kanbanNoteId?: string } }) => {
                    setChannelKanbanNoteId(d.settings?.kanbanNoteId ?? '');
                  }).catch(() => { /* keep local */ });
                }}
              >
                Internal board
              </button>
              </div>
              <p className="chat-channel-board-hint">
                Optional pointer to a vault board. Superkanban collates every board.
              </p>
              <ChatWorkspacePanel
                channelId={channelId}
                channelName={channelName}
                vaultId={vaultId}
                cwd={channelCwd}
                onUseWorkspace={(path) => { void saveChannelCwd(path); }}
              />
            </details>
          </div>
        )}

        {!usersCollapsed && (
          <>
        {inviteOpen && (
          <form className="chat-invite-menu" onSubmit={submitInvite} onClick={(event) => event.stopPropagation()}>
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

        <div className="chat-users-title">People in this vault</div>
        {humanUsers.map((name) => {
          const isSelf = name === currentUser;
          const isOnline = isSelf || onlineUsers.has(name);
          const isOwner = name === presence.owner;
          const roleLabel = isOwner ? 'owner' : isSelf ? 'you' : isOnline ? 'online' : 'offline';
          const participantAction = presence.owner === currentUser && !isSelf && onRemoveParticipant
            ? 'remove'
            : isSelf && !isOwner && onLeaveChannel
              ? 'leave'
              : null;
          return (
          <div
            className={`chat-user chat-human${isOnline ? '' : ' is-offline'}${isSelf ? ' is-self' : ''}`}
            key={name}
            onContextMenu={participantAction
              ? (event) => openParticipantContextMenu(event, name, participantAction)
              : undefined}
          >
            <div className="chat-user-row">
              <ChatAvatar name={presence.profiles?.[name]?.displayName || name} kind="human" avatarUrl={presence.profiles?.[name]?.avatarUrl} size="sm" />
              <div className="chat-user-copy">
                <strong>{presence.profiles?.[name]?.displayName || name}</strong>
                {presence.profiles?.[name]?.displayName && presence.profiles?.[name]?.displayName !== name && <span className="chat-user-handle">@{name}</span>}
                <span className="chat-user-role">{roleLabel}</span>
              </div>
            </div>
          </div>
          );
        })}

        <div className="chat-agent-section">
          <div className="chat-users-title">Agents in this vault</div>
          {registeredAgentRows.length === 0 && (
            <div className="chat-runs-empty">No agents in this vault yet</div>
          )}
          {registeredAgentRows.map((agent) => {
          const selectedModel = agent.registration.model || agent.models[0]?.id || '';
          const isEditing = editingRegistrationId === agent.registration.id && agentMenuOpen;
          const canManage = canManageRegistration(agent.registration);
          const planUsage = canManage
            ? runnerHealth?.planUsage?.[planUsageProviderId(agent.registration.agentId)] || null
            : null;
          return (
            <div
              className={`chat-user chat-agent-user${agent.registration.orchestrator ? ' is-supervisor' : ''}${isEditing ? ' is-editing' : ''}`}
              key={agent.registration.id}
            >
              <button
                type="button"
                className="chat-agent-edit-btn"
                disabled={!canManage}
                onClick={canManage ? (event) => editRegisteredAgent(event, agent.registration) : undefined}
                title={canManage ? 'Channel settings for this agent' : 'Only the agent owner can edit its settings'}
              >
                <ChatAvatar name={agent.registration.displayName || agent.label} kind="agent" avatarUrl={agent.registration.avatarUrl} size="sm" />
                {/* Supervisor reads as a hairline ring on the avatar (see .is-supervisor);
                    the rank still needs a name for screen readers. */}
                {agent.registration.orchestrator && <span className="sr-only">Channel supervisor</span>}
                <div className="chat-user-copy">
                  <div className="chat-user-copy-head">
                    <strong>{agent.registration.displayName || agent.label}</strong>
                    {planUsage && <PlanUsageMeters usage={planUsage} decal />}
                  </div>
                  <span className="chat-user-handle">@{agent.registration.mention || agent.id}</span>
                  <span className="chat-user-role">{selectedModel || 'no model'}</span>
                </div>
              </button>
              {canManage && <button
                type="button"
                className="chat-remove-agent"
                onClick={(event) => {
                  event.stopPropagation();
                  if (agent.registration.vaultAgentId && onDeleteVaultAgent) void onDeleteVaultAgent(agent.registration.vaultAgentId);
                  else onRemoveAgent(channelId, agent.registration.id);
                }}
                title="Delete agent from vault"
              >
                <X size={12} />
              </button>}
            </div>
          );
          })}

          {agentMenuOpen && agentPanelMode === 'picker' && (
          <div className="chat-agent-menu" onClick={(event) => event.stopPropagation()}>
            <div className="chat-agent-menu-heading">Vault agents</div>
            {vaultAgents.length === 0 ? (
              <div className="chat-runs-empty">No vault agents yet</div>
            ) : (
              vaultAgents.map((va) => {
                const inChannel = channelVaultAgentIds.has(va.id);
                const canManage = va.ownerUsername === currentUser;
                return (
                  <div key={va.id} className={`chat-vault-pick-row${inChannel ? ' is-in-channel' : ''}`}>
                    <button
                      type="button"
                      className="chat-vault-pick-btn"
                      disabled={inChannel || !canManage}
                      onClick={() => {
                        if (!inChannel) void addVaultAgentFromPicker(va.id);
                      }}
                      title={inChannel ? 'Already in this vault' : canManage ? 'Add to this vault' : 'Only the agent owner can add it'}
                    >
                      <ChatAvatar name={va.displayName || va.mention} kind="agent" avatarUrl={va.avatarUrl} size="sm" />
                      <span className="chat-user-copy">
                        <strong>{va.displayName || va.mention}</strong>
                        <span>
                          @{va.mention} · {va.model || va.agentId}
                          {va.ownerUsername ? ` · ${va.ownerUsername}'s agent` : ''}
                          {inChannel ? ' · in vault' : ''}
                        </span>
                      </span>
                    </button>
                    {onDeleteVaultAgent && canManage && (
                      <button
                        type="button"
                        className="chat-remove-agent"
                        title="Delete vault agent (all channels)"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (window.confirm(`Delete vault agent @${va.mention}?`)) {
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
          <form
            className="chat-agent-menu chat-agent-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-agent-editor-title"
            onSubmit={(e) => void submitAgentRegistration(e)}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="chat-agent-menu-heading chat-agent-editor-heading">
              <strong id="chat-agent-editor-title">
                {agentPanelMode === 'edit-member' && 'Channel membership'}
                {agentPanelMode === 'edit-identity' && 'Vault identity'}
                {agentPanelMode === 'create' && 'New vault agent'}
              </strong>
              <span>
                {agentPanelMode === 'edit-member' && 'Run behavior for this conversation.'}
                {agentPanelMode === 'edit-identity' && 'Applies to every channel in this vault.'}
                {agentPanelMode === 'create' && 'Added to every channel in this vault.'}
              </span>
              <button
                type="button"
                className="chat-agent-editor-close"
                aria-label="Close agent editor"
                onClick={() => {
                  setAgentMenuOpen(false);
                  setEditingRegistrationId(null);
                  setAgentPanelMode('picker');
                  setAgentFormError('');
                }}
              >
                <X size={18} />
              </button>
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
            <div className="chat-agent-group">
              {agentPanelMode === 'edit-member' && <div className="chat-agent-group-title">Runtime</div>}
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
            {agentForm.agentId === 'codex' && (agentPanelMode === 'edit-member' || agentPanelMode === 'create') && (
              <ChatAgentToggle
                checked={agentForm.priorityServiceTier}
                onChange={(event) => setAgentForm((value) => ({ ...value, priorityServiceTier: event.target.checked }))}
                name="Fast mode"
                hint="Uses Codex priority processing for new runs; may consume usage faster."
              />
            )}
            </div>
            {(agentPanelMode === 'edit-member' || agentPanelMode === 'create') && (
              <>
            <div className="chat-agent-group">
              <div className="chat-agent-group-title">Replies</div>
              <ChatAgentToggle
                checked={agentForm.orchestrator}
                onChange={(event) => setAgentForm((value) => ({
                  ...value,
                  orchestrator: event.target.checked,
                  replyToEveryMessage: event.target.checked,
                }))}
                name="Coordinate this channel"
                hint="Reads every human message and can delegate durable work."
              />
              <ChatAgentToggle
                stateClass={agentForm.orchestrator ? ' is-locked' : ''}
                checked={agentForm.replyToEveryMessage}
                disabled={agentForm.orchestrator}
                onChange={(event) => setAgentForm((value) => ({ ...value, replyToEveryMessage: event.target.checked }))}
                name="Reply to every human message"
                hint={agentForm.orchestrator
                  ? 'Always on while coordinating.'
                  : 'Otherwise it only answers when @mentioned.'}
              />
            </div>
            <div className="chat-agent-group">
              <div className="chat-agent-group-title">Mentions</div>
              <ChatAgentToggle
                checked={agentForm.taggableByAgents}
                onChange={(event) => setAgentForm((value) => ({ ...value, taggableByAgents: event.target.checked }))}
                name="Other agents"
                hint="Agents in this channel may @mention it."
              />
              <ChatAgentToggle
                checked={agentForm.pingableByOthers}
                onChange={(event) => setAgentForm((value) => ({ ...value, pingableByOthers: event.target.checked }))}
                name="Other people"
                hint="Anyone in the vault, not just you, may @mention it."
              />
            </div>
            <div className="chat-agent-group">
              <div className="chat-agent-group-title">Execution</div>
              <div className="chat-agent-mode-summary">
                <span>Auto</span>
                <span>Recommended</span>
              </div>
              <span className="chat-agent-field-hint">Uses the owner’s desktop CLI and stays inside its workspace. Provider usage follows that local account; private note blocks remain hidden.</span>
              <ChatAgentToggle
                stateClass={agentForm.yolo ? ' is-hot' : ''}
                checked={agentForm.yolo}
                onChange={(event) => setAgentForm((value) => ({ ...value, yolo: event.target.checked }))}
                name="Full host access"
                hint="Bypasses prompts and workspace boundaries."
              />
            </div>
              </>
            )}
            {agentPanelMode === 'edit-member' && agentForm.vaultAgentId && (
              <button
                type="button"
                className="chat-agent-identity-link"
                onClick={(event) => editVaultIdentity(event, agentForm)}
              >
                <span className="chat-agent-toggle-copy">
                  <span className="chat-agent-toggle-name">Edit vault identity</span>
                  <span className="chat-agent-toggle-hint">Name, handle, persona — shared across all channels.</span>
                </span>
                <ChevronRight size={13} />
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
      </aside>}

      {missionArchiveOpen && (
        <div
          className="chat-mission-archive-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-mission-archive-title"
          onClick={() => setMissionArchiveOpen(false)}
        >
          <section className="chat-mission-archive" onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <strong id="chat-mission-archive-title">Mission history</strong>
                <span>Durable work in #{channelName}</span>
              </div>
              <div>
                <button type="button" disabled={missionArchiveBusy} onClick={() => void loadMissionArchive()}>
                  Refresh
                </button>
                <button type="button" title="Close" aria-label="Close mission history" onClick={() => setMissionArchiveOpen(false)}>
                  <X size={16} />
                </button>
              </div>
            </header>
            <div className="chat-mission-archive-list">
              {missionArchiveBusy && missionArchive.length === 0 && <div className="chat-mission-archive-empty">Loading missions…</div>}
              {missionArchiveError && <div className="chat-mission-archive-empty is-error">{missionArchiveError}</div>}
              {!missionArchiveBusy && !missionArchiveError && missionArchive.length === 0 && (
                <div className="chat-mission-archive-empty">No missions in this channel yet.</div>
              )}
              {missionArchive.map((mission) => (
                <ChatMissionCard key={mission.id} mission={mission} vaultId={vaultId} channelId={channelId} />
              ))}
            </div>
          </section>
        </div>
      )}

      {collaborationSource && (
        <div
          className="chat-forward-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="chat-collaboration-title"
          onClick={() => !collaborationBusy && setCollaborationSource(null)}
        >
          <form className="chat-forward-panel chat-collaboration-panel" onSubmit={(event) => void submitCollaboration(event)} onClick={(event) => event.stopPropagation()}>
            <div className="chat-forward-head">
              <strong id="chat-collaboration-title">Ask another agent</strong>
              <button type="button" title="Cancel" disabled={collaborationBusy} onClick={() => setCollaborationSource(null)}>
                <X size={14} />
              </button>
            </div>
            <div className="chat-forward-preview">
              <strong>{collaborationSource.author}</strong>
              <span>{buildReplyPreview(collaborationSource)}</span>
            </div>
            <label className="chat-collaboration-field">
              Agent
              <select value={collaborationTargetId} onChange={(event) => setCollaborationTargetId(event.target.value)}>
                {targetsForCollaboration(collaborationSource).map((registration) => (
                  <option key={registration.id} value={registration.id}>
                    {registration.displayName} (@{registration.mention})
                  </option>
                ))}
              </select>
            </label>
            <label className="chat-collaboration-field">
              Relationship
              <select
                value={collaborationRelationship}
                onChange={(event) => {
                  const relationship = event.target.value as ChatRelationship;
                  setCollaborationRelationship(relationship);
                  setCollaborationInstruction(CHAT_RELATIONSHIP_INSTRUCTIONS[relationship]);
                }}
              >
                {CHAT_RELATIONSHIPS.map((relationship) => (
                  <option key={relationship} value={relationship}>{CHAT_RELATIONSHIP_LABELS[relationship]}</option>
                ))}
              </select>
            </label>
            <label className="chat-collaboration-field">
              Instruction
              <textarea
                autoFocus
                rows={4}
                value={collaborationInstruction}
                onChange={(event) => setCollaborationInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !collaborationBusy) setCollaborationSource(null);
                }}
              />
            </label>
            {collaborationError && <div className="chat-forward-error">{collaborationError}</div>}
            <div className="chat-collaboration-actions">
              <button type="button" disabled={collaborationBusy} onClick={() => setCollaborationSource(null)}>Cancel</button>
              <button type="submit" disabled={collaborationBusy || !collaborationTargetId || !collaborationInstruction.trim()}>
                {collaborationBusy ? 'Asking…' : 'Ask agent'}
              </button>
            </div>
          </form>
        </div>
      )}

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
      {reportMessage && vaultId && (
        <ReportDialog
          vaultId={vaultId}
          targetType="message"
          targetId={reportMessage.id}
          title={`message from ${reportMessage.author}`}
          onClose={() => setReportMessage(null)}
        />
      )}
    </section>
  );
});
