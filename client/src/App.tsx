import { useEffect, useState, useCallback, useRef, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { Sidebar } from './components/Sidebar';
import { type Tab } from './components/TabBar';
import { NoteEditor } from './components/NoteEditor';
import { WebView } from './components/WebView';
import { TerminalWindow } from './components/TerminalWindow';
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
import { Gem, PanelLeftOpen, SquareTerminal } from 'lucide-react';

/**
 * @file App.tsx — Root component for Cascade
 *
 * Orchestrates application state and the tiling workspace. `openTabs` is the
 * global registry of tab content (notes, web views, terminals); a recursive
 * {@link LayoutNode} tree (see `layout/tree.ts`) describes how those tabs are
 * arranged into draggable, resizable panes. Note bodies are held per-tab in
 * `noteContents` so any number of note panes can be edited independently.
 *
 * Web tabs render once into a persistent overlay positioned over whichever pane
 * currently shows them, so switching/tiling never reloads them.
 *
 * @component
 */

function sanitizeRestoredTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tab): tab is Partial<Tab> => Boolean(tab) && typeof tab === 'object')
    .map((tab): Tab | null => {
      if (typeof tab.id !== 'string' || typeof tab.title !== 'string') return null;
      if (tab.type === 'web') {
        return {
          id: tab.id,
          title: tab.title,
          type: 'web',
          dirty: false,
          url: typeof tab.url === 'string' ? tab.url : 'about:blank',
          isChatNote: typeof tab.isChatNote === 'boolean' ? tab.isChatNote : undefined
        };
      }
      if (tab.type === 'terminal') {
        return { id: tab.id, title: tab.title || 'Terminal', type: 'terminal', dirty: false, terminalHistory: typeof tab.terminalHistory === 'string' ? tab.terminalHistory : '' };
      }
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
 * re-fetched on restore; web tabs reload from their persisted URL.
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
  agentConversationsByChannel: Record<string, string>;
  agentModelsByAgent: Record<string, string>;
  registeredAgentsByChannel: Record<string, ChatAgentRegistration[]>;
}

const emptyChatState = (): ChatState => ({
  messagesByChannel: {},
  agentConversationsByChannel: {},
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

function loadChatState(): ChatState {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return emptyChatState();
    const parsed = JSON.parse(raw) as Partial<ChatState>;
    const messagesByChannel: Record<string, ChatMessage[]> = {};
    const agentConversationsByChannel: Record<string, string> = {};
    const agentModelsByAgent: Record<string, string> = {};
    const registeredAgentsByChannel: Record<string, ChatAgentRegistration[]> = {};

    if (parsed.messagesByChannel && typeof parsed.messagesByChannel === 'object') {
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
    }

    if (parsed.agentConversationsByChannel && typeof parsed.agentConversationsByChannel === 'object') {
      for (const [key, value] of Object.entries(parsed.agentConversationsByChannel)) {
        if (typeof value === 'string') agentConversationsByChannel[key] = value;
      }
    }

    if (parsed.agentModelsByAgent && typeof parsed.agentModelsByAgent === 'object') {
      for (const [key, value] of Object.entries(parsed.agentModelsByAgent)) {
        if (typeof value === 'string') agentModelsByAgent[key] = value;
      }
    }

    if (parsed.registeredAgentsByChannel && typeof parsed.registeredAgentsByChannel === 'object') {
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
            };
          });
      }
    }

    return { messagesByChannel, agentConversationsByChannel, agentModelsByAgent, registeredAgentsByChannel };
  } catch {
    return emptyChatState();
  }
}

type PaneRect = { left: number; top: number; width: number; height: number };
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
    { id: 'claude-sonnet-4-6', label: 'Claude 4.6 Sonnet' },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude 4.5 Haiku' },
    { id: 'claude-opus-4-8', label: 'Claude 4.8 Opus' },
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
    { id: 'claude-haiku-4.5', label: 'Claude 4.5 Haiku' },
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

