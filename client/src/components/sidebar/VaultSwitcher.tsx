import { useEffect, useMemo, useState } from 'react';
import { canRenameVault, isSharedVault, type Vault } from '../../api';
import { Check, ChevronDownIcon, Compass, LogIn, Pencil, Plus, Settings, Trash2, X } from 'lucide-react';
import { FizzerMark } from '../FizzerMark';

interface VaultSwitcherProps {
  vaults: Vault[];
  activeVaultId: string | null;
  updateCounts: { byVault: Record<string, number> };
  onSelectVault: (id: string) => void;
  onCreateVault: (name: string) => Promise<boolean>;
  onRenameVault: (id: string, name: string) => Promise<boolean>;
  onDeleteVault: (id: string) => Promise<boolean>;
  onManageVault: (id: string) => void;
  onJoinVault: (inviteLink: string) => Promise<boolean>;
  onOpenPublicVaults: () => void;
}

interface VaultSwitcherTriggerProps {
  activeVault: Vault | undefined;
  updateCount: number;
  open: boolean;
  onToggle: () => void;
}

function countLabel(count: number): string {
  return count >= 99 ? '99+' : String(count);
}

export function VaultSwitcher({
  vaults,
  activeVaultId,
  updateCounts,
  onSelectVault,
  onCreateVault,
  onRenameVault,
  onDeleteVault,
  onManageVault,
  onJoinVault,
  onOpenPublicVaults,
}: VaultSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [creatingVault, setCreatingVault] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [creatingVaultBusy, setCreatingVaultBusy] = useState(false);
  const [renamingVaultId, setRenamingVaultId] = useState<string | null>(null);
  const [renameVaultName, setRenameVaultName] = useState('');
  const [renameVaultBusy, setRenameVaultBusy] = useState(false);
  const [joiningVault, setJoiningVault] = useState(false);
  const [vaultInviteLink, setVaultInviteLink] = useState('');
  const [joiningVaultBusy, setJoiningVaultBusy] = useState(false);
  const activeVault = useMemo(() => vaults.find((vault) => vault.id === activeVaultId), [vaults, activeVaultId]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const submitNewVault = async () => {
    const name = newVaultName.trim();
    if (!name || creatingVaultBusy) return;
    setCreatingVaultBusy(true);
    const created = await onCreateVault(name);
    setCreatingVaultBusy(false);
    if (!created) return;
    setNewVaultName('');
    setCreatingVault(false);
    setOpen(false);
  };

  const startRenameVault = (vault: Vault) => {
    setCreatingVault(false);
    setJoiningVault(false);
    setRenamingVaultId(vault.id);
    setRenameVaultName(vault.name);
  };

  const cancelRenameVault = () => {
    setRenamingVaultId(null);
    setRenameVaultName('');
  };

  const submitRenameVault = async () => {
    const name = renameVaultName.trim();
    if (!renamingVaultId || !name || renameVaultBusy) return;
    setRenameVaultBusy(true);
    const renamed = await onRenameVault(renamingVaultId, name);
    setRenameVaultBusy(false);
    if (renamed) cancelRenameVault();
  };

  const submitJoinVault = async () => {
    const inviteLink = vaultInviteLink.trim();
    if (!inviteLink || joiningVaultBusy) return;
    setJoiningVaultBusy(true);
    const joined = await onJoinVault(inviteLink);
    setJoiningVaultBusy(false);
    if (!joined) return;
    setVaultInviteLink('');
    setJoiningVault(false);
    setOpen(false);
  };

  return (
    <>
      <VaultSwitcherTrigger
        activeVault={activeVault}
        updateCount={activeVault ? updateCounts.byVault[activeVault.id] || 0 : 0}
        open={open}
        onToggle={() => setOpen((current) => !current)}
      />
      {open && (
        <div className="vault-switcher-menu" role="dialog" aria-modal="true" aria-label="Vault workspace">
          <div className="vault-switcher-shell">
            <div className="vault-switcher-heading">
              <div><span>Vault workspace</span><small>{vaults.length} {vaults.length === 1 ? 'vault' : 'vaults'}</small></div>
              <button type="button" className="vault-switcher-close" onClick={() => setOpen(false)} aria-label="Close vault workspace"><X size={18} /></button>
            </div>
            <section className="vault-switcher-section" aria-labelledby="vault-switcher-your-vaults">
              <h2 className="vault-switcher-section-title" id="vault-switcher-your-vaults">Your vaults</h2>
              <div className="vault-switcher-grid" role="menu" aria-label="Your vaults">
                {vaults.map((vault) => renamingVaultId === vault.id ? (
                  <div className="vault-switcher-create-form vault-switcher-rename-form" key={vault.id}>
                    <strong>Rename {vault.name}</strong>
                    <input autoFocus value={renameVaultName} placeholder="Vault name" aria-label={`Rename ${vault.name}`} maxLength={80} disabled={renameVaultBusy} onChange={(event) => setRenameVaultName(event.target.value)} onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitRenameVault();
                      if (event.key === 'Escape') cancelRenameVault();
                    }} />
                    <div className="vault-switcher-form-actions">
                      <button type="button" onClick={cancelRenameVault}>Cancel</button>
                      <button type="button" disabled={!renameVaultName.trim() || renameVaultBusy} onClick={() => void submitRenameVault()}>{renameVaultBusy ? 'Saving' : 'Save'}</button>
                    </div>
                  </div>
                ) : (
                  <VaultRow
                    key={vault.id}
                    vault={vault}
                    active={vault.id === activeVaultId}
                    updateCount={updateCounts.byVault[vault.id] || 0}
                    onSelect={() => { onSelectVault(vault.id); setOpen(false); }}
                    onRename={() => startRenameVault(vault)}
                    onDelete={() => {
                      if (!window.confirm(`Permanently delete “${vault.name}” and all of its notes? This cannot be undone.`)) return;
                      void onDeleteVault(vault.id).then((deleted) => { if (deleted) setOpen(false); });
                    }}
                    onManage={() => { setOpen(false); onManageVault(vault.id); }}
                  />
                ))}
              </div>
            </section>
            <section className="vault-switcher-section" aria-labelledby="vault-switcher-manage">
              <h2 className="vault-switcher-section-title" id="vault-switcher-manage">Explore and manage vaults</h2>
              <div className="vault-switcher-action-grid" role="menu" aria-label="Explore and manage vaults">
                <button type="button" role="menuitem" className="vault-switcher-action vault-switcher-discover" onClick={() => { setOpen(false); onOpenPublicVaults(); }}>
                  <span className="vault-switcher-action-icon" aria-hidden="true"><Compass size={28} /></span>
                  <span className="vault-switcher-copy"><strong>Browse public vaults</strong><small>Find open communities</small></span>
                </button>
                {creatingVault ? (
                  <VaultForm title="New vault" value={newVaultName} placeholder="Vault name" label="New vault name" busy={creatingVaultBusy} busyLabel="Creating" submitLabel="Create" onChange={setNewVaultName} onSubmit={submitNewVault} onCancel={() => { setCreatingVault(false); setNewVaultName(''); }} />
                ) : (
                  <button type="button" role="menuitem" className="vault-switcher-action vault-switcher-create" onClick={() => { setJoiningVault(false); setCreatingVault(true); }}>
                    <span className="vault-switcher-action-icon" aria-hidden="true"><Plus size={28} /></span>
                    <span className="vault-switcher-copy"><strong>New vault</strong><small>Start a private workspace</small></span>
                  </button>
                )}
                {joiningVault ? (
                  <VaultForm title="Join vault" value={vaultInviteLink} placeholder="Paste vault invite link" label="Vault invite link" busy={joiningVaultBusy} busyLabel="Joining" submitLabel="Join" onChange={setVaultInviteLink} onSubmit={submitJoinVault} onCancel={() => { setJoiningVault(false); setVaultInviteLink(''); }} />
                ) : (
                  <button type="button" role="menuitem" className="vault-switcher-action vault-switcher-join" onClick={() => { setCreatingVault(false); setJoiningVault(true); }}>
                    <span className="vault-switcher-action-icon" aria-hidden="true"><LogIn size={28} /></span>
                    <span className="vault-switcher-copy"><strong>Join vault</strong><small>Use an invite link</small></span>
                  </button>
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </>
  );
}

function VaultSwitcherTrigger({ activeVault, updateCount, open, onToggle }: VaultSwitcherTriggerProps) {
  return (
    <>
      <button type="button" className="vault-name" onClick={onToggle} title="Open vault workspace" aria-label={`Vault switcher; current vault ${activeVault?.name || 'Fizzer'}`} aria-expanded={open}>
        <span className="vault-icon" aria-hidden="true"><FizzerMark size={24} /></span>
        <span className="vault-name-copy"><span className="vault-name-text">{activeVault?.name || 'Fizzer'}</span><span className="vault-name-meta">{activeVault ? isSharedVault(activeVault) ? `${activeVault.memberCount} members · ${activeVault.role || 'member'}` : 'Private · only you' : 'Your workspace'}</span></span>
        <ChevronDownIcon className="vault-name-chevron" size={14} aria-hidden="true" />
      </button>
      {updateCount > 0 && <span className="vault-update-badge" aria-label={`${countLabel(updateCount)} unread updates`}>{countLabel(updateCount)}</span>}
    </>
  );
}

interface VaultRowProps {
  vault: Vault;
  active: boolean;
  updateCount: number;
  onSelect: () => void;
  onRename: () => void;
  onDelete: () => void;
  onManage: () => void;
}

function VaultRow({ vault, active, updateCount, onSelect, onRename, onDelete, onManage }: VaultRowProps) {
  const canEdit = canRenameVault(vault);
  return (
    <div className="vault-switcher-row">
      <button type="button" role="menuitemradio" aria-checked={active} className={active ? 'is-active' : ''} onClick={onSelect}>
        <span className="vault-switcher-art" aria-hidden="true"><span className="vault-switcher-icon"><FizzerMark size={38} /></span></span>
        <span className="vault-switcher-copy"><span className="vault-switcher-title-line"><strong>{vault.name}</strong>{updateCount > 0 && <span className="vault-switcher-update-badge" aria-label={`${countLabel(updateCount)} unread updates`}>{countLabel(updateCount)}</span>}{active && <Check className="vault-switcher-check" size={16} aria-hidden="true" />}</span><small>{isSharedVault(vault) ? `${vault.memberCount} members · ${vault.role || 'member'}` : 'Private · only you'}</small></span>
      </button>
      {canEdit && <button type="button" className="vault-switcher-rename" title={`Rename ${vault.name}`} aria-label={`Rename ${vault.name}`} onClick={(event) => { event.stopPropagation(); onRename(); }}><Pencil size={14} aria-hidden="true" /></button>}
      {canEdit && <button type="button" className="vault-switcher-delete" title={`Delete ${vault.name}`} aria-label={`Delete ${vault.name}`} onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 size={14} aria-hidden="true" /></button>}
      <button type="button" className="vault-switcher-manage" title={`Manage ${vault.name}`} aria-label={`Manage ${vault.name}`} onClick={(event) => { event.stopPropagation(); onManage(); }}><Settings size={14} aria-hidden="true" /></button>
    </div>
  );
}

interface VaultFormProps {
  title: string;
  value: string;
  placeholder: string;
  label: string;
  busy: boolean;
  busyLabel: string;
  submitLabel: string;
  onChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  onCancel: () => void;
}

function VaultForm({ title, value, placeholder, label, busy, busyLabel, submitLabel, onChange, onSubmit, onCancel }: VaultFormProps) {
  return (
    <div className="vault-switcher-create-form vault-switcher-action-form">
      <strong>{title}</strong>
      <input autoFocus value={value} placeholder={placeholder} aria-label={label} disabled={busy} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void onSubmit(); if (event.key === 'Escape') onCancel(); }} />
      <div className="vault-switcher-form-actions"><button type="button" onClick={onCancel}>Cancel</button><button type="button" disabled={!value.trim() || busy} onClick={() => void onSubmit()}>{busy ? busyLabel : submitLabel}</button></div>
    </div>
  );
}
