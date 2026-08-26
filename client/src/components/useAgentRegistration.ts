import { createChatAgentRegistrationId } from '../chat/shared';
import { normalizeMention } from '../chat/mentions';
import type { ChatAgentRegistration, VaultAgent } from '../chat/types';
import { modelFromPicker } from './chatAgentPanelSupport';

export type AgentPanelMode = 'picker' | 'create' | 'edit-member' | 'edit-identity';
type Options = {
  channelId: string;
  agentPanelMode: AgentPanelMode;
  agentForm: ChatAgentRegistration;
  modelChoice: string;
  customModel: string;
  vaultAgents: VaultAgent[];
  registeredAgents: ChatAgentRegistration[];
  setAgentFormError: (value: string) => void;
  setAgentMenuOpen: (value: boolean) => void;
  setEditingRegistrationId: (value: string | null) => void;
  setAgentPanelMode: (value: AgentPanelMode) => void;
  onRegisterAgent: (channelId: string, registration: ChatAgentRegistration) => void;
  onUpsertVaultAgent?: (agent: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent | void> | VaultAgent | void;
  onAddVaultAgentToChannel?: (channelId: string, vaultAgentId: string) => Promise<void> | void;
};

export function useAgentRegistration({
  channelId, agentPanelMode, agentForm, modelChoice, customModel, vaultAgents, registeredAgents,
  setAgentFormError, setAgentMenuOpen, setEditingRegistrationId, setAgentPanelMode,
  onRegisterAgent, onUpsertVaultAgent, onAddVaultAgentToChannel,
}: Options) {
  return async function submitAgentRegistration(event: React.FormEvent) {
    event.preventDefault();
    if (!agentForm.agentId) return;
    const mention = normalizeMention(agentForm.mention || '');
    if (!mention && agentPanelMode !== 'edit-member') {
      setAgentFormError('Choose a unique @ handle.');
      return;
    }
    if (agentPanelMode !== 'edit-member' && mention) {
      if (vaultAgents.some((va) => va.id !== agentForm.vaultAgentId && normalizeMention(va.mention) === mention)) {
        setAgentFormError(`@${mention} is already used by another vault agent.`);
        return;
      }
      if (registeredAgents.some((registration) => registration.id !== agentForm.id && registration.vaultAgentId !== agentForm.vaultAgentId && normalizeMention(registration.mention) === mention)) {
        setAgentFormError(`@${mention} is already used in this channel.`);
        return;
      }
    }
    const model = modelFromPicker(modelChoice, customModel);
    if (!model && agentPanelMode !== 'edit-member') {
      setAgentFormError('Choose a model or enter a custom model ID.');
      return;
    }
    const persistMembership = (overrides: Partial<ChatAgentRegistration> = {}) => {
      onRegisterAgent(channelId, {
        ...agentForm, ...overrides,
        id: agentForm.id || createChatAgentRegistrationId(),
        displayName: agentForm.displayName.trim(), mention: overrides.mention ?? mention,
        model: overrides.model ?? model, cwd: agentForm.cwd.trim(), contextPrompt: agentForm.contextPrompt.trim(),
      });
    };
    try {
      if (agentPanelMode === 'edit-identity' && onUpsertVaultAgent && agentForm.vaultAgentId) {
        await onUpsertVaultAgent({ id: agentForm.vaultAgentId, agentId: agentForm.agentId, displayName: agentForm.displayName.trim(), mention, model, cwd: agentForm.cwd.trim(), contextPrompt: agentForm.contextPrompt.trim(), hermesProfile: agentForm.hermesProfile.trim(), hermesSafeMode: agentForm.hermesSafeMode });
        if (registeredAgents.some((registration) => registration.id === agentForm.id)) persistMembership();
      } else if (agentPanelMode === 'create' && onUpsertVaultAgent) {
        const va = await onUpsertVaultAgent({ agentId: agentForm.agentId, displayName: agentForm.displayName.trim() || agentForm.agentId, mention, model, cwd: agentForm.cwd.trim(), contextPrompt: agentForm.contextPrompt.trim(), hermesProfile: agentForm.hermesProfile.trim(), hermesSafeMode: agentForm.hermesSafeMode });
        const vaultAgentId = va?.id || agentForm.vaultAgentId || '';
        if (vaultAgentId && onAddVaultAgentToChannel) await onAddVaultAgentToChannel(channelId, vaultAgentId);
        persistMembership({ vaultAgentId });
      } else {
        if (agentForm.vaultAgentId && onUpsertVaultAgent) await onUpsertVaultAgent({ id: agentForm.vaultAgentId, agentId: agentForm.agentId, displayName: agentForm.displayName.trim(), mention: mention || agentForm.mention, model, cwd: agentForm.cwd.trim(), contextPrompt: agentForm.contextPrompt.trim(), hermesProfile: agentForm.hermesProfile.trim(), hermesSafeMode: agentForm.hermesSafeMode });
        persistMembership({ mention: mention || agentForm.mention, model: model || agentForm.model });
      }
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentPanelMode('picker');
      setAgentFormError('');
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : 'Could not save agent');
    }
  };
}
