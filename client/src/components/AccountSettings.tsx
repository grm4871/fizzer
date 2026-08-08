import { useEffect, useRef, useState } from 'react';
import { Camera, Globe2, KeyRound, Link as LinkIcon, LogOut, Trash2, Users, X } from 'lucide-react';
import { api, type User, type VaultMember, type VaultRole } from '../api';

type AssignableRole = Exclude<VaultRole, 'owner'>;
type PublicJoinPolicy = 'open' | 'request' | 'invite';
type PublicVaultSettings = {
  visibility: 'private' | 'public';
  summary: string;
  topics: string[];
  guidelines: string;
  homeNoteId: string | null;
  joinPolicy: PublicJoinPolicy;
};
type PublicHomeNoteChoice = { id: string; title: string };
type PublicJoinRequest = {
  id: number;
  userId: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  status: 'pending';
  createdAt: string;
};

const ROLE_HELP: Record<VaultRole, string> = {
  owner: 'Owns the vault. Cannot be removed or demoted here.',
  editor: 'Can read and write notes, folders, and chats.',
  viewer: 'Read-only access.',
};

export function AccountSettings({ user, vaultId, vaultName, onClose, onUserChanged, onSessionChanged, onMembershipChanged }: {
  user: User;
  vaultId?: string | null;
  vaultName?: string;
  onClose: () => void;
  onUserChanged: (user: User) => void;
  onSessionChanged: () => void;
  /** Lets the app refresh the vault list so the switcher's shared badge stays accurate. */
  onMembershipChanged?: () => void;
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
  const [memberRole, setMemberRole] = useState<AssignableRole>('editor');
  const [memberState, setMemberState] = useState('');
  const [memberBusy, setMemberBusy] = useState(false);
  const [inviteLinkCopied, setInviteLinkCopied] = useState(false);
  const [vaultVisibility, setVaultVisibility] = useState<'private' | 'public'>('private');
  const [publicSummary, setPublicSummary] = useState('');
  const [publicTopics, setPublicTopics] = useState('');
  const [publicGuidelines, setPublicGuidelines] = useState('');
  const [publicHomeNoteId, setPublicHomeNoteId] = useState('');
  const [publicJoinPolicy, setPublicJoinPolicy] = useState<PublicJoinPolicy>('open');
  const [publicHomeNotes, setPublicHomeNotes] = useState<PublicHomeNoteChoice[]>([]);
  const [publicJoinRequests, setPublicJoinRequests] = useState<PublicJoinRequest[]>([]);

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
      const [result, visibility] = await Promise.all([
        api<{ members: VaultMember[]; role: VaultRole | null }>(`/api/vaults/${vaultId}/members`),
        api<PublicVaultSettings>(`/api/vaults/${vaultId}/visibility`),
      ]);
      setMembers(result.members || []);
      setMyRole(result.role || null);
      setVaultVisibility(visibility.visibility);
      setPublicSummary(visibility.summary || '');
      setPublicTopics((visibility.topics || []).join(', '));
      setPublicGuidelines(visibility.guidelines || '');
      setPublicHomeNoteId(visibility.homeNoteId || '');
      setPublicJoinPolicy(visibility.joinPolicy || 'open');
      if (result.role === 'owner') {
        const [homeNotes, joinRequests] = await Promise.all([
          api<{ notes: PublicHomeNoteChoice[] }>(`/api/vaults/${vaultId}/public-home-notes`),
          api<{ requests: PublicJoinRequest[] }>(`/api/vaults/${vaultId}/join-requests`),
        ]);
        setPublicHomeNotes(homeNotes.notes || []);
        setPublicJoinRequests(joinRequests.requests || []);
      } else {
        setPublicHomeNotes([]);
        setPublicJoinRequests([]);
      }
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not load vault members');
    }
  };

  useEffect(() => {
    void loadMembers();
  }, [vaultId]);

  const canManageMembers = myRole === 'owner';
  const canManage = (member: VaultMember) => canManageMembers
    && member.role !== 'owner'
    && member.userId !== user.id;
  const assignableRoles: AssignableRole[] = ['editor', 'viewer'];
  const canLeave = Boolean(myRole) && myRole !== 'owner';

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
      onMembershipChanged?.();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not add member');
    } finally {
      setMemberBusy(false);
    }
  };

  /**
   * Share link for someone whose username you don't know, or who has no
   * account yet — inviting by username needs both.
   */
  const copyInviteLink = async () => {
    if (!vaultId) return;
    setMemberBusy(true);
    setMemberState('');
    try {
      const { url } = await api<{ url: string }>(`/api/vaults/${vaultId}/invite-link`, {
        method: 'POST',
        body: JSON.stringify({ role: memberRole }),
      });
      try {
        await navigator.clipboard.writeText(url);
        setInviteLinkCopied(true);
        window.setTimeout(() => setInviteLinkCopied(false), 2500);
        setMemberState(`${memberRole} invite link copied — valid for 7 days`);
      } catch {
        // Clipboard is blocked in some webviews; the link is useless unseen.
        setMemberState(url);
      }
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not create invite link');
    } finally {
      setMemberBusy(false);
    }
  };

  const saveDiscoverySettings = async (overrides: Partial<PublicVaultSettings> = {}) => {
    if (!vaultId || !canManageMembers) return;
    const visibility = overrides.visibility ?? vaultVisibility;
    const summary = overrides.summary ?? publicSummary;
    const topics = overrides.topics ?? publicTopics.split(',').map((topic) => topic.trim()).filter(Boolean);
    const guidelines = overrides.guidelines ?? publicGuidelines;
    const homeNoteId = overrides.homeNoteId !== undefined ? overrides.homeNoteId : (publicHomeNoteId || null);
    const joinPolicy = overrides.joinPolicy ?? publicJoinPolicy;
    setMemberBusy(true);
    setMemberState('');
    try {
      const body = overrides.visibility === 'private'
        ? { visibility: 'private' as const }
        : { visibility, summary, topics, guidelines, homeNoteId, joinPolicy };
      const result = await api<PublicVaultSettings>(`/api/vaults/${vaultId}/visibility`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
      setVaultVisibility(result.visibility);
      setPublicSummary(result.summary);
      setPublicTopics(result.topics.join(', '));
      setPublicGuidelines(result.guidelines);
      setPublicHomeNoteId(result.homeNoteId || '');
      setPublicJoinPolicy(result.joinPolicy);
      setMemberState(result.visibility === 'public' ? 'Public discovery profile saved.' : 'Discovery profile saved; vault is private.');
      if (result.joinPolicy !== 'request') setPublicJoinRequests([]);
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not update vault visibility');
    } finally {
      setMemberBusy(false);
    }
  };

  const reviewJoinRequest = async (request: PublicJoinRequest, action: 'approve' | 'reject') => {
    if (!vaultId || !canManageMembers) return;
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/join-requests/${request.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      setPublicJoinRequests((current) => current.filter((item) => item.id !== request.id));
      setMemberState(action === 'approve' ? `Added @${request.username} as viewer` : `Declined @${request.username}'s request`);
      if (action === 'approve') {
        await loadMembers();
        onMembershipChanged?.();
      }
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not review join request');
    } finally {
      setMemberBusy(false);
    }
  };

  const changeMemberRole = async (target: VaultMember, role: AssignableRole) => {
    if (!vaultId || target.role === 'owner') return;
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/members/${target.userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      });
      setMemberState(`@${target.username} is now ${role}`);
      await loadMembers();
      onMembershipChanged?.();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not update role');
    } finally {
      setMemberBusy(false);
    }
  };

  const removeMember = async (target: VaultMember) => {
    if (!vaultId || target.role === 'owner') return;
    if (!window.confirm(`Remove @${target.username} from ${vaultName || 'this vault'}? They lose access to its notes and chats.`)) return;
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/members/${target.userId}`, { method: 'DELETE' });
      setMemberState(`Removed @${target.username}`);
      await loadMembers();
      onMembershipChanged?.();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not remove member');
    } finally {
      setMemberBusy(false);
    }
  };

  // Any non-owner member may remove themselves; the vault disappears from their switcher.
  const leaveVault = async () => {
    if (!vaultId || !canLeave) return;
    if (!window.confirm(`Leave ${vaultName || 'this vault'}? You lose access until someone invites you back.`)) return;
    setMemberBusy(true);
    setMemberState('');
    try {
      await api(`/api/vaults/${vaultId}/members/${user.id}`, { method: 'DELETE' });
      onMembershipChanged?.();
      onClose();
    } catch (error) {
      setMemberState(error instanceof Error ? error.message : 'Could not leave vault');
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
            <div className="account-section-title"><Users size={15} /><strong>Vault sharing</strong></div>
            <p className="account-settings-lede">
              <strong>{vaultName || 'This vault'}</strong> ·{' '}
              {members.length > 1
                ? `shared with ${members.length - 1} other ${members.length === 2 ? 'person' : 'people'}`
                : 'private to you'}
              {' · you are '}<strong>{myRole || 'a member'}</strong>
            </p>
            {canManageMembers && (
              <div className="account-public-discovery">
                <div className="account-vault-visibility">
                  <Globe2 size={15} aria-hidden="true" />
                  <label>
                    <input
                      type="checkbox"
                      checked={vaultVisibility === 'public'}
                      disabled={memberBusy}
                      onChange={(event) => void saveDiscoverySettings({ visibility: event.target.checked ? 'public' : 'private' })}
                    />
                    List this vault publicly
                  </label>
                </div>
                <label>
                  Public summary
                  <textarea value={publicSummary} maxLength={240} rows={2} onChange={(event) => setPublicSummary(event.target.value)} placeholder="What is this vault for?" />
                  <small>{publicSummary.length}/240</small>
                </label>
                <label>
                  Topics
                  <input value={publicTopics} onChange={(event) => setPublicTopics(event.target.value)} placeholder="research, design systems" />
                  <small>1–5 comma-separated topics. Topics are normalized when saved.</small>
                </label>
                <label>
                  Community guidelines
                  <textarea value={publicGuidelines} maxLength={2000} rows={4} onChange={(event) => setPublicGuidelines(event.target.value)} placeholder="Set expectations before someone joins." />
                  <small>{publicGuidelines.length}/2000</small>
                </label>
                <label>
                  Curated home note preview
                  <select value={publicHomeNoteId} onChange={(event) => setPublicHomeNoteId(event.target.value)}>
                    <option value="">No home note preview</option>
                    {publicHomeNotes.map((note) => <option key={note.id} value={note.id}>{note.title}</option>)}
                  </select>
                  <small>Only a sanitized preview of this listed non-chat note appears before membership.</small>
                </label>
                <label>
                  Join policy
                  <select value={publicJoinPolicy} onChange={(event) => setPublicJoinPolicy(event.target.value as PublicJoinPolicy)}>
                    <option value="open">Open — anyone can join as viewer</option>
                    <option value="request">Request — owner approval required</option>
                    <option value="invite">Invite only — no self-join</option>
                  </select>
                  <small>Public discovery never grants editor access. Promote viewers deliberately below.</small>
                </label>
                <div className="account-settings-actions">
                  <button type="button" disabled={memberBusy} onClick={() => void saveDiscoverySettings()}>Save discovery profile</button>
                </div>
              </div>
            )}
            {canManageMembers && (publicJoinPolicy === 'request' || publicJoinRequests.length > 0) && (
              <div className="account-join-requests">
                <strong>Join requests</strong>
                {publicJoinRequests.map((request) => (
                  <div key={request.id}>
                    <span>{request.displayName || request.username} <small>@{request.username}</small></span>
                    <button type="button" disabled={memberBusy} onClick={() => void reviewJoinRequest(request, 'reject')}>Decline</button>
                    <button type="button" disabled={memberBusy} onClick={() => void reviewJoinRequest(request, 'approve')}>Approve as viewer</button>
                  </div>
                ))}
                {!publicJoinRequests.length && <small className="account-settings-hint">No pending requests.</small>}
              </div>
            )}
            <ul className="account-vault-members">
              {members.map((member) => (
                <li key={member.userId}>
                  <div>
                    <strong>
                      {member.displayName || member.username}
                      {member.userId === user.id && <em className="account-vault-you"> (you)</em>}
                    </strong>
                    <span>@{member.username}</span>
                  </div>
                  {canManage(member) ? (
                    <div className="account-vault-member-actions">
                      <select
                        aria-label={`Role for @${member.username}`}
                        value={member.role}
                        disabled={memberBusy}
                        onChange={(event) => void changeMemberRole(member, event.target.value as AssignableRole)}
                      >
                        {assignableRoles.map((role) => (
                          <option key={role} value={role}>{role}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={memberBusy}
                        onClick={() => void removeMember(member)}
                        title={`Remove @${member.username}`}
                        aria-label={`Remove @${member.username}`}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ) : (
                    <span className="account-vault-role" title={ROLE_HELP[member.role]}>{member.role}</span>
                  )}
                </li>
              ))}
            </ul>
            {canManageMembers ? (
              <div className="account-vault-invite">
                <input
                  value={memberUsername}
                  aria-label="Invite by username"
                  placeholder="username"
                  onChange={(event) => setMemberUsername(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void inviteMember(); }}
                  autoComplete="off"
                />
                <select aria-label="Invite role" value={memberRole} onChange={(event) => setMemberRole(event.target.value as AssignableRole)}>
                  {assignableRoles.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </select>
                <button type="button" disabled={memberBusy || !memberUsername.trim()} onClick={() => void inviteMember()}>
                  {memberBusy ? 'Working' : 'Invite'}
                </button>
              </div>
            ) : (
              <small className="account-settings-hint">Only the owner can invite, change, or remove members.</small>
            )}
            {canManageMembers && <small className="account-settings-hint">{ROLE_HELP[memberRole]}</small>}
            {canManageMembers && (
              <div className="account-settings-actions">
                <button type="button" disabled={memberBusy} onClick={() => void copyInviteLink()}>
                  <LinkIcon size={13} /> {inviteLinkCopied ? 'Link copied' : `Copy ${memberRole} invite link`}
                </button>
              </div>
            )}
            {canLeave && (
              <div className="account-settings-actions">
                <button type="button" className="account-vault-leave" disabled={memberBusy} onClick={() => void leaveVault()}>
                  <LogOut size={13} /> Leave vault
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
