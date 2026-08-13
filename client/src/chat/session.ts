/**
 * localStorage session + legacy chat-state migration for the workspace shell.
 */

import * as Layout from '../layout/tree';
import type { LayoutNode } from '../layout/tree';
import type { Tab } from '../components/TabBar';
import type { ChatAgentRegistration, ChatMessage } from './types';
import { agentLabel, normalizeChatCwd, type AgentId } from './agents';

export const SESSION_STORAGE_KEY = 'cascade_session';
export const CHAT_STORAGE_KEY = 'cascade_chat_state';

/** One vault's independently-restored workspace. Note bodies are re-fetched. */
export interface PersistedWorkspace {
  openTabs: Tab[];
  layout: LayoutNode;
  focusedPaneId: string;
}

/**
 * Session persisted to localStorage. The top-level workspace mirrors the active
 * vault for backwards compatibility; `workspacesByVault` is authoritative once
 * present and keeps tabs from leaking between vaults.
 */
export interface PersistedSession extends PersistedWorkspace {
  activeVaultId: string | null;
  workspacesByVault: Record<string, PersistedWorkspace>;
}

export interface ChatState {
  agentModelsByAgent: Record<string, string>;
  registeredAgentsByChannel: Record<string, ChatAgentRegistration[]>;
}

export const emptyChatState = (): ChatState => ({
  agentModelsByAgent: {},
  registeredAgentsByChannel: {},
});

function sanitizeRestoredTabs(value: unknown): Tab[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tab): tab is Partial<Tab> => Boolean(tab) && typeof tab === 'object')
    .map((tab): Tab | null => {
      if (typeof tab.id !== 'string' || typeof tab.title !== 'string') return null;
      if (tab.type === 'chat') {
        return { id: tab.id, title: tab.title.replace(/^#/, '') || 'Channel', type: 'chat', dirty: false };
      }
      if (tab.type === 'note') {
        return { id: tab.id, title: tab.title, type: 'note', dirty: false };
      }
      if (tab.type === 'superkanban') {
        return { id: tab.id, title: tab.title || 'Superkanban', type: 'superkanban', dirty: false };
      }
      if (tab.type === 'new') {
        return { id: tab.id, title: 'New tab', type: 'new', dirty: false };
      }
      return null;
    })
    .filter((tab): tab is Tab => Boolean(tab));
}

export function emptyWorkspace(): PersistedWorkspace {
  const pane = Layout.createPane();
  return { openTabs: [], layout: pane, focusedPaneId: pane.id };
}

export function emptySession(): PersistedSession {
  return { activeVaultId: null, workspacesByVault: {}, ...emptyWorkspace() };
}

type PersistedWorkspaceInput = Partial<PersistedWorkspace> & {
  activeTabId?: string;
  splitTabId?: string;
};

function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false;
  const node = value as Partial<LayoutNode>;
  if (node.type === 'pane') {
    return typeof node.id === 'string'
      && Array.isArray(node.tabIds)
      && node.tabIds.every((id) => typeof id === 'string')
      && (node.activeTabId === null || typeof node.activeTabId === 'string');
  }
  if (node.type === 'split') {
    return typeof node.id === 'string'
      && (node.direction === 'row' || node.direction === 'column')
      && Array.isArray(node.children)
      && node.children.length > 0
      && node.children.every(isLayoutNode)
      && Array.isArray(node.sizes)
      && node.sizes.every((size) => typeof size === 'number' && Number.isFinite(size));
  }
  return false;
}

function restoreWorkspace(value: unknown): PersistedWorkspace {
  const parsed = value && typeof value === 'object' ? value as PersistedWorkspaceInput : {};
  const openTabs = sanitizeRestoredTabs(parsed.openTabs);
  const validIds = new Set(openTabs.map((tab) => tab.id));

  let layout: LayoutNode;
  if (isLayoutNode(parsed.layout)) {
    layout = Layout.ensureValid(parsed.layout, validIds);
  } else {
    // Migrate the pre-grid single/split-pane session into a layout tree.
    const activeTabId = typeof parsed.activeTabId === 'string' ? parsed.activeTabId : null;
    const splitTabId = typeof parsed.splitTabId === 'string' ? parsed.splitTabId : null;
    layout = Layout.migrateFromLegacy(openTabs.map((tab) => tab.id), activeTabId, splitTabId);
  }

  const focusedPaneId =
    typeof parsed.focusedPaneId === 'string' && Layout.findPane(layout, parsed.focusedPaneId)
      ? parsed.focusedPaneId
      : Layout.getFirstPane(layout).id;

  return { openTabs, layout, focusedPaneId };
}

