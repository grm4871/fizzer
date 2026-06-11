import { useState } from 'react';
import { apiFetch } from '../utils/api';
import ConfirmUpdateSuccess from './ConfirmUpdateSuccess';

export type PermsMode = 'whitelist' | 'blacklist';

type FieldError = { status: 'idle' | 'error'; message: string };
const defaultError: FieldError = { status: 'idle', message: '' };

function getUserDisplayName(userId: string, usernames: Map<string, string>): string {
  return usernames.get(userId) || userId.slice(0, 8);
}

async function lookupUser(
  username: string,
  existingIds: string[],
  setUsernames: React.Dispatch<React.SetStateAction<Map<string, string>>>,
  currentUserId?: string,
  preventSelfAdd?: boolean,
): Promise<{ id: string } | { error: string }> {
  const trimmed = username.trim();
  if (!trimmed) return { error: '' };

  try {
    const res = await apiFetch(`/api/profile/${trimmed}`);
    if (!res.ok) return { error: `User "${trimmed}" not found` };

    const data = await res.json();
    const profile = data.profile || data;

    if (preventSelfAdd && currentUserId && profile.id === currentUserId) {
      return { error: `You can't blacklist yourself` };
    }

    if (existingIds.includes(profile.id)) {
      return { error: `User "${trimmed}" already added` };
    }

    setUsernames(prev => {
      const next = new Map(prev);
      next.set(profile.id, profile.username);
      return next;
    });

    return { id: profile.id };
  } catch {
    return { error: `Failed to lookup user "${trimmed}"` };
  }
}

export async function fetchUsernamesForIds(userIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const userId of userIds) {
    try {
      const res = await apiFetch(`/api/profile/id/${userId}`);
      if (res.ok) {
        const data = await res.json();
        const profile = data.profile || data;
        map.set(userId, profile.username || profile.displayName || userId.slice(0, 8));
      }
    } catch { /* ignore */ }
  }
  return map;
}

function PermissionTag({ userId, usernames, onRemove, isBlacklist = false }: {
  userId: string;
  usernames: Map<string, string>;
  onRemove: () => void;
  isBlacklist?: boolean;
}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.4em',
      background: isBlacklist ? '#3a1a1a' : '#2a2a2a',
      border: '1px solid ' + (isBlacklist ? '#5a3a3a' : '#555'),
      borderRadius: '3px', padding: '0.3em 0.5em', fontSize: '0.85em',
      color: isBlacklist ? '#e88888' : '#aaa'
    }}>
      {getUserDisplayName(userId, usernames)}
      <button onClick={onRemove} style={{
        background: 'none', border: 'none',
        color: isBlacklist ? '#888' : '#e88888',
        cursor: 'pointer', padding: '0', fontSize: '1em', fontWeight: 'bold', lineHeight: 1
      }}>×</button>
    </span>
  );
}

interface PermissionSectionProps {
  title: string;
  color: string;
  mode: PermsMode;
  onToggleMode: () => void;
  users: string[];
  onAddUser: (userId: string) => void;
  onRemoveUser: (userId: string) => void;
  blacklist: string[];
  onAddToBlacklist: (userId: string) => void;
  onRemoveFromBlacklist: (userId: string) => void;
  usernames: Map<string, string>;
  setUsernames: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  currentUserId: string;
  allowSelfBlacklist?: boolean;
}

