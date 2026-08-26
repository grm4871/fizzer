import { X } from 'lucide-react';
import type { ChatAgentOption, ChatAgentRegistration, DesktopRunnerHealth, VaultAgent } from '../chat/types';
import { ChatAvatar } from './ChatAvatar';
import { PlanUsageMeters, planUsageProviderId } from './chatAgentPanelSupport';

export type ChatAgentMemberPickerProps = {
  currentUser: string;
  registeredAgentRows: (ChatAgentOption & { registration: ChatAgentRegistration })[];
  editingRegistrationId: string | null;
  agentMenuOpen: boolean;
  runnerHealth?: DesktopRunnerHealth | null;
  pickerOpen: boolean;
  canManageRegistration: (registration: ChatAgentRegistration) => boolean;
  onEdit: (event: React.MouseEvent, registration: ChatAgentRegistration) => void;
  onRemoveAgent: (event: React.MouseEvent, registration: ChatAgentRegistration) => void;
  vaultAgents: VaultAgent[];
  channelVaultAgentIds: Set<string>;
  agentFormError: string;
  onAddVaultAgent: (id: string) => void;
  onEditVaultIdentity: (event: React.MouseEvent, agent: VaultAgent) => void;
  onDeleteAgentProfile?: (id: string) => void;
  onCancelPicker: () => void;
  onCreateNew: () => void;
};

export function ChatAgentMemberPicker({
  currentUser, registeredAgentRows, editingRegistrationId, agentMenuOpen, runnerHealth, pickerOpen,
  canManageRegistration, onEdit, onRemoveAgent, vaultAgents, channelVaultAgentIds, agentFormError,
  onAddVaultAgent, onEditVaultIdentity, onDeleteAgentProfile, onCancelPicker, onCreateNew,
}: ChatAgentMemberPickerProps) {
  return <>
    <div className="chat-agent-section">
      <div className="chat-users-title">Agents in this vault</div>
      {registeredAgentRows.length === 0 && <div className="chat-runs-empty">No agents in this vault yet</div>}
      {registeredAgentRows.map((agent) => {
        const selectedModel = agent.registration.model || agent.models[0]?.id || '';
        const isEditing = editingRegistrationId === agent.registration.id && agentMenuOpen;
        const canManage = canManageRegistration(agent.registration);
        const planUsage = canManage ? runnerHealth?.planUsage?.[planUsageProviderId(agent.registration.agentId)] || null : null;
        return <div className={`chat-user chat-agent-user${agent.registration.orchestrator ? ' is-supervisor' : ''}${isEditing ? ' is-editing' : ''}`} key={agent.registration.id}>
          <button type="button" className="chat-agent-edit-btn" disabled={!canManage} onClick={canManage ? (event) => onEdit(event, agent.registration) : undefined} title={canManage ? 'Channel settings for this agent' : 'Only the agent owner can edit its settings'}>
            <ChatAvatar name={agent.registration.displayName || agent.label} kind="agent" avatarUrl={agent.registration.avatarUrl} size="sm" />
            {agent.registration.orchestrator && <span className="sr-only">Channel supervisor</span>}
            <div className="chat-user-copy"><div className="chat-user-copy-head"><strong>{agent.registration.displayName || agent.label}</strong>{planUsage && <PlanUsageMeters usage={planUsage} decal />}</div><span className="chat-user-handle">@{agent.registration.mention || agent.id}</span><span className="chat-user-role">{selectedModel || 'no model'}</span></div>
          </button>
          {canManage && <button type="button" className="chat-remove-agent" onClick={(event) => onRemoveAgent(event, agent.registration)} title="Remove agent from this vault"><X size={12} /></button>}
        </div>;
      })}
    </div>
    {pickerOpen && <div className="chat-agent-menu" onClick={(event) => event.stopPropagation()}>
      <div className="chat-agent-menu-heading">Vault agents</div>
      {vaultAgents.length === 0 ? <div className="chat-runs-empty">No vault agents yet</div> : vaultAgents.map((va) => {
        const inChannel = channelVaultAgentIds.has(va.id);
        const canManage = va.ownerUsername === currentUser;
        return <div key={va.id} className={`chat-vault-pick-row${inChannel ? ' is-in-channel' : ''}`}>
          <button type="button" className="chat-vault-pick-btn" disabled={inChannel || !canManage} onClick={() => { if (!inChannel) onAddVaultAgent(va.id); }} title={inChannel ? 'Already in this vault' : canManage ? 'Add to this vault' : 'Only the agent owner can add it'}>
            <ChatAvatar name={va.displayName || va.mention} kind="agent" avatarUrl={va.avatarUrl} size="sm" /><span className="chat-user-copy"><strong>{va.displayName || va.mention}</strong><span>@{va.mention} · {va.model || va.agentId}{va.ownerUsername ? ` · ${va.ownerUsername}'s agent` : ''}{inChannel ? ' · in vault' : ''}</span></span>
          </button>
          {canManage && <button type="button" className="chat-vault-edit-agent" title={`Edit @${va.mention} vault identity`} onClick={(event) => onEditVaultIdentity(event, va)}>Edit identity</button>}
          {onDeleteAgentProfile && canManage && <button type="button" className="chat-remove-agent" title="Permanently delete agent profile" onClick={(event) => { event.stopPropagation(); if (window.confirm(`Permanently delete @${va.mention} from your agent profiles and every vault?`)) onDeleteAgentProfile(va.id); }}><X size={12} /></button>}
        </div>;
      })}
      {agentFormError && <div className="chat-agent-form-error">{agentFormError}</div>}
      <div className="chat-agent-menu-actions"><button type="button" onClick={onCancelPicker}>Cancel</button><button type="button" onClick={onCreateNew}>Create new…</button></div>
    </div>}
  </>;
}
