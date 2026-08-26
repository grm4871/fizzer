import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { createChatAgentRegistrationId } from '../chat/shared';
import type {
  ChatAgentOption,
  ChatAgentRegistration,
  DesktopRunnerHealth,
  VaultAgent,
} from '../chat/types';
import {
  CUSTOM_MODEL_VALUE,
  modelFromPicker,
  ReasoningEffortSelect,
  resolveModelPicker,
} from './chatAgentPanelSupport';
export {
  CUSTOM_MODEL_VALUE,
  modelFromPicker,
  planUsageProviderId,
  ReasoningEffortSelect,
  resolveModelPicker,
  PlanUsageMeters,
  REASONING_EFFORTS,
} from './chatAgentPanelSupport';
import { ChatAgentToggle } from './ChatAgentToggle';
import { ChatAgentMemberPicker } from './ChatAgentMemberPicker';
import { useAgentRegistration, type AgentPanelMode } from './useAgentRegistration';

export type ChatAgentPanelHandle = {
  openMenu: () => void;
  toggleInvite: () => void;
  openMemberSettings: (registration: ChatAgentRegistration) => void;
  closeChrome: () => void;
};

export type ChatAgentRow = ChatAgentOption & { registration: ChatAgentRegistration };

export const ChatAgentPanel = forwardRef<ChatAgentPanelHandle, {
  channelId: string;
  currentUser: string;
  availableAgents: ChatAgentOption[];
  registeredAgents: ChatAgentRegistration[];
  registeredAgentRows: ChatAgentRow[];
  vaultAgents: VaultAgent[];
  runnerHealth?: DesktopRunnerHealth | null;
  onRegisterAgent: (channelId: string, registration: ChatAgentRegistration) => void;
  onRemoveAgent: (channelId: string, registrationId: string) => void;
  onUpsertVaultAgent?: (agent: Partial<VaultAgent> & { agentId: string }) => Promise<VaultAgent | void> | VaultAgent | void;
  onDeleteVaultAgent?: (vaultAgentId: string) => Promise<void> | void;
  onDeleteAgentProfile?: (vaultAgentId: string) => Promise<void> | void;
  onAddVaultAgentToChannel?: (channelId: string, vaultAgentId: string) => Promise<void> | void;
  onInviteUser: (channelId: string, username: string) => Promise<void>;
  canManageRegistration: (registration: ChatAgentRegistration) => boolean;
  onExpandRail: () => void;
  onChromeChange: (chrome: { inviteOpen: boolean; agentMenuOpen: boolean }) => void;
  children?: ReactNode;
}>(function ChatAgentPanel({
  channelId,
  currentUser,
  availableAgents,
  registeredAgents,
  registeredAgentRows,
  vaultAgents,
  runnerHealth = null,
  onRegisterAgent,
  onRemoveAgent,
  onUpsertVaultAgent,
  onDeleteVaultAgent,
  onDeleteAgentProfile,
  onAddVaultAgentToChannel,
  onInviteUser,
  canManageRegistration,
  onExpandRail,
  onChromeChange,
  children,
}, ref) {
  const [agentPanelMode, setAgentPanelMode] = useState<AgentPanelMode>('picker');
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteUsername, setInviteUsername] = useState('');
  const [inviteStatus, setInviteStatus] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [editingRegistrationId, setEditingRegistrationId] = useState<string | null>(null);
  const [agentFormError, setAgentFormError] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  const [customModel, setCustomModel] = useState('');
  const createDefaultAgentForm = useCallback((): ChatAgentRegistration => {
    return {
      id: createChatAgentRegistrationId(),
      agentId: '',
      displayName: '',
      avatarUrl: '',
      mention: '',
      model: '',
      reasoningEffort: '',
      priorityServiceTier: false,
      cwd: '',
      contextPrompt: '',
      taggableByAgents: false,
      replyToEveryMessage: false,
      orchestrator: false,
      pingableByOthers: false,
      yolo: false,
      hermesProfile: '',
      hermesSafeMode: false,
      conversationId: '',
    };
  }, []);
  const [agentForm, setAgentForm] = useState<ChatAgentRegistration>(() => ({
    id: createChatAgentRegistrationId(),
    agentId: '',
    displayName: '',
    avatarUrl: '',
    mention: '',
    model: '',
    reasoningEffort: '',
    priorityServiceTier: false,
    cwd: '',
    contextPrompt: '',
    taggableByAgents: false,
    replyToEveryMessage: false,
    orchestrator: false,
    pingableByOthers: false,
    yolo: false,
    hermesProfile: '',
    hermesSafeMode: false,
    conversationId: '',
  }));
  const activeFormAgent = availableAgents.find((agent) => agent.id === agentForm.agentId);
  const channelVaultAgentIds = useMemo(
    () => new Set(registeredAgents.map((r) => r.vaultAgentId).filter(Boolean) as string[]),
    [registeredAgents],
  );

  useEffect(() => {
    onChromeChange({ inviteOpen, agentMenuOpen });
  }, [agentMenuOpen, inviteOpen, onChromeChange]);

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
    onExpandRail();
    if (agentMenuOpen) {
      setAgentMenuOpen(false);
      setEditingRegistrationId(null);
      setAgentFormError('');
      setAgentPanelMode('picker');
      return;
    }
    setAgentPanelMode(vaultAgents.length > 0 || onAddVaultAgentToChannel ? 'picker' : 'create');
    openAgentEditor();
  }

  function toggleInvite() {
    onExpandRail();
    setInviteStatus('');
    setInviteOpen((value) => !value);
  }

  function editRegisteredAgent(event: React.MouseEvent, registration: ChatAgentRegistration) {
    event.stopPropagation();
    onExpandRail();
    setAgentPanelMode('edit-member');
    openAgentEditor(registration);
  }

  function openMemberSettings(registration: ChatAgentRegistration) {
    onExpandRail();
    setAgentFormError('');
    const agent = availableAgents.find((option) => option.id === registration.agentId);
    const { choice, custom } = resolveModelPicker(agent, registration.model);
    setModelChoice(choice);
    setCustomModel(custom);
    setAgentForm({ ...registration, model: modelFromPicker(choice, custom) });
    setEditingRegistrationId(registration.id);
    setAgentPanelMode('edit-member');
    setAgentMenuOpen(true);
  }

  function editVaultIdentity(event: React.MouseEvent, registration: ChatAgentRegistration) {
    event.stopPropagation();
    setAgentPanelMode('edit-identity');
    openAgentEditor(registration);
  }

  function openVaultIdentity(event: React.MouseEvent, identity: VaultAgent) {
    event.stopPropagation();
    const member = registeredAgents.find((registration) => registration.vaultAgentId === identity.id);
    const registration: ChatAgentRegistration = {
      ...(member || createDefaultAgentForm()),
      vaultAgentId: identity.id,
      agentId: identity.agentId,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      mention: identity.mention,
      model: identity.model,
      cwd: identity.cwd,
      contextPrompt: identity.contextPrompt,
      hermesProfile: identity.hermesProfile || '',
      hermesSafeMode: identity.hermesSafeMode === true,
    };
    setAgentPanelMode('edit-identity');
    openAgentEditor(registration);
  }

  function closeChrome() {
    setAgentMenuOpen(false);
    setInviteOpen(false);
    setEditingRegistrationId(null);
    setAgentPanelMode('picker');
    setAgentFormError('');
  }

  useImperativeHandle(ref, () => ({
    openMenu: openAgentMenu,
    toggleInvite,
    openMemberSettings,
    closeChrome,
  }), [agentMenuOpen, availableAgents, createDefaultAgentForm, onAddVaultAgentToChannel, onExpandRail, vaultAgents.length]);

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
          hermesProfile: va.hermesProfile || '',
          hermesSafeMode: va.hermesSafeMode === true,
          conversationId: '',
        });
      }
      setAgentMenuOpen(false);
      setAgentPanelMode('picker');
    } catch (error) {
      setAgentFormError(error instanceof Error ? error.message : 'Could not add agent');
    }
  }

  const submitAgentRegistration = useAgentRegistration({
    channelId,
    agentPanelMode,
    agentForm,
    modelChoice,
    customModel,
    vaultAgents,
    registeredAgents,
    setAgentFormError,
    setAgentMenuOpen,
    setEditingRegistrationId,
    setAgentPanelMode,
    onRegisterAgent,
    onUpsertVaultAgent,
    onAddVaultAgentToChannel,
  });

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

  return (
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

        {children}

        <ChatAgentMemberPicker
          currentUser={currentUser}
          registeredAgentRows={registeredAgentRows}
          editingRegistrationId={editingRegistrationId}
          agentMenuOpen={agentMenuOpen}
          pickerOpen={agentMenuOpen && agentPanelMode === 'picker'}
          runnerHealth={runnerHealth}
          canManageRegistration={canManageRegistration}
          onEdit={editRegisteredAgent}
          onRemoveAgent={(event, registration) => {
            event.stopPropagation();
            if (registration.vaultAgentId && onDeleteVaultAgent) void onDeleteVaultAgent(registration.vaultAgentId);
            else onRemoveAgent(channelId, registration.id);
          }}
          vaultAgents={vaultAgents}
          channelVaultAgentIds={channelVaultAgentIds}
          agentFormError={agentFormError}
          onAddVaultAgent={(id) => { void addVaultAgentFromPicker(id); }}
          onEditVaultIdentity={openVaultIdentity}
          onDeleteAgentProfile={onDeleteAgentProfile
            ? (id) => { void onDeleteAgentProfile(id); }
            : undefined}
          onCancelPicker={() => {
            setAgentMenuOpen(false);
            setAgentPanelMode('picker');
            setAgentFormError('');
          }}
          onCreateNew={() => {
            setAgentPanelMode('create');
            openAgentEditor();
          }}
        />

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
                <option value="" disabled>Choose a backend…</option>
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
              {agentForm.agentId === 'hermes' && (
                <>
                  <label>
                    Hermes profile
                    <input
                      value={agentForm.hermesProfile}
                      placeholder="Default local profile"
                      spellCheck={false}
                      onChange={(event) => setAgentForm((value) => ({ ...value, hermesProfile: event.target.value }))}
                    />
                    <span className="chat-agent-field-hint">Uses this named profile from the agent owner's local Hermes installation.</span>
                  </label>
                  <ChatAgentToggle
                    checked={agentForm.hermesSafeMode}
                    onChange={(event) => setAgentForm((value) => ({ ...value, hermesSafeMode: event.target.checked }))}
                    name="Hermes safe mode"
                    hint="Disables user configuration, memory, plugins, AGENTS.md, and MCP integrations."
                  />
                </>
              )}
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

    </>
  );
});
