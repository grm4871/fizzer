import { useEffect, useRef, useState } from 'react';
import { Camera, KeyRound, Trash2, X } from 'lucide-react';
import { api, type User } from '../api';

export function AccountSettings({ user, onClose, onUserChanged, onSessionChanged }: {
  user: User;
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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
      </section>
    </div>
  );
}