function chatConversationKey(channelId: string, registration: ChatAgentRegistration) {
  return [
    channelId,
    registration.id,
    registration.agentId,
    registration.model || '',
    normalizeChatCwd(registration.cwd),
  ].join(':');
}

function textFromRunContent(content: unknown): string {
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

function formatAgentChatPrompt(channelName: string, registrations: ChatAgentRegistration[], registration: ChatAgentRegistration, history: ChatMessage[], request: string) {
  const recentHistory = history
    .filter((message) => message.body.trim() || (message.images?.length ?? 0) > 0 || (message.attachments?.length ?? 0) > 0)
    .slice(-40)
    .map((message) => {
      const body = message.body.length > 1200 ? `${message.body.slice(0, 1199)}…` : message.body;
      const mediaNote = [
        message.images?.length ? `[${message.images.length} image${message.images.length === 1 ? '' : 's'} attached]` : '',
        message.attachments?.length ? `[${message.attachments.length} file${message.attachments.length === 1 ? '' : 's'} attached]` : '',
      ].filter(Boolean).join(' ');
      const suffix = mediaNote ? (body ? ` ${mediaNote}` : mediaNote) : '';
      const replyNote = message.replyTo ? `[reply to @${message.replyTo.mention}] ` : '';
      return `${message.author}: ${replyNote}${body || '(media)'}${suffix}`;
    })
    .join('\n');

  return [
    `You are responding in the Cascade chat channel #${channelName}.`,
    'You can access and use the chat history below as context for your reply.',
    registration.contextPrompt ? `Your channel-specific context: ${registration.contextPrompt}` : '',
    '',
    'Registered agents in this channel:',
    registrations.length
      ? registrations.map((item) => {
          const agent = CHAT_AGENTS.find((candidate) => candidate.id === item.agentId);
          const taggable = item.taggableByAgents ? 'taggable by agents' : 'not taggable by agents';
          return `- @${item.mention || item.agentId}: ${item.displayName || agent?.label || item.agentId} (${taggable})`;
        }).join('\n')
      : '(none)',
    '',
    'Chat history:',
    recentHistory || '(no prior messages)',
    '',
    'Current user request:',
    request,
  ].join('\n');
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
  // True while a tab is being dragged, so the <webview> overlay lets drops
  // fall through to the panes underneath it.
  const [isDraggingTab, setIsDraggingTab] = useState(false);

  // ─── Derived focus state ────────────────────────────────────────
  const focusedPane = Layout.findPane(layout, focusedPaneId) ?? Layout.getFirstPane(layout);
  const activeTabId = focusedPane.activeTabId;
  const activeTab = openTabs.find((t) => t.id === activeTabId);
  const currentUsername = user?.username ?? '';

  const runningChatAgents = useMemo(() => {
    const entries: RunningChatAgent[] = [];
    for (const [channelId, messages] of Object.entries(chatState.messagesByChannel)) {
      const channelName = notes.find((note) => note.id === channelId)?.title || 'channel';
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
  }, [chatState.messagesByChannel, notes]);

  // Refs mirror the latest state so event handlers stay stable (no dep churn)
  // and never read a stale closure during drags / async work.
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const focusedPaneRef = useRef(focusedPane); focusedPaneRef.current = focusedPane;
  const openTabsRef = useRef(openTabs); openTabsRef.current = openTabs;
  const noteContentsRef = useRef(noteContents); noteContentsRef.current = noteContents;
  const activeVaultIdRef = useRef(activeVaultId); activeVaultIdRef.current = activeVaultId;
  const notesRef = useRef(notes); notesRef.current = notes;
  const chatStateRef = useRef(chatState); chatStateRef.current = chatState;
  const runSocketsRef = useRef<Map<number, ReturnType<typeof connectRunsSocket>>>(new Map());
  const startAgentChatRunRef = useRef<((channelId: string, registration: ChatAgentRegistration, prompt: string, triggeringMessage: ChatMessage) => void) | null>(null);

  // ─── Persistent web-tab geometry ────────────────────────────────
  // Each pane registers its content element so we can position the persistent
  // <webview> overlay over the pane that currently shows a given web tab.
  const editorAreaRef = useRef<HTMLDivElement>(null);
  const paneElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [paneRects, setPaneRects] = useState<Record<string, PaneRect>>({});

  const registerPaneContent = useCallback((paneId: string, el: HTMLDivElement | null) => {
    if (el) paneElsRef.current.set(paneId, el);
    else paneElsRef.current.delete(paneId);
  }, []);

  const measurePanes = useCallback(() => {
    const area = editorAreaRef.current;
    if (!area) return;
    const areaRect = area.getBoundingClientRect();
    const next: Record<string, PaneRect> = {};
    paneElsRef.current.forEach((el, id) => {
      if (!el.isConnected) return;
      const r = el.getBoundingClientRect();
      next[id] = { left: r.left - areaRect.left, top: r.top - areaRect.top, width: r.width, height: r.height };
    });
    setPaneRects(next);
  }, []);

  useLayoutEffect(() => {
    measurePanes();
    const observer = new ResizeObserver(() => measurePanes());
    if (editorAreaRef.current) observer.observe(editorAreaRef.current);
    paneElsRef.current.forEach((el) => observer.observe(el));
    window.addEventListener('resize', measurePanes);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measurePanes);
    };
  }, [measurePanes, layout, sidebarOpen, sidebarWidth, openTabs]);

  // Repair focus if the focused pane disappears (e.g. after collapsing a split).
  useEffect(() => {
    if (!Layout.findPane(layout, focusedPaneId)) {
      setFocusedPaneId(Layout.getFirstPane(layout).id);
    }
  }, [layout, focusedPaneId]);

  useEffect(() => { localStorage.setItem('cascade_sidebar_w', String(sidebarWidth)); }, [sidebarWidth]);

  // Persist the workspace session.
  useEffect(() => {
    const session: PersistedSession = { activeVaultId, openTabs, layout, focusedPaneId };
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }, [activeVaultId, openTabs, layout, focusedPaneId]);

  useEffect(() => {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatState));
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

  const loadVaultData = useCallback(async (vaultId: string) => {
    try {
      const [folderData, noteData] = await Promise.all([
        api<{ folders: Folder[] }>(`/api/vaults/${vaultId}/folders`),
        api<{ notes: NoteSummary[] }>(`/api/vaults/${vaultId}/notes`),
      ]);
      setFolders(folderData.folders || []);
      setNotes(noteData.notes || []);
    } catch (error) {
      console.error('Error loading vault data:', error);
    }
  }, []);

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

  // ═══════════════════════════════════════════════════════════════
  // WEB / TERMINAL TAB OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  function extractDomain(url: string): string {
    try { return new URL(url).hostname; } catch { return url; }
  }

  /** Add a tab to the registry and place it (active) into a pane. */
  const addTabToPane = useCallback((tab: Tab, paneId: string) => {
    setOpenTabs((prev) => [...prev, tab]);
    setLayout(Layout.simplify(Layout.addTabToPane(layoutRef.current, paneId, tab.id)));
    setFocusedPaneId(paneId);
  }, []);

  /** Create a fresh browser tab in the given (or focused) pane. */
  const handleCreateWebTab = useCallback((paneId?: string) => {
    const id = `web-${Date.now()}`;
    addTabToPane({ id, title: 'New Tab', type: 'web', dirty: false, url: 'about:blank' }, paneId ?? focusedPaneRef.current.id);
  }, [addTabToPane]);

  /** Open a URL: focus an existing matching web tab, else open a new one. */
  const handleOpenWebView = useCallback((url: string, isChatNote?: boolean) => {
    const shouldBeChatNote = isChatNote || url.includes('#chatNote') || url.includes('chatNote=true');
    const cleanUrl = url.replace('#chatNote', '').replace(/[?&]chatNote=true/, '');

    const existing = openTabsRef.current.find((t) => t.type === 'web' && (t.url === cleanUrl || t.url === url));
    if (existing) {
      if (shouldBeChatNote && !existing.isChatNote) {
        setOpenTabs((prev) => prev.map((t) => (t.id === existing.id ? { ...t, isChatNote: true } : t)));
      }
      const pane = Layout.findPaneByTab(layoutRef.current, existing.id);
      if (pane) { setLayout(Layout.setActiveTab(layoutRef.current, pane.id, existing.id)); setFocusedPaneId(pane.id); }
      return;
    }
    const id = `web-${Date.now()}`;
    addTabToPane({
      id,
      title: extractDomain(cleanUrl) || cleanUrl,
      type: 'web',
      dirty: false,
      url: cleanUrl,
      isChatNote: shouldBeChatNote,
    }, focusedPaneRef.current.id);
  }, [addTabToPane]);

  const handleCreateChatNote = useCallback(async (tabId: string) => {
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (!tab || tab.type !== 'web') return;

    // Promote the tab locally to be a chat note
    setOpenTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, isChatNote: true } : t))
    );

    // Call electron to update its chat note state
    const electronAPI = (window as unknown as {
      electronAPI?: { setChatNote?: (id: string, isChatNote: boolean) => Promise<{ success: boolean }> };
    }).electronAPI;
    if (electronAPI?.setChatNote) {
      void electronAPI.setChatNote(tabId, true);
    }

    // Create the shortcut note in the vault
    if (!activeVaultIdRef.current) return;
    try {
      const urlWithHash = `${tab.url || 'about:blank'}#chatNote`;
      const title = tab.title || 'Chat Note';
      await api<{ note: Note }>(`/api/vaults/${activeVaultIdRef.current}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title, content: urlWithHash }),
      });
      setNotice(`Created chat note shortcut: ${title}`);
      await loadVaultData(activeVaultIdRef.current);
    } catch (error) {
      console.error('Error creating chat note shortcut:', error);
    }
  }, [loadVaultData]);

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

    if (mode !== 'replace' && existingPane) {
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
      if (openTabsRef.current.find((t) => t.id === oldId)?.type === 'terminal') {
        const electronAPI = (window as unknown as {
          electronAPI?: { stopTerminal?: (id: string) => Promise<{ success: boolean; error?: string }> };
        }).electronAPI;
        void electronAPI?.stopTerminal?.(oldId);
      }
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
  }, []);

  const updateChatMessage = useCallback((channelId: string, messageId: string, updater: (message: ChatMessage) => ChatMessage) => {
    setChatState((prev) => ({
      ...prev,
      messagesByChannel: {
        ...prev.messagesByChannel,
        [channelId]: (prev.messagesByChannel[channelId] ?? []).map((message) =>
          message.id === messageId ? updater(message) : message,
        ),
      },
    }));
  }, []);

  const handleRegisterChatAgent = useCallback((channelId: string, registration: ChatAgentRegistration) => {
    const normalized = {
      ...registration,
      id: registration.id || createChatAgentRegistrationId(),
      displayName: registration.displayName.trim() || agentLabel(registration.agentId as AgentId),
      mention: normalizeMention(registration.mention || registration.agentId),
      cwd: normalizeChatCwd(registration.cwd),
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
  }, []);

  const handleRemoveChatAgent = useCallback((channelId: string, registrationId: string) => {
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: (prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== registrationId),
      },
    }));
  }, []);

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
    const registrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
    const chatHistory = [...(chatStateRef.current.messagesByChannel[channelId] ?? []), triggeringMessage];
    const runPrompt = formatAgentChatPrompt(channelName, registrations, registration, chatHistory, prompt);
    const agentMessageId = `agent-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

    try {
      const conversationKey = chatConversationKey(channelId, registration);
      const res = await api<{ run: { id: number; status: string; conversation_id: string } }>(`/api/vaults/${vaultId}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          prompt: runPrompt,
          note_id: null,
          agent: agentId,
          conversation_id: chatStateRef.current.agentConversationsByChannel[conversationKey],
          model: registration.model || undefined,
          cwd: normalizeChatCwd(registration.cwd) || undefined,
          images: runImages,
        }),
      });

      if (res.run.conversation_id) {
        setChatState((prev) => ({
          ...prev,
          agentConversationsByChannel: {
            ...prev.agentConversationsByChannel,
            [conversationKey]: res.run.conversation_id,
          },
        }));
      }

      updateChatMessage(channelId, agentMessageId, (message) => ({
        ...message,
        runId: res.run.id,
      }));

      const socket = connectRunsSocket();
      runSocketsRef.current.set(res.run.id, socket);
      socket.emit('joinRun', res.run.id);
      let assistantText = '';
      // The run starts streaming events server-side the instant it's created,
      // but this socket only joins the run room after its handshake completes.
      // Socket.IO doesn't replay a room's past events to a late joiner, so the
      // earliest events (notably the first assistant message's thinking blocks)
      // would be dropped. Dedup by event `seq` and backfill from the persisted
      // event log below so nothing emitted before the join is lost.
      const processedSeqs = new Set<number>();
      const processRunEvent = (event: any) => {
        if (typeof event?.seq === 'number') {
          if (processedSeqs.has(event.seq)) return;
          processedSeqs.add(event.seq);
        }
        try {
          if (event.type === 'status') {
            const payload = JSON.parse(event.payload_json);
            if (payload.status === 'completed' || payload.status === 'failed') {
              updateChatMessage(channelId, agentMessageId, (message) => ({
                ...message,
                body: message.body === 'Thinking...' ? (payload.status === 'completed' ? 'Done.' : payload.summary || 'Agent failed.') : message.body,
                status: payload.status === 'failed' ? 'failed' : undefined,
              }));
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
              socket.disconnect();
              runSocketsRef.current.delete(res.run.id);
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

      socket.on('event', processRunEvent);

      // Backfill events that were emitted before this socket joined the room
      // (e.g. the opening thinking blocks). Deduped by seq against live events,
      // so overlap is harmless and ordering settles on the persisted log.
      try {
        const history = await api<{ events: Array<{ seq: number; type: string; payload_json: string }> }>(`/api/runs/${res.run.id}/events`);
        for (const event of history.events) processRunEvent(event);
      } catch {
        // Best-effort backfill; live events will still populate going forward.
      }
    } catch (error) {
      updateChatMessage(channelId, agentMessageId, (message) => ({
        ...message,
        body: error instanceof Error ? error.message : 'Failed to start agent.',
        status: 'failed',
      }));
    }
  }, [appendChatMessage, updateChatMessage]);
  startAgentChatRunRef.current = startAgentChatRun;

  const handleCancelChatRun = useCallback((runId: number) => {
    void (async () => {
      try {
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

    let outgoingMessage = candidate;
    setChatState((prev) => {
      const messages = prev.messagesByChannel[channelId] ?? [];
      const last = messages[messages.length - 1];
      if (last && canMergeChatMessages(last, candidate)) {
        const merged: ChatMessage = {
          ...last,
          body: `${last.body}\n${trimmed}`,
          createdAt: candidate.createdAt,
        };
        outgoingMessage = merged;
        return {
          ...prev,
          messagesByChannel: {
            ...prev.messagesByChannel,
            [channelId]: [...messages.slice(0, -1), merged],
          },
        };
      }
      return {
        ...prev,
        messagesByChannel: {
          ...prev.messagesByChannel,
          [channelId]: [...messages, candidate],
        },
      };
    });

    const registrations = chatStateRef.current.registeredAgentsByChannel[channelId] ?? [];
    const implicitMention = replyTo?.mention ? `@${replyTo.mention}` : '';
    const mentionSource = [implicitMention, trimmed, attachments.map((item) => item.name).join(' ')].filter(Boolean).join(' ');
    const mentionedAgents = getMentionedRegistrations(mentionSource, registrations, false);
    if (mentionedAgents.length === 0) return;
    const prompt = stripRegisteredAgentMentions(mentionSource, registrations) || mentionSource || 'Please review the attached media.';
    const runImages = mediaToRunImages(media);
    const agentsWithoutImages = new Set<AgentId>(['grok', 'antigravity', 'copilot', 'hermes']);
    for (const registration of mentionedAgents) {
      const imagesForRun = agentsWithoutImages.has(registration.agentId as AgentId) ? [] : runImages;
      void startAgentChatRun(channelId, registration, prompt, outgoingMessage, imagesForRun);
    }
  }, [startAgentChatRun, user]);

  // ═══════════════════════════════════════════════════════════════
  // TERMINAL HELPERS
  // ═══════════════════════════════════════════════════════════════

  const stopTerminalTab = useCallback((tabId: string) => {
    const electronAPI = (window as unknown as {
      electronAPI?: { stopTerminal?: (id: string) => Promise<{ success: boolean; error?: string }> };
    }).electronAPI;
    void electronAPI?.stopTerminal?.(tabId);
  }, []);

  /** Close a tab from anywhere: drop it from the registry, content, and tree. */
  const closeTab = useCallback((tabId: string) => {
    const tab = openTabsRef.current.find((t) => t.id === tabId);
    if (tab?.type === 'terminal') stopTerminalTab(tabId);
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId));
    setNoteContents((prev) => { const next = { ...prev }; delete next[tabId]; return next; });
    setLayout(Layout.simplify(Layout.removeTab(layoutRef.current, tabId)));
  }, [stopTerminalTab]);

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
      const match = content.match(/^(https?:\/\/[^\s]+)$/);
      if (match) {
        const url = match[1];
        closeTab(noteId);
        handleOpenWebView(url);
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
  }, [loadVaultData, closeTab, handleOpenWebView, openChatChannel]);

  /**
   * Open a note: ensure it has a tab, place it in the focused pane (or focus the
   * pane that already shows it), then load its body. `replace` swaps the focused
   * pane's active tab for this note (used by single-click in the sidebar).
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
      const match = preview.match(/^(https?:\/\/[^\s]+)$/);
      if (match) {
        handleOpenWebView(match[1]);
        return;
      }
    }

    setOpenTabs((prev) =>
      prev.some((t) => t.id === noteId) ? prev : [...prev, { id: noteId, title: 'Untitled Note', type: 'note', dirty: false }],
    );

    const prev = layoutRef.current;
    const focused = focusedPaneRef.current;
    const existingPane = Layout.findPaneByTab(prev, noteId);

    if (mode !== 'replace' && existingPane) {
      setLayout(Layout.setActiveTab(prev, existingPane.id, noteId));
      setFocusedPaneId(existingPane.id);
    } else {
      let next = Layout.addTabToPane(Layout.removeTab(prev, noteId), focused.id, noteId);
      const oldId = focused.activeTabId;
      if (mode === 'replace' && oldId && oldId !== noteId) {
        next = Layout.removeTab(next, oldId);
        setOpenTabs((p) => p.filter((t) => t.id !== oldId));
        setNoteContents((p) => { const copy = { ...p }; delete copy[oldId]; return copy; });
        if (openTabsRef.current.find((t) => t.id === oldId)?.type === 'terminal') stopTerminalTab(oldId);
      }
      setLayout(Layout.simplify(next));
      setFocusedPaneId(focused.id);
    }

    void loadNoteContent(noteId);
  }, [loadNoteContent, stopTerminalTab, handleOpenWebView, openChatChannel]);

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
    socket.emit('joinVault', activeVaultId);

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

    socket.on('vault:noteChanged', handleNoteChanged);
    socket.on('vault:noteCreated', handleNoteCreated);
    socket.on('vault:noteDeleted', handleNoteDeleted);
    socket.on('vault:feedNotify', handleFeedNotify);
    return () => {
      socket.emit('leaveVault', activeVaultId);
      socket.off('vault:noteChanged', handleNoteChanged);
      socket.off('vault:noteCreated', handleNoteCreated);
      socket.off('vault:noteDeleted', handleNoteDeleted);
      socket.off('vault:feedNotify', handleFeedNotify);
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
          const agentConversationsByChannel = { ...prev.agentConversationsByChannel };
          for (const key of Object.keys(agentConversationsByChannel)) {
            if (key.startsWith(`${noteId}:`)) delete agentConversationsByChannel[key];
          }
          return { ...prev, messagesByChannel, agentConversationsByChannel };
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
  // WEB / TERMINAL TAB STATE UPDATES
  // ═══════════════════════════════════════════════════════════════

  const updateTabUrl = useCallback((tabId: string, url: string) => {
    setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, url, title: extractDomain(url) } : t)));
  }, []);

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setOpenTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, title } : t)));
  }, []);

  const updateTerminalHistory = useCallback((tabId: string, terminalHistory: string) => {
    setOpenTabs((prev) => prev.map((t) => (t.id === tabId && t.type === 'terminal' ? { ...t, terminalHistory } : t)));
  }, []);

  /** Turn the focused pane's active tab into a terminal (or open a new one). */
  const handleUpgradeActiveTabToTerminal = useCallback(() => {
    const focused = focusedPaneRef.current;
    const activeId = focused.activeTabId;
    const termId = activeId ?? `terminal-${Date.now()}`;
    const termTab: Tab = { id: termId, title: 'Terminal', type: 'terminal', dirty: false, terminalHistory: '' };
    setOpenTabs((prev) => (activeId ? prev.map((t) => (t.id === activeId ? termTab : t)) : [...prev, termTab]));
    setNoteContents((prev) => { const next = { ...prev }; delete next[termId]; return next; });
    if (!activeId) setLayout(Layout.simplify(Layout.addTabToPane(layoutRef.current, focused.id, termId)));
  }, []);

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
    // The dropped tab's button unmounts as the layout rebuilds, so its
    // onDragEnd never fires. Clear the drag flag here, otherwise the webview
    // wrapper stays at pointer-events:none and the page becomes unclickable.
    setIsDraggingTab(false);
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
    if (tab.type === 'chat') return;
    void electronAPI.popOutTab({ tab, screenX, screenY }).then((res) => {
      if (!res?.popped) return;
      // Remove from this window but DON'T stop a terminal's PTY — the popped-out
      // window reconnects to the same live shell by id (terminal:start reuses it).
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
    if (focused.tabIds.length >= 2 && focused.activeTabId) {
      const next = Layout.splitPaneWithTab(layoutRef.current, focused.id, 'right', focused.activeTabId);
      setLayout(next);
      const landed = Layout.findPaneByTab(next, focused.activeTabId);
      if (landed) setFocusedPaneId(landed.id);
    } else {
      const id = `web-${Date.now()}`;
      setOpenTabs((prev) => [...prev, { id, title: 'New Tab', type: 'web', dirty: false, url: 'about:blank' }]);
      const next = Layout.splitPaneWithTab(layoutRef.current, focused.id, 'right', id);
      setLayout(next);
      const landed = Layout.findPaneByTab(next, id);
      if (landed) setFocusedPaneId(landed.id);
    }
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

  /** Render the content of a tab inside its pane (web tabs draw via the overlay). */
  const renderTabContent = useCallback((tab: Tab): ReactNode => {
    if (tab.type === 'web') return null;
    if (tab.type === 'terminal') {
      return (
        <TerminalWindow
          id={tab.id}
          history={tab.terminalHistory || ''}
          onHistoryChange={(history) => updateTerminalHistory(tab.id, history)}
          onTitleChange={(title) => updateTabTitle(tab.id, title)}
        />
      );
    }
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
        onOpenWebView={handleOpenWebView}
        onLinkifySelection={(term, context) => handleLinkifyTerm(term, context, entry?.note?.title)}
      />
    );
  }, [chatState.messagesByChannel, chatState.registeredAgentsByChannel, currentUsername, runningChatAgents, handleCancelChatRun, handleRegisterChatAgent, handleRemoveChatAgent, handleSendChatMessage, noteContents, notes, updateTerminalHistory, updateTabTitle, handleNoteChange, saveNoteTab, renameNoteTab, handleExecuteDirective, handleOpenWebView, handleLinkifyTerm, openNote]);

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

  const webTabs = openTabs.filter((t) => t.type === 'web');

  return (
    <main
      className="app-shell"
      style={{
        display: 'grid',
        gridTemplateColumns: `${sidebarOpen ? `${sidebarWidth}px` : '0px'} minmax(0, 1fr)`,
        height: '100vh',
        overflow: 'hidden',
        position: 'relative',
        transition: isResizing ? 'none' : undefined,
      }}
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
          onSelectNote={(id) => openNote(id, 'replace')}
          onOpenNoteInNewTab={(id) => openNote(id)}
          onNewNote={handleCreateNote}
          onCreateChannel={handleCreateChannel}
          onNewNoteInFolder={handleCreateNoteInFolder}
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
      <div className="flex flex-col flex-1" style={{ height: '100%', overflow: 'hidden', gridColumn: 2 }}>
        <div className="workspace-toolbar" style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-surface)', padding: '4px 8px', gap: 4, borderBottom: '1px solid var(--border)' }}>
          {!sidebarOpen && (
            <button id="sidebar-expand-btn" className="btn-icon" onClick={() => setSidebarOpen(true)} title="Expand sidebar">
              <PanelLeftOpen size={16} />
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }} />
          {activeTab?.type !== 'terminal' && (
            <button className="btn-icon" onClick={handleUpgradeActiveTabToTerminal} title={activeTab ? 'Turn current tab into a terminal' : 'Open terminal'}>
              <SquareTerminal size={16} />
            </button>
          )}
        </div>

        <div ref={editorAreaRef} className="flex-1" style={{ position: 'relative', display: 'flex', overflow: 'hidden' }}>
          <PaneGrid
            node={layout}
            openTabs={openTabs}
            focusedPaneId={focusedPaneId}
            onFocusPane={setFocusedPaneId}
            onSelectTab={selectTabInPane}
            onCloseTab={closeTab}
            onNewTab={handleCreateWebTab}
            onDropTab={handleDropTab}
            onResize={handleResizeSplit}
            onDetachTab={handleDetachTab}
            onDragStateChange={setIsDraggingTab}
            registerPaneContent={registerPaneContent}
            renderContent={renderTabContent}
            onCreateChatNote={handleCreateChatNote}
          />

          {/* Persistent web tabs: every web tab stays mounted and is positioned
              over whichever pane currently shows it, so switching or tiling never
              reloads it. Hidden tabs sleep (muted, display:none). These render as
              direct children of the (position:relative) editor area rather than
              inside a pointer-events:none layer — Electron's <webview> guest does
              not receive mouse input when any ancestor has pointer-events:none,
              which made the page render but ignore every click. Each wrapper only
              covers its own pane, so empty regions fall through to PaneGrid. */}
          {webTabs.map((tab) => {
            const pane = Layout.findPaneByTab(layout, tab.id);
            const visible = Boolean(pane && pane.activeTabId === tab.id && paneRects[pane.id]);
            const rect = visible && pane ? paneRects[pane.id] : null;
            return (
              <div
                key={tab.id}
                style={{
                  position: 'absolute',
                  left: rect?.left ?? 0,
                  top: rect?.top ?? 0,
                  width: rect?.width ?? 0,
                  height: rect?.height ?? 0,
                  display: visible ? 'flex' : 'none',
                  flexDirection: 'column',
                  // During a tab drag, let drops pass through to the pane beneath.
                  pointerEvents: isDraggingTab ? 'none' : 'auto',
                }}
              >
                <WebView
                  tabId={tab.id}
                  url={tab.url || ''}
                  active={visible}
                  onNavigate={(url) => updateTabUrl(tab.id, url)}
                  onTitleChange={(title) => updateTabTitle(tab.id, title)}
                  isChatNote={tab.isChatNote}
                />
              </div>
            );
          })}
        </div>
      </div>

      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} vaultId={activeVaultId} onSelectNote={(id) => openNote(id)} />
      <CommandPalette open={commandPaletteOpen} onClose={() => setCommandPaletteOpen(false)} notes={notes} onSelectNote={(id) => openNote(id)} onCreateNote={handleCreateNote} />

      {notice && <div className="toast" role="status">{notice}</div>}
    </main>
  );
}
