import { useCallback, useEffect, useMemo, useState } from 'react';
import { GitBranch, GitPullRequest, Plus, RefreshCw, Trash2 } from 'lucide-react';
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

/**
 * @file ChatWorkspacePanel.tsx — task workspaces and pull requests, in-channel
 *
 * A channel's working directory decides where its agents run. Point several
 * channels at one checkout and parallel agents trample each other, so this
 * panel lets a channel take an isolated git worktree instead, see what has
 * accumulated in it, and open a pull request when the work is worth reviewing.
 *
 * Desktop-only by construction: git and `gh` live in the Electron main process.
 * With no bridge (browser tab, older shell) the panel renders nothing.
 */

type Props = {
  channelId: string;
  channelName: string;
  /** The channel's working directory — both the repo we inspect and the cwd agents get. */
  cwd: string;
  /** Repoint the channel at a workspace path. */
  onUseWorkspace: (path: string) => void;
};

export function ChatWorkspacePanel({ channelId, channelName, cwd, onUseWorkspace }: Props) {
  const bridge = useMemo(workspaceBridge, []);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [repoError, setRepoError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [creating, setCreating] = useState(false);
  // Set only after git has told us exactly what a removal would destroy, so the
  // destructive second click is always an informed one.
  const [forceRemovePath, setForceRemovePath] = useState('');
  const [slug, setSlug] = useState('');
  const [prOpen, setPrOpen] = useState(false);
  const [prTitle, setPrTitle] = useState('');
  const [prBody, setPrBody] = useState('');
  const [prDraft, setPrDraft] = useState(true);

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
    // The PR lookup shells out to `gh`; keep it off the critical path so the
    // workspace list still renders on a machine without gh installed.
    const found = await bridge.getWorktreePullRequest(cwd);
    setPr(found.ok ? found.pr : null);
  }, [bridge, cwd]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { setSlug(suggestWorkspaceSlug(channelName)); }, [channelName]);
  useEffect(() => {
    if (status?.commits.length && !prTitle) setPrTitle(status.commits[status.commits.length - 1].subject);
  }, [status, prTitle]);

  if (!bridge) return null;

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
    }
  };

  const createWorkspace = () => act('create', async () => {
    const result = await bridge.createWorktree({ dir: cwd, slug, channelId });
    if (!result.ok) return result.error;
    onUseWorkspace(result.path);
    setCreating(false);
    return `Created ${result.branch}`;
  });

  const removeWorkspace = (workspace: Workspace) => act(`remove:${workspace.path}`, async () => {
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
    const result = await bridge.createWorktreePullRequest({ dir: cwd, title: prTitle, body: prBody, draft: prDraft });
    if (!result.ok) return result.error;
    setPrOpen(false);
    return `Opened ${result.draft ? 'draft ' : ''}PR: ${result.url}`;
  });

  const activePath = status?.path;
  const canOpenPr = Boolean(status && !status.isPrimary && status.commits.length && !status.dirty);
  const isolationHint = recommendIsolation(status, workspaces);
  const overlaps = overlapWarnings(workspaces, status);

  return (
    <div className="chat-workspaces">
      <div className="chat-workspaces-heading">
        <GitBranch size={12} />
        <span>Task workspaces</span>
        <button type="button" onClick={() => void refresh()} disabled={busy === 'refresh'} aria-label="Refresh workspaces">
          <RefreshCw size={11} />
        </button>
      </div>

      {!cwd.trim() && <p className="chat-workspaces-hint">Set a working directory above to use isolated workspaces.</p>}
      {repoError && <p className="chat-workspaces-hint">{repoError}</p>}
      {isolationHint && <p className="chat-workspaces-notice is-warn">{isolationHint}</p>}
      {overlaps.map((warning) => (
        <p key={warning} className="chat-workspaces-notice is-warn">{warning}</p>
      ))}

      {workspaces && (
        <>
          <ul className="chat-workspaces-list">
            {workspaces.map((workspace) => {
              const isActive = activePath === workspace.path;
              return (
                <li key={workspace.path} className={isActive ? 'is-active' : undefined}>
                  <div className="chat-workspace-row">
                    <span className="chat-workspace-branch" title={workspace.path}>{workspace.branch}</span>
                    {workspace.isPrimary && <span className="chat-workspace-tag">primary</span>}
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
              <span className="chat-workspaces-hint">branch cascade/{suggestWorkspaceSlug(slug) || '…'}</span>
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

export default ChatWorkspacePanel;
