import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Ban, BookOpen, Clock3, Compass, Gem, LoaderCircle, MessageCircle, Search, ShieldCheck, UserPlus, X } from 'lucide-react';
import { api, formatRelativeDate } from '../api';

export type DiscoveryTab = 'public' | 'dms';

type PublicVault = {
  id: string;
  name: string;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerAvatarUrl: string;
  memberCount: number;
  summary: string;
  topics: string[];
  joinPolicy: 'open' | 'request' | 'invite';
  lastActivity: string;
  role: 'owner' | 'editor' | 'viewer' | null;
  requestStatus: 'pending' | 'approved' | 'rejected' | null;
};

type PublicVaultDetail = PublicVault & {
  guidelines: string;
  homeNote: { title: string; preview: string; updatedAt: string } | null;
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
  const [publicVaultDetail, setPublicVaultDetail] = useState<PublicVaultDetail | null>(null);
  const [dms, setDms] = useState<DirectMessage[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [allowStrangerDms, setAllowStrangerDms] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [dmUsername, setDmUsername] = useState('');
  const [blockUsername, setBlockUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [status, setStatus] = useState('');

  const loadPublicVaults = useCallback(async (query = '') => {
    setLoading(true);
    setStatus('');
    try {
      const suffix = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
      const data = await api<{ vaults: PublicVault[] }>(`/api/public-vaults${suffix}`);
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
    if (tab !== 'public') {
      void loadDms();
      return;
    }
    const timer = window.setTimeout(() => void loadPublicVaults(searchQuery), 180);
    return () => window.clearTimeout(timer);
  }, [loadDms, loadPublicVaults, searchQuery, tab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const openPublicVaultDetail = async (vault: PublicVault) => {
    setBusyAction(`detail:${vault.id}`);
    setStatus('');
    try {
      const data = await api<{ vault: PublicVaultDetail }>(`/api/public-vaults/${encodeURIComponent(vault.id)}`);
      setPublicVaultDetail(data.vault);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not open ${vault.name}`);
    } finally {
      setBusyAction('');
    }
  };

  const joinVault = async (vault: PublicVault) => {
    if (vault.role) {
      await onOpenLocation(vault.id);
      onClose();
      return;
    }
    setBusyAction(`join:${vault.id}`);
    setStatus('');
    try {
      const joined = await api<{ vaultId: string; name: string; role: string | null; requestStatus: 'pending' | null }>(
        `/api/public-vaults/${encodeURIComponent(vault.id)}/join`,
        { method: 'POST' },
      );
      if (joined.requestStatus === 'pending') {
        setPublicVaults((current) => current.map((item) => item.id === vault.id ? { ...item, requestStatus: 'pending' } : item));
        setPublicVaultDetail((current) => current?.id === vault.id ? { ...current, requestStatus: 'pending' } : current);
        setStatus(`Request sent to @${vault.ownerUsername}.`);
        return;
      }
      await onVaultsChanged();
      await onOpenLocation(joined.vaultId);
      onClose();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : `Could not join ${vault.name}`);
    } finally {
      setBusyAction('');
    }
  };

  const publicActionLabel = (vault: PublicVault) => {
    if (vault.role) return 'Open';
    if (vault.joinPolicy === 'invite') return 'Invite only';
    if (vault.requestStatus === 'pending') return 'Requested';
    return vault.joinPolicy === 'request' ? 'Request access' : 'Join as viewer';
  };

  const publicActionDisabled = (vault: PublicVault) => (
    busyAction === `join:${vault.id}`
    || (!vault.role && (vault.joinPolicy === 'invite' || vault.requestStatus === 'pending'))
  );

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
              {publicVaultDetail ? (
                <div className="public-vault-detail">
                  <button type="button" className="public-vault-back" onClick={() => setPublicVaultDetail(null)}><ArrowLeft size={14} /> Back to public vaults</button>
                  <div className="public-vault-detail-heading">
                    <span className="discovery-avatar discovery-vault-avatar" aria-hidden="true"><Gem size={16} /></span>
                    <div><h3>{publicVaultDetail.name}</h3><span>by @{publicVaultDetail.ownerUsername}</span></div>
                  </div>
                  <p className="public-vault-purpose">{publicVaultDetail.summary || 'The owner has not added a public summary yet.'}</p>
                  {!!publicVaultDetail.topics.length && <div className="public-vault-topics">{publicVaultDetail.topics.map((topic) => <span key={topic}>{topic}</span>)}</div>}
                  <div className="public-vault-activity"><Clock3 size={13} /> Active {formatRelativeDate(publicVaultDetail.lastActivity)}</div>
                  <section><h4>Community guidelines</h4><p>{publicVaultDetail.guidelines || 'No additional guidelines have been posted.'}</p></section>
                  {publicVaultDetail.homeNote && (
                    <section className="public-vault-home-preview">
                      <h4><BookOpen size={13} /> {publicVaultDetail.homeNote.title}</h4>
                      <p>{publicVaultDetail.homeNote.preview || 'This note does not have a preview yet.'}</p>
                    </section>
                  )}
                  <button type="button" className="public-vault-primary-action" disabled={publicActionDisabled(publicVaultDetail)} onClick={() => void joinVault(publicVaultDetail)}>
                    {busyAction === `join:${publicVaultDetail.id}` ? 'Working…' : publicActionLabel(publicVaultDetail)}
                  </button>
                </div>
              ) : (
                <>
                  <label className="discovery-search">
                    <Search size={14} aria-hidden="true" />
                    <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search name, owner, purpose, or topic" aria-label="Search public vaults" />
                  </label>
                  <div className="discovery-list public-vault-list" aria-label="Public vaults">
                    {loading && <div className="discovery-empty"><LoaderCircle className="spin" size={17} /> Loading public vaults…</div>}
                    {!loading && publicVaults.map((vault) => (
                      <article className="discovery-row public-vault-card" key={vault.id}>
                        <span className="discovery-avatar discovery-vault-avatar" aria-hidden="true"><Gem size={15} /></span>
                        <button type="button" className="public-vault-card-copy" disabled={busyAction === `detail:${vault.id}`} onClick={() => void openPublicVaultDetail(vault)} aria-label={`View ${vault.name} details`}>
                          <strong>{vault.name}</strong>
                          <span className="public-vault-owner">by @{vault.ownerUsername}</span>
                          <span className="public-vault-purpose">{vault.summary || 'No public summary yet.'}</span>
                          {!!vault.topics.length && <span className="public-vault-topics">{vault.topics.map((topic) => <em key={topic}>{topic}</em>)}</span>}
                          <span className="public-vault-activity"><Clock3 size={12} /> Active {formatRelativeDate(vault.lastActivity)}</span>
                        </button>
                        <button type="button" disabled={publicActionDisabled(vault)} onClick={() => void joinVault(vault)}>
                          {busyAction === `join:${vault.id}` ? 'Working…' : publicActionLabel(vault)}
                        </button>
                      </article>
                    ))}
                    {!loading && !publicVaults.length && <div className="discovery-empty">No public vaults match that search.</div>}
                  </div>
                </>
              )}
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
