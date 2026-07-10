import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, Bot, ChevronLeft, ChevronRight, Copy, Hash, ImagePlus, Paperclip, Plus, Reply, Send, Square, UserPlus, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import type { NoteSummary } from '../api';
import { DOC_EMBED_REGEX, findEmbeddedNote, NOTE_DND_TYPE, noteEmbedMarkdown, splitDocEmbeds } from '../docEmbeds';
import { escapeRegExp, normalizeMention } from '../chat/mentions';
import { highlightJSON } from './jsonHighlighter';
import { CascadeRunPanel } from './CascadeRunPanel';
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
  images?: string[];
  attachments?: Array<{ name: string; media_type: string; url: string }>;
  replyTo?: ChatReplyRef;
}

/** Desktop runner health from GET /api/me/desktop-runner */
export interface DesktopRunnerHealth {
  online: boolean;
  activeRuns: number;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSeenAt: string | null;
  models: Record<string, string[]> | null;
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
  mention: string;
  model: string;
  cwd: string;
  contextPrompt: string;
  taggableByAgents: boolean;
  replyToEveryMessage: boolean;
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
  mention: string;
  model: string;
  cwd: string;
  contextPrompt: string;
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

export interface RunningChatAgent {
  runId?: number;
  channelId: string;
  channelName: string;
  author: string;
  messageId: string;
  preview: string;
}

export interface ChatChannelPresence {
  participants: string[];
  online: string[];
}

interface ChatViewProps {
  channelId: string;
  channelName: string;
  messages: ChatMessage[];
  currentUser: string;
  presence: ChatChannelPresence;
  availableAgents: ChatAgentOption[];
  registeredAgents: ChatAgentRegistration[];
  vaultAgents?: VaultAgent[];
  runningAgents: RunningChatAgent[];
  runnerHealth?: DesktopRunnerHealth | null;
  onRegisterAgent: (channelId: string, registration: ChatAgentRegistration) => void;
  onRemoveAgent: (channelId: string, registrationId: string) => void;
  onUpsertVaultAgent?: (agent: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent | void> | VaultAgent | void;
  onDeleteVaultAgent?: (vaultAgentId: string) => Promise<void> | void;
  onAddVaultAgentToChannel?: (channelId: string, vaultAgentId: string) => Promise<void> | void;
  onCreateInviteLink: (channelId: string) => Promise<string>;
  onInviteUser: (channelId: string, username: string) => Promise<void>;
  onSendMessage: (channelId: string, body: string, media?: ChatMediaAttachment[], replyTo?: ChatReplyRef) => void;
  onCancelRun: (runId: number) => void;
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
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

function isAtScrollBottom(element: HTMLElement, threshold = 24) {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
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
  body,
  mentionableAliases,
  notes = [],
  onOpenNote,
}: {
  body: string;
  mentionableAliases: string[];
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
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
            className={`chat-doc-embed${embedded ? '' : ' is-missing'}`}
            onClick={() => embedded && onOpenNote?.(embedded.id)}
            disabled={!embedded}
            title={embedded ? `Open ${embedded.title}` : undefined}
            draggable={!!embedded}
            onDragStart={(event) => {
              if (!embedded) return;
              event.dataTransfer.setData(NOTE_DND_TYPE, embedded.id);
              event.dataTransfer.setData('text/plain', noteEmbedMarkdown(embedded));
              event.dataTransfer.effectAllowed = 'copyMove';
            }}
          >
            <span className="chat-doc-embed-title">{embedded?.title ?? `Missing note: ${part.value}`}</span>
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
  if ((a.images?.length ?? 0) > 0 || (b.images?.length ?? 0) > 0) return false;
  if ((a.attachments?.length ?? 0) > 0 || (b.attachments?.length ?? 0) > 0) return false;
  return true;
}

export function mediaToRunImages(media: ChatMediaAttachment[]) {
  return media
    .filter((item) => isImageMediaType(item.media_type))
    .map(({ media_type, data }) => ({ media_type, data }));
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
  size = 'md',
}: {
  name: string;
  kind: 'agent' | 'human';
  size?: 'sm' | 'md';
}) {
  return (
    <div className={`chat-avatar chat-avatar-${size} chat-avatar-${kind}`} aria-hidden="true">
      {kind === 'agent' ? <Bot size={size === 'sm' ? 14 : 15} /> : initialFor(name)}
    </div>
  );
}

function hasExpandableTrace(message: ChatMessage): boolean {
  return hasRunActivity(message);
}

function groupHasDocEmbed(group: ChatMessageGroup): boolean {
  return group.messages.some((message) => message.body && bodyHasDocEmbed(message.body));
}

/**
 * One author-run of messages. Memoized so keystrokes in the composer, agent
 * panel state, and stream ticks in *other* groups don't re-render the whole
 * transcript — only the group whose message objects actually changed.
 */
const ChatGroupRow = memo(function ChatGroupRow({
  group,
  selectedMessageId,
  avatarKind,
  mentionableAliases,
  notes,
  onOpenNote,
  onCancelRun,
  onToggleSelect,
  onContextMenu,
  onLightbox,
  onImageLoad,
}: {
  group: ChatMessageGroup;
  /** Pre-filtered by the parent: non-null only when the selection is inside this group. */
  selectedMessageId: string | null;
  avatarKind: 'agent' | 'human';
  mentionableAliases: string[];
  notes: NoteSummary[];
  onOpenNote?: (id: string) => void;
  onCancelRun: ChatViewProps['onCancelRun'];
  onToggleSelect: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, message: ChatMessage) => void;
  onLightbox: (src: string) => void;
  onImageLoad: () => void;
}) {
  const head = group.messages[0];
  const tail = group.messages[group.messages.length - 1];
  const groupHasRunWidget = group.messages.some((message) => message.status === 'running' || hasExpandableTrace(message));
  const groupSelected = group.messages.some((message) => message.id === selectedMessageId);
  return (
    <article
      className={`chat-message-group ${tail.status ? `status-${tail.status}` : ''} ${groupHasRunWidget ? 'has-run-widget' : ''} ${groupSelected ? 'selected' : ''}`}
    >
      <ChatAvatar name={head.author} kind={avatarKind} />
      <div className="chat-message-body">
        <div className="chat-message-meta">
          <strong>{head.author}</strong>
          <time dateTime={tail.createdAt}>{formatTime(tail.createdAt)}</time>
          {tail.status === 'running' && <span className="chat-message-status">working</span>}
          {tail.status === 'failed' && <span className="chat-message-status is-error">failed</span>}
          {tail.status === 'canceled' && <span className="chat-message-status is-error">canceled</span>}
        </div>
        {group.messages.map((message) => {
          const hasRunWidget = message.status === 'running';
          const hasThoughtBlocks = hasExpandableTrace(message);
          const isTappable = hasRunWidget || hasThoughtBlocks;
          const selected = selectedMessageId === message.id;
          return (
            <div
              key={message.id}
              className={`chat-message-chunk ${isTappable ? 'has-run-widget' : ''} ${selected ? 'selected' : ''}`}
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
              {message.body && <ChatMessageText body={message.body} mentionableAliases={mentionableAliases} notes={notes} onOpenNote={onOpenNote} />}
              {(selected || hasRunWidget || hasThoughtBlocks) && (
                <CascadeRunPanel
                  message={message}
                  onCancelRun={onCancelRun}
                  forceOpen={selected}
                />
              )}
            </div>
          );
        })}
      </div>
    </article>
  );
}, (prev, next) =>
  prev.group === next.group
  && prev.selectedMessageId === next.selectedMessageId
  && prev.avatarKind === next.avatarKind
  && prev.mentionableAliases === next.mentionableAliases
  // Same trick as ChatMessageText: note churn only invalidates groups that
  // actually render an embed.
  && (prev.notes === next.notes || !groupHasDocEmbed(next.group))
  && prev.onOpenNote === next.onOpenNote
  && prev.onCancelRun === next.onCancelRun
  && prev.onToggleSelect === next.onToggleSelect
  && prev.onContextMenu === next.onContextMenu
  && prev.onLightbox === next.onLightbox
  && prev.onImageLoad === next.onImageLoad
);

export function ChatView({
  channelId,
  channelName,
  messages,
  currentUser,
  presence,
  availableAgents,
  registeredAgents,
  vaultAgents = [],
  runningAgents,
  runnerHealth = null,
  onRegisterAgent,
  onRemoveAgent,
  onUpsertVaultAgent,
  onDeleteVaultAgent,
  onAddVaultAgentToChannel,
  onCreateInviteLink,
  onInviteUser,
  onSendMessage,
  onCancelRun,
  notes = EMPTY_NOTES,
  onOpenNote,
}: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const [sidebarMode, setSidebarMode] = useState<'users' | 'runs'>('users');
  const [usersCollapsed, setUsersCollapsed] = useState(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem('cascade_chat_users_collapsed') === '1'
  );
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
  const createDefaultAgentForm = useCallback((): ChatAgentRegistration => {
    const agent = availableAgents[0];
    return {
      id: createChatAgentRegistrationId(),
      agentId: agent?.id ?? '',
      displayName: agent?.label ?? '',
      mention: agent?.label.toLowerCase().replace(/\s+/g, '-') ?? '',
      model: agent?.models[0]?.id ?? '',
      cwd: '',
      contextPrompt: '',
      taggableByAgents: true,
      replyToEveryMessage: false,
      pingableByOthers: false,
      yolo: false,
      conversationId: '',
    };
  }, [availableAgents]);
  const [agentForm, setAgentForm] = useState<ChatAgentRegistration>(() => ({
    id: createChatAgentRegistrationId(),
    agentId: availableAgents[0]?.id ?? '',
    displayName: availableAgents[0]?.label ?? '',
    mention: availableAgents[0]?.label.toLowerCase().replace(/\s+/g, '-') ?? '',
    model: availableAgents[0]?.models[0]?.id ?? '',
    cwd: '',
    contextPrompt: '',
    taggableByAgents: true,
    replyToEveryMessage: false,
    pingableByOthers: false,
    yolo: false,
    conversationId: '',
  }));
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<ChatReplyRef | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; message: ChatMessage } | null>(null);
  const [pendingMedia, setPendingMedia] = useState<ChatMediaAttachment[]>([]);
  const [mediaError, setMediaError] = useState('');
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  /** Inner content wrapper — ResizeObserver watches height growth (harness, thinking). */
  const messagesContentRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true);
  const scrollFrameRef = useRef<number | null>(null);
  const previousChannelIdRef = useRef(channelId);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const sortedMessages = useMemo(
    () => [...messages]
      // Hide completed run shells whose body was suppressed after cascade-chat
      // send — unless they still carry harness/thinking/tool activity worth showing.
      .filter((message) => {
        if (message.status === 'running' || message.status === 'sending') return true;
        if (message.status === 'failed' || message.status === 'canceled') return true;
        if (message.body?.trim()) return true;
        if (message.images?.length || message.attachments?.length) return true;
        // Empty body but has run activity (thinking/tools/harness) — keep as activity card.
        if (hasRunActivity(message)) return true;
        // Empty completed agent bubble with no activity — suppressed double-post shell.
        if (message.agentId || message.registrationId || message.runId != null) return false;
        return true;
      })
      .sort((a, b) => {
      const byTime = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      if (byTime !== 0) return byTime;
      // Same millisecond: order by server persistence order (rowid) so a user
      // message and the agent placeholder it triggers never flip. Not-yet-
      // persisted messages (no seq) sort last within the tie — they're newest.
      const seqA = a.seq ?? Number.MAX_SAFE_INTEGER;
      const seqB = b.seq ?? Number.MAX_SAFE_INTEGER;
      return seqA - seqB;
    }),
    [messages],
  );
  // Grouping recomputes on every message change, but unchanged groups must
  // keep their object identity or ChatGroupRow's memo never hits: reuse the
  // previous group object when the exact same message refs compose it.
  const groupIdentityCacheRef = useRef<Map<string, ChatMessageGroup>>(new Map());
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
  const registeredAgentRows = useMemo(() => registeredAgents.map((registration) => {
    const agent = availableAgents.find((option) => option.id === registration.agentId);
    return agent ? { ...agent, registration } : null;
  }).filter((agent): agent is ChatAgentOption & { registration: ChatAgentRegistration } => Boolean(agent)), [availableAgents, registeredAgents]);
  const agentAuthors = useMemo(() => new Set(
    registeredAgentRows.flatMap((agent) => [agent.label, agent.registration.displayName].filter(Boolean)),
  ), [registeredAgentRows]);
  const getMessageAvatarKind = (message: ChatMessage): 'agent' | 'human' =>
    message.agentId || agentAuthors.has(message.author) ? 'agent' : 'human';
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

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem('cascade_chat_users_collapsed', usersCollapsed ? '1' : '0');
    if (usersCollapsed) {
      setAgentMenuOpen(false);
      setInviteOpen(false);
      setEditingRegistrationId(null);
    }
  }, [usersCollapsed]);

  const scrollToBottomIfSticky = useCallback(() => {
    if (!wasAtBottomRef.current) return;
    if (scrollFrameRef.current != null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (wasAtBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' });
    });
  }, []);

  useLayoutEffect(() => {
    if (previousChannelIdRef.current !== channelId) {
      previousChannelIdRef.current = channelId;
      wasAtBottomRef.current = true;
    }
    scrollToBottomIfSticky();
  }, [sortedMessages.length, channelId, scrollToBottomIfSticky]);

  // When harness/thinking expands layout height without a React dep change
  // (or after paint), keep the main chat scroller pinned if the user was at bottom.
  useEffect(() => {
    const content = messagesContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      scrollToBottomIfSticky();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [channelId, scrollToBottomIfSticky]);

  useEffect(() => () => {
    if (scrollFrameRef.current != null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const updateBottomStickiness = useCallback(() => {
    const element = messagesRef.current;
    if (!element) return;
    wasAtBottomRef.current = isAtScrollBottom(element);
  }, []);

  useEffect(() => {
    setReplyTarget(null);
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

  function openAgentMenu(event: React.MouseEvent) {
    event.stopPropagation();
    setInviteOpen(false);
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

  function toggleInvite(event: React.MouseEvent) {
    event.stopPropagation();
    setAgentMenuOpen(false);
    setEditingRegistrationId(null);
    setAgentFormError('');
    setAgentPanelMode('picker');
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
          mention: va.mention,
          model: va.model,
          cwd: va.cwd,
          contextPrompt: va.contextPrompt,
          taggableByAgents: true,
          replyToEveryMessage: false,
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

  function startReply(message: ChatMessage) {
    setReplyTarget(buildReplyRef(message, registeredAgents));
    setContextMenu(null);
    draftRef.current?.focus();
  }

  const openMessageContextMenu = useCallback((event: React.MouseEvent, message: ChatMessage) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY, message });
  }, []);

  const toggleMessageSelection = useCallback((id: string) => {
    setSelectedMessageId((current) => (current === id ? null : id));
  }, []);

  const openLightbox = useCallback((src: string) => setLightboxSrc(src), []);

  async function submitAgentRegistration(event: React.FormEvent) {
    event.preventDefault();
    if (!agentForm.agentId) return;
    const mention = agentForm.mention.replace(/^@+/, '').trim();
    if (!mention && agentPanelMode !== 'edit-member') {
      setAgentFormError('Choose a unique @ handle.');
      return;
    }
    if (agentPanelMode !== 'edit-member') {
      const duplicateMention = registeredAgents.some((registration) =>
        registration.id !== agentForm.id
        && normalizeMention(registration.mention) === normalizeMention(mention),
      );
      if (duplicateMention && agentPanelMode === 'create') {
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
        // edit-member or fallback create without vault-agent API
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
    onSendMessage(channelId, body, pendingMedia, replyTarget ?? undefined);
    setDraft('');
    setPendingMedia([]);
    setMediaError('');
    setReplyTarget(null);
  }

  const canSend = draft.trim().length > 0 || pendingMedia.length > 0;

  return (
    <section className="chat-view">
      <div className="chat-main">
        <header className="chat-header">
          <Hash size={18} />
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
          onScroll={updateBottomStickiness}
        >
          <div ref={messagesContentRef} className="chat-messages-content">
          {sortedMessages.length === 0 ? (
            <div className="chat-empty">
              <Hash size={24} />
              <strong>#{channelName}</strong>
            </div>
          ) : (
            messageGroups.map((group) => {
              const head = group.messages[0];
              const groupSelected = selectedMessageId != null
                && group.messages.some((message) => message.id === selectedMessageId);
              return (
                <ChatGroupRow
                  key={head.id}
                  group={group}
                  selectedMessageId={groupSelected ? selectedMessageId : null}
                  avatarKind={getMessageAvatarKind(head)}
                  mentionableAliases={mentionableAliases}
                  notes={notes}
                  onOpenNote={onOpenNote}
                  onCancelRun={onCancelRun}
                  onToggleSelect={toggleMessageSelection}
                  onContextMenu={openMessageContextMenu}
                  onLightbox={openLightbox}
                  onImageLoad={scrollToBottomIfSticky}
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
                <button
                  type="button"
                  className="chat-reply-bar-close"
                  title="Cancel reply"
                  onClick={() => setReplyTarget(null)}
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
              onChange={(e) => setDraft(e.target.value)}
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
                if (e.key === 'Escape' && replyTarget) {
                  e.preventDefault();
                  setReplyTarget(null);
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
          <span className="chat-current-user">
            {currentUser}
            {mediaError && <span className="chat-media-error">{mediaError}</span>}
          </span>
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
        </div>
      )}

      <aside
        className={`chat-users${usersCollapsed ? ' is-collapsed' : ''}`}
        aria-label={sidebarMode === 'runs' ? 'Running agents' : 'Chat users'}
      >
        <div className="chat-users-header">
          <button
            type="button"
            className="chat-users-collapse-btn"
            onClick={() => setUsersCollapsed((value) => !value)}
            title={usersCollapsed ? 'Expand users' : 'Minimize users'}
            aria-label={usersCollapsed ? 'Expand chat users' : 'Minimize chat users'}
          >
            {usersCollapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
          <button type="button" className={`chat-invite-btn${inviteOpen ? ' active' : ''}`} onClick={toggleInvite} title="Invite user">
            <UserPlus size={14} />
          </button>
          <button type="button" className="chat-add-agent-btn" onClick={openAgentMenu} title="Add agent">
            <Bot size={14} />
            <Plus size={12} />
          </button>
          <button
            type="button"
            className={`chat-runs-toggle-btn${sidebarMode === 'runs' ? ' active' : ''}`}
            onClick={() => {
              setSidebarMode((mode) => (mode === 'runs' ? 'users' : 'runs'));
              if (sidebarMode === 'runs') return;
              setAgentMenuOpen(false);
              setEditingRegistrationId(null);
            }}
            title={sidebarMode === 'runs' ? 'Show users' : 'Show running agents'}
          >
            <Activity size={14} />
            {runningAgents.length > 0 && (
              <span className="chat-runs-count">{runningAgents.length}</span>
            )}
          </button>
        </div>

        {!usersCollapsed && (sidebarMode === 'runs' ? (
          <>
            <div className="chat-users-title">Desktop runner</div>
            <div className={`chat-runner-health ${runnerHealth?.online ? 'is-online' : 'is-offline'}`}>
              <div className="chat-runner-health-row">
                <span className={`chat-runner-dot ${runnerHealth?.online ? 'online' : 'offline'}`} />
                <strong>{runnerHealth?.online ? 'Online' : 'Offline'}</strong>
              </div>
              <span className="chat-runner-meta">
                {runnerHealth?.activeRuns ?? 0} active run{(runnerHealth?.activeRuns ?? 0) === 1 ? '' : 's'}
              </span>
              {runnerHealth?.lastError && (
                <span className="chat-runner-error" title={runnerHealth.lastErrorAt || undefined}>
                  Last error: {runnerHealth.lastError}
                </span>
              )}
              {!runnerHealth?.online && (
                <span className="chat-runner-hint">
                  Open Cascade desktop signed in to the same account to run agents.
                </span>
              )}
            </div>
            <div className="chat-users-title">Running agents</div>
            {runningAgents.length === 0 ? (
              <div className="chat-runs-empty">No agents running</div>
            ) : (
              runningAgents.map((run) => (
                <div className="chat-run-row" key={`${run.channelId}:${run.messageId}`}>
                  <ChatAvatar name={run.author} kind="agent" size="sm" />
                  <div className="chat-run-row-copy">
                    <strong>{run.author}</strong>
                    <span>#{run.channelName}</span>
                    <span className="chat-run-row-preview">{run.preview}</span>
                  </div>
                  <button
                    type="button"
                    className="chat-run-row-stop"
                    onClick={() => run.runId && onCancelRun(run.runId)}
                    disabled={!run.runId}
                    title={run.runId ? 'Force stop' : 'Starting…'}
                  >
                    <Square size={11} fill="currentColor" />
                  </button>
                </div>
              ))
            )}
          </>
        ) : (
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

        {humanUsers.map((name) => {
          const isSelf = name === currentUser;
          const isOnline = isSelf || onlineUsers.has(name);
          return (
          <div className={`chat-user chat-human${isOnline ? '' : ' is-offline'}`} key={name}>
            <div className="chat-user-row">
              <ChatAvatar name={name} kind="human" size="sm" />
              <div className="chat-user-copy">
                <strong>{name}</strong>
                <span>{isSelf ? 'you' : isOnline ? 'online' : 'offline'}</span>
              </div>
            </div>
          </div>
          );
        })}

        <div className="chat-users-title">In this channel</div>
        {registeredAgentRows.length === 0 && (
          <div className="chat-runs-empty">No agents yet — add from vault</div>
        )}
        {registeredAgentRows.map((agent) => {
          const selectedModel = agent.registration.model || agent.models[0]?.id || '';
          const isEditing = editingRegistrationId === agent.registration.id && agentMenuOpen;
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
                <ChatAvatar name={agent.registration.displayName || agent.label} kind="agent" size="sm" />
                <div className="chat-user-copy">
                  <strong>{agent.registration.displayName || agent.label}</strong>
                  <span>@{agent.registration.mention || agent.id} · {selectedModel || 'no model'}</span>
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

        {sidebarMode === 'users' && agentMenuOpen && agentPanelMode === 'picker' && (
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
                      <ChatAvatar name={va.displayName || va.mention} kind="agent" size="sm" />
                      <span className="chat-user-copy">
                        <strong>{va.displayName || va.mention}</strong>
                        <span>
                          @{va.mention} · {va.model || va.agentId}
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

        {sidebarMode === 'users' && agentMenuOpen && agentPanelMode !== 'picker' && (
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
                checked={agentForm.replyToEveryMessage}
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
          </>
        ))}
      </aside>

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
    </section>
  );
}
