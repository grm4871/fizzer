import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, GitBranch, GitPullRequest, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  describeStatus,
  isSafeToRemove,
  overlapWarnings,
  recommendIsolation,
  suggestWorkspaceSlug,
  workspaceBridge,
  type PullRequest,
  type Workspace,
  type WorkspaceStatus,
} from '../chat/workspaces';
import {
  createChannelWorkItem,
  fetchWorkItem,
  leaseWorkItem,
  listChannelWorkItems,
  patchWorkItem,
  releaseWorkItem,
  workItemStatusLabel,
  type WorkItem,
  type WorkItemReview,
} from '../chat/workItems';
import { ChatTaskReview } from './ChatTaskReview';

/**
 * @file ChatWorkspacePanel.tsx — durable work items + git task workspaces
 *
 * Server-backed work items are the addressable record (status, lease, PR,
 * handoffs). Host worktrees remain a materialization managed by Electron.
 */

type Props = {
  channelId: string;
  channelName: string;
  vaultId?: string;
  cwd: string;
  onUseWorkspace: (path: string) => void;
};

export function ChatWorkspacePanel({ channelId, channelName, vaultId, cwd, onUseWorkspace }: Props) {
  const bridge = useMemo(workspaceBridge, []);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [repoError, setRepoError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  const [forceRemovePath, setForceRemovePath] = useState('');
  const [slug, setSlug] = useState('');
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(true);

  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [itemDetail, setItemDetail] = useState<{
    item: WorkItem;
    reviews: WorkItemReview[];
    siblings: WorkItem[];
  } | null>(null);
  const [newItemTitle, setNewItemTitle] = useState('');
  const [creatingItem, setCreatingItem] = useState(false);

  const refreshWorkItems = useCallback(async () => {
    if (!vaultId) {
      setWorkItems([]);
      setItemDetail(null);
      return;
    }
    try {
      const items = await listChannelWorkItems(vaultId, channelId);
      setWorkItems(items.filter((item) => !['done', 'canceled'].includes(item.status) || items.length <= 12));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load work items');
    }
  }, [vaultId, channelId]);

  const refreshItemDetail = useCallback(async (id: string) => {
    try {
      const detail = await fetchWorkItem(id);
      setItemDetail(detail);
      setSelectedItemId(id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load work item');
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!bridge || !cwd.trim()) {
      setWorkspaces(null);
      setStatus(null);
      setPr(null);
      setRepoError('');
      return;
    }
    setBusy('refresh');
    const [listed, current] = await Promise.all([bridge.listWorktrees(cwd), bridge.getWorktreeStatus(cwd)]);
    setBusy('');
    if (!listed.ok) {
      setRepoError(listed.error);
      setWorkspaces(null);
      setStatus(null);
      setPr(null);
      return;
    }
    setRepoError('');
    setWorkspaces(listed.workspaces);
    setStatus(current.ok ? current : null);
    const found = await bridge.getWorktreePullRequest(cwd);
    setPr(found.ok ? found.pr : null);
  }, [bridge, cwd]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { void refreshWorkItems(); }, [refreshWorkItems]);
  useEffect(() => { setSlug(suggestWorkspaceSlug(channelName)); }, [channelName]);
  useEffect(() => {
    if (status?.commits.length && !prTitle) setPrTitle(status.commits[status.commits.length - 1].subject);
  }, [status, prTitle]);

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setNotice('');
    try {
      setNotice(await fn());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy('');
      void refresh();
      void refreshWorkItems();
      if (selectedItemId) void refreshItemDetail(selectedItemId);
    }
  };

  const createWorkspace = () => act('create', async () => {
    if (!bridge) return 'Desktop only';
    const result = await bridge.createWorktree({
      dir: cwd,
      slug,
      channelId,
      workItemId: selectedItemId || undefined,
    });
    if (!result.ok) return result.error;
    onUseWorkspace(result.path);
    if (selectedItemId && vaultId) {
      await patchWorkItem(selectedItemId, {
        worktreePath: result.path,
        branch: result.branch,
        workspaceMode: 'isolated',
        baseCommit: result.baseCommit,
        repository: cwd,
        status: 'in_progress',
      });
    }
    setCreating(false);
    return `Created ${result.branch}`;
  });

  const removeWorkspace = (workspace: Workspace) => act(`remove:${workspace.path}`, async () => {
    if (!bridge) return 'Desktop only';
    const force = forceRemovePath === workspace.path;
    const result = await bridge.removeWorktree({ dir: workspace.path, force });
    if (!result.ok) {
      setForceRemovePath(result.needsForce ? workspace.path : '');
      return result.needsForce ? `${result.error}. Click again to remove anyway.` : result.error;
    }
    setForceRemovePath('');
    return `Removed ${workspace.branch}`;
  });

  const openPullRequest = () => act('pr', async () => {
    if (!bridge) return 'Desktop only';
    const result = await bridge.createWorktreePullRequest({ dir: cwd, title: prTitle, body: prBody, draft: prDraft });
    if (!result.ok) return result.error;
    if (selectedItemId) {
      await patchWorkItem(selectedItemId, {
        prUrl: result.url,
        prState: result.draft ? 'draft' : 'open',
        status: 'review',
        branch: result.branch,
      });
    }
    setPrOpen(false);
    return `Opened ${result.draft ? 'draft ' : ''}PR: ${result.url}`;
  });

  const createItem = async () => {
    if (!vaultId) return;
    const title = newItemTitle.trim() || `Work · ${channelName}`;
    setBusy('item');
    setNotice('');
    try {
      const item = await createChannelWorkItem(vaultId, {
        title,
        brief: '',
        channelId,
        sourceKind: 'manual',
        repository: cwd || '',
        workspaceMode: cwd ? 'isolated' : 'shared',
      });
      setNewItemTitle('');
      setCreatingItem(false);
      await refreshWorkItems();
      await refreshItemDetail(item.id);
      setNotice(`Created work item ${item.title}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create work item');
    } finally {
      setBusy('');
    }
  };

  const bindWorkspaceToItem = () => act('bind', async () => {
    if (!selectedItemId || !status) return 'Select a work item and open a workspace first';
    if (!status.baseCommit) return 'This workspace has no recorded base — create or select a Cascade-managed workspace first';
    await patchWorkItem(selectedItemId, {
      worktreePath: status.path,
      branch: status.branch,
      baseCommit: status.baseCommit,
      repository: cwd,
      workspaceMode: status.isPrimary ? 'shared' : 'isolated',
    });
    return 'Bound current workspace to work item';
  });

  const activePath = status?.path;
  const canOpenPr = Boolean(status && !status.isPrimary && status.commits.length && !status.dirty);
  const isolationHint = recommendIsolation(status, workspaces);
  const overlaps = overlapWarnings(workspaces, status);
  const openItems = workItems.filter((item) => !['done', 'canceled'].includes(item.status));
  const selected = itemDetail?.item;

  return (
    <div className="chat-workspaces">
      {vaultId && (
        <div className="chat-work-items">
          <div className="chat-workspaces-heading">
            <ClipboardList size={12} />
            <span>Work items</span>
            <button type="button" onClick={() => void refreshWorkItems()} disabled={busy === 'item'} aria-label="Refresh work items">
              <RefreshCw size={11} />
            </button>
          </div>
          {openItems.length > 0 && (
            <ul className="chat-work-items-list">
              {openItems.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`chat-work-item-row${selectedItemId === item.id ? ' is-active' : ''}`}
                    onClick={() => void refreshItemDetail(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <span>{workItemStatusLabel(item.status)}{item.branch ? ` · ${item.branch}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {creatingItem ? (
            <div className="chat-workspace-create">
              <input
                value={newItemTitle}
                autoFocus
                placeholder="Work item title"
                onChange={(event) => setNewItemTitle(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void createItem(); }}
              />
              <div className="chat-workspace-actions">
                <button type="button" onClick={() => setCreatingItem(false)}>Cancel</button>
                <button type="button" disabled={busy === 'item'} onClick={() => void createItem()}>
                  {busy === 'item' ? 'Creating' : 'Create'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="chat-workspace-new" onClick={() => setCreatingItem(true)}>
              <Plus size={11} /> New work item
            </button>
          )}

          {selected && (
            <div className="chat-workspace-detail">
              <div className="chat-workspace-detail-heading">Work item detail</div>
              <p className="chat-workspaces-hint">
                {workItemStatusLabel(selected.status)}
                {selected.leaseHolder ? ` · leased by ${selected.leaseHolder}` : ''}
                {selected.priority ? ` · p${selected.priority}` : ''}
              </p>
              {selected.brief && <p className="chat-workspaces-hint">{selected.brief}</p>}
              <p className="chat-workspaces-hint">
                {selected.repository || 'no repo'} · {selected.workspaceMode}
                {selected.branch ? ` · ${selected.branch}` : ''}
                {selected.worktreePath ? ` · ${selected.worktreePath}` : ''}
              </p>
              {selected.runIds.length > 0 && (
                <p className="chat-workspaces-hint">runs: {selected.runIds.join(', ')}</p>
              )}
              {selected.dependsOn.length > 0 && (
                <p className="chat-workspaces-hint">depends on {selected.dependsOn.length} item(s)</p>
              )}
              {(itemDetail?.siblings.length || 0) > 0 && (
                <p className="chat-workspaces-notice is-warn">
                  {itemDetail!.siblings.length} sibling item(s) open on the same repository
                </p>
              )}
              {(itemDetail?.reviews.length || 0) > 0 && (
                <ul className="chat-workspace-detail-list">
                  {itemDetail!.reviews.slice(-4).map((review) => (
                    <li key={review.id}>
                      handoff → {review.toRegistrationId || 'agent'} · {review.status}
                      {review.note ? ` — ${review.note}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              <div className="chat-workspace-actions" style={{ marginTop: 6 }}>
                <button
                  type="button"
                  disabled={busy === 'lease'}
                  onClick={() => void act('lease', async () => {
                    await leaseWorkItem(selected.id, 'desktop');
                    return 'Lease acquired';
                  })}
                >
                  Lease
                </button>
                <button
                  type="button"
                  disabled={busy === 'release'}
                  onClick={() => void act('release', async () => {
                    await releaseWorkItem(selected.id, 'desktop');
                    return 'Lease released';
                  })}
                >
                  Release
                </button>
                <button type="button" disabled={!status || busy === 'bind'} onClick={() => void bindWorkspaceToItem()}>
                  Bind cwd
                </button>
                <button
                  type="button"
                  disabled={busy === 'done'}
                  onClick={() => void act('done', async () => {
                    await patchWorkItem(selected.id, { status: 'done' });
                    return 'Marked done';
                  })}
                >
                  Done
                </button>
              </div>
              {selected.prUrl && (
                <a className="chat-workspace-pr" href={selected.prUrl} target="_blank" rel="noreferrer">
                  <GitPullRequest size={11} />
                  PR {selected.prNumber ? `#${selected.prNumber}` : ''} {selected.prState || ''}
                </a>
              )}
              {selected.worktreePath && (
                <ChatTaskReview workItemId={selected.id} worktreePath={selected.worktreePath} />
              )}
            </div>
          )}
        </div>
      )}

      <div className="chat-workspaces-heading">
        <GitBranch size={12} />
        <span>Task workspaces</span>
        <button type="button" onClick={() => void refresh()} disabled={busy === 'refresh' || !bridge} aria-label="Refresh workspaces">
          <RefreshCw size={11} />
        </button>
      </div>

      {!bridge && <p className="chat-workspaces-hint">Worktrees require the desktop app.</p>}
      {!cwd.trim() && <p className="chat-workspaces-hint">Set a working directory above to use isolated workspaces.</p>}
      {repoError && <p className="chat-workspaces-hint">{repoError}</p>}
      {isolationHint && <p className="chat-workspaces-notice is-warn">{isolationHint}</p>}
      {overlaps.map((warning) => (
        <p key={warning} className="chat-workspaces-notice is-warn">{warning}</p>
      ))}

      {bridge && workspaces && (
        <>
          <ul className="chat-workspaces-list">
            {workspaces.map((workspace) => {
              const isActive = activePath === workspace.path;
              return (
                <li key={workspace.path} className={isActive ? 'is-active' : undefined}>
                  <div className="chat-workspace-row">
                    <span className="chat-workspace-branch" title={workspace.path}>{workspace.branch}</span>
                    {workspace.isPrimary && <span className="chat-workspace-tag">primary</span>}
                    {workspace.workItemId && <span className="chat-workspace-tag">linked</span>}
                    {isActive && status && <span className="chat-workspace-tag is-status">{describeStatus(status)}</span>}
                  </div>
                  <div className="chat-workspace-actions">
                    {!isActive && (
                      <button type="button" onClick={() => onUseWorkspace(workspace.path)}>Use</button>
                    )}
                    {workspace.managed && (
                      <button
                        type="button"
                        className={`chat-workspace-remove${forceRemovePath === workspace.path ? ' is-armed' : ''}`}
                        title={isActive && status && !isSafeToRemove(status) ? 'Has unsaved or unpushed work' : 'Remove workspace'}
                        disabled={busy === `remove:${workspace.path}`}
                        onClick={() => void removeWorkspace(workspace)}
                      >
                        <Trash2 size={11} />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          {creating ? (
            <div className="chat-workspace-create">
              <input
                value={slug}
                autoFocus
                spellCheck={false}
                placeholder="workspace-name"
                onChange={(event) => setSlug(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void createWorkspace(); }}
              />
              <span className="chat-workspaces-hint">
                branch cascade/{suggestWorkspaceSlug(slug) || '…'}
                {selectedItemId ? ' · linked to selected work item' : ''}
              </span>
              <div className="chat-workspace-actions">
                <button type="button" onClick={() => setCreating(false)}>Cancel</button>
                <button type="button" disabled={busy === 'create' || !suggestWorkspaceSlug(slug)} onClick={() => void createWorkspace()}>
                  {busy === 'create' ? 'Creating' : 'Create'}
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="chat-workspace-new" onClick={() => setCreating(true)}>
              <Plus size={11} /> New isolated workspace
            </button>
          )}
        </>
      )}

      {status && !status.isPrimary && (
        <div className="chat-workspace-review">
          <div className="chat-workspace-detail">
            <div className="chat-workspace-detail-heading">Workspace detail</div>
            <p className="chat-workspaces-hint">
              {status.branch} · {status.head.slice(0, 7)} · base {status.baseBranch}
              {status.behindBase ? ` · ${status.behindBase} behind` : ''}
              {status.unpushed ? ` · ${status.unpushed} unpushed` : ''}
            </p>
            {status.commits.length > 0 && (
              <ul className="chat-workspace-detail-list">
                {status.commits.slice(-8).map((commit) => (
                  <li key={commit.sha} title={commit.sha}>
                    <code>{commit.sha.slice(0, 7)}</code> {commit.subject}
                  </li>
                ))}
              </ul>
            )}
            {status.changedFiles.length > 0 && (
              <ul className="chat-workspace-detail-list">
                {status.changedFiles.slice(0, 12).map((file) => (
                  <li key={`${file.status}:${file.path}`}>
                    <span className="chat-workspace-file-status">{file.status}</span> {file.path}
                  </li>
                ))}
                {status.changedFiles.length > 12 && (
                  <li className="chat-workspaces-hint">+{status.changedFiles.length - 12} more files</li>
                )}
              </ul>
            )}
            {!status.commits.length && !status.changedFiles.length && (
              <p className="chat-workspaces-hint">No local commits or file changes yet.</p>
            )}
          </div>
          {pr ? (
            <a className="chat-workspace-pr" href={pr.url} target="_blank" rel="noreferrer">
              <GitPullRequest size={11} />
              #{pr.number} {pr.isDraft ? 'draft' : pr.state.toLowerCase()}
              {pr.checks.total > 0 && (
                <span className={pr.checks.failing ? 'is-failing' : undefined}>
                  {pr.checks.failing ? `${pr.checks.failing} failing` : pr.checks.pending ? `${pr.checks.pending} pending` : 'checks green'}
                </span>
              )}
              {pr.mergeable && pr.mergeable !== 'MERGEABLE' && (
                <span className="is-failing">{pr.mergeable.toLowerCase()}</span>
              )}
              {pr.reviewDecision && <span>{pr.reviewDecision.toLowerCase()}</span>}
            </a>
          ) : prOpen ? (
            <div className="chat-workspace-create">
              <input value={prTitle} placeholder="Pull request title" onChange={(event) => setPrTitle(event.target.value)} />
              <textarea value={prBody} rows={3} placeholder="What changed and how it was verified" onChange={(event) => setPrBody(event.target.value)} />
              <label className="chat-workspace-draft">
                <input type="checkbox" checked={prDraft} onChange={(event) => setPrDraft(event.target.checked)} />
                Draft
              </label>
              <div className="chat-workspace-actions">
                <button type="button" onClick={() => setPrOpen(false)}>Cancel</button>
                <button type="button" disabled={busy === 'pr' || !prTitle.trim()} onClick={() => void openPullRequest()}>
                  {busy === 'pr' ? 'Pushing' : 'Push & open'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="chat-workspace-new"
              disabled={!canOpenPr}
              title={canOpenPr ? 'Push this branch and open a pull request' : 'Commit work in this workspace first'}
              onClick={() => setPrOpen(true)}
            >
              <GitPullRequest size={11} /> Open pull request
            </button>
          )}
        </div>
      )}

      {notice && <p className="chat-workspaces-notice">{notice}</p>}
    </div>
  );
}
