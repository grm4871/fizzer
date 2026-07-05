import { useEffect, useState, useCallback, useRef, useMemo, type CSSProperties, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { type Tab } from './components/TabBar';
import { NoteEditor } from './components/NoteEditor';
import {
  canMergeChatMessages,
  CHAT_NOTE_MARKER,
  ChatView,
  createChatAgentRegistrationId,
  mediaToRunImages,
  type ChatAgentRegistration,
  type ChatBlock,
  type ChatMediaAttachment,
  type ChatMessage,
  type ChatReplyRef,
  type RunningChatAgent,
} from './components/ChatView';
import { SearchOverlay } from './components/SearchOverlay';
import { CommandPalette } from './components/CommandPalette';
import { PaneGrid, type TabDragPayload } from './components/PaneGrid';
import * as Layout from './layout/tree';
import type { LayoutNode } from './layout/tree';
import { api, type User, type Vault, type Folder, type NoteSummary, type Note } from './api';
import { connectRunsSocket, connectVaultSocket } from './socket';
import { isLocalRunId, cancelLocalAgentRun } from './localAgentRunner';
import { startDesktopRunnerHost } from './desktopRunnerHost';
import { Gem, PanelLeftOpen } from 'lucide-react';

/**
 * @file App.tsx — Root component for Cascade
 *
 * Orchestrates application state and the tiling workspace. `openTabs` is the
 * global registry of tab content (notes and chat channels); a recursive
 * {@link LayoutNode} tree (see `layout/tree.ts`) describes how those tabs are
 * arranged into draggable, resizable panes. Note bodies are held per-tab in
 * `noteContents` so any number of note panes can be edited independently.
 *
 * @component
 */

function sanitizeRestoredTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tab): tab is Partial<Tab> => Boolean(tab) && typeof tab === 'object')
    .map((tab): Tab | null => {
      if (typeof tab.id !== 'string' || typeof tab.title !== 'string') return null;
      if (tab.type === 'chat') {
        return { id: tab.id, title: tab.title || 'Channel', type: 'chat', dirty: false };
      }
      if (tab.type === 'note') {
        return { id: tab.id, title: tab.title, type: 'note', dirty: false };
      }
      return null;
    })
    .filter((tab): tab is Tab => Boolean(tab));
}

/**
 * Session persisted to localStorage so a reload restores the workspace: the open
 * tabs, the pane layout tree, and which pane was focused. Note bodies are
 * re-fetched on restore.
 */
interface PersistedSession {
  activeVaultId: string | null;
  openTabs: Tab[];
  layout: LayoutNode;
  focusedPaneId: string;
}

const SESSION_STORAGE_KEY = 'cascade_session';
const CHAT_STORAGE_KEY = 'cascade_chat_state';

interface ChatState {
  messagesByChannel: Record<string, ChatMessage[]>;
  agentModelsByAgent: Record<string, string>;
  registeredAgentsByChannel: Record<string, ChatAgentRegistration[]>;
}

const emptyChatState = (): ChatState => ({
  messagesByChannel: {},
  agentModelsByAgent: {},
  registeredAgentsByChannel: {},
});

function emptySession(): PersistedSession {
  const pane = Layout.createPane();
  return { activeVaultId: null, openTabs: [], layout: pane, focusedPaneId: pane.id };
}

function loadPersistedSession(): PersistedSession {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return emptySession();
    const parsed = JSON.parse(raw) as Partial<PersistedSession> & { activeTabId?: string; splitTabId?: string };
    const openTabs = sanitizeRestoredTabs(parsed.openTabs);
    const validIds = new Set(openTabs.map((t) => t.id));

    let layout: LayoutNode;
    if (parsed.layout) {
      layout = Layout.ensureValid(parsed.layout, validIds);
    } else {
      // Migrate the pre-grid single/split-pane session into a layout tree.
      const activeTabId = typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null;
      const splitTabId = typeof parsed.splitTabId === 'string' ? parsed.splitTabId : null;
      layout = Layout.migrateFromLegacy(openTabs.map((t) => t.id), activeTabId, splitTabId);
    }

    const focusedPaneId =
      parsed.focusedPaneId && Layout.findPane(layout, parsed.focusedPaneId)
        ? parsed.focusedPaneId
        : Layout.getFirstPane(layout).id;

    return { activeVaultId: parsed.activeVaultId ?? null, openTabs, layout, focusedPaneId };
  } catch {
    return emptySession();
  }
}

function readLegacyLocalChatAgentMembers(): Record<string, ChatAgentRegistration[]> {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ChatState>;
    if (!parsed.registeredAgentsByChannel || typeof parsed.registeredAgentsByChannel !== 'object') return {};
    const registeredAgentsByChannel: Record<string, ChatAgentRegistration[]> = {};
    for (const [channelId, registrations] of Object.entries(parsed.registeredAgentsByChannel)) {
      if (!Array.isArray(registrations)) continue;
      registeredAgentsByChannel[channelId] = registrations
        .filter((registration): registration is ChatAgentRegistration =>
          Boolean(registration) &&
          typeof registration === 'object' &&
          typeof registration.agentId === 'string',
        )
        .map((registration, index) => {
          const mention = typeof registration.mention === 'string' && registration.mention.trim()
            ? registration.mention.replace(/^@+/, '').trim()
            : registration.agentId;
          return {
            id: typeof registration.id === 'string' && registration.id.trim()
              ? registration.id.trim()
              : `legacy-${registration.agentId}-${mention}-${index}`,
            agentId: registration.agentId,
            displayName: typeof registration.displayName === 'string' && registration.displayName.trim()
              ? registration.displayName.trim()
              : agentLabel(registration.agentId as AgentId),
            mention,
            model: typeof registration.model === 'string' ? registration.model : '',
            cwd: typeof registration.cwd === 'string' ? normalizeChatCwd(registration.cwd) : '',
            contextPrompt: typeof registration.contextPrompt === 'string' ? registration.contextPrompt : '',
            taggableByAgents: typeof registration.taggableByAgents === 'boolean' ? registration.taggableByAgents : true,
            replyToEveryMessage: typeof registration.replyToEveryMessage === 'boolean' ? registration.replyToEveryMessage : false,
            yolo: typeof registration.yolo === 'boolean' ? registration.yolo : false,
            conversationId: typeof registration.conversationId === 'string' ? registration.conversationId : '',
          };
        });
    }
    return registeredAgentsByChannel;
  } catch {
    return {};
  }
}

function readLegacyLocalChatMessages(): Record<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<ChatState>;
    if (!parsed.messagesByChannel || typeof parsed.messagesByChannel !== 'object') return {};
    const messagesByChannel: Record<string, ChatMessage[]> = {};
    for (const [channelId, messages] of Object.entries(parsed.messagesByChannel)) {
      if (!Array.isArray(messages)) continue;
      messagesByChannel[channelId] = messages
        .filter((message): message is ChatMessage =>
          Boolean(message) &&
          typeof message.id === 'string' &&
          typeof message.channelId === 'string' &&
          typeof message.author === 'string' &&
          typeof message.body === 'string' &&
          typeof message.createdAt === 'string',
        )
        .map((message) => ({
          ...message,
          images: Array.isArray(message.images)
            ? message.images.filter((item): item is string => typeof item === 'string')
            : undefined,
          attachments: Array.isArray(message.attachments)
            ? message.attachments.filter((item): item is { name: string; media_type: string; url: string } =>
              Boolean(item) &&
              typeof item === 'object' &&
              typeof item.name === 'string' &&
              typeof item.media_type === 'string' &&
              typeof item.url === 'string',
            )
            : undefined,
          replyTo: message.replyTo &&
            typeof message.replyTo === 'object' &&
            typeof message.replyTo.messageId === 'string' &&
            typeof message.replyTo.author === 'string' &&
            typeof message.replyTo.mention === 'string' &&
            typeof message.replyTo.preview === 'string'
            ? message.replyTo
            : undefined,
        }));
    }
    return messagesByChannel;
  } catch {
    return {};
  }
}

function loadChatState(): ChatState {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return emptyChatState();
    const parsed = JSON.parse(raw) as Partial<ChatState>;
    const agentModelsByAgent: Record<string, string> = {};

    if (parsed.agentModelsByAgent && typeof parsed.agentModelsByAgent === 'object') {
      for (const [key, value] of Object.entries(parsed.agentModelsByAgent)) {
        if (typeof value === 'string') agentModelsByAgent[key] = value;
      }
    }

    return { messagesByChannel: {}, agentModelsByAgent, registeredAgentsByChannel: {} };
  } catch {
    return emptyChatState();
  }
}

type NoteEntry = { note: Note; draft: string };
type AgentId = 'claude-code' | 'codex' | 'grok' | 'antigravity' | 'copilot' | 'hermes';

const CHAT_AGENTS: Array<{ id: AgentId; label: string }> = [
  { id: 'claude-code', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'Copilot' },
  { id: 'hermes', label: 'Hermes' },
];

const CHAT_AGENT_MODEL_PRESETS: Record<AgentId, { id: string; label: string }[]> = {
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
    { id: 'grok-composer-2.5-fast', label: 'Grok Composer 2.5 Fast' },
    { id: 'grok-build', label: 'Grok Build' },
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

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionPattern(alias: string) {
  const escaped = alias.trim().split(/\s+/).map(escapeRegExp).join('[\\s-]*');
  return new RegExp(`@\\s*${escaped}(?=$|[\\s.,:;!?\\])}])`, 'gi');
}

function normalizeMention(value: string) {
  return value.replace(/^@+/, '').trim();
}

function normalizeChatCwd(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^(vault\s*root|root|\.\/?)$/i.test(trimmed)) return '';
  return trimmed;
}

