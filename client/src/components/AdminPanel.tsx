/**
 * @file AdminPanel.tsx — Owner-only admin modal.
 *
 * Currently: issue single-use password-reset tokens for any account. Reachable
 * from the sidebar footer only when the logged-in user is the server owner
 * (first-registered account); the endpoints are owner-gated server-side too.
 */
import { useEffect, useState } from 'react';
import { Copy, KeyRound, X } from 'lucide-react';
import { api } from '../api';

interface AdminUser {
  id: number;
  username: string;
  created_at: string;
}

export function AdminPanel({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [issuedFor, setIssuedFor] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ users: AdminUser[] }>('/api/admin/users')
      .then((data) => { if (alive) setUsers(data.users); })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Failed to load users'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function issueReset(username: string) {
    setBusy(username);
    setError('');
    setCopied(false);
    try {
      const data = await api<{ token: string; username: string; expiresInMinutes: number }>(
        '/api/auth/reset/issue',
        { method: 'POST', body: JSON.stringify({ username }) },
      );
      setIssuedFor(data.username);
      setToken(data.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not issue token');
    } finally {
      setBusy(null);
    }
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard may be blocked; the field is selectable as a fallback */ }
  }

  const ownerId = users[0]?.id;

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="admin-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Admin">
        <div className="admin-panel-header">
          <h2><KeyRound size={16} aria-hidden="true" /> Admin</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="admin-panel-hint">
          Issue a single-use password-reset token (valid 1 hour). Hand it to the user; they redeem it
          via “Forgot password?” on the login screen.
        </p>
        {error && <div className="error">{error}</div>}
        {token && (
          <div className="admin-token">
            <div className="admin-token-label">Reset token for <strong>{issuedFor}</strong> — expires in 60 min</div>
            <div className="admin-token-row">
              <input readOnly value={token} onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn" onClick={copyToken}><Copy size={14} /> {copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        )}
        <div className="admin-user-list">
          {loading ? (
            <div className="admin-panel-hint">Loading accounts…</div>
          ) : users.length === 0 ? (
            <div className="admin-panel-hint">No accounts.</div>
          ) : users.map((u) => (
            <div key={u.id} className="admin-user-row">
              <span className="truncate">{u.username}{u.id === ownerId ? ' · owner' : ''}</span>
              <button type="button" className="btn" disabled={busy === u.username} onClick={() => issueReset(u.username)}>
                {busy === u.username ? 'Issuing…' : 'Issue reset'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
