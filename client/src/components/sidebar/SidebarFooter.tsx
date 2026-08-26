import { useEffect, useState } from 'react';
import { LogOut, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CommunityUpdates, User } from '../../api';
import type { ElectronUpdateAPI } from './types';

interface SidebarFooterProps {
  user: User;
  updateCounts: CommunityUpdates['counts'];
  isOwner?: boolean;
  onOpenAccount: () => void;
  onOpenDirectMessages: () => void;
  onLogout: () => void;
  onOpenAdmin?: () => void;
}

function countLabel(count: number): string {
  return count >= 99 ? '99+' : String(count);
}

function electronAPI(): ElectronUpdateAPI | undefined {
  return (window as unknown as { electronAPI?: ElectronUpdateAPI }).electronAPI;
}

export function SidebarFooter({ user, updateCounts, isOwner, onOpenAccount, onOpenDirectMessages, onLogout, onOpenAdmin }: SidebarFooterProps) {
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    const api = electronAPI();
    if (!api?.onUpdateFailed) return;
    return api.onUpdateFailed((payload) => {
      setUpdating(false);
      alert('Desktop update failed: ' + (payload?.error || 'Unknown error'));
    });
  }, []);

  const updateDesktop = async () => {
    const api = electronAPI();
    if (!api?.updateAndRestart) return;
    setUpdating(true);
    const result = await api.updateAndRestart();
    if (!result.success) {
      alert('Desktop update failed: ' + (result.error || 'Unknown error'));
      setUpdating(false);
    } else if (!result.refreshing) {
      setUpdating(false);
    }
  };

  return (
    <div className="sidebar-footer">
      <button type="button" className="user-info" onClick={onOpenAccount} title="Account settings">
        <div className="user-avatar">{user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : (user.displayName || user.username).charAt(0).toUpperCase()}</div>
        <span className="truncate">{user.displayName || user.username}</span>
      </button>
      <button id="direct-messages-btn" type="button" className="btn-icon sidebar-dm-button" onClick={onOpenDirectMessages} title="Messages" aria-label={updateCounts.directMessages > 0 ? `${countLabel(updateCounts.directMessages)} unread direct messages` : 'Messages'}>
        <Mail size={16} />
        {updateCounts.directMessages > 0 && <span className="sidebar-dm-dot" aria-hidden="true" />}
      </button>
      <button className="btn-icon" title="Update desktop app" disabled={updating} onClick={() => void updateDesktop()}><RefreshCw size={16} className={updating ? 'spin' : ''} /></button>
      {isOwner && onOpenAdmin && <button className="btn-icon" onClick={onOpenAdmin} title="Admin"><ShieldCheck size={16} /></button>}
      <button id="logout-btn" className="btn-icon" onClick={onLogout} title="Log out"><LogOut size={16} /></button>
    </div>
  );
}