/** Restore and migrate an already-parsed localStorage value. */
export function restorePersistedSession(value: unknown): PersistedSession {
  if (!value || typeof value !== 'object') return emptySession();
  const parsed = value as PersistedWorkspaceInput & {
    activeVaultId?: unknown;
    workspacesByVault?: unknown;
  };
  const activeVaultId = typeof parsed.activeVaultId === 'string' ? parsed.activeVaultId : null;
  const workspacesByVault: Record<string, PersistedWorkspace> = {};

  if (parsed.workspacesByVault && typeof parsed.workspacesByVault === 'object' && !Array.isArray(parsed.workspacesByVault)) {
    for (const [vaultId, workspace] of Object.entries(parsed.workspacesByVault)) {
      if (!vaultId) continue;
      workspacesByVault[vaultId] = restoreWorkspace(workspace);
    }
  }

  // One-release migration: the old schema stored only the active workspace at
  // the top level. Adopt it for that vault the first time the new schema loads.
  if (activeVaultId && !workspacesByVault[activeVaultId]) {
    workspacesByVault[activeVaultId] = restoreWorkspace(parsed);
  }

  const activeWorkspace = activeVaultId
    ? workspacesByVault[activeVaultId] ?? emptyWorkspace()
    : emptyWorkspace();
  return { activeVaultId, workspacesByVault, ...activeWorkspace };
}

export function loadPersistedSession(): PersistedSession {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return emptySession();
    return restorePersistedSession(JSON.parse(raw));
  } catch {
    return emptySession();
  }
}

export function readLegacyLocalChatAgentMembers(): Record<string, ChatAgentRegistration[]> {
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
            vaultAgentId: typeof registration.vaultAgentId === 'string' ? registration.vaultAgentId : '',
            agentId: registration.agentId,
            displayName: typeof registration.displayName === 'string' && registration.displayName.trim()
              ? registration.displayName.trim()
              : agentLabel(registration.agentId as AgentId),
            avatarUrl: typeof registration.avatarUrl === 'string' ? registration.avatarUrl : '',
            mention,
            model: typeof registration.model === 'string' ? registration.model : '',
            reasoningEffort: typeof registration.reasoningEffort === 'string' ? registration.reasoningEffort : '',
            priorityServiceTier: registration.priorityServiceTier === true,
            cwd: typeof registration.cwd === 'string' ? normalizeChatCwd(registration.cwd) : '',
            contextPrompt: typeof registration.contextPrompt === 'string' ? registration.contextPrompt : '',
            taggableByAgents: typeof registration.taggableByAgents === 'boolean' ? registration.taggableByAgents : true,
            replyToEveryMessage: typeof registration.replyToEveryMessage === 'boolean' ? registration.replyToEveryMessage : false,
            orchestrator: typeof registration.orchestrator === 'boolean' ? registration.orchestrator : false,
            pingableByOthers: typeof registration.pingableByOthers === 'boolean' ? registration.pingableByOthers : false,
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

export function readLegacyLocalChatMessages(): Record<string, ChatMessage[]> {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return {};
    // Legacy shape: messages used to be persisted in this key before they moved
    // to the in-memory message store, so parse the raw record directly.
    const parsed = JSON.parse(raw) as { messagesByChannel?: Record<string, unknown> };
    if (!parsed.messagesByChannel || typeof parsed.messagesByChannel !== 'object') return {};
    const messagesByChannel: Record<string, ChatMessage[]> = {};
    for (const [channelId, messages] of Object.entries(parsed.messagesByChannel)) {
      if (!Array.isArray(messages)) continue;
      messagesByChannel[channelId] = messages
        .filter((message): message is ChatMessage =>
          Boolean(message) &&
          typeof message === 'object' &&
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
          forwardedFrom: message.forwardedFrom &&
            typeof message.forwardedFrom === 'object' &&
            typeof message.forwardedFrom.channelName === 'string' &&
            typeof message.forwardedFrom.author === 'string'
            ? message.forwardedFrom
            : undefined,
        }));
    }
    return messagesByChannel;
  } catch {
    return {};
  }
}

export function loadChatState(): ChatState {
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

    return { agentModelsByAgent, registeredAgentsByChannel: {} };
  } catch {
    return emptyChatState();
  }
}
