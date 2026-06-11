import { useEffect, useMemo, useState } from 'react';

type User = { id: number; username: string };
type DocSummary = { id: number; title: string; creator_id: number; creator_username: string; updated_at: string };
type Doc = DocSummary & { content: string; created_at: string };

const API_BASE = import.meta.env.VITE_API_URL || '';

async function api(path: string, options: RequestInit = {}) {
  const token = localStorage.getItem('docs_token');
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401) localStorage.removeItem('docs_token');
  return res;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [activeDoc, setActiveDoc] = useState<Doc | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [status, setStatus] = useState('');

  const dirty = activeDoc ? draftTitle !== activeDoc.title || draftContent !== activeDoc.content : false;
  const sortedDocs = useMemo(() => docs, [docs]);

  async function loadDocs(selectFirst = false) {
    const res = await api('/api/docs');
    if (!res.ok) return;
    const data = await res.json();
    setDocs(data.docs);
    if (selectFirst && data.docs[0]) setActiveId(data.docs[0].id);
  }

  async function loadDoc(id: number) {
    const res = await api(`/api/docs/${id}`);
    if (!res.ok) {
      setActiveDoc(null);
      setCanEdit(false);
      return;
    }
    const data = await res.json();
    setActiveDoc(data.doc);
    setCanEdit(data.canEdit);
    setDraftTitle(data.doc.title);
    setDraftContent(data.doc.content);
  }

  useEffect(() => {
    const token = localStorage.getItem('docs_token');
    if (!token) return;
    api('/api/me')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (!data?.user) return;
        setUser(data.user);
        loadDocs(true);
      })
      .catch(() => localStorage.removeItem('docs_token'));
  }, []);

  useEffect(() => {
    if (activeId) loadDoc(activeId);
  }, [activeId]);

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault();
    setAuthError('');
    const res = await api(`/api/auth/${authMode}`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      setAuthError(data.error || 'Authentication failed');
      return;
    }
    localStorage.setItem('docs_token', data.token);
    setUser(data.user);
    setPassword('');
    await loadDocs(true);
  }

  async function createDoc() {
    const res = await api('/api/docs', {
      method: 'POST',
      body: JSON.stringify({ title: 'Untitled', content: '' }),
    });
    const data = await res.json();
    if (res.ok) {
      await loadDocs();
      setActiveId(data.doc.id);
    }
  }

  async function saveDoc() {
    if (!activeDoc || !canEdit) return;
    const res = await api(`/api/docs/${activeDoc.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: draftTitle, content: draftContent }),
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || 'Save failed');
      return;
    }
    setActiveDoc(data.doc);
    setStatus('Saved');
    await loadDocs();
    window.setTimeout(() => setStatus(''), 1500);
  }

  async function deleteDoc() {
    if (!activeDoc || !canEdit) return;
    const res = await api(`/api/docs/${activeDoc.id}`, { method: 'DELETE' });
    if (res.ok) {
      const remaining = docs.filter((doc) => doc.id !== activeDoc.id);
      setDocs(remaining);
      setActiveDoc(null);
      setActiveId(remaining[0]?.id ?? null);
    }
  }

  async function moveDoc(id: number, direction: -1 | 1) {
    const index = docs.findIndex((doc) => doc.id === id);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= docs.length) return;
    const next = [...docs];
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    setDocs(next);
    await api('/api/sidebar/reorder', {
      method: 'POST',
      body: JSON.stringify({ docIds: next.map((doc) => doc.id) }),
    });
  }

  function logout() {
    localStorage.removeItem('docs_token');
    setUser(null);
    setDocs([]);
    setActiveDoc(null);
    setActiveId(null);
  }

  if (!user) {
    return (
      <main className="auth-shell">
        <form className="auth-panel" onSubmit={submitAuth}>
          <h1>Docs</h1>
          <p>Sign in to write and organize documents. Only a document creator can edit it.</p>
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
      <aside className="sidebar">
        <div className="sidebar-top">
          <strong>{user.username}</strong>
          <button onClick={logout}>Log out</button>
        </div>
        <button className="new-doc" onClick={createDoc}>New doc</button>
        <div className="doc-list">
          {sortedDocs.map((doc, index) => (
            <div key={doc.id} className={`doc-row ${doc.id === activeId ? 'active' : ''}`}>
              <button className="doc-title" onClick={() => setActiveId(doc.id)}>
                <span>{doc.title}</span>
                <small>{doc.creator_username}</small>
              </button>
              <button title="Move up" disabled={index === 0} onClick={() => moveDoc(doc.id, -1)}>↑</button>
              <button title="Move down" disabled={index === docs.length - 1} onClick={() => moveDoc(doc.id, 1)}>↓</button>
            </div>
          ))}
          {docs.length === 0 && <div className="empty">No docs yet.</div>}
        </div>
      </aside>

      <section className="document">
        {!activeDoc ? (
          <div className="empty-state">Create a document to begin.</div>
        ) : (
          <>
            <header className="document-header">
              <div>
                <input
                  className="title-input"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  disabled={!canEdit}
                />
                <p>Created by {activeDoc.creator_username} · Updated {formatDate(activeDoc.updated_at)}</p>
              </div>
              <div className="actions">
                {!canEdit && <span className="readonly">Read only</span>}
                {status && <span>{status}</span>}
                {canEdit && <button disabled={!dirty} onClick={saveDoc}>Save</button>}
                {canEdit && <button className="danger" onClick={deleteDoc}>Delete</button>}
              </div>
            </header>
            <textarea
              className="editor"
              value={draftContent}
              onChange={(event) => setDraftContent(event.target.value)}
              disabled={!canEdit}
              placeholder="Write..."
            />
          </>
        )}
      </section>
      <Style />
    </main>
  );
}

function Style() {
  return (
    <style>{`
      * { box-sizing: border-box; }
      body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #101112; color: #ece8df; }
      button, input, textarea { font: inherit; }
      button { border: 1px solid #3b3d40; background: #1f2124; color: #ece8df; padding: 0.5rem 0.7rem; cursor: pointer; }
      button:disabled { opacity: 0.45; cursor: default; }
      .auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 1rem; }
      .auth-panel { width: min(420px, 100%); display: grid; gap: 1rem; border: 1px solid #303236; padding: 1.5rem; background: #17191b; }
      .auth-panel h1 { margin: 0; font-size: 2rem; }
      .auth-panel p { margin: 0; color: #a9adb4; line-height: 1.5; }
      label { display: grid; gap: 0.35rem; color: #c9cbd0; }
      input, textarea { width: 100%; border: 1px solid #34373c; background: #111315; color: #ece8df; padding: 0.65rem; outline: none; }
      input:focus, textarea:focus { border-color: #8ea7ff; }
      .error { color: #ff9c9c; }
      .link-button { background: transparent; border: 0; color: #aebcff; padding: 0; justify-self: start; }
      .app-shell { height: 100vh; display: grid; grid-template-columns: 290px minmax(0, 1fr); }
      .sidebar { border-right: 1px solid #303236; background: #151719; display: flex; flex-direction: column; min-height: 0; }
      .sidebar-top { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem; border-bottom: 1px solid #303236; }
      .new-doc { margin: 1rem; }
      .doc-list { overflow: auto; padding: 0 0.5rem 1rem; }
      .doc-row { display: grid; grid-template-columns: minmax(0, 1fr) 34px 34px; gap: 0.25rem; margin-bottom: 0.25rem; }
      .doc-title { text-align: left; min-width: 0; display: grid; gap: 0.2rem; }
      .doc-title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .doc-title small { color: #8d9299; }
      .doc-row.active .doc-title { border-color: #8ea7ff; background: #252936; }
      .empty, .empty-state { color: #8d9299; padding: 1rem; }
      .document { min-width: 0; display: flex; flex-direction: column; height: 100vh; }
      .document-header { display: flex; justify-content: space-between; gap: 1rem; padding: 1rem; border-bottom: 1px solid #303236; }
      .document-header p { margin: 0.35rem 0 0; color: #8d9299; }
      .title-input { border: 0; padding: 0; background: transparent; font-size: 1.8rem; font-weight: 700; }
      .actions { display: flex; align-items: center; gap: 0.5rem; white-space: nowrap; }
      .readonly { color: #ffd38e; }
      .danger { border-color: #6a3030; color: #ffb4b4; }
      .editor { flex: 1; resize: none; border: 0; padding: 1rem; line-height: 1.6; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.95rem; }
      @media (max-width: 760px) {
        .app-shell { grid-template-columns: 1fr; grid-template-rows: 42vh 58vh; }
        .sidebar { border-right: 0; border-bottom: 1px solid #303236; }
        .document { height: auto; min-height: 0; }
        .document-header { flex-direction: column; }
      }
    `}</style>
  );
}
