import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Ban, Compass, Gem, LoaderCircle, MessageCircle, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import { api } from '../api';

export type DiscoveryTab = 'public' | 'dms';

type PublicVault = {
  id: string;
  name: string;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerAvatarUrl: string;
  memberCount: number;
  joinRole: 'editor' | 'viewer';
  role: 'owner' | 'editor' | 'viewer' | null;
};

type DirectMessage = {
  user: {
    id: number;
    username: string;
    displayName: string;
    avatarUrl: string;
  };
  vaultId: string;
  channelId: string;
  title: string;
  createdAt: string;
};

type BlockedUser = {
  id: number;
  username: string;
  displayName: string;
  avatarUrl: string;
  createdAt: string;
};

type DiscoveryDmsModalProps = {
  initialTab: DiscoveryTab;
  onClose: () => void;
  onOpenLocation: (vaultId: string, channelId?: string, title?: string) => void | Promise<void>;
  onVaultsChanged: () => void | Promise<void>;
};

function personInitial(displayName: string, username: string) {
  return (displayName || username).trim().charAt(0).toUpperCase() || '?';
}

export function DiscoveryDmsModal({
  initialTab,
  onClose,
  onOpenLocation,
  onVaultsChanged,
}: DiscoveryDmsModalProps) {
  const [tab, setTab] = useState<DiscoveryTab>(initialTab);
  const [publicVaults, setPublicVaults] = useState<PublicVault[]>([]);
  const [dms, setDms] = useState<DirectMessage[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [allowStrangerDms, setAllowStrangerDms] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [dmUsername, setDmUsername] = useState('');
  const [blockUsername, setBlockUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [status, setStatus] = useState('');

  const loadPublicVaults = useCallback(async () => {
    setLoading(true);
    setStatus('');
    try {
      const data = await api<{ vaults: PublicVault[] }>('/api/public-vaults');
      setPublicVaults(data.vaults);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not load public vaults');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDms = useCallback(async () => {
    setLoading(true);
    setStatus('');
    try {
      const [dmData, privacyData, blocksData] = await Promise.all([
        api<{ conversations: DirectMessage[] }>('/api/me/direct-messages'),
        api<{ allowDirectMessages: boolean }>('/api/me/dm-settings'),
        api<{ blocks: BlockedUser[] }>('/api/me/blocks'),
      ]);
      setDms(dmData.conversations);
      setAllowStrangerDms(privacyData.allowDirectMessages);
      setBlockedUsers(blocksData.blocks);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Could not load direct messages');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === 'public') void loadPublicVaults();
    else void loadDms();
  }, [loadDms, loadPublicVaults, tab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const visibleVaults = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return publicVaults;
    return publicVaults.filter((vault) => (
      vault.name.toLocaleLowerCase().includes(query)
      || vault.ownerUsername.toLocaleLowerCase().includes(query)
      || vault.ownerDisplayName.toLocaleLowerCase().includes(query)
    ));
  }, [publicVaults, searchQuery]);

  const joinVault = async (vault: PublicVault) => {
    if (vault.role) {
      await onOpenLocation(vault.id);
      onClose();
      return;
    }
    setBusyAction(`join:${vault.id}`);
    setStatus('');
    try {
      const joined = await api<{ vaultId: string; name: string; role: string }>(
        `/api/public-vaults/${encodeURIComponent(vault.id)}/join`,
        { method: 'POST' },
      );
      await onVaultsChanged();
      await onOpenLocation(joined.vaultId);
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not join ${vault.name}`);
    } finally {
      setBusyAction('');
    }
  };

  const createDm = async (event: FormEvent) => {
    event.preventDefault();
    const username = dmUsername.trim().replace(/^@/, '');
    if (!username) return;
    setBusyAction('create-dm');
    setStatus('');
    try {
      const created = await api<DirectMessage>('/api/direct-messages', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      await onVaultsChanged();
      await onOpenLocation(created.vaultId, created.channelId, created.title);
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not message @${username}`);
    } finally {
      setBusyAction('');
    }
  };

  const updatePrivacy = async () => {
    const next = !allowStrangerDms;
    setAllowStrangerDms(next);
    setBusyAction('privacy');
    setStatus('');
    try {
      const data = await api<{ allowDirectMessages: boolean }>('/api/me/dm-settings', {
        method: 'PUT',
        body: JSON.stringify({ allowDirectMessages: next }),
      });
      setAllowStrangerDms(data.allowDirectMessages);
      setStatus(data.allowDirectMessages ? 'Anyone may start a DM with you.' : 'New direct messages are turned off.');
    } catch (error) {
      setAllowStrangerDms(!next);
      setStatus(error instanceof Error ? error.message : 'Could not update DM privacy');
    } finally {
      setBusyAction('');
    }
  };

  const blockUser = async (usernameValue: string) => {
    const username = usernameValue.trim().replace(/^@/, '');
    if (!username) return;
    setBusyAction(`block:${username}`);
    setStatus('');
    try {
      const data = await api<{ block: BlockedUser }>('/api/me/blocks', {
        method: 'POST',
        body: JSON.stringify({ username }),
      });
      setBlockedUsers((current) => [data.block, ...current.filter((user) => user.username !== data.block.username)]);
      setBlockUsername('');
      setStatus(`Blocked @${data.block.username}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not block @${username}`);
    } finally {
      setBusyAction('');
    }
  };

  const unblockUser = async (username: string) => {
    setBusyAction(`unblock:${username}`);
    setStatus('');
    try {
      await api(`/api/me/blocks/${encodeURIComponent(username)}`, {
        method: 'DELETE',
      });
      setBlockedUsers((current) => current.filter((user) => user.username !== username));
      setStatus(`Unblocked @${username}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not unblock @${username}`);
    } finally {
      setBusyAction('');
    }
  };

  return (
    <div className="overlay-backdrop discovery-dms-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="discovery-dms-modal" role="dialog" aria-modal="true" aria-labelledby="discovery-dms-title">
        <header className="discovery-dms-header">
          <div>
            <h2 id="discovery-dms-title">Connect</h2>
            <p>Find a workspace or start a private conversation.</p>
          </div>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Close connect dialog"><X size={17} /></button>
        </header>

        <div className="discovery-dms-tabs" role="tablist" aria-label="Connect">
          <button type="button" role="tab" aria-selected={tab === 'public'} className={tab === 'public' ? 'is-active' : ''} onClick={() => setTab('public')}>
            <Compass size={14} /> Public vaults
          </button>
          <button type="button" role="tab" aria-selected={tab === 'dms'} className={tab === 'dms' ? 'is-active' : ''} onClick={() => setTab('dms')}>
            <MessageCircle size={14} /> Direct messages
          </button>
        </div>

        <div className="discovery-dms-body">
          {tab === 'public' ? (
            <div className="discovery-panel" role="tabpanel">
              <label className="discovery-search">
                <Search size={14} aria-hidden="true" />
                <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search public vaults" aria-label="Search public vaults" />
              </label>
              <div className="discovery-list" aria-label="Public vaults">
                {loading && <div className="discovery-empty"><LoaderCircle className="spin" size={17} /> Loading public vaults…</div>}
                {!loading && visibleVaults.map((vault) => (
                  <article className="discovery-row" key={vault.id}>
                    <span className="discovery-avatar discovery-vault-avatar" aria-hidden="true"><Gem size={15} /></span>
                    <div className="discovery-row-copy">
                      <strong>{vault.name}</strong>
                      <span>by @{vault.ownerUsername} · {vault.memberCount} {vault.memberCount === 1 ? 'member' : 'members'} · joins as {vault.joinRole}</span>
                    </div>
                    <button type="button" disabled={busyAction === `join:${vault.id}`} onClick={() => void joinVault(vault)}>
                      {busyAction === `join:${vault.id}` ? 'Joining…' : vault.role ? 'Open' : 'Join'}
                    </button>
                  </article>
                ))}
                {!loading && !visibleVaults.length && <div className="discovery-empty">No public vaults match that search.</div>}
              </div>
            </div>
          ) : (
            <div className="discovery-panel dm-panel" role="tabpanel">
              <form className="dm-compose" onSubmit={createDm}>
                <label htmlFor="dm-username">Message someone</label>
                <div>
                  <span aria-hidden="true">@</span>
                  <input id="dm-username" autoFocus value={dmUsername} onChange={(event) => setDmUsername(event.target.value)} placeholder="username" autoComplete="off" />
                  <button type="submit" disabled={!dmUsername.trim() || busyAction === 'create-dm'}><UserPlus size={14} />{busyAction === 'create-dm' ? 'Opening…' : 'Start DM'}</button>
                </div>
              </form>

              <div className="dm-privacy-row">
                <ShieldCheck size={16} aria-hidden="true" />
                <div><strong>New direct messages</strong><span>Choose whether other people may start a DM with you.</span></div>
                <button type="button" role="switch" aria-checked={allowStrangerDms} aria-label="Allow messages from strangers" className={`dm-toggle ${allowStrangerDms ? 'is-on' : ''}`} disabled={busyAction === 'privacy'} onClick={() => void updatePrivacy()}><span /></button>
              </div>

              <section className="dm-section" aria-labelledby="dm-conversations-title">
                <h3 id="dm-conversations-title">Conversations</h3>
                <div className="discovery-list">
                  {loading && <div className="discovery-empty"><LoaderCircle className="spin" size={17} /> Loading messages…</div>}
                  {!loading && dms.map((dm) => (
                    <article className="discovery-row" key={`${dm.vaultId}:${dm.user.username}`}>
                      <span className="discovery-avatar" aria-hidden="true">{dm.user.avatarUrl ? <img src={dm.user.avatarUrl} alt="" /> : personInitial(dm.user.displayName, dm.user.username)}</span>
                      <button type="button" className="discovery-row-copy dm-open" onClick={() => { void onOpenLocation(dm.vaultId, dm.channelId, dm.title); onClose(); }}>
                        <strong>{dm.user.displayName || dm.user.username}</strong><span>@{dm.user.username}</span>
                      </button>
                      <button type="button" className="dm-block-button" disabled={busyAction === `block:${dm.user.username}`} onClick={() => void blockUser(dm.user.username)} aria-label={`Block @${dm.user.username}`} title={`Block @${dm.user.username}`}><Ban size={14} /></button>
                    </article>
                  ))}
                  {!loading && !dms.length && <div className="discovery-empty">No direct messages yet.</div>}
                </div>
              </section>

              <section className="dm-section" aria-labelledby="blocked-users-title">
                <h3 id="blocked-users-title">Blocked users</h3>
                <form className="dm-block-form" onSubmit={(event) => { event.preventDefault(); void blockUser(blockUsername); }}>
                  <input value={blockUsername} onChange={(event) => setBlockUsername(event.target.value)} placeholder="Username to block" aria-label="Username to block" autoComplete="off" />
                  <button type="submit" disabled={!blockUsername.trim() || busyAction.startsWith('block:')}>Block</button>
                </form>
                <div className="discovery-list dm-block-list">
                  {blockedUsers.map((blocked) => (
                    <article className="discovery-row" key={blocked.username}>
                      <span className="discovery-avatar" aria-hidden="true">{blocked.avatarUrl ? <img src={blocked.avatarUrl} alt="" /> : personInitial(blocked.displayName, blocked.username)}</span>
                      <div className="discovery-row-copy"><strong>{blocked.displayName || blocked.username}</strong><span>@{blocked.username}</span></div>
                      <button type="button" disabled={busyAction === `unblock:${blocked.username}`} onClick={() => void unblockUser(blocked.username)}>Unblock</button>
                    </article>
                  ))}
                  {!blockedUsers.length && <div className="discovery-empty compact">Nobody is blocked.</div>}
                </div>
              </section>
            </div>
          )}
        </div>
        {status && <div className="discovery-dms-status" role="status">{status}</div>}
      </section>
    </div>
  );
}