function getMentionedRegistrations(text: string, registrations: ChatAgentRegistration[], fromAgent: boolean) {
  const mentioned: ChatAgentRegistration[] = [];
  for (const registration of registrations) {
    if (fromAgent && !registration.taggableByAgents) continue;
    const mention = normalizeMention(registration.mention || registration.agentId);
    if (mention && mentionPattern(mention).test(text)) mentioned.push(registration);
  }
  return mentioned;
}

function stripRegisteredAgentMentions(text: string, registrations: ChatAgentRegistration[]) {
  let next = text;
  for (const registration of registrations) {
    const mention = normalizeMention(registration.mention || registration.agentId);
    if (mention) next = next.replace(mentionPattern(mention), ' ');
  }
  return next.replace(/\s+/g, ' ').trim();
}

function agentLabel(agentId: AgentId) {
  return CHAT_AGENTS.find((agent) => agent.id === agentId)?.label ?? agentId;
}

function newId(prefix: string) {
  const uuid = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${uuid}`;
}

function textFromRunContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .join('');
}

function normalizeChatRunBlocks(content: unknown): ChatBlock[] {
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) return [];
  const blocks: ChatBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const block = item as Record<string, any>;
    if (block.type === 'text' && typeof block.text === 'string') {
      blocks.push({ type: 'text', text: block.text });
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', text: String(block.thinking || block.text || '') });
    } else if (block.type === 'redacted_thinking') {
      blocks.push({ type: 'thinking', text: '', redacted: true });
    }
  }
  return blocks;
}

function appendChatRunBlocks(existing: ChatBlock[] | undefined, blocks: ChatBlock[]) {
  const next = [...(existing ?? [])];
  for (const block of blocks) {
    const last = next[next.length - 1];
    if (last && last.type === block.type && (block.type === 'text' || block.type === 'thinking')) {
      next[next.length - 1] = {
        ...last,
        text: `${last.text || ''}${block.text || ''}`,
      };
    } else {
      next.push({ ...block });
    }
  }
  return next;
}

function chatMessageStreamScore(message: ChatMessage): number {
  const bodyScore = message.body?.length ?? 0;
  const blockScore = (message.blocks ?? []).reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
  const statusScore = message.status === 'running' ? 1 : message.status === 'failed' ? 2 : 10;
  return statusScore * 1_000_000 + bodyScore + blockScore;
}

function mergeRemoteChatMessage(local: ChatMessage, remote: ChatMessage): ChatMessage {
  const localScore = chatMessageStreamScore(local);
  const remoteScore = chatMessageStreamScore(remote);
  if (remoteScore >= localScore) return remote;
  if (local.status === 'running' && !remote.status && remote.body.length >= local.body.length) {
    return { ...remote, blocks: remote.blocks?.length ? remote.blocks : local.blocks };
  }
  return local;
}

/** JSON patch body with explicit nulls so the server can clear status/blocks. */
function toChatMessagePatch(message: ChatMessage): Record<string, unknown> {
  return {
    author: message.author,
    body: message.body,
    createdAt: message.createdAt,
    status: message.status ?? null,
    agentId: message.agentId ?? null,
    registrationId: message.registrationId ?? null,
    runId: message.runId ?? null,
    blocks: message.blocks ?? null,
    images: message.images ?? null,
    attachments: message.attachments ?? null,
    replyTo: message.replyTo ?? null,
  };
}

function formatAgentChatPrompt(
  channelName: string,
  registration: ChatAgentRegistration,
  request: string,
  triggeringAuthor: string,
  // True when the agent's CLI session is being resumed — earlier turns live in
  // the long session; pull channel history via cascade-chat only when needed.
  continuation = false,
) {
  const selfAgent = CHAT_AGENTS.find((candidate) => candidate.id === registration.agentId);
  const selfHandle = registration.mention || registration.agentId;
  const selfName = registration.displayName || selfAgent?.label || registration.agentId;
  const sessionNote = continuation ? ' Your session already has earlier turns.' : '';
  const channelNote = registration.contextPrompt ? ` Channel note: ${registration.contextPrompt}` : '';
  const header = `You are ${selfName} (@${selfHandle}) in #${channelName}, responding to ${triggeringAuthor}.${sessionNote} Reply briefly. Run \`cascade-chat history --include-reply-context\` for full channel context. Notes: \`cascade-note\` + \`![[Title]]\` embeds.${channelNote}`;
  return `${header}\n\n${request}`;
}

