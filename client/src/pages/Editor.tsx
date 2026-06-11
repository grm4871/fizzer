import { useState } from 'react';
import { Netdoc } from '../types';
import { apiFetch } from '../utils/api';

interface DocumentEditorProps {
  profileId: string;
  onBack: () => void;
  onDocumentCreated?: () => void;
  initialDocument?: Netdoc;
}

export default function Editor({ profileId, onBack, onDocumentCreated, initialDocument }: DocumentEditorProps) {
  const isNew = !initialDocument?.id;
  const [title, setTitle] = useState(initialDocument?.title || '');
  const [content, setContent] = useState(initialDocument?.content || '');
  const [privacy, setPrivacy] = useState(initialDocument?.privacy || 'private');
  const [status, setStatus] = useState(initialDocument?.status || 'draft');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  // Track original values to detect unsaved changes
  const [originalPrivacy] = useState(initialDocument?.privacy || 'private');
  const [originalStatus] = useState(initialDocument?.status || 'draft');

  const hasUnsavedChanges = privacy !== originalPrivacy || status !== originalStatus;

const handlePost = async () => {
  if (!title.trim() || !content.trim()) {
    setMessage('Title and content are required');
    return;
  }

  setSaving(true);
  setMessage('');

  try {
    const url = isNew
      ? '/api/documents'
      : `/api/documents/${initialDocument!.id}`;  // ← ! to assert id exists

    const method = isNew ? 'POST' : 'PATCH';

    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: title.trim(),
        content: content.trim(),
        authorId: profileId,
        status,
        privacy
      })
    });

    if (res.ok) {
      setMessage(isNew ? 'Document created!' : 'Document updated!');
      setTitle('');
      setContent('');
      onDocumentCreated?.();  // ← Trigger refresh in Profile
      setTimeout(onBack, 1000);
    } else {
      const error = await res.json();
      setMessage(error.error || 'Failed to save');
    }
  } catch (error) {
    console.error('Save error:', error);
    setMessage('Failed to save');
  } finally {
    setSaving(false);
  }
};

  return (
    <div className="editor-container">
      <div className="editor-header">
        <h2 className="editor-title">{isNew ? 'New Document' : `Edit ${title}`}</h2>
        <div className="editor-controls">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="editor-select">
            <option value="draft">Draft</option>
            <option value="working">Working</option>
          </select>

          <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} className="editor-select">
            <option value="private">Private</option>
            <option value="unlisted">Unlisted</option>
            <option value="public">Public</option>
          </select>

          <button onClick={onBack} className="rectangle-button editor-btn">Cancel</button>
          <button onClick={handlePost} disabled={saving} className={`rectangle-button editor-btn ${saving ? 'disabled' : ''}`}>
            {saving ? 'Saving...' : (isNew ? 'Create' : 'Update')}
          </button>
        </div>
      </div>

      <div className="editor-form max-width">
        <label className="editor-label">Title</label>
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Enter document title..." className="editor-input" />
      </div>

      {hasUnsavedChanges && (
        <div className="editor-unsaved">You have unsaved changes!</div>
      )}

      <div className="editor-form editor-content-wrapper">
        <label className="editor-label">Content (Markdown)</label>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="Write your document content here..." className="editor-textarea" />
      </div>

      {message && (
        <div className={`editor-message ${message.includes('created') || message.includes('updated') ? 'ok' : 'error'}`}>{message}</div>
      )}
    </div>
  );
}
