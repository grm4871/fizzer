import { useEffect, useRef, useState } from 'react';
import { Camera, KeyRound, Trash2, Users, X } from 'lucide-react';
import { api, type User } from '../api';

type VaultRole = 'owner' | 'admin' | 'editor' | 'viewer';
type VaultMember = {
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  role: VaultRole;
  createdAt: string;
};

export function AccountSettings({ user, vaultId, vaultName, onClose, onUserChanged, onSessionChanged }: {
  user: User;
  vaultId?: string | null;
  vaultName?: string;
  onClose: () => void;
  onUserChanged: (user: User) => void;
  onSessionChanged: () => void;
}) {
  const [displayName, setDisplayName] = useState(user.displayName || user.username);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [profileState, setProfileState] = useState('');
  const [passwordState, setPasswordState] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [members, setMembers] = useState<VaultMember[]>([]);
  const [myRole, setMyRole] = useState<VaultRole | null>(null);
  const [memberUsername, setMemberUsername] = useState('');
  const [memberRole, setMemberRole] = useState<Exclude<VaultRole, 'owner'>>('editor');
  const [memberState, setMemberState] = useState('');
  const [memberBusy, setMemberBusy] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const loadMembers = async () => {
    if (!vaultId) {
      setMembers([]);
      setMyRole(null);
      return;
    }
    try {
      const result = await api<{ members: VaultMember[]; role: VaultRole | null }>(`/api/vaults/${vaultId}/members`);
      setMembers(result.members || []);
      setMyRole(result.role || null);
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not load vault members');
    }
  };

  useEffect(() => {
    void loadMembers();
  }, [vaultId]);

  const canManageMembers = myRole === 'owner' || myRole === 'admin';

  const saveProfile = async () => {
    setBusy(true);
    setProfileState('');
    try {
      const result = await api<{ user: User }>('/api/me/profile', {
        method: 'PUT',
        body: JSON.stringify({ displayName, avatarUrl }),
      });
      onUserChanged(result.user);
      setProfileState('Profile saved');
    } catch (error) {
      setProfileState(error instanceof Error ? error.message : 'Could not save profile');
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async () => {
    setPasswordState('');
    if (newPassword !== confirmPassword) {
      setPasswordState('New passwords do not match');
      return;
    }
    setBusy(true);
    try {
      const result = await api<{ token: string }>('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      localStorage.setItem('docs_token', result.token);
      onSessionChanged();
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordState('Password changed');
      window.setTimeout(() => window.location.reload(), 350);
    } catch (error) {
      setPasswordState(error instanceof Error ? error.message : 'Could not change password');
    } finally {
      setBusy(false);
    }
  };

  const chooseAvatar = (file?: File) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      setProfileState('Choose a PNG, JPEG, WebP, or GIF image');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setProfileState('Profile picture must be smaller than 2 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setAvatarUrl(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const inviteMember = async () => {
    if (!vaultId) return;
    const username = memberUsername.trim().replace(/^@+/, '').toLowerCase();
    if (!username) {
      setMemberState('Enter a username');
      return;
    }
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/members`, {
        method: 'POST',
        body: JSON.stringify({ username, role: memberRole }),
      });
      setMemberUsername('');
      setMemberState(`Added @${username} as ${memberRole}`);
      await loadMembers();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not add member');
    } finally {
      setMemberBusy(false);
    }
  };

  const changeMemberRole = async (target: VaultMember, role: Exclude<VaultRole, 'owner'>) => {
    if (!vaultId || target.role === 'owner') return;
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/members/${target.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      await loadMembers();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not update role');
    } finally {
      setMemberBusy(false);
    }
  };

  const removeMember = async (target: VaultMember) => {
    if (!vaultId || target.role === 'owner') return;
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/members/${target.userId}`, { method: 'DELETE' });
      await loadMembers();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not remove member');
    } finally {
      setMemberBusy(false);
    }
  };

  return (
    <div className="overlay-backdrop account-settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="account-settings" role="dialog" aria-modal="true" aria-labelledby="account-settings-title">
        <header>
          <div>
            <h2 id="account-settings-title">Account</h2>
            <p>Profile changes appear anywhere you share a chat.</p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close account settings"><X size={17} /></button>
        </header>

        <div className="account-settings-section account-profile-section">
          <div className="account-avatar-preview">
            {avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{(displayName || user.username).charAt(0).toUpperCase()}</span>}
          </div>
          <div className="account-avatar-actions">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => chooseAvatar(event.target.files?.[0])} />
            <button type="button" onClick={() => fileRef.current?.click()}><Camera size={14} /> Choose picture</button>
            {avatarUrl && <button type="button" onClick={() => setAvatarUrl('')}><Trash2 size={14} /> Remove</button>}
            <small>PNG, JPEG, WebP, or GIF. Maximum 2 MB.</small>
          </div>
          <label>
            Display name
            <input value={displayName} maxLength={48} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
          </label>
          <label>
            Login handle
            <input value={user.username} disabled />
            <small>Handles stay stable so mentions, invites, ownership, and history remain reliable.</small>
          </label>
          {profileState && <div className="account-settings-status" role="status">{profileState}</div>}
          <div className="account-settings-actions"><button type="button" disabled={busy || !displayName.trim()} onClick={() => void saveProfile()}>Save profile</button></div>
        </div>

        <div className="account-settings-section">
          <div className="account-section-title"><KeyRound size={15} /><strong>Change password</strong></div>
          <label>Current password<input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></label>
          <label>New password<input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={8} /></label>
          <label>Confirm new password<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" minLength={8} /></label>
          {passwordState && <div className="account-settings-status" role="status">{passwordState}</div>}
          <div className="account-settings-actions"><button type="button" disabled={busy || !currentPassword || newPassword.length < 8 || !confirmPassword} onClick={() => void changePassword()}>Change password</button></div>
        </div>

        {vaultId && (
          <div className="account-settings-section">
            <div className="account-section-title"><Users size={15} /><strong>Vault members</strong></div>
            <p className="account-settings-lede">
              {vaultName || 'This vault'} · your role: <strong>{myRole || 'member'}</strong>
            </p>
            <ul className="account-vault-members">
              {members.map((member) => (
                <li key={member.userId}>
                  <div>
                    <strong>{member.displayName || member.username}</strong>
                    <span>@{member.username}</span>
                  </div>
                  {member.role === 'owner' || !canManageMembers ? (
                    <span className="account-vault-role">{member.role}</span>
                  ) : (
                    <div className="account-vault-member-actions">
                      <select
                        value={member.role}
                        disabled={memberBusy}
                        onChange={(event) => void changeMemberRole(member, event.target.value as Exclude<VaultRole, 'owner'>)}
                      >
                        <option value="admin">admin</option>
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                      <button type="button" disabled={memberBusy} onClick={() => void removeMember(member)} title="Remove member">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {canManageMembers && (
              <div className="account-vault-invite">
                <input
                  value={memberUsername}
                  placeholder="username"
                  onChange={(event) => setMemberUsername(event.target.value)}
                  autoComplete="off"
                />
                <select value={memberRole} onChange={(event) => setMemberRole(event.target.value as Exclude<VaultRole, 'owner'>)}>
                  <option value="editor">editor</option>
                  <option value="admin">admin</option>
                  <option value="viewer">viewer</option>
                </select>
                <button type="button" disabled={memberBusy || !memberUsername.trim()} onClick={() => void inviteMember()}>
                  {memberBusy ? 'Working' : 'Invite'}
                </button>
              </div>
            )}
            {memberState && <div className="account-settings-status" role="status">{memberState}</div>}
          </div>
        )}
      </section>
    </div>
  );
}