export default function App() {
  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  const persistedSessionRef = useRef<PersistedSession>(loadPersistedSession());

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');

  // App data state
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [activeVaultId, setActiveVaultId] = useState<string | null>(persistedSessionRef.current.activeVaultId);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [chatState, setChatState] = useState<ChatState>(loadChatState);

  // Tabs + tiling layout
  const [openTabs, setOpenTabs] = useState<Tab[]>(persistedSessionRef.current.openTabs);
  const [layout, setLayout] = useState<LayoutNode>(persistedSessionRef.current.layout);
  const [focusedPaneId, setFocusedPaneId] = useState<string>(persistedSessionRef.current.focusedPaneId);
  // Note bodies, keyed by tab id, so each note pane edits independently.
  const [noteContents, setNoteContents] = useState<Record<string, NoteEntry>>({});

  // UI panels state
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(localStorage.getItem('cascade_sidebar_w')) || 280);
  const [isResizing, setIsResizing] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // ─── Derived focus state ────────────────────────────────────────
  const focusedPane = Layout.findPane(layout, focusedPaneId) ?? Layout.getFirstPane(layout);
  const activeTabId = focusedPane.activeTabId;
  const currentUsername = user?.username ?? '';
  const noteTitleById = useMemo(() => new Map(notes.map((note) => [note.id, note.title])), [notes]);

  const runningChatAgents = useMemo(() => {
    const entries: RunningChatAgent[] = [];
    for (const [channelId, messages] of Object.entries(chatState.messagesByChannel)) {
      const channelName = noteTitleById.get(channelId) || 'channel';
      for (const message of messages) {
        if (message.status !== 'running') continue;
        entries.push({
          runId: message.runId,
          channelId,
          channelName,
          author: message.author,
          messageId: message.id,
          preview: message.body === 'Thinking...' ? 'Starting…' : message.body.slice(0, 120),
        });
      }
    }
    return entries;
  }, [chatState.messagesByChannel, noteTitleById]);

  // Refs mirror the latest state so event handlers stay stable (no dep churn)
  // and never read a stale closure during drags / async work.
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const focusedPaneRef = useRef(focusedPane); focusedPaneRef.current = focusedPane;
  const openTabsRef = useRef(openTabs); openTabsRef.current = openTabs;
  const noteContentsRef = useRef(noteContents); noteContentsRef.current = noteContents;
  const activeVaultIdRef = useRef(activeVaultId); activeVaultIdRef.current = activeVaultId;
  const notesRef = useRef(notes); notesRef.current = notes;
  const localAgentUnsubsRef = useRef<Map<number, () => void>>(new Map());
  const desktopRunnerStopRef = useRef<(() => void) | null>(null);
  const chatStateRef = useRef(chatState); chatStateRef.current = chatState;
  const vaultSocketRef = useRef<ReturnType<typeof connectVaultSocket> | null>(null);
  const runSocketsRef = useRef<Map<number, ReturnType<typeof connectRunsSocket>>>(new Map());
  const streamingChatMessageIdsRef = useRef<Set<string>>(new Set());
  // Agent messages whose persistence is owned by the server (the run is linked to
  // them server-side). We skip our own PATCH for these to avoid duplicate writes.
  const serverOwnedChatMessageIdsRef = useRef<Set<string>>(new Set());
  // Per agent session (keyed by registration id + conversationId), the id of the
  // last chat message already folded into the agent's resumed CLI session. The
  // next turn feeds only messages after this watermark instead of the whole
  // history — the resumed session already holds everything up to it. A `/clear`
  // rotates the conversationId, so the new key has no watermark and the agent
  // gets a fresh full-context priming.
  const agentContextWatermarkRef = useRef<Map<string, string>>(new Map());
  const pendingChatPatchRef = useRef<Map<string, ChatMessage>>(new Map());
  const chatPatchTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const startAgentChatRunRef = useRef<((channelId: string, registration: ChatAgentRegistration, prompt: string, triggeringMessage: ChatMessage) => void) | null>(null);

  // Repair focus if the focused pane disappears (e.g. after collapsing a split).
  useEffect(() => {
    if (!Layout.findPane(layout, focusedPaneId)) {
      setFocusedPaneId(Layout.getFirstPane(layout).id);
    }
  }, [layout, focusedPaneId]);

  useEffect(() => {
    const id = window.setTimeout(() => localStorage.setItem('cascade_sidebar_w', String(sidebarWidth)), 150);
    return () => clearTimeout(id);
  }, [sidebarWidth]);

  useEffect(() => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setSidebarOpen(false);
    }
  }, []);

  // Persist the workspace session.
  useEffect(() => {
    const id = window.setTimeout(() => {
    const session: PersistedSession = { activeVaultId, openTabs, layout, focusedPaneId };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }, 250);
    return () => clearTimeout(id);
  }, [activeVaultId, openTabs, layout, focusedPaneId]);

  useEffect(() => {
    const id = window.setTimeout(() => {
    const { messagesByChannel: _messages, registeredAgentsByChannel: _agents, ...persistedChat } = chatState;
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(persistedChat));
    }, 250);
    return () => clearTimeout(id);
  }, [chatState]);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  useEffect(() => {
    if (notes.length === 0) return;
    setOpenTabs((prev) => prev.map((tab) => {
      if (tab.type !== 'chat') return tab;
      const note = notes.find((item) => item.id === tab.id && item.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      return note ? { ...tab, title: `#${note.title}` } : tab;
    }));
  }, [notes]);

  /** Drag the sidebar divider. */
  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startSidebar = sidebarWidth;
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - startX;
      setSidebarWidth(clamp(startSidebar + delta, 180, 480));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  // ═══════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════

  const loadVaults = useCallback(async () => {
    try {
      const data = await api<{ vaults: Vault[] }>('/api/vaults');
      setVaults(data.vaults);
      const restoredVaultValid = activeVaultId && data.vaults.some((v) => v.id === activeVaultId);
      if (data.vaults.length > 0 && !restoredVaultValid) {
        setActiveVaultId(data.vaults[0].id);
      } else if (data.vaults.length === 0) {
        const created = await api<{ vault: Vault }>('/api/vaults', {
          method: 'POST',
          body: JSON.stringify({ name: 'My Vault' }),
        });
        setVaults([created.vault]);
        setActiveVaultId(created.vault.id);
      }
    } catch (error) {
      console.error('Error loading vaults:', error);
    }
  }, [activeVaultId]);

  useEffect(() => {
    const token = localStorage.getItem('docs_token');
    if (!token) return;
    api<{ user: User }>('/api/me')
      .then((data) => { setUser(data.user); void loadVaults(); })
      .catch(() => localStorage.removeItem('docs_token'));
  }, [loadVaults]);

  useEffect(() => {
    desktopRunnerStopRef.current?.();
    desktopRunnerStopRef.current = user ? startDesktopRunnerHost() : null;
    return () => {
      desktopRunnerStopRef.current?.();
      desktopRunnerStopRef.current = null;
    };
  }, [user]);

  const loadChatAgentMembers = useCallback(async (vaultId: string, noteList: NoteSummary[]) => {
    const channelIds = noteList
      .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
      .map((note) => note.id);
    if (channelIds.length === 0) return;

    const legacyAgents = readLegacyLocalChatAgentMembers();
    const results = await Promise.all(channelIds.map(async (channelId) => {
      try {
        const data = await api<{ agents: ChatAgentRegistration[] }>(`/api/vaults/${vaultId}/channels/${channelId}/agents`);
        let agents = data.agents ?? [];
        const local = legacyAgents[channelId] ?? [];
        if (agents.length === 0 && local.length > 0) {
          for (const registration of local) {
            try {
              await api(`/api/vaults/${vaultId}/channels/${channelId}/agents`, {
                method: 'PUT',
                body: JSON.stringify(registration),
              });
            } catch {
              // Best-effort migration from pre-network agent member storage.
            }
          }
          const refreshed = await api<{ agents: ChatAgentRegistration[] }>(`/api/vaults/${vaultId}/channels/${channelId}/agents`);
          agents = refreshed.agents ?? [];
        }
        return { channelId, agents };
      } catch {
        return { channelId, agents: legacyAgents[channelId] ?? [] };
      }
    }));

    setChatState((prev) => {
      const registeredAgentsByChannel = { ...prev.registeredAgentsByChannel };
      for (const { channelId, agents } of results) {
        registeredAgentsByChannel[channelId] = agents;
      }
      return { ...prev, registeredAgentsByChannel };
    });
  }, []);

  const loadChatMessages = useCallback(async (vaultId: string, noteList: NoteSummary[]) => {
    const channelIds = noteList
      .filter((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER))
      .map((note) => note.id);
    if (channelIds.length === 0) return;

    const legacyMessages = readLegacyLocalChatMessages();
    const results = await Promise.all(channelIds.map(async (channelId) => {
      try {
        const data = await api<{ messages: ChatMessage[] }>(`/api/vaults/${vaultId}/channels/${channelId}/messages`);
        let messages = data.messages ?? [];
        const local = legacyMessages[channelId] ?? [];
        if (messages.length === 0 && local.length > 0) {
          for (const message of local) {
            try {
              await api(`/api/vaults/${vaultId}/channels/${channelId}/messages`, {
                method: 'POST',
                body: JSON.stringify(message),
              });
            } catch {
              // Best-effort migration from pre-network chat storage.
            }
          }
          const refreshed = await api<{ messages: ChatMessage[] }>(`/api/vaults/${vaultId}/channels/${channelId}/messages`);
          messages = refreshed.messages ?? [];
        }
        return { channelId, messages };
      } catch {
        return { channelId, messages: legacyMessages[channelId] ?? [] };
      }
    }));

    setChatState((prev) => {
      const messagesByChannel = { ...prev.messagesByChannel };
      for (const { channelId, messages } of results) {
        messagesByChannel[channelId] = messages;
      }
      return { ...prev, messagesByChannel };
    });
  }, []);

  const persistChatMessageToServer = useCallback(async (vaultId: string, channelId: string, message: ChatMessage) => {
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify(message),
      });
    } catch (error) {
      console.error('Failed to persist chat message:', error);
      setNotice(error instanceof Error ? error.message : 'Could not save chat message');
    }
  }, []);

  const flushChatMessagePatch = useCallback(async (vaultId: string, channelId: string, messageId: string) => {
    const message = pendingChatPatchRef.current.get(messageId);
    if (!message) return;
    pendingChatPatchRef.current.delete(messageId);
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/messages/${messageId}`, {
        method: 'PATCH',
        body: JSON.stringify(toChatMessagePatch(message)),
      });
    } catch (error) {
      console.error('Failed to update chat message:', error);
    }
  }, []);

  const scheduleChatMessagePatch = useCallback((
    vaultId: string,
    channelId: string,
    messageId: string,
    message: ChatMessage,
    immediate = false,
  ) => {
    pendingChatPatchRef.current.set(messageId, message);
    if (immediate) {
      const existingTimer = chatPatchTimerRef.current.get(messageId);
      if (existingTimer) clearTimeout(existingTimer);
      chatPatchTimerRef.current.delete(messageId);
      void flushChatMessagePatch(vaultId, channelId, messageId);
      return;
    }
    // Throttle (not debounce): keep an already-scheduled flush so streamed tokens
    // are broadcast to other clients at most ~300ms apart. A debounce here would
    // reset on every token and never fire during continuous streaming, so remote
    // observers would see nothing until the run completed.
    if (chatPatchTimerRef.current.has(messageId)) return;
    const timer = setTimeout(() => {
      chatPatchTimerRef.current.delete(messageId);
      void flushChatMessagePatch(vaultId, channelId, messageId);
    }, 300);
    chatPatchTimerRef.current.set(messageId, timer);
  }, [flushChatMessagePatch]);

  const persistChatAgentMemberToServer = useCallback(async (vaultId: string, channelId: string, registration: ChatAgentRegistration) => {
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/agents`, {
        method: 'PUT',
        body: JSON.stringify(registration),
      });
    } catch (error) {
      console.error('Failed to persist chat agent member:', error);
      setNotice(error instanceof Error ? error.message : 'Could not save agent member');
    }
  }, []);

  const removeChatAgentMemberOnServer = useCallback(async (vaultId: string, channelId: string, registrationId: string) => {
    try {
      await api(`/api/vaults/${vaultId}/channels/${channelId}/agents/${registrationId}`, {
        method: 'DELETE',
      });
    } catch (error) {
      console.error('Failed to remove chat agent member:', error);
      setNotice(error instanceof Error ? error.message : 'Could not remove agent member');
    }
  }, []);

  const loadVaultData = useCallback(async (vaultId: string) => {
    try {
      const [folderData, noteData] = await Promise.all([
        api<{ folders: Folder[] }>(`/api/vaults/${vaultId}/folders`),
        api<{ notes: NoteSummary[] }>(`/api/vaults/${vaultId}/notes`),
      ]);
      const nextNotes = noteData.notes || [];
      setFolders(folderData.folders || []);
      setNotes(nextNotes);
      await Promise.all([
        loadChatMessages(vaultId, nextNotes),
        loadChatAgentMembers(vaultId, nextNotes),
      ]);
    } catch (error) {
      console.error('Error loading vault data:', error);
    }
  }, [loadChatMessages, loadChatAgentMembers]);

  useEffect(() => {
    const resyncOnResume = () => {
      if (!user) return;
      desktopRunnerStopRef.current?.();
      desktopRunnerStopRef.current = startDesktopRunnerHost();

      const vaultId = activeVaultIdRef.current;
      const vaultSocket = vaultSocketRef.current;
      if (vaultSocket && vaultId) {
        if (vaultSocket.connected) {
          vaultSocket.emit('joinVault', vaultId);
        } else {
          vaultSocket.connect();
        }
      }
      for (const [runId, socket] of runSocketsRef.current) {
        if (socket.connected) {
          socket.emit('joinRun', runId);
        } else {
          socket.connect();
        }
      }
      if (vaultId) {
        void loadVaultData(vaultId);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') resyncOnResume();
    };
    window.addEventListener('focus', resyncOnResume);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', resyncOnResume);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user, loadVaultData]);

  useEffect(() => {
    if (activeVaultId) {
      void loadVaultData(activeVaultId);
    } else {
      const pane = Layout.createPane();
      setFolders([]);
      setNotes([]);
      setOpenTabs([]);
      setLayout(pane);
      setFocusedPaneId(pane.id);
      setNoteContents({});
    }
  }, [activeVaultId, loadVaultData]);

  /** Add a tab to the registry and place it (active) into a pane. */
  const addTabToPane = useCallback((tab: Tab, paneId: string) => {
    setOpenTabs((prev) => [...prev, tab]);
    setLayout(Layout.simplify(Layout.addTabToPane(layoutRef.current, paneId, tab.id)));
    setFocusedPaneId(paneId);
  }, []);

  // ═══════════════════════════════════════════════════════════════
  // CHAT CHANNEL OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const openChatChannel = useCallback((channelId: string, title: string, mode: 'open' | 'replace' = 'open') => {
    const name = title.trim() || 'chat';
    const tab: Tab = { id: channelId, title: `#${name}`, type: 'chat', dirty: false };

    setOpenTabs((prev) =>
      prev.some((t) => t.id === channelId)
        ? prev.map((t) => (t.id === channelId ? { ...t, title: tab.title, type: 'chat' } : t))
        : [...prev, tab],
    );

    const prev = layoutRef.current;
    const focused = focusedPaneRef.current;
    const existingPane = Layout.findPaneByTab(prev, channelId);

    if (existingPane) {
      setLayout(Layout.setActiveTab(prev, existingPane.id, channelId));
      setFocusedPaneId(existingPane.id);
      return;
    }

    let next = Layout.addTabToPane(Layout.removeTab(prev, channelId), focused.id, channelId);
    const oldId = focused.activeTabId;
    if (mode === 'replace' && oldId && oldId !== channelId) {
      next = Layout.removeTab(next, oldId);
      setOpenTabs((p) => p.filter((t) => t.id !== oldId || t.id === channelId));
      setNoteContents((p) => { const copy = { ...p }; delete copy[oldId]; return copy; });
    }
    setLayout(Layout.simplify(next));
    setFocusedPaneId(focused.id);
  }, []);

  const handleCreateChannel = useCallback(async (folderId: string | null = null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return undefined;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER, folder_id: folderId ?? undefined }),
      });
      await loadVaultData(vaultId);
      openChatChannel(data.note.id, data.note.title);
      return { id: data.note.id, title: data.note.title };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
      return undefined;
    }
  }, [loadVaultData, openChatChannel]);

  const appendChatMessage = useCallback((channelId: string, message: ChatMessage) => {
    setChatState((prev) => ({
      ...prev,
      messagesByChannel: {
        ...prev.messagesByChannel,
        [channelId]: [...(prev.messagesByChannel[channelId] ?? []), message],
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) void persistChatMessageToServer(vaultId, channelId, message);
  }, [persistChatMessageToServer]);

  const updateChatMessage = useCallback((channelId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
    // Compute the next message synchronously from the freshest known version so
    // we can both update React state and schedule the server patch. We can't read
    // a value assigned *inside* the setChatState updater here — React 18 doesn't
    // run that updater synchronously, so it would still be null when we schedule
    // the patch, and the streamed/final agent text would never be broadcast to
    // other clients. The base prefers a pending (not-yet-flushed) patch so a burst
    // of synchronous stream events (e.g. the history backfill loop) accumulates.
    const base = pendingChatPatchRef.current.get(messageId)
      ?? (chatStateRef.current.messagesByChannel[channelId] ?? []).find((message) => message.id === messageId);
    if (!base) return;
    const patched = updater(base);
    setChatState((prev) => ({
      ...prev,
      messagesByChannel: {
        ...prev.messagesByChannel,
        [channelId]: (prev.messagesByChannel[channelId] ?? []).map((message) => (
          message.id === messageId ? patched : message
        )),
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId && !serverOwnedChatMessageIdsRef.current.has(messageId)) {
      const immediate = !patched.status || patched.status === 'failed';
      scheduleChatMessagePatch(vaultId, channelId, messageId, patched, immediate);
    }
  }, [scheduleChatMessagePatch]);

  const handleRegisterChatAgent = useCallback((channelId: string, registration: ChatAgentRegistration) => {
    const normalized = {
      ...registration,
      id: registration.id || createChatAgentRegistrationId(),
      displayName: registration.displayName.trim() || agentLabel(registration.agentId as AgentId),
      mention: normalizeMention(registration.mention || registration.agentId),
      cwd: normalizeChatCwd(registration.cwd),
      replyToEveryMessage: registration.replyToEveryMessage === true,
      conversationId: registration.conversationId || newId('conv'),
    };
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: [
          ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== normalized.id),
          normalized,
        ],
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) void persistChatAgentMemberToServer(vaultId, channelId, normalized);
  }, [persistChatAgentMemberToServer]);

  const handleRemoveChatAgent = useCallback((channelId: string, registrationId: string) => {
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: (prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== registrationId),
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) void removeChatAgentMemberOnServer(vaultId, channelId, registrationId);
  }, [removeChatAgentMemberOnServer]);

  const startAgentChatRun = useCallback(async (
    channelId: string,
    registration: ChatAgentRegistration,
    prompt: string,
    triggeringMessage: ChatMessage,
    runImages: Array<{ media_type: string; data: string }> = [],
  ) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;

    const agentId = registration.agentId as AgentId;
    if (!CHAT_AGENTS.some((agent) => agent.id === agentId)) return;
    const channelName = notesRef.current.find((note) => note.id === channelId)?.title || 'chat';
    // One sticky session per agent: the run resumes (and extends) the member's
    // conversation, so its earlier turns are already in context. A `/clear`
    // rotates conversationId, so a fresh key here has no watermark.
    const watermarkKey = `${registration.id}:${registration.conversationId || ''}`;
    const watermark = agentContextWatermarkRef.current.get(watermarkKey);
    const continuation = Boolean(watermark);
    const runPrompt = formatAgentChatPrompt(channelName, registration, prompt, triggeringMessage.author, continuation);
    const agentMessageId = `agent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    streamingChatMessageIdsRef.current.add(agentMessageId);
    appendChatMessage(channelId, {
      id: agentMessageId,
      channelId,
      author: registration.displayName || agentLabel(agentId),
      body: 'Thinking...',
      createdAt: new Date().toISOString(),
      status: 'running',
      agentId,
      registrationId: registration.id,
    });

    let runSocket: ReturnType<typeof connectRunsSocket> | null = null;
    let activeRunId: number | null = null;

    try {
      // One sticky session per member: the run resumes (and extends) the
      // member's conversation. A `/clear` rotates conversationId to start fresh.
      const resumeSessionId = registration.conversationId || undefined;
      let assistantText = '';
      const processedSeqs = new Set<number>();

      const finishRun = (runId: number, cleanup: () => void) => {
        cleanup();
        streamingChatMessageIdsRef.current.delete(agentMessageId);
        serverOwnedChatMessageIdsRef.current.delete(agentMessageId);
        if (isLocalRunId(runId)) {
          localAgentUnsubsRef.current.delete(runId);
        } else {
          const socket = runSocketsRef.current.get(runId);
          if (socket) {
            socket.off('connect', joinRunRoom);
            socket.disconnect();
          }
          runSocketsRef.current.delete(runId);
        }
      };

      let joinRunRoom: () => void = () => {};

      const processRunEvent = (event: { seq?: number; type: string; payload_json: string }, runId: number, cleanup: () => void) => {
        if (typeof event?.seq === 'number') {
          if (processedSeqs.has(event.seq)) return;
          processedSeqs.add(event.seq);
        }
        try {
          if (event.type === 'status') {
            const payload = JSON.parse(event.payload_json);
            if (payload.status === 'completed' || payload.status === 'failed') {
              // Collapse the chat body to the final answer (run summary); the full
              // narration stays in `blocks` for the trace disclosure.
              const summaryText = typeof payload.summary === 'string' ? payload.summary.trim() : '';
              const finalBody = summaryText
                || assistantText.trim()
                || (payload.status === 'failed' ? 'Agent failed.' : 'Done.');
              updateChatMessage(channelId, agentMessageId, (message) => ({
                ...message,
                body: finalBody,
                status: payload.status === 'failed' ? 'failed' : undefined,
              }));
              if (payload.status === 'completed') {
                // The agent's session now holds everything through this reply, so
                // the next turn only needs messages posted after it. Left untouched
                // on failure so the next turn re-feeds the context this run missed.
                agentContextWatermarkRef.current.set(watermarkKey, agentMessageId);
              }
              if (payload.status === 'completed' && assistantText.trim()) {
                const registrations = (chatStateRef.current.registeredAgentsByChannel[channelId] ?? [])
                  .filter((item) => item.id !== registration.id);
                const mentionedAgents = getMentionedRegistrations(assistantText, registrations, true);
                const prompt = stripRegisteredAgentMentions(assistantText, registrations) || assistantText;
                const triggeringAgentMessage: ChatMessage = {
                  id: agentMessageId,
                  channelId,
                  author: registration.displayName || agentLabel(agentId),
                  body: assistantText,
                  createdAt: new Date().toISOString(),
                  agentId,
                  registrationId: registration.id,
                };
                for (const mentionedRegistration of mentionedAgents) {
                  startAgentChatRunRef.current?.(channelId, mentionedRegistration, prompt, triggeringAgentMessage);
                }
              }
              finishRun(runId, cleanup);
            }
          } else if (event.type === 'text') {
            const payload = JSON.parse(event.payload_json);
            const blocks = normalizeChatRunBlocks(payload.message?.content);
            const text = textFromRunContent(payload.message?.content);
            if (!text && blocks.length === 0) return;
            if (text) assistantText += text;
            updateChatMessage(channelId, agentMessageId, (message) => ({
              ...message,
              body: text ? (message.body === 'Thinking...' ? text : message.body + text) : message.body,
              blocks: appendChatRunBlocks(message.blocks, blocks),
            }));
          } else if (event.type === 'user') {
            const payload = JSON.parse(event.payload_json);
            const blocks = normalizeChatRunBlocks(payload.message?.content);
            if (blocks.length === 0) return;
            updateChatMessage(channelId, agentMessageId, (message) => ({
              ...message,
              blocks: appendChatRunBlocks(message.blocks, blocks),
            }));
          }
        } catch {
          // Ignore one malformed stream event; the run status will still settle.
        }
      };

      runSocket = connectRunsSocket();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Runs socket connect timeout')), 10000);
        runSocket!.on('connect', () => {
          clearTimeout(timer);
          resolve();
        });
        runSocket!.on('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      const res = await api<{ run: { id: number; status: string; conversation_id: string } }>(`/api/vaults/${vaultId}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: runPrompt,
          note_id: null,
          agent: agentId,
          conversation_id: resumeSessionId,
          model: registration.model || undefined,
          cwd: normalizeChatCwd(registration.cwd) || undefined,
          yolo: registration.yolo,
          images: runImages,
          // Link the run to this chat message so the server persists/broadcasts
          // the streamed reply to all clients (see serverOwnedChatMessageIdsRef).
          chat: { channelId, messageId: agentMessageId },
        }),
      });

      activeRunId = res.run.id;
      // The run is registered server-side; the server now owns persistence of this
      // message's streamed updates. Skip our own debounced PATCH to avoid duplicate
      // writes — we still update local state for instant display.
      serverOwnedChatMessageIdsRef.current.add(agentMessageId);
      // Legacy members predate per-member sessions: adopt the conversation the
      // server just minted and persist it so later turns resume the same session.
      if (!registration.conversationId && res.run.conversation_id) {
        handleRegisterChatAgent(channelId, { ...registration, conversationId: res.run.conversation_id });
      }

      updateChatMessage(channelId, agentMessageId, (message) => ({
        ...message,
        runId: res.run.id,
      }));

      runSocketsRef.current.set(res.run.id, runSocket);
      joinRunRoom = () => runSocket!.emit('joinRun', res.run.id);
      runSocket.on('connect', joinRunRoom);
      runSocket.emit('joinRun', res.run.id);
      const cleanup = () => {};
      runSocket.on('event', (event) => processRunEvent(event, res.run.id, cleanup));

      try {
        const history = await api<{ events: Array<{ seq: number; type: string; payload_json: string }> }>(`/api/runs/${res.run.id}/events`);
        for (const event of history.events) processRunEvent(event, res.run.id, cleanup);
      } catch {
        // Best-effort backfill; live events will still populate going forward.
      }
    } catch (error) {
      streamingChatMessageIdsRef.current.delete(agentMessageId);
      // Release server ownership so this client-side failure is persisted by us.
      // If the run was actually created and later succeeds, the server's update
      // (higher stream score) still wins over this 'failed' state.
      serverOwnedChatMessageIdsRef.current.delete(agentMessageId);
      if (activeRunId != null) {
        runSocketsRef.current.get(activeRunId)?.disconnect();
        runSocketsRef.current.delete(activeRunId);
      } else {
        runSocket?.disconnect();
      }
      updateChatMessage(channelId, agentMessageId, (message) => ({
        ...message,
        body: error instanceof Error ? error.message : 'Failed to start agent.',
        status: 'failed',
      }));
    }
  }, [appendChatMessage, updateChatMessage, handleRegisterChatAgent]);
  startAgentChatRunRef.current = startAgentChatRun;

  const handleCancelChatRun = useCallback((runId: number) => {
    void (async () => {
      try {
        if (isLocalRunId(runId)) {
          const cleanup = localAgentUnsubsRef.current.get(runId);
          cleanup?.();
          localAgentUnsubsRef.current.delete(runId);
          const cancelled = await cancelLocalAgentRun(runId);
          if (!cancelled) {
            setNotice('Could not cancel run');
            return;
          }
        } else {
          const res = await api<{ success: boolean }>(`/api/runs/${runId}/cancel`, { method: 'POST' });
          const socket = runSocketsRef.current.get(runId);
          if (socket) {
            socket.disconnect();
            runSocketsRef.current.delete(runId);
          }
          if (!res.success) {
            setNotice('Could not cancel run');
            return;
          }
        }
        setChatState((prev) => ({
          ...prev,
          messagesByChannel: Object.fromEntries(
            Object.entries(prev.messagesByChannel).map(([channelId, messages]) => [
              channelId,
              messages.map((message) => (
                message.runId === runId && message.status === 'running'
                  ? {
                      ...message,
                      body: message.body === 'Thinking...' ? 'Run canceled by user.' : message.body,
                      status: 'failed',
                    }
                  : message
              )),
            ]),
          ),
        }));
      } catch (error) {
        setNotice(error instanceof Error ? error.message : 'Could not cancel run');
      }
    })();
  }, []);

  const handleSendChatMessage = useCallback((
    channelId: string,
    body: string,
    media: ChatMediaAttachment[] = [],
    replyTo?: ChatReplyRef,
  ) => {
    const trimmed = body.trim();
    if ((!trimmed && media.length === 0) || !user) return;

    // `/clear` (optionally targeting @mentions) rotates the session for the
    // channel's agents so the next message starts fresh, without deleting history.
    const channelRegistrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
    const clearCommand = stripRegisteredAgentMentions(trimmed, channelRegistrations).trim();
    if (/^\/(clear|reset)$/i.test(clearCommand)) {
      const mentioned = getMentionedRegistrations(trimmed, channelRegistrations, false);
      const targets = mentioned.length > 0 ? mentioned : channelRegistrations;
      if (targets.length === 0) {
        setNotice('No agents in this channel to clear.');
        return;
      }
      for (const registration of targets) {
        handleRegisterChatAgent(channelId, { ...registration, conversationId: newId('conv') });
      }
      const names = targets.map((item) => `@${normalizeMention(item.mention || item.agentId)}`).join(', ');
      appendChatMessage(channelId, {
        id: newId('sys'),
        channelId,
        author: 'Cascade',
        body: `🧹 Cleared the session for ${names}. The next message starts a fresh conversation.`,
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const images = media.filter((item) => item.media_type.startsWith('image/')).map((item) => item.url);
    const attachments = media
      .filter((item) => !item.media_type.startsWith('image/'))
      .map((item) => ({ name: item.name || 'attachment', media_type: item.media_type, url: item.url }));

    const candidate: ChatMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId,
      author: user.username,
      body: trimmed,
      createdAt: new Date().toISOString(),
      ...(images.length > 0 ? { images } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(replyTo ? { replyTo } : {}),
    };

    const messages = chatStateRef.current.messagesByChannel[channelId] ?? [];
    const last = messages[messages.length - 1];
    let outgoingMessage = candidate;
    let mergeTargetId: string | null = null;
    if (last && canMergeChatMessages(last, candidate)) {
      mergeTargetId = last.id;
      outgoingMessage = {
        ...last,
        body: `${last.body}\n${trimmed}`,
        createdAt: candidate.createdAt,
      };
    }

    setChatState((prev) => {
      const channelMessages = prev.messagesByChannel[channelId] ?? [];
      if (mergeTargetId) {
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [channelId]: [...channelMessages.slice(0, -1), outgoingMessage],
          },
        };
      }
      return {
        ...prev,
        messagesByChannel: {
          ...prev.messagesByChannel,
          [channelId]: [...channelMessages, candidate],
        },
      };
    });

    const vaultId = activeVaultIdRef.current;
    if (vaultId) {
      if (mergeTargetId) {
        scheduleChatMessagePatch(vaultId, channelId, mergeTargetId, outgoingMessage, true);
      } else {
        void persistChatMessageToServer(vaultId, channelId, candidate);
      }
    }

    const registrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
    const implicitMention = replyTo?.mention ? `@${replyTo.mention}` : '';
    const mentionSource = [implicitMention, trimmed, attachments.map((item) => item.name).join(' ')].filter(Boolean).join(' ');
    const mentionedAgents = getMentionedRegistrations(mentionSource, registrations, false);
    const targetAgents = [
      ...mentionedAgents,
      ...registrations.filter((registration) =>
        registration.replyToEveryMessage
        && !mentionedAgents.some((mentioned) => mentioned.id === registration.id)
      ),
    ];
    if (targetAgents.length === 0) return;
    const prompt = stripRegisteredAgentMentions(mentionSource, registrations) || mentionSource || 'Please review the attached media.';
    const runImages = mediaToRunImages(media);
    const agentsWithoutImages = new Set<AgentId>(['grok', 'antigravity', 'copilot', 'hermes']);
    for (const registration of targetAgents) {
      const imagesForRun = agentsWithoutImages.has(registration.agentId as AgentId) ? [] : runImages;
      void startAgentChatRun(channelId, registration, prompt, outgoingMessage, imagesForRun);
    }
  }, [scheduleChatMessagePatch, persistChatMessageToServer, startAgentChatRun, user, handleRegisterChatAgent, appendChatMessage]);

  /** Close a tab from anywhere: drop it from the registry, content, and tree. */
  const closeTab = useCallback((tabId: string) => {
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
    setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
  }, []);

  // Stable handle so socket/delete callbacks can close tabs without re-subscribing.
  const closeTabRef = useRef(closeTab); closeTabRef.current = closeTab;

  // ═══════════════════════════════════════════════════════════════
  // NOTE CONTENT
  // ═══════════════════════════════════════════════════════════════

  /** Fetch a note body into `noteContents` (no layout change). Self-heals stale tabs. */
  const loadNoteContent = useCallback(async (noteId: string) => {
    try {
      const data = await api<{ note: Note }>(`/api/notes/${noteId}`);

      // Shortcut URL check
      const content = data.note.content.trim();
      if (content.startsWith(CHAT_NOTE_MARKER)) {
        closeTab(noteId);
        openChatChannel(noteId, data.note.title);
        return;
      }

      setNoteContents((prev) => {
        const existing = prev[noteId];
        const isDirty = existing ? existing.draft !== existing.note.content : false;
        return { ...prev, [noteId]: { note: data.note, draft: isDirty ? existing!.draft : data.note.content } };
      });
      setOpenTabs((prev) => prev.map((t) => (t.id === noteId ? { ...t, title: data.note.title, type: 'note' } : t)));
    } catch (error) {
      console.error('Error loading note:', error);
      setOpenTabs((prev) => prev.filter((t) => t.id !== noteId));
      setNoteContents((prev) => { const next = { ...prev }; delete next[noteId]; return next; });
      setLayout((prev) => Layout.simplify(Layout.removeTab(prev, noteId)));
      setNotice('That note could not be opened — it may have been moved or deleted. Refreshing the list.');
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
    }
  }, [loadVaultData, closeTab, openChatChannel]);

  /**
   * Open a note: ensure it has a tab, focus the pane that already shows it, or
   * place it in the focused pane. `replace` swaps the focused pane's active tab
   * only when the note is not already open (used by single-click in the sidebar).
   */
  const openNote = useCallback((noteId: string, mode: 'open' | 'replace' = 'open') => {
    // Check if the note is a shortcut URL in the summary list
    const summary = notesRef.current.find((n) => n.id === noteId);
    if (summary) {
      const preview = summary.content_preview.trim();
      if (preview.startsWith(CHAT_NOTE_MARKER)) {
        openChatChannel(noteId, summary.title, mode);
        return;
      }
    }

    setOpenTabs((prev) =>
      prev.some((t) => t.id === noteId) ? prev : [...prev, { id: noteId, title: 'Untitled Note', type: 'note', dirty: false }],
    );

    const prev = layoutRef.current;
    const focused = focusedPaneRef.current;
    const existingPane = Layout.findPaneByTab(prev, noteId);

    if (existingPane) {
      setLayout(Layout.setActiveTab(prev, existingPane.id, noteId));
      setFocusedPaneId(existingPane.id);
    } else {
      let next = Layout.addTabToPane(Layout.removeTab(prev, noteId), focused.id, noteId);
      const oldId = focused.activeTabId;
      if (mode === 'replace' && oldId && oldId !== noteId) {
        next = Layout.removeTab(next, oldId);
        setOpenTabs((p) => p.filter((t) => t.id !== oldId));
        setNoteContents((p) => { const copy = { ...p }; delete copy[oldId]; return copy; });
      }
      setLayout(Layout.simplify(next));
      setFocusedPaneId(focused.id);
    }

    void loadNoteContent(noteId);
  }, [loadNoteContent, openChatChannel]);

  /** Save a specific note tab's draft. */
  const saveNoteTab = useCallback(async (tabId: string) => {
    const entry = noteContentsRef.current[tabId];
    if (!entry) return;
    try {
      const data = await api<{ note: Note }>(`/api/notes/${tabId}`, {
        method: 'PUT',
        body: JSON.stringify({ content: entry.draft }),
      });
      setNoteContents((prev) => ({ ...prev, [tabId]: { note: data.note, draft: data.note.content } }));
      setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: data.note.title, dirty: false } : t)));
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
      return data.note;
    } catch (error) {
      console.error('Error saving note:', error);
      throw error;
    }
  }, [loadVaultData]);

  /** Save whichever note is in the focused pane (Ctrl+S, AI panel). */
  const handleSaveActiveNote = useCallback(() => {
    const tabId = focusedPaneRef.current.activeTabId;
    return tabId ? saveNoteTab(tabId) : Promise.resolve(undefined);
  }, [saveNoteTab]);

  /** Track edits to a note tab's body and update its dirty flag. */
  const handleNoteChange = useCallback((tabId: string, newContent: string) => {
    setNoteContents((prev) => {
      const entry = prev[tabId];
      if (!entry) return prev;
      return { ...prev, [tabId]: { ...entry, draft: newContent } };
    });
    setOpenTabs((prev) => prev.map((t) => {
      if (t.id !== tabId) return t;
      const entry = noteContentsRef.current[tabId];
      return { ...t, dirty: entry ? newContent !== entry.note.content : false };
    }));
  }, []);

  /** Rename a note tab (title + on-disk file + wikilink references). */
  const renameNoteTab = useCallback(async (tabId: string, title: string) => {
    try {
      const data = await api<{ note: Note }>(`/api/notes/${tabId}/rename`, {
        method: 'POST',
        body: JSON.stringify({ title }),
      });
      setNoteContents((prev) => (prev[tabId] ? { ...prev, [tabId]: { ...prev[tabId], note: data.note } } : prev));
      setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title: t.type === 'chat' ? `#${data.note.title}` : data.note.title } : t)));
      if (activeVaultIdRef.current) void loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Could not rename note');
      throw error; // let the editor revert its title draft
    }
  }, [loadVaultData]);

  // ═══════════════════════════════════════════════════════════════
  // SOCKET SETUP
  // ═══════════════════════════════════════════════════════════════

  useEffect(() => {
    if (!activeVaultId) return;
    const socket = connectVaultSocket();
    vaultSocketRef.current = socket;
    const joinActiveVault = () => {
      socket.emit('joinVault', activeVaultId);
    };
    joinActiveVault();
    socket.on('connect', joinActiveVault);

    const handleNoteChanged = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      void loadVaultData(activeVaultId);
      // Refresh the body only if the note is open and has no unsaved edits.
      const entry = noteContentsRef.current[data.noteId];
      if (entry && entry.draft === entry.note.content) void loadNoteContent(data.noteId);
    };
    const handleNoteCreated = (data: { vaultId: string }) => {
      if (data.vaultId === activeVaultId) void loadVaultData(activeVaultId);
    };
    const handleNoteDeleted = (data: { noteId: string; vaultId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      void loadVaultData(activeVaultId);
      closeTabRef.current(data.noteId);
    };
    const handleFeedNotify = (data: { noteId: string; feedTitle: string; item?: { title?: string } }) => {
      const title = data.item?.title || 'New feed item';
      setNotice(`${data.feedTitle}: ${title}`);
      if (!('Notification' in window)) return;
      const show = () => {
        const n = new Notification(data.feedTitle || 'Cascade feed update', { body: title });
        n.onclick = () => { window.focus(); openNote(data.noteId); };
      };
      if (Notification.permission === 'granted') show();
      else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => { if (p === 'granted') show(); });
    };

    const handleChatMessageCreated = (data: { vaultId: string; channelId: string; message: ChatMessage }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => {
        const existing = prev.messagesByChannel[data.channelId] ?? [];
        if (existing.some((message) => message.id === data.message.id)) return prev;
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [data.channelId]: [...existing, data.message],
          },
        };
      });
    };
    const handleChatMessageUpdated = (data: { vaultId: string; channelId: string; message: ChatMessage }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => {
        const existing = prev.messagesByChannel[data.channelId] ?? [];
        const index = existing.findIndex((message) => message.id === data.message.id);
        if (index === -1) {
          return {
            ...prev,
            messagesByChannel: {
              ...prev.messagesByChannel,
              [data.channelId]: [...existing, data.message],
            },
          };
        }
        const next = [...existing];
        const local = existing[index];
        if (streamingChatMessageIdsRef.current.has(data.message.id)) {
          if (data.message.status === 'running') return prev;
          next[index] = mergeRemoteChatMessage(local, data.message);
        } else {
          next[index] = mergeRemoteChatMessage(local, data.message);
        }
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [data.channelId]: next,
          },
        };
      });
    };
    const handleChatAgentMemberUpserted = (data: { vaultId: string; channelId: string; registration: ChatAgentRegistration }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => {
        const existing = prev.registeredAgentsByChannel[data.channelId] ?? [];
        const filtered = existing.filter((item) => item.id !== data.registration.id);
        return {
          ...prev,
          registeredAgentsByChannel: {
            ...prev.registeredAgentsByChannel,
            [data.channelId]: [...filtered, data.registration],
          },
        };
      });
    };
    const handleChatAgentMemberRemoved = (data: { vaultId: string; channelId: string; registrationId: string }) => {
      if (data.vaultId !== activeVaultId) return;
      setChatState((prev) => ({
        ...prev,
        registeredAgentsByChannel: {
          ...prev.registeredAgentsByChannel,
          [data.channelId]: (prev.registeredAgentsByChannel[data.channelId] ?? []).filter((item) => item.id !== data.registrationId),
        },
      }));
    };

    socket.on('vault:noteChanged', handleNoteChanged);
    socket.on('vault:noteCreated', handleNoteCreated);
    socket.on('vault:noteDeleted', handleNoteDeleted);
    socket.on('vault:feedNotify', handleFeedNotify);
    socket.on('vault:chatMessageCreated', handleChatMessageCreated);
    socket.on('vault:chatMessageUpdated', handleChatMessageUpdated);
    socket.on('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
    socket.on('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
    return () => {
      socket.off('connect', joinActiveVault);
      socket.emit('leaveVault', activeVaultId);
      vaultSocketRef.current = null;
      socket.off('vault:noteChanged', handleNoteChanged);
      socket.off('vault:noteCreated', handleNoteCreated);
      socket.off('vault:noteDeleted', handleNoteDeleted);
      socket.off('vault:feedNotify', handleFeedNotify);
      socket.off('vault:chatMessageCreated', handleChatMessageCreated);
      socket.off('vault:chatMessageUpdated', handleChatMessageUpdated);
      socket.off('vault:chatAgentMemberUpserted', handleChatAgentMemberUpserted);
      socket.off('vault:chatAgentMemberRemoved', handleChatAgentMemberRemoved);
      socket.disconnect();
    };
  }, [activeVaultId, loadVaultData, loadNoteContent, openNote]);

  // ═══════════════════════════════════════════════════════════════
  // NOTE / FOLDER OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  const handleCreateNote = useCallback(async () => {
    if (!activeVaultIdRef.current) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${activeVaultIdRef.current}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Note', content: '' }),
      });
      await loadVaultData(activeVaultIdRef.current);
      openNote(data.note.id);
    } catch (error) {
      console.error('Error creating note:', error);
    }
  }, [loadVaultData, openNote]);

  const handleCreateNoteInPane = useCallback(async (paneId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Note', content: '' }),
      });
      await loadVaultData(vaultId);
      setOpenTabs((prev) =>
        prev.some((t) => t.id === data.note.id)
          ? prev
          : [...prev, { id: data.note.id, title: data.note.title || 'Untitled Note', type: 'note', dirty: false }],
      );
      setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, data.note.id), paneId, data.note.id)));
      setFocusedPaneId(paneId);
      void loadNoteContent(data.note.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create note');
    }
  }, [loadNoteContent, loadVaultData]);

  const handleCreateChatInPane = useCallback(async (paneId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER }),
      });
      await loadVaultData(vaultId);
      const tab: Tab = { id: data.note.id, title: `#${data.note.title || 'new-channel'}`, type: 'chat', dirty: false };
      setOpenTabs((prev) =>
        prev.some((t) => t.id === tab.id)
          ? prev.map((t) => (t.id === tab.id ? { ...t, ...tab } : t))
          : [...prev, tab],
      );
      setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, tab.id), paneId, tab.id)));
      setFocusedPaneId(paneId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
    }
  }, [loadVaultData]);

  const handleDeleteNote = useCallback(async (noteId: string) => {
    if (!window.confirm('Delete this note? This cannot be undone.')) return;
    try {
      const wasChatChannel = notesRef.current.find((note) => note.id === noteId)?.content_preview.trim().startsWith(CHAT_NOTE_MARKER);
      await api(`/api/notes/${noteId}`, { method: 'DELETE' });
      closeTabRef.current(noteId);
      if (wasChatChannel) {
        setChatState((prev) => {
          const messagesByChannel = { ...prev.messagesByChannel };
          delete messagesByChannel[noteId];
          return { ...prev, messagesByChannel };
        });
      }
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete note');
    }
  }, [loadVaultData]);

  const handleMoveNote = useCallback(async (noteId: string, folderId: string | null) => {
    try {
      await api(`/api/notes/${noteId}/move`, { method: 'POST', body: JSON.stringify({ folder_id: folderId }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not move note');
    }
  }, [loadVaultData]);

  const handleCreateFolder = useCallback(async (parentId: string | null = null) => {
    if (!activeVaultIdRef.current) return undefined;
    try {
      const data = await api<{ folder: Folder }>(`/api/vaults/${activeVaultIdRef.current}/folders`, {
        method: 'POST',
        body: JSON.stringify({ name: 'New Folder', parent_id: parentId ?? undefined }),
      });
      await loadVaultData(activeVaultIdRef.current);
      return data.folder;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create folder');
      return undefined;
    }
  }, [loadVaultData]);

  const handleRenameFolder = useCallback(async (folderId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await api(`/api/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ name: trimmed }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename folder');
    }
  }, [loadVaultData]);

  const handleMoveFolder = useCallback(async (folderId: string, parentId: string | null, position: number) => {
    try {
      await api(`/api/folders/${folderId}`, { method: 'PATCH', body: JSON.stringify({ parent_id: parentId, position }) });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not move folder');
    }
  }, [loadVaultData]);

  const handleDeleteFolder = useCallback(async (folderId: string) => {
    if (!window.confirm('Delete this folder? Notes inside it move to the parent folder.')) return;
    try {
      await api(`/api/folders/${folderId}`, { method: 'DELETE' });
      if (activeVaultIdRef.current) await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete folder');
    }
  }, [loadVaultData]);

  const handleCreateNoteInFolder = useCallback(async (folderId: string | null) => {
    if (!activeVaultIdRef.current) return;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${activeVaultIdRef.current}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'Untitled Note', content: '', folder_id: folderId ?? undefined }),
      });
      await loadVaultData(activeVaultIdRef.current);
      openNote(data.note.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create note');
    }
  }, [loadVaultData, openNote]);

  const handleExecuteDirective = useCallback((text: string) => {
    const run = async () => {
      const vaultId = activeVaultIdRef.current;
      if (!vaultId) return;
      let channel = notesRef.current.find((note) => note.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      let channelInfo = channel ? { id: channel.id, title: channel.title } : null;
      if (!channel) {
        const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
          method: 'POST',
          body: JSON.stringify({ title: 'agent-chat', content: CHAT_NOTE_MARKER }),
        });
        await loadVaultData(vaultId);
        channelInfo = { id: data.note.id, title: data.note.title };
      }
      if (!channelInfo) return;
      openChatChannel(channelInfo.id, channelInfo.title);
      handleSendChatMessage(channelInfo.id, `@claude ${text}`);
    };
    void run().catch((error) => {
      setNotice(error instanceof Error ? error.message : 'Could not start agent chat');
    });
  }, [handleSendChatMessage, loadVaultData, openChatChannel]);

  const handleLinkifyTerm = useCallback(async (term: string, _context: string, sourceTitle?: string) => {
    if (!activeVaultIdRef.current) return;
    try {
      const data = await api<{ note: Note; matched: boolean }>(
        `/api/vaults/${activeVaultIdRef.current}/notes/linkify`,
        { method: 'POST', body: JSON.stringify({ term }) },
      );
      await loadVaultData(activeVaultIdRef.current);
      const canonical = data.note.title;
      const linkedFrom = sourceTitle ? ` it was linked from the note "${sourceTitle}", which you can read if you desire context.` : '';
      const prompt = data.matched
        ? `the existing note "${canonical} was linked from ${linkedFrom}. if this provides additional context, please update ${canonical} to match."`
        : `please fill in the new note titled "${canonical}". move the note into the folder that feels most appropriate, or create a new folder.${linkedFrom}`;
      handleExecuteDirective(prompt);
      setNotice(data.matched ? `Linking “${term}” to “${canonical}” — agent is updating it…` : `Created “${canonical}” — agent is filling it in…`);
      return { title: canonical, matched: data.matched };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not link term');
      throw error;
    }
  }, [loadVaultData, handleExecuteDirective]);

  // ═══════════════════════════════════════════════════════════════
  // TAB / PANE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /** Select a tab inside a specific pane (per-pane strip click). */
  const selectTabInPane = useCallback((paneId: string, tabId: string) => {
    setLayout(Layout.setActiveTab(layoutRef.current, paneId, tabId));
    setFocusedPaneId(paneId);
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (tab?.type === 'note' && !noteContentsRef.current[tabId]) void loadNoteContent(tabId);
  }, [loadNoteContent]);

  /** Handle a tab dropped onto a pane (drag-tile). */
  const handleDropTab = useCallback((payload: TabDragPayload, targetPaneId: string, side: Layout.DropSide, index?: number) => {
    const prev = layoutRef.current;
    const next = side === 'center'
      ? Layout.moveTab(prev, payload.tabId, targetPaneId, index)
      : Layout.splitPaneWithTab(prev, targetPaneId, side, payload.tabId);
    setLayout(next);
    const landed = Layout.findPaneByTab(next, payload.tabId);
    setFocusedPaneId(landed?.id ?? targetPaneId);
  }, []);

  const handleResizeSplit = useCallback((splitId: string, sizes: number[]) => {
    setLayout(Layout.setSplitSizes(layoutRef.current, splitId, sizes));
  }, []);

  /**
   * A tab was dragged out of the window. Ask the main process to pop it into a
   * new OS window at the cursor; if it did (drop was outside this window), drop
   * the tab from this window's layout so it lives in exactly one place.
   */
  const handleDetachTab = useCallback((tabId: string, screenX: number, screenY: number) => {
    const electronAPI = (window as unknown as {
      electronAPI?: { popOutTab?: (input: { tab: Tab; screenX: number; screenY: number }) => Promise<{ success: boolean; popped?: boolean }> };
    }).electronAPI;
    if (!electronAPI?.popOutTab) return;
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (!tab) return;
    if (tab.type !== 'note') return;
    void electronAPI.popOutTab({ tab, screenX, screenY }).then((res) => {
      if (!res?.popped) return;
      setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
      setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
      setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
    });
  }, []);

  // Adopt a tab merged back in from a popped-out window (it was dragged onto
  // this window). Dock it into the focused pane and load its body if a note.
  useEffect(() => {
    const electronAPI = (window as unknown as {
      electronAPI?: { onAdoptTab?: (cb: (tab: Tab) => void) => () => void };
    }).electronAPI;
    if (!electronAPI?.onAdoptTab) return;
    return electronAPI.onAdoptTab((tab) => {
      if (!tab || typeof tab.id !== 'string') return;
      if (tab.type !== 'note') return;
      setOpenTabs((prev) =>
        prev.some((t) => t.id === tab.id) ? prev.map((t) => (t.id === tab.id ? { ...t, ...tab } : t)) : [...prev, tab],
      );
      const paneId = focusedPaneRef.current.id;
      setLayout(Layout.simplify(Layout.addTabToPane(Layout.removeTab(layoutRef.current, tab.id), paneId, tab.id)));
      setFocusedPaneId(paneId);
      if (tab.type === 'note') void loadNoteContent(tab.id);
    });
  }, [loadNoteContent]);

  /** Split the focused pane to the right (Ctrl/Cmd+Shift+\). */
  const splitFocusedPane = useCallback(() => {
    const focused = focusedPaneRef.current;
    if (!focused.activeTabId) return;
    const next = Layout.splitPaneWithTab(layoutRef.current, focused.id, 'right', focused.activeTabId);
    setLayout(next);
    const landed = Layout.findPaneByTab(next, focused.activeTabId);
    if (landed) setFocusedPaneId(landed.id);
  }, []);

  // After login/reload, fetch bodies for the note tabs that are visible in panes.
  const didRestoreSessionRef = useRef(false);
  useEffect(() => {
    if (didRestoreSessionRef.current || !activeVaultId) return;
    didRestoreSessionRef.current = true;
    Layout.getActiveTabIds(layoutRef.current).forEach((id) => {
      if (openTabsRef.current.find((t) => t.id === id)?.type === 'note') void loadNoteContent(id);
    });
  }, [activeVaultId, loadNoteContent]);

  // ═══════════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════════

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    try {
      const data = await api<{ user: User; token: string }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem('docs_token', data.token);
      setUser(data.user);
      setPassword('');
      await loadVaults();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  const handleLogout = () => {
    const pane = Layout.createPane();
    runSocketsRef.current.forEach((socket) => socket.disconnect());
    runSocketsRef.current.clear();
    localStorage.removeItem('docs_token');
    setUser(null);
    setVaults([]);
    setActiveVaultId(null);
    setFolders([]);
    setNotes([]);
    setOpenTabs([]);
    setLayout(pane);
    setFocusedPaneId(pane.id);
    setNoteContents({});
  };

  // ═══════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'p') { e.preventDefault(); setCommandPaletteOpen((v) => !v); }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen((v) => !v); }
      if (mod && e.key === '\\' && !(e.altKey || e.shiftKey)) { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && !e.shiftKey && e.key === 'n') { e.preventDefault(); void handleCreateNote(); }
      if (mod && e.key === 's') { e.preventDefault(); void handleSaveActiveNote(); }
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const id = focusedPaneRef.current.activeTabId;
        if (id) closeTab(id);
      }
      if (mod && (e.altKey || e.shiftKey) && (e.key === '\\' || e.key === '|')) { e.preventDefault(); splitFocusedPane(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCreateNote, handleSaveActiveNote, closeTab, splitFocusedPane]);

  // Chromium-reserved shortcuts forwarded from the Electron main process.
  useEffect(() => {
    const electronAPI = (window as unknown as { electronAPI?: { onShortcut?: (cb: (a: string) => void) => () => void } }).electronAPI;
    if (!electronAPI?.onShortcut) return;
    return electronAPI.onShortcut((action) => {
      if (action === 'new-note') void handleCreateNote();
      else if (action === 'toggle-sidebar') setSidebarOpen((v) => !v);
    });
  }, [handleCreateNote]);

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════

  /** Render the content of a tab inside its pane. */
  const renderTabContent = useCallback((tab: Tab): ReactNode => {
    if (tab.type === 'chat') {
      const channel = notes.find((note) => note.id === tab.id && note.content_preview.trim().startsWith(CHAT_NOTE_MARKER));
      if (!channel) return <div className="pane-empty">Channel not found</div>;
      return (
        <ChatView
          channelId={channel.id}
          channelName={channel.title}
          messages={chatState.messagesByChannel[channel.id] ?? []}
          currentUser={currentUsername}
          availableAgents={CHAT_AGENTS.map((agent) => ({
            id: agent.id,
            label: agent.label,
            models: CHAT_AGENT_MODEL_PRESETS[agent.id],
          }))}
          registeredAgents={chatState.registeredAgentsByChannel[channel.id] ?? []}
          runningAgents={runningChatAgents}
          onRegisterAgent={handleRegisterChatAgent}
          onRemoveAgent={handleRemoveChatAgent}
          onSendMessage={handleSendChatMessage}
          onCancelRun={handleCancelChatRun}
          notes={notes}
          onOpenNote={openNote}
        />
      );
    }
    const entry = noteContents[tab.id];
    return (
      <NoteEditor
        note={entry?.note ?? null}
        content={entry?.draft ?? ''}
        onContentChange={(c) => handleNoteChange(tab.id, c)}
        onSave={() => saveNoteTab(tab.id)}
        onRename={(title) => renameNoteTab(tab.id, title)}
        onExecuteDirective={handleExecuteDirective}
        onOpenWikilink={(title) => {
          const target = notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
          if (target) openNote(target.id);
        }}
        notes={notes}
        onOpenNote={openNote}
        onLinkifySelection={(term, context) => handleLinkifyTerm(term, context, entry?.note?.title)}
      />
    );
  }, [chatState.messagesByChannel, chatState.registeredAgentsByChannel, currentUsername, runningChatAgents, handleCancelChatRun, handleRegisterChatAgent, handleRemoveChatAgent, handleSendChatMessage, noteContents, notes, handleNoteChange, saveNoteTab, renameNoteTab, handleExecuteDirective, handleLinkifyTerm, openNote]);

  if (!user) {
    return (
      <main className="auth-shell">
        <form className="auth-panel" id="auth-panel" onSubmit={submitAuth}>
          <div className="auth-brand" aria-label="Cascade Notes">
            <Gem size={24} aria-hidden="true" />
            <h1>Cascade</h1>
          </div>
          <label htmlFor="username">
            Username
            <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus />
          </label>
          <label htmlFor="password">
            Password
            <input id="password" value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          {authError && <div className="error">{authError}</div>}
          <button id="auth-submit" type="submit">{authMode === 'login' ? 'Log in' : 'Create account'}</button>
          <button id="auth-toggle-mode" type="button" className="link-button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
            {authMode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main
      className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}
      style={{
        display: 'grid',
        '--sidebar-width': `${sidebarWidth}px`,
        overflow: 'hidden',
        position: 'relative',
        transition: isResizing ? 'none' : undefined,
      } as CSSProperties}
    >
      {sidebarOpen && (
        <div className="resize-handle" style={{ left: sidebarWidth - 3 }} onMouseDown={startResize} role="separator" aria-orientation="vertical" aria-label="Resize sidebar" title="Drag to resize" />
      )}

      {sidebarOpen && (
        <Sidebar
          user={user}
          vaults={vaults}
          activeVaultId={activeVaultId}
          folders={folders}
          notes={notes}
          activeNoteId={activeTabId}
          onSelectVault={setActiveVaultId}
          onSelectNote={(id) => {
            openNote(id, 'replace');
            if (window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false);
          }}
          onOpenNoteInNewTab={(id) => {
            openNote(id);
            if (window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false);
          }}
          onNewNote={() => {
            void handleCreateNote();
            if (window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false);
          }}
          onCreateChannel={async (folderId) => {
            const channel = await handleCreateChannel(folderId);
            if (window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false);
            return channel;
          }}
          onNewNoteInFolder={(folderId) => {
            void handleCreateNoteInFolder(folderId);
            if (window.matchMedia('(max-width: 900px)').matches) setSidebarOpen(false);
          }}
          onSearch={() => setSearchOpen(true)}
          onCollapse={() => setSidebarOpen(false)}
          onLogout={handleLogout}
          onDeleteNote={handleDeleteNote}
          onMoveNote={handleMoveNote}
          onMoveFolder={handleMoveFolder}
          onCreateFolder={handleCreateFolder}
          onRenameFolder={handleRenameFolder}
          onRenameNote={renameNoteTab}
          onDeleteFolder={handleDeleteFolder}
        />
      )}

      {/* Workspace */}
      <div className="workspace flex flex-col flex-1" style={{ height: '100%', overflow: 'hidden' }}>
        <div className="workspace-toolbar" style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-surface)', padding: '4px 8px', gap: 4, borderBottom: '1px solid var(--border)' }}>
          {!sidebarOpen && (
            <button id="sidebar-expand-btn" className="btn-icon" onClick={() => setSidebarOpen(true)} title="Expand sidebar">
              <PanelLeftOpen size={16} />
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }} />
        </div>

        <div className="flex-1" style={{ position: 'relative', display: 'flex', overflow: 'hidden' }}>
          <PaneGrid
            node={layout}
            openTabs={openTabs}
            focusedPaneId={focusedPaneId}
            onFocusPane={setFocusedPaneId}
            onSelectTab={selectTabInPane}
            onCloseTab={closeTab}
            onDropTab={handleDropTab}
            onResize={handleResizeSplit}
            onCreateNote={handleCreateNoteInPane}
            onCreateChat={handleCreateChatInPane}
            onDetachTab={handleDetachTab}
            renderContent={renderTabContent}
          />
        </div>
      </div>

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} vaultId={activeVaultId} onSelectNote={(id) => openNote(id)} />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} notes={notes} onSelectNote={(id) => openNote(id)} onCreateNote={handleCreateNote} />

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