export function PermissionSection({
  title, color, mode, onToggleMode,
  users, onAddUser, onRemoveUser,
  blacklist, onAddToBlacklist, onRemoveFromBlacklist,
  usernames, setUsernames, currentUserId, allowSelfBlacklist = false,
}: PermissionSectionProps) {
  const [input, setInput] = useState('');
  const [blacklistInput, setBlacklistInput] = useState('');
  const [error, setError] = useState<FieldError>(defaultError);
  const [blacklistError, setBlacklistError] = useState<FieldError>(defaultError);

  const isBlacklistMode = mode === 'blacklist';

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    if (isBlacklistMode) {
      const result = await lookupUser(blacklistInput, blacklist, setUsernames, currentUserId, !allowSelfBlacklist);
      if ('id' in result) { onAddToBlacklist(result.id); setBlacklistInput(''); setBlacklistError(defaultError); }
      else if (result.error) setBlacklistError({ status: 'error', message: result.error });
    } else {
      const result = await lookupUser(input, users, setUsernames);
      if ('id' in result) { onAddUser(result.id); setInput(''); setError(defaultError); }
      else if (result.error) setError({ status: 'error', message: result.error });
    }
  };

  return (
    <div style={{ marginBottom: '1.5em' }}>
      <label style={{ color, fontWeight: 'bold', display: 'block', marginBottom: '0.75em', textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '0.9rem' }}>
        {title}
      </label>

      <div style={{ paddingLeft: '24px' }}>
      <div style={{ display: 'flex', gap: '0.5em', marginBottom: '0.75em' }}>
        <button onClick={onToggleMode} style={{
          padding: '0.4em 0.8em',
          background: isBlacklistMode ? '#3a5a7a' : '#1a1a1a',
          border: '1px solid ' + (isBlacklistMode ? '#6b98c1' : '#555'),
          color: '#aaa', cursor: 'pointer', fontSize: '0.85em',
          whiteSpace: 'nowrap', fontWeight: isBlacklistMode ? 'bold' : 'normal'
        }}>
          {isBlacklistMode ? '✓ Everyone' : 'Everyone'}
        </button>
        {(() => {
          const isNoOne = !isBlacklistMode && users.length === 0;
          return (
            <button
              onClick={isNoOne ? undefined : onToggleMode}
              disabled={isNoOne}
              style={{
                padding: '0.4em 0.8em',
                background: isNoOne ? '#3a5a7a' : '#1a1a1a',
                border: '1px solid ' + (isNoOne ? '#6b98c1' : '#555'),
                color: '#aaa', fontSize: '0.85em', whiteSpace: 'nowrap',
                cursor: isNoOne ? 'default' : 'pointer',
                fontWeight: isNoOne ? 'bold' : 'normal'
              }}
            >
              {isNoOne ? '✓ No one' : 'No one'}
            </button>
          );
        })()}
      </div>

      {!isBlacklistMode && (
        <div style={{
          background: '#1a1a1a', border: '1px solid #555', borderRadius: '2px',
          padding: '0.5em', marginBottom: '0.75em', minHeight: '44px',
          display: 'flex', flexWrap: 'wrap', gap: '0.4em', alignItems: 'center'
        }}>
          {users.map(userId => <PermissionTag key={userId} userId={userId} usernames={usernames} onRemove={() => onRemoveUser(userId)} />)}
          <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Type a username" style={{ background: 'transparent', border: 'none', outline: 'none', color: '#aaa', fontSize: '0.85em', flex: 1, minWidth: '120px', padding: '0.3em' }} />
        </div>
      )}
      {!isBlacklistMode && error.status === 'error' && (
        <div style={{ marginBottom: '0.5em' }}>
          <ConfirmUpdateSuccess status="error" errorMessage={error.message} onDismiss={() => setError(defaultError)} />
        </div>
      )}

      {isBlacklistMode && (
        <div style={{ marginTop: '0.5em' }}>
          <label style={{ color: '#e88888', fontWeight: 'bold', display: 'block', marginBottom: '0.5em', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Blacklist
          </label>
          <div style={{ background: '#2a1a1a', border: '1px solid #5a3a3a', borderRadius: '2px', padding: '0.5em', minHeight: '40px', display: 'flex', flexWrap: 'wrap', gap: '0.4em', alignItems: 'center' }}>
            {blacklist.map(userId => <PermissionTag key={userId} userId={userId} usernames={usernames} onRemove={() => onRemoveFromBlacklist(userId)} isBlacklist />)}
            <input type="text" value={blacklistInput} onChange={e => setBlacklistInput(e.target.value)} onKeyDown={handleKeyDown}
              placeholder="Type a username" style={{ background: 'transparent', border: 'none', outline: 'none', color: '#e88888', fontSize: '0.85em', flex: 1, minWidth: '120px', padding: '0.3em' }} />
          </div>
          {blacklistError.status === 'error' && (
            <div style={{ marginTop: '0.5em' }}>
              <ConfirmUpdateSuccess status="error" errorMessage={blacklistError.message} onDismiss={() => setBlacklistError(defaultError)} />
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
