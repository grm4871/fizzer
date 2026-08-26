import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { ChatAgentRegistration, VaultAgent } from '../chat/types';
import type { ChatState, PersistedWorkspace } from '../chat/session';
import type { NoteEntry } from './useAppState';
import type { Note, NoteSummary, User, VaultMember } from '../api';
import { api } from '../api';
import * as Layout from '../layout/tree';
import type { Tab } from '../components/TabBar';
import { CHAT_NOTE_MARKER, createChatAgentRegistrationId } from '../chat/shared';
import { agentLabel, normalizeChatCwd, type AgentId } from '../chat/agents';
import { normalizeMention } from '../chat/mentions';
import { newId } from '../chat/runBlocks';

export interface ChatChannelOperationsOptions {
  activeVaultIdRef: MutableRefObject<string | null>; notesRef: MutableRefObject<NoteSummary[]>; user: User | null;
  acceptedInviteTokenRef: MutableRefObject<string | null>; vaultWorkspacesRef: MutableRefObject<Record<string, PersistedWorkspace>>; vaultNoteContentsRef: MutableRefObject<Record<string, Record<string, NoteEntry>>>;
  layoutRef: MutableRefObject<Layout.LayoutNode>; focusedPaneRef: MutableRefObject<Layout.PaneNode>; ensureChatChannelLoaded: (id: string) => void;
  setOpenTabs: Dispatch<SetStateAction<Tab[]>>; setLayout: Dispatch<SetStateAction<Layout.LayoutNode>>; setFocusedPaneId: Dispatch<SetStateAction<string>>; setNoteContents: Dispatch<SetStateAction<Record<string, NoteEntry>>>;
  setNotice: Dispatch<SetStateAction<string | null>>; setChatState: Dispatch<SetStateAction<ChatState>>; setVaultAgents: Dispatch<SetStateAction<VaultAgent[]>>;
  loadVaults: () => Promise<void>; loadVaultData: (id: string, options?: { soft?: boolean }) => Promise<void>; switchVaultWorkspace: (id: string | null) => void;
  loadVaultAgents: (id: string) => Promise<void>; loadChatAgentMembers: (id: string, notes: NoteSummary[]) => Promise<void>; persistChatAgentMemberToServer: (vault: string, channel: string, registration: ChatAgentRegistration) => Promise<ChatAgentRegistration | null>; removeChatAgentMemberOnServer: (vault: string, channel: string, registration: string) => Promise<void>;
}

