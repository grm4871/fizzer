import type { SpecSummary, Workspace } from '../api';

type Props = {
  workspaces: Workspace[];
  activeWorkspaceId: number | null;
  specs: SpecSummary[];
  activeSpecId: string | null;
  onSelectWorkspace: (id: number) => void;
  onSelectSpec: (id: string) => void;
  onNewSpec: () => void;
  onRescan: () => void;
  onLogout: () => void;
  username: string;
};

export function SpecTree({
  workspaces,
  activeWorkspaceId,
  specs,
  activeSpecId,
  onSelectWorkspace,
  onSelectSpec,
  onNewSpec,
  onRescan,
  onLogout,
  username,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <strong>{username}</strong>
        <button onClick={onLogout}>Log out</button>
      </div>
      <div className="workspace-tools">
        <select value={activeWorkspaceId ?? ''} onChange={(event) => onSelectWorkspace(Number(event.target.value))}>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
          ))}
        </select>
        <button onClick={onRescan} disabled={!activeWorkspaceId}>Rescan</button>
      </div>
      <button className="new-doc" onClick={onNewSpec} disabled={!activeWorkspaceId}>New spec</button>
      <div className="doc-list">
        {specs.map((spec) => (
          <button
            key={spec.id}
            className={`spec-row ${spec.id === activeSpecId ? 'active' : ''}`}
            onClick={() => onSelectSpec(spec.id)}
          >
            <span className="spec-title">{spec.title}</span>
            <span className={`badge ${spec.status}`}>{spec.status}</span>
            <small>{spec.rel_path}</small>
          </button>
        ))}
        {specs.length === 0 && <div className="empty">No specs indexed.</div>}
      </div>
    </aside>
  );
}
