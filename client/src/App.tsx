import { useEffect, useMemo, useState } from 'react';
import { AgentPanel } from './components/AgentPanel';
import { SpecEditor } from './components/SpecEditor';
import { SpecTree } from './components/SpecTree';
import { api, type Spec, type SpecSummary, type SpecVersion, type User, type Workspace } from './api';
import { connectRunSocket } from './socket';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(null);
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  const [activeSpecId, setActiveSpecId] = useState<string | null>(null);
  const [activeSpec, setActiveSpec] = useState<Spec | null>(null);
  const [draftContent, setDraftContent] = useState('');
  const [versions, setVersions] = useState<SpecVersion[]>([]);
  const [diff, setDiff] = useState('');
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState('');

  const dirty = activeSpec ? draftContent !== activeSpec.content : false;
  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? null,
    [activeWorkspaceId, workspaces],
  );

  useEffect(() => {
    const token = localStorage.getItem('docs_token');
    if (!token) return;
    api<{ user: User }>('/api/me')
      .then((data) => {
        setUser(data.user);
        return loadWorkspaces();
      })
      .catch(() => localStorage.removeItem('docs_token'));
  }, []);

  useEffect(() => {
    if (activeWorkspaceId) loadSpecs(activeWorkspaceId, true);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (activeSpecId) loadSpec(activeSpecId);
  }, [activeSpecId]);

  useEffect(() => {
    if (!activeWorkspaceId) return;
    const socket = connectRunSocket();
    socket.emit('joinWorkspace', activeWorkspaceId);
    socket.on('workspace:changed', (message) => {
      if (message.workspaceId === activeWorkspaceId) void loadSpecs(activeWorkspaceId);
    });
    return () => {
      socket.emit('leaveWorkspace', activeWorkspaceId);
      socket.disconnect();
    };
  }, [activeWorkspaceId]);

  async function loadWorkspaces() {
    const data = await api<{ workspaces: Workspace[] }>('/api/workspaces');
    if (data.workspaces.length === 0) {
      const created = await api<{ workspace: Workspace }>('/api/workspaces', {
        method: 'POST',
        body: JSON.stringify({ name: 'This repo' }),
      });
      setWorkspaces([created.workspace]);
      setActiveWorkspaceId(created.workspace.id);
      return;
    }
    setWorkspaces(data.workspaces);
    setActiveWorkspaceId((current) => current ?? data.workspaces[0].id);
  }

  async function loadSpecs(workspaceId: number, selectFirst = false) {
    const data = await api<{ specs: SpecSummary[] }>(`/api/workspaces/${workspaceId}/specs`);
    setSpecs(data.specs);
    if (selectFirst) setActiveSpecId((current) => current ?? data.specs[0]?.id ?? null);
  }

  async function refreshSelectedSpec() {
    if (activeWorkspaceId) await loadSpecs(activeWorkspaceId);
    if (activeSpecId) await loadSpec(activeSpecId);
  }

  async function loadSpec(id: string) {
    const [specData, versionData] = await Promise.all([
      api<{ spec: Spec }>(`/api/specs/${id}`),
      api<{ versions: SpecVersion[] }>(`/api/specs/${id}/versions`),
    ]);
    setActiveSpec(specData.spec);
    setDraftContent(specData.spec.content);
    setVersions(versionData.versions);
    setDiff('');
  }

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    try {
      const data = await api<{ user: User; token: string }>(`/api/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      localStorage.setItem('docs_token', data.token);
      setUser(data.user);
      setPassword('');
      await loadWorkspaces();
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Authentication failed');
    }
  }

  async function createSpec() {
    if (!activeWorkspace) return;
    const title = 'Untitled Spec';
    const data = await api<{ spec: Spec }>(`/api/workspaces/${activeWorkspace.id}/specs`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    await loadSpecs(activeWorkspace.id);
    setActiveSpecId(data.spec.id);
  }

  async function saveSpec() {
    if (!activeSpec) return;
    setStatus('');
    try {
      const data = await api<{ spec: Spec }>(`/api/specs/${activeSpec.id}`, {
        method: 'PUT',
        body: JSON.stringify({ content: draftContent }),
      });
      setActiveSpec(data.spec);
      setDraftContent(data.spec.content);
      setStatus('Saved');
      await Promise.all([loadSpecs(data.spec.workspace_id), loadVersions(data.spec.id)]);
      window.setTimeout(() => setStatus(''), 1500);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    }
  }

  async function loadVersions(specId: string) {
    const data = await api<{ versions: SpecVersion[] }>(`/api/specs/${specId}/versions`);
    setVersions(data.versions);
  }

  async function rescanWorkspace() {
    if (!activeWorkspaceId) return;
    const data = await api<{ specs: SpecSummary[] }>(`/api/workspaces/${activeWorkspaceId}/rescan`, { method: 'POST' });
    setSpecs(data.specs);
  }

  async function showLatestDiff() {
    if (!activeSpec) return;
    const data = await api<{ diff: string }>(`/api/specs/${activeSpec.id}/diff`);
    setDiff(data.diff);
  }

  function logout() {
    localStorage.removeItem('docs_token');
    setUser(null);
    setWorkspaces([]);
    setSpecs([]);
    setActiveSpec(null);
    setActiveSpecId(null);
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <form className="auth-panel" onSubmit={submitAuth}>
          <h1>Cascade</h1>
          <p>Sign in to browse and edit implementation specs from a target repo.</p>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoFocus />
          </label>
          <label>
            Password
            <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" />
          </label>
          {authError && <div className="error">{authError}</div>}
          <button type="submit">{authMode === 'login' ? 'Log in' : 'Create account'}</button>
          <button type="button" className="link-button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>
            {authMode === 'login' ? 'Need an account?' : 'Already have an account?'}
          </button>
        </form>
        <Style />
      </main>
    );
  }

  return (
    <main className="app-shell">
      <SpecTree
        username={user.username}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        specs={specs}
        activeSpecId={activeSpecId}
        onSelectWorkspace={setActiveWorkspaceId}
        onSelectSpec={setActiveSpecId}
        onNewSpec={createSpec}
        onRescan={rescanWorkspace}
        onLogout={logout}
      />
      <SpecEditor
        spec={activeSpec}
        content={draftContent}
        dirty={dirty}
        status={status}
        versions={versions}
        diff={diff}
        preview={preview}
        onContentChange={setDraftContent}
        onSave={saveSpec}
        onPreviewChange={setPreview}
        onDiffLatest={showLatestDiff}
      />
      <AgentPanel spec={activeSpec} onSpecChanged={refreshSelectedSpec} />
      <Style />
    </main>
  );
}

function Style() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #111315; color: #ece8df; }
      button, input, textarea, select { font: inherit; }
      button, select { border: 1px solid #3b3d40; background: #1f2124; color: #ece8df; padding: 0.5rem 0.7rem; cursor: pointer; border-radius: 6px; }
      button:disabled { opacity: 0.45; cursor: default; }
      input, textarea { width: 100%; border: 1px solid #34373c; background: #111315; color: #ece8df; padding: 0.65rem; outline: none; border-radius: 6px; }
      input:focus, textarea:focus, select:focus { border-color: #8ea7ff; }
      .auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
      .auth-panel { width: min(420px, 100%); display: grid; gap: 1rem; border: 1px solid #303236; padding: 1.5rem; background: #17191b; border-radius: 8px; }
      .auth-panel h1 { margin: 0; font-size: 2rem; }
      .auth-panel p { margin: 0; color: #a9adb4; line-height: 1.5; }
      label { display: grid; gap: 0.35rem; color: #c9cbd0; }
      .error { color: #ff9c9c; }
      .link-button { background: transparent; border: 0; color: #aebcff; padding: 0; justify-self: start; }
      .app-shell { height: 100vh; display: grid; grid-template-columns: 290px minmax(0, 1fr) 340px; }
      .sidebar, .agent-panel { background: #151719; display: flex; flex-direction: column; min-height: 0; }
      .sidebar { border-right: 1px solid #303236; }
      .agent-panel { border-left: 1px solid #303236; overflow: hidden; }
      .sidebar-top, .agent-panel header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem; border-bottom: 1px solid #303236; }
      .workspace-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; padding: 1rem; border-bottom: 1px solid #303236; }
      .workspace-tools select { min-width: 0; }
      .new-doc { margin: 1rem; }
      .doc-list { overflow: auto; padding: 0 0.5rem 1rem; }
      .spec-row { width: 100%; text-align: left; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.25rem 0.5rem; margin-bottom: 0.35rem; }
      .spec-row.active { border-color: #8ea7ff; background: #252936; }
      .spec-title, .spec-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .spec-row small { grid-column: 1 / -1; color: #8d9299; }
      .badge { border: 1px solid #4a4d52; border-radius: 999px; padding: 0.05rem 0.45rem; font-size: 0.72rem; color: #d9dce2; }
      .badge.ready { border-color: #667a45; color: #d9f5b4; }
      .badge.implemented { border-color: #477467; color: #b9f3de; }
      .badge.implementing { border-color: #7a6845; color: #ffe1a9; }
      .badge.stale { border-color: #7c4c4c; color: #ffb4b4; }
      .empty, .empty-state { color: #8d9299; padding: 1rem; }
      .document { min-width: 0; display: flex; flex-direction: column; height: 100vh; }
      .document-header { display: flex; justify-content: space-between; gap: 1rem; padding: 1rem; border-bottom: 1px solid #303236; }
      .document-header h1 { margin: 0; font-size: 1.3rem; }
      .document-header p { margin: 0.35rem 0 0; color: #8d9299; }
      .actions { display: flex; align-items: center; gap: 0.5rem; white-space: nowrap; }
      .danger { border-color: #6a3030; color: #ffb4b4; }
      .frontmatter-strip { display: grid; grid-template-columns: 140px 1fr 1fr; gap: 0.75rem; padding: 0.75rem 1rem; border-bottom: 1px solid #303236; background: #17191b; }
      .frontmatter-strip label span { font-size: 0.75rem; color: #8d9299; }
      .editor { flex: 1; resize: none; border: 0; border-radius: 0; padding: 1rem; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.95rem; }
      .preview { flex: 1; overflow: auto; padding: 1rem 1.25rem; line-height: 1.65; }
      .preview h1, .preview h2, .preview h3 { line-height: 1.2; }
      .history-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; padding: 0.65rem 1rem; border-top: 1px solid #303236; color: #a9adb4; }
      .diff-view { max-height: 30vh; overflow: auto; margin: 0; padding: 0.75rem 1rem; border-top: 1px solid #303236; background: #0d0f10; }
      .diff-view code { display: block; min-height: 1.35rem; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.82rem; }
      .diff-view .add { color: #a5f3c8; background: #102218; }
      .diff-view .remove { color: #ffb4b4; background: #261414; }
      .diff-view .hunk { color: #aebcff; }
      .agent-panel h2 { margin: 0; font-size: 1rem; }
      .run-actions { display: flex; gap: 0.4rem; }
      .panel-error { color: #ffb4b4; padding: 0.75rem 1rem; border-bottom: 1px solid #303236; }
      .runs-panel { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
      .run-list { flex: 0 0 auto; border-bottom: 1px solid #303236; max-height: 24vh; overflow: auto; padding: 0.5rem; }
      .run-row { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.25rem 0.5rem; text-align: left; margin-bottom: 0.35rem; }
      .run-row.active { border-color: #8ea7ff; background: #252936; }
      .run-row small { grid-column: 1 / -1; color: #8d9299; }
      .run-detail { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
      .run-meta { display: grid; gap: 0.25rem; padding: 0.8rem 1rem; border-bottom: 1px solid #303236; }
      .run-meta strong, .run-meta small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .run-meta small { color: #a9adb4; }
      .run-feed { flex: 1 1 auto; min-height: 0; overflow: auto; display: grid; align-content: start; gap: 0.5rem; padding: 0.75rem 1rem; }
      .event-line { display: grid; gap: 0.2rem; padding-bottom: 0.5rem; border-bottom: 1px solid #25282c; }
      .event-line span { color: #8ea7ff; font-size: 0.75rem; text-transform: uppercase; }
      .event-line p { margin: 0; color: #d6d8dd; line-height: 1.4; overflow-wrap: anywhere; }
      .review-actions { display: flex; gap: 0.5rem; padding: 0.75rem 1rem; border-top: 1px solid #303236; border-bottom: 1px solid #303236; }
      .follow-up { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; padding: 0.75rem 1rem; border-top: 1px solid #303236; }
      .run-empty { padding: 1rem; color: #a9adb4; line-height: 1.5; }
      .run-empty strong { display: block; color: #ece8df; margin-bottom: 0.35rem; }
      .threads-panel { flex: 0 0 auto; max-height: 32vh; border-top: 1px solid #303236; padding: 0.75rem 1rem; overflow: hidden; }
      .threads-panel h3 { margin: 0 0 0.6rem; font-size: 0.95rem; }
      .thread-form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.5rem; margin-bottom: 0.75rem; }
      .thread-list { display: grid; gap: 0.6rem; max-height: 22vh; overflow: auto; padding-right: 0.25rem; }
      .thread-row { display: grid; gap: 0.35rem; border-bottom: 1px solid #25282c; padding-bottom: 0.6rem; }
      .thread-row small { color: #8d9299; }
      .thread-row p { margin: 0; line-height: 1.4; color: #d6d8dd; overflow-wrap: anywhere; }
      .thread-row div { display: flex; gap: 0.4rem; }
      @media (max-width: 1050px) {
        .app-shell { grid-template-columns: 260px minmax(0, 1fr); }
        .agent-panel { display: none; }
      }
      @media (max-width: 760px) {
        .app-shell { height: auto; min-height: 100vh; grid-template-columns: 1fr; grid-template-rows: 38vh 62vh; }
        .sidebar { border-right: 0; border-bottom: 1px solid #303236; }
        .document { height: auto; min-height: 0; }
        .document-header, .frontmatter-strip { grid-template-columns: 1fr; flex-direction: column; }
      }
    `}</style>
  );
}