/** Coordinates channel creation, invitation redemption, and vault/channel agent membership. */
export function useChatChannelOperations(options: ChatChannelOperationsOptions) {
  const {
    activeVaultIdRef, notesRef, user, acceptedInviteTokenRef, vaultWorkspacesRef, vaultNoteContentsRef,
    layoutRef, focusedPaneRef, ensureChatChannelLoaded, setOpenTabs, setLayout, setFocusedPaneId, setNoteContents,
    setNotice, setChatState, setVaultAgents, loadVaults, loadVaultData, switchVaultWorkspace, loadVaultAgents,
    loadChatAgentMembers, persistChatAgentMemberToServer, removeChatAgentMemberOnServer,
  } = options;
  const openChatChannel = useCallback((channelId: string, title: string, mode: 'open' | 'replace' = 'open') => {
    const name = title.trim() || 'chat';
    const tab: Tab = { id: channelId, title: name, type: 'chat', dirty: false };

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
      ensureChatChannelLoaded(channelId);
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
    ensureChatChannelLoaded(channelId);
  }, [ensureChatChannelLoaded]);

  const acceptVaultInvite = useCallback(async (token: string): Promise<boolean> => {
    try {
      const data = await api<{ vaultId: string; name: string; role: string; alreadyMember?: boolean }>(
        `/api/vault-invites/${encodeURIComponent(token)}/accept`,
        { method: 'POST' },
      );
      await loadVaults();
      switchVaultWorkspace(data.vaultId);
      await loadVaultData(data.vaultId);
      setNotice(data.alreadyMember
        ? `You already have access to ${data.name}.`
        : `Joined ${data.name} as ${data.role}.`);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not accept invite link');
      return false;
    }
  }, [loadVaultData, loadVaults, switchVaultWorkspace]);

  const handleJoinVault = useCallback(async (inviteLink: string): Promise<boolean> => {
    try {
      const parsed = new URL(inviteLink, window.location.origin);
      const match = parsed.pathname.match(/^\/vault-invite\/([^/]+)$/);
      if (!match) throw new Error('Paste a valid vault invite link');
      return await acceptVaultInvite(decodeURIComponent(match[1]));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Paste a valid vault invite link');
      return false;
    }
  }, [acceptVaultInvite]);

  // Redeem a vault share link. Unlike the chat invite above this joins the
  // vault itself, so the whole vault appears in the switcher.
  useEffect(() => {
    const match = window.location.pathname.match(/^\/vault-invite\/([^/]+)$/);
    const token = match ? decodeURIComponent(match[1]) : '';
    if (!token || !user || acceptedInviteTokenRef.current === token) return;
    acceptedInviteTokenRef.current = token;
    (async () => {
      if (await acceptVaultInvite(token)) {
        window.history.replaceState({}, '', '/app.html');
      }
    })();
  }, [acceptVaultInvite, user]);

  const handleCreateChannel = useCallback(async (folderId: string | null = null) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return undefined;
    try {
      const data = await api<{ note: Note }>(`/api/vaults/${vaultId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ title: 'new-channel', content: CHAT_NOTE_MARKER, folder_id: folderId ?? undefined }),
      });
      await loadVaultData(vaultId);
      if (activeVaultIdRef.current !== vaultId) return undefined;
      openChatChannel(data.note.id, data.note.title);
      return { id: data.note.id, title: data.note.title };
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create channel');
      return undefined;
    }
  }, [loadVaultData, openChatChannel]);

  const handleRegisterChatAgent = useCallback((channelId: string, registration: ChatAgentRegistration, sourceVaultId?: string) => {
    const normalized = {
      ...registration,
      id: registration.id || createChatAgentRegistrationId(),
      vaultAgentId: registration.vaultAgentId || '',
      displayName: registration.displayName.trim() || agentLabel(registration.agentId as AgentId),
      mention: normalizeMention(registration.mention || registration.agentId),
      cwd: normalizeChatCwd(registration.cwd),
      orchestrator: registration.orchestrator === true,
      replyToEveryMessage: registration.replyToEveryMessage === true || registration.orchestrator === true,
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
    // A run may finish after the user has switched vaults. Persist session
    // adoption back to the vault that launched it, never whichever vault is
    // currently visible.
    const vaultId = sourceVaultId || activeVaultIdRef.current;
    if (vaultId) {
      void persistChatAgentMemberToServer(vaultId, channelId, normalized).then((saved) => {
        if (saved) {
          setChatState((prev) => ({
            ...prev,
            registeredAgentsByChannel: {
              ...prev.registeredAgentsByChannel,
              [channelId]: [
                ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => (
                  item.id !== normalized.id
                  && item.id !== saved.id
                  && (!saved.vaultAgentId || item.vaultAgentId !== saved.vaultAgentId)
                )),
                saved,
              ],
            },
          }));
        }
        void loadVaultAgents(vaultId);
        // Re-project vault-wide so every room picks up the new member.
        void loadChatAgentMembers(vaultId, notesRef.current);
      });
    }
  }, [persistChatAgentMemberToServer, loadVaultAgents, loadChatAgentMembers]);

  const handleRemoveChatAgent = useCallback((channelId: string, registrationId: string) => {
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: (prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== registrationId),
      },
    }));
    const vaultId = activeVaultIdRef.current;
    if (vaultId) {
      void removeChatAgentMemberOnServer(vaultId, channelId, registrationId).then(() => {
        void loadVaultAgents(vaultId);
      });
    }
  }, [removeChatAgentMemberOnServer, loadVaultAgents]);

  const handleUpsertVaultAgent = useCallback(async (input: Partial<VaultAgent> & { agentId: string }) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ agent: VaultAgent }>(`/api/vaults/${vaultId}/vault-agents`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
    const agent = data.agent;
    setVaultAgents((prev) => {
      const rest = prev.filter((a) => a.id !== agent.id);
      return [...rest, agent].sort((a, b) => (a.displayName || a.mention).localeCompare(b.displayName || b.mention));
    });
    // Sync identity into any loaded channel memberships
    setChatState((prev) => {
      const next = { ...prev.registeredAgentsByChannel };
      for (const [chId, regs] of Object.entries(next)) {
        next[chId] = regs.map((r) => (
          r.vaultAgentId === agent.id
            ? {
                ...r,
                agentId: agent.agentId,
                displayName: agent.displayName,
                avatarUrl: agent.avatarUrl,
                mention: agent.mention,
                model: agent.model,
                cwd: agent.cwd,
                contextPrompt: agent.contextPrompt,
              }
            : r
        ));
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
    // PUT vault-agents projects into every channel server-side; refresh client
    // maps so no room keeps a stale shorter roster.
    void loadChatAgentMembers(vaultId, notesRef.current);
    return agent;
  }, [loadChatAgentMembers]);

  const handleDeleteVaultAgent = useCallback(async (vaultAgentId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    await api(`/api/vaults/${vaultId}/vault-agents/${vaultAgentId}`, { method: 'DELETE' });
    setChatState((prev) => {
      const next: Record<string, ChatAgentRegistration[]> = {};
      for (const [chId, regs] of Object.entries(prev.registeredAgentsByChannel)) {
        next[chId] = regs.filter((r) => r.vaultAgentId !== vaultAgentId);
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
  }, []);

  const handleDeleteAgentProfile = useCallback(async (vaultAgentId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    await api(`/api/vaults/${vaultId}/vault-agents/${vaultAgentId}/profile`, { method: 'DELETE' });
    setVaultAgents((prev) => prev.filter((a) => a.id !== vaultAgentId));
    setChatState((prev) => {
      const next: Record<string, ChatAgentRegistration[]> = {};
      for (const [chId, regs] of Object.entries(prev.registeredAgentsByChannel)) {
        next[chId] = regs.filter((r) => r.vaultAgentId !== vaultAgentId);
      }
      return { ...prev, registeredAgentsByChannel: next };
    });
  }, []);

  const handleAddVaultAgentToChannel = useCallback(async (channelId: string, vaultAgentId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    const data = await api<{ registration: ChatAgentRegistration }>(
      `/api/vaults/${vaultId}/channels/${channelId}/agents/from-vault`,
      {
        method: 'POST',
        body: JSON.stringify({ vaultAgentId }),
      },
    );
    const reg = data.registration;
    setChatState((prev) => ({
      ...prev,
      registeredAgentsByChannel: {
        ...prev.registeredAgentsByChannel,
        [channelId]: [
          ...(prev.registeredAgentsByChannel[channelId] ?? []).filter((item) => item.id !== reg.id && item.vaultAgentId !== vaultAgentId),
          reg,
        ],
      },
    }));
    void loadVaultAgents(vaultId);
    // from-vault only seats the agent on one channel; reload all rooms so the
    // vault-wide projection (server ensure) lands in client state everywhere.
    void loadChatAgentMembers(vaultId, notesRef.current);
  }, [loadVaultAgents, loadChatAgentMembers]);

  const handleInviteChatUser = useCallback(async (_channelId: string, username: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) throw new Error('No active vault');
    await api(`/api/vaults/${vaultId}/members`, {
      method: 'POST',
      body: JSON.stringify({ username, role: 'editor' }),
    });
    await loadVaultData(vaultId, { soft: true });
  }, [loadVaultData]);

  const handleRemoveChatParticipant = useCallback(async (_channelId: string, username: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId) return;
    const data = await api<{ members: VaultMember[] }>(`/api/vaults/${vaultId}/members`);
    const member = data.members.find((item) => item.username.toLowerCase() === username.toLowerCase());
    if (!member) throw new Error('Vault member not found');
    await api(`/api/vaults/${vaultId}/members/${member.userId}`, { method: 'DELETE' });
    await loadVaultData(vaultId, { soft: true });
  }, [loadVaultData]);

  const handleLeaveChatChannel = useCallback(async (_channelId: string) => {
    const vaultId = activeVaultIdRef.current;
    if (!vaultId || !user || !window.confirm('Leave this vault?')) return;
    await api(`/api/vaults/${vaultId}/members/${user.id}`, { method: 'DELETE' });
    switchVaultWorkspace(null);
    const { [vaultId]: _removedWorkspace, ...remainingWorkspaces } = vaultWorkspacesRef.current;
    const { [vaultId]: _removedDrafts, ...remainingDrafts } = vaultNoteContentsRef.current;
    vaultWorkspacesRef.current = remainingWorkspaces;
    vaultNoteContentsRef.current = remainingDrafts;
    await loadVaults();
  }, [user, loadVaults, switchVaultWorkspace]);
  return {
    openChatChannel, handleJoinVault, handleCreateChannel, handleRegisterChatAgent,
    handleRemoveChatAgent, handleUpsertVaultAgent, handleDeleteVaultAgent,
    handleDeleteAgentProfile, handleAddVaultAgentToChannel, handleInviteChatUser,
    handleRemoveChatParticipant, handleLeaveChatChannel,
  };
}
