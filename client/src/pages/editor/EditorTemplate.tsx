import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle, useMemo } from 'react';
import DocumentButtons from '../../components/DocumentButtons';
import ConfirmUpdateSuccess from '../../components/ConfirmUpdateSuccess';
import { apiFetch } from '../../utils/api';
import { showToast } from '../../components/dialogue/Toast';
import ConfirmDialogue from '../../components/dialogue/ConfirmDialogue';
import EditorNormal, { EditorHandle } from './editorNormal';
import EditorVi, { EditorViRef } from './editorVi';
import EditorMonospace from './editorMonospace';
import { useYjs } from '../../hooks/useYjs';
import '../netdoc-editor.css';

// Types for the template configuration
export interface EditorConfig {
  mode: 'new' | 'write';
  profileId: string;
  // Edit mode specific
  netdoc?: any;
  netdocId?: string;
  isOwner?: boolean;
  isBookmarked?: boolean;
  isRemote?: boolean;
  // Space to add new netdoc to (optional - defaults to profile space)
  spaceId?: string;
  // Callbacks
  onCreated?: (netdocId: string, netdocName: string) => void;
  onNetdocUpdate?: (updatedNetdoc: any) => void;
  onNetdocLoad?: (netdoc: any) => void;
  onCancel?: (force?: boolean) => void;
  onSaveComplete?: () => void;
  onVersions?: () => void;
  onPermissions?: () => void;
  onBookmarkChange?: () => void;
  onContentChange?: (hasChanges: boolean) => void;
  onTitleChange?: (title: string) => void;
  initialTitle?: string;
  // Common options
  pendingPermissions?: {
    isUnlisted: boolean;
    hideHistoryFromNonEditors: boolean;
    readMode?: 'whitelist' | 'blacklist';
    commentMode?: 'whitelist' | 'blacklist';
    writeMode?: 'whitelist' | 'blacklist';
    readUsers: string[];
    editUsers: string[];
    commentUsers: string[];
    readBlacklist: string[];
    editBlacklist: string[];
    commentBlacklist: string[];
  } | null;
  isElectron?: boolean;
  hideButtons?: boolean;
}

export interface EditorTemplateState {
  editContent: string;
  editTitle: string;
  scrollPosition: number;
}

export interface EditorTemplateHandle {
  getState: () => EditorTemplateState | null;
}

// Shared hook for file operations
function useFileOperations(
  setEditContent: (content: string) => void,
  editContent: string,
  editTitle: string
) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        setEditContent(content);
        showToast('File loaded', 'success');
      }
    };
    reader.onerror = () => {
      showToast('Failed to read file', 'error');
    };
    reader.readAsText(file);
    e.target.value = '';
  }, [setEditContent]);

  const handleUpload = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDownload = useCallback(() => {
    const blob = new Blob([editContent], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(editTitle.trim() || 'Untitled').replace(/[^a-z0-9]/gi, '_').toLowerCase()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [editContent, editTitle]);

  return { fileInputRef, handleFileChange, handleUpload, handleDownload };
}

// Shared hook for title measurement
function useTitleMeasure(editTitle: string) {
  const titleMeasureRef = useRef<HTMLSpanElement>(null);
  const [titleWidth, setTitleWidth] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (titleMeasureRef.current) {
      setTitleWidth(titleMeasureRef.current.offsetWidth + 4);
    }
  }, [editTitle]);

  return { titleMeasureRef, titleWidth };
}

// Custom history tracker for undo/redo
function useHistory(initialContent: string) {
  const undoStackRef = useRef<string[]>([]);
  const redoStackRef = useRef<string[]>([]);
  const currentContentRef = useRef<string>(initialContent);
  const lastPushTimeRef = useRef<number>(0);

  // Push current state to undo stack (call before changing content)
  const pushState = useCallback((content: string) => {
    const now = Date.now();
    // Debounce: only push if 500ms passed since last push
    if (now - lastPushTimeRef.current > 500) {
      undoStackRef.current.push(currentContentRef.current);
      // Limit stack size to 100 entries
      if (undoStackRef.current.length > 100) {
        undoStackRef.current.shift();
      }
      redoStackRef.current = []; // Clear redo on new change
      lastPushTimeRef.current = now;
    }
    currentContentRef.current = content;
  }, []);

  const undo = useCallback((): string | null => {
    if (undoStackRef.current.length === 0) return null;
    redoStackRef.current.push(currentContentRef.current);
    const prev = undoStackRef.current.pop()!;
    currentContentRef.current = prev;
    return prev;
  }, []);

  const redo = useCallback((): string | null => {
    if (redoStackRef.current.length === 0) return null;
    undoStackRef.current.push(currentContentRef.current);
    const next = redoStackRef.current.pop()!;
    currentContentRef.current = next;
    return next;
  }, []);

  // Reset history when initial content changes (e.g., loading a new doc)
  const resetHistory = useCallback((content: string) => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    currentContentRef.current = content;
    lastPushTimeRef.current = 0;
  }, []);

  return { pushState, undo, redo, resetHistory };
}

// Apply pending permissions after netdoc creation
async function applyPendingPermissions(
  netdocId: string,
  profileId: string,
  pendingPermissions: NonNullable<EditorConfig['pendingPermissions']>
) {
  // Save visibility
  await apiFetch(`/api/netdoc/${netdocId}/visibility`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      isUnlisted: pendingPermissions.isUnlisted,
      hideHistoryFromNonEditors: pendingPermissions.hideHistoryFromNonEditors
    })
  });

  // Save modes if provided
  if (pendingPermissions.readMode || pendingPermissions.commentMode || pendingPermissions.writeMode) {
    await apiFetch(`/api/netdoc/${netdocId}/perms-mode`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(pendingPermissions.readMode && { read: pendingPermissions.readMode }),
        ...(pendingPermissions.commentMode && { comment: pendingPermissions.commentMode }),
        ...(pendingPermissions.writeMode && { write: pendingPermissions.writeMode }),
      })
    });
  }

  // Save permissions (grants)
  const permissionUpdates = [
    { type: 'read', users: pendingPermissions.readUsers },
    { type: 'write', users: pendingPermissions.editUsers },
    { type: 'comment', users: pendingPermissions.commentUsers }
  ];

  for (const perm of permissionUpdates) {
    for (const userId of perm.users) {
      await apiFetch(`/api/netdoc/${netdocId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: profileId,
          permissionType: perm.type,
          targetUserId: userId === 'private' ? null : userId,
          isBlacklist: false
        })
      });
    }
  }

  // Save blacklists
  const blacklistUpdates = [
    { type: 'read', users: pendingPermissions.readBlacklist },
    { type: 'write', users: pendingPermissions.editBlacklist },
    { type: 'comment', users: pendingPermissions.commentBlacklist }
  ];

  for (const blacklist of blacklistUpdates) {
    for (const userId of blacklist.users) {
      await apiFetch(`/api/netdoc/${netdocId}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: profileId,
          permissionType: blacklist.type,
          targetUserId: userId,
          isBlacklist: true
        })
      });
    }
  }
}

// The main template component
const EditorTemplate = forwardRef<EditorTemplateHandle, EditorConfig>((config, ref) => {
  const {
    mode,
    profileId,
    netdoc: propNetdoc,
    netdocId,
    isOwner = false,
    isBookmarked = false,
    isRemote = true,
    spaceId,
    onCreated,
    onNetdocUpdate,
    onNetdocLoad,
    onCancel,
    onSaveComplete,
    onVersions,
    onPermissions,
    onBookmarkChange,
    onContentChange,
    onTitleChange,
    initialTitle,
    pendingPermissions,
    isElectron = false,
    hideButtons = false,
  } = config;

  const isNew = mode === 'new';

  // State
  const [localNetdoc, setLocalNetdoc] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [editTitle, setEditTitle] = useState(initialTitle || '');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'success' | 'error'>('idle');
  const [jacketMissingLinks, setJacketMissingLinks] = useState<{ ids: string[]; links: string[] } | null>(null);
  const [editorMode, setEditorMode] = useState<'normal' | 'vi' | 'monospace'>('normal');

  const normalEditorRef = useRef<EditorHandle>(null);
  const viEditorRef = useRef<EditorViRef>(null);
  const monoEditorRef = useRef<EditorHandle>(null);

  // Yjs live collaboration
  const yjsUser = useMemo(() => ({
    id: profileId,
    name: localStorage.getItem('displayName') || 'Anonymous',
    color: localStorage.getItem('color') || 'd2b34e'
  }), [profileId]);

  const yjsEnabled = !isNew && !!netdocId && !!profileId;
  const { text: yjsText, updateText, remoteUsers, updateCursor } = useYjs({
    netdocId: netdocId || '',
    user: yjsUser,
    enabled: yjsEnabled
  });

  // Track whether a local edit is in progress to avoid echo loops
  const localEditRef = useRef(false);

  // Push remote Yjs text changes into editor state
  useEffect(() => {
    if (!yjsEnabled || localEditRef.current) return;
    if (yjsText !== undefined && yjsText !== editContent) {
      setEditContent(yjsText);
    }
  }, [yjsText, yjsEnabled]);

  // History tracking for undo/redo
  const { pushState, undo, redo, resetHistory } = useHistory(editContent);

  // Wrapped content change handler that tracks history + Yjs sync
  const handleContentChange = useCallback((newContent: string) => {
    pushState(newContent);
    localEditRef.current = true;
    setEditContent(newContent);
    updateText(newContent);
    // Reset flag after state flush
    requestAnimationFrame(() => { localEditRef.current = false; });
  }, [pushState, updateText]);

  const handleUndo = useCallback(() => {
    const prev = undo();
    if (prev !== null) setEditContent(prev);
  }, [undo]);

  const handleRedo = useCallback(() => {
    const next = redo();
    if (next !== null) setEditContent(next);
  }, [redo]);

  // Load editor mode preference from localStorage
  useEffect(() => {
    try {
      const savedSettings = localStorage.getItem('localsettings');
      if (savedSettings) {
        const settings = JSON.parse(savedSettings);
        if (settings.editorMode === 'vi' || settings.editorMode === 'monospace') {
          setEditorMode(settings.editorMode);
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }, []);

  // Use prop netdoc if available, otherwise use locally fetched
  const netdoc = propNetdoc || localNetdoc;

  // Hooks
  const { fileInputRef, handleFileChange, handleUpload, handleDownload } = useFileOperations(
    setEditContent,
    editContent,
    editTitle
  );
  const { titleMeasureRef, titleWidth } = useTitleMeasure(editTitle);

  // Fetch netdoc if not provided via props (edit mode only)
  useEffect(() => {
    if (isNew || propNetdoc || !netdocId) {
      console.log('[EditorTemplate] Skipping fetch:', { isNew, propNetdoc: !!propNetdoc, netdocId });
      return;
    }

    console.log('[EditorTemplate] Fetching netdoc:', netdocId);
    setIsLoading(true);
    const abortController = new AbortController();

    (async () => {
      try {
        const res = await apiFetch(`/api/netdoc/${netdocId}`, {
          signal: abortController.signal
        });
        console.log('[EditorTemplate] Fetch response:', res.status, res.statusText);
        if (res.ok) {
          const data = await res.json();
          console.log('[EditorTemplate] Netdoc data:', data);
          setLocalNetdoc(data);
          setEditContent(data.content || '');
          setEditTitle(data.name || '');
          resetHistory(data.content || '');
          onNetdocLoad?.(data);
        } else {
          const errorData = await res.json().catch(() => null);
          console.error('[EditorTemplate] Fetch failed:', res.status, errorData);
        }
      } catch (err: any) {
        if (err?.name !== 'AbortError') {
          console.error('[EditorTemplate] Error fetching netdoc:', err);
        }
      } finally {
        setIsLoading(false);
      }
    })();

    return () => abortController.abort();
  }, [netdocId, propNetdoc, onNetdocLoad, isNew]);

  // Update content when netdoc changes (edit mode)
  useEffect(() => {
    if (isNew) return;
    if (netdoc) {
      setEditContent(netdoc.content || '');
      setEditTitle(netdoc.name || '');
      resetHistory(netdoc.content || '');
    }
  }, [netdoc?.id, isNew, resetHistory]);

  // Update title when netdoc name changes (e.g. rename from sidebar)
  useEffect(() => {
    if (isNew || !netdoc) return;
    setEditTitle(netdoc.name || '');
  }, [netdoc?.name, isNew]);

  // Compute if there are unsaved changes
  const originalContent = netdoc?.content || '';
  const originalTitle = netdoc?.name || '';
  const hasChanges = isNew
    ? (editContent.trim().length > 0 || editTitle.trim().length > 0)
    : (editContent !== originalContent || editTitle !== originalTitle);

  // Notify parent of change state
  useEffect(() => {
    onContentChange?.(hasChanges);
  }, [hasChanges, onContentChange]);

  // Clear saved indicator when there are new changes
  useEffect(() => {
    if (hasChanges && saveStatus === 'success') {
      setSaveStatus('idle');
    }
  }, [hasChanges, saveStatus]);

  // Auto-dismiss saved indicator after 5 seconds
  useEffect(() => {
    if (saveStatus === 'success') {
      const timer = setTimeout(() => setSaveStatus('idle'), 5000);
      return () => clearTimeout(timer);
    }
  }, [saveStatus]);

  // Debounced title change callback
  useEffect(() => {
    if (!onTitleChange) return;
    const timer = setTimeout(() => {
      onTitleChange(editTitle);
    }, 300);
    return () => clearTimeout(timer);
  }, [editTitle, onTitleChange]);

  // Expose state via ref (for edit mode)
  useImperativeHandle(ref, () => ({
    getState: () => ({
      editContent,
      editTitle,
      scrollPosition: 0,
    })
  }));

  // Handle save
  const handleSave = useCallback(async () => {
    if (!isNew && !netdoc) return;

    setSaveStatus('saving');
    try {
      if (isNew) {
        // CREATE: POST new netdoc
        const res = await apiFetch('/api/netdoc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: profileId,
            name: editTitle.trim() || 'Untitled',
            content: editContent,
            ...(spaceId && { spaceId }),
          })
        });

        if (res.ok) {
          const created = await res.json();

          if (pendingPermissions) {
            try {
              await applyPendingPermissions(created.id, profileId, pendingPermissions);
            } catch (permErr) {
              console.error('Error applying permissions:', permErr);
            }
          }

          setSaveStatus('success');
          onCreated?.(created.id, created.name || 'Untitled');
        } else {
          setSaveStatus('error');
          showToast('Failed to create netdoc', 'error');
        }
      } else if (!isRemote && isElectron && window.electronAPI) {
        // EDIT: Save to local SQLite
        const result = await window.electronAPI.saveNetdoc({
          id: netdoc.id,
          name: editTitle,
          content: editContent,
          canWrite: true
        });

        if (result?.success) {
          setSaveStatus('success');
          onSaveComplete?.();
        } else {
          setSaveStatus('error');
        }
      } else {
        // EDIT: Save to remote server
        const res = await apiFetch(`/api/netdoc/${netdoc.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userId: profileId,
            name: editTitle,
            content: editContent
          })
        });

        if (res.ok) {
          const updated = await res.json();
          setLocalNetdoc(updated);
          setEditContent(updated.content);
          setEditTitle(updated.name || editTitle);
          setSaveStatus('success');
          onNetdocUpdate?.(updated);
          onSaveComplete?.();
        } else if (res.status === 400) {
          const data = await res.json();
          if (data.error === 'missing_jacket_links' && data.missingNetdocIds?.length) {
            setSaveStatus('idle');
            setJacketMissingLinks({ ids: data.missingNetdocIds, links: data.missingLinks || data.missingNetdocIds.map((id: string) => `/netdoc/${id}`) });
          } else {
            setSaveStatus('error');
          }
        } else {
          setSaveStatus('error');
        }
      }
    } catch (err) {
      console.error('Error saving netdoc:', err);
      setSaveStatus('error');
    }
  }, [isNew, netdoc, profileId, editTitle, editContent, spaceId, pendingPermissions, isRemote, isElectron, onCreated, onSaveComplete, onNetdocUpdate]);

  const handleCancel = () => {
    if (!isNew) {
      setEditContent(netdoc?.content || '');
      setEditTitle(netdoc?.name || '');
    }
    onCancel?.();
  };

  if (isLoading) {
    return <div style={{ padding: '1em', color: '#888' }}>Loading...</div>;
  }

  if (!isNew && !netdoc) {
    return <div style={{ padding: '1em', color: '#888' }}>No document loaded</div>;
  }

  return (
    <div className="page-container" style={{ position: 'relative', background: '#111' }}>
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        accept=".md,.txt,.html,text/plain,text/markdown,text/html"
        style={{ display: 'none' }}
      />

      {/* Document buttons toolbar with title */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0.5em',
        flexShrink: 0,
        gap: '0.5em',
        background: '#111',
      }}>
        {!hideButtons && (
          <DocumentButtons
            mode="write"
            isEditor={true}
            isOwner={isNew || isOwner}
            isBookmarked={isBookmarked}
            onSave={handleSave}
            onCancel={handleCancel}
            onUpload={handleUpload}
            onDownload={handleDownload}
            onVersions={isNew ? undefined : onVersions}
            onPermissions={onPermissions}
            onBookmarkChange={isNew ? undefined : onBookmarkChange}
            isRemote={isRemote}
            isElectron={isElectron}
            docId={netdoc?.id || ''}
            hasChanges={hasChanges}
            isNewMode={isNew}
            hasContent={editContent.length > 0 || editTitle.length > 0}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0, marginLeft: '1em', gap: '0.5em' }}>
          {/* Hidden span to measure title width */}
          <span
            ref={titleMeasureRef}
            style={{
              position: 'absolute',
              visibility: 'hidden',
              whiteSpace: 'pre',
              fontSize: '1.1em',
              fontWeight: 'bold',
            }}
          >
            {editTitle || 'Netdoc title...'}
          </span>
          <input
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            placeholder="Netdoc title..."
            style={{
              background: 'transparent',
              border: 'none',
              color: '#dec572',
              fontSize: '1.1em',
              fontWeight: 'bold',
              outline: 'none',
              width: titleWidth,
              minWidth: 0,
            }}
          />
          <div style={{ marginLeft: '1em' }}>
            <ConfirmUpdateSuccess
              status={saveStatus}
              onDismiss={() => setSaveStatus('idle')}
            />
          </div>
        </div>
        <span style={{ color: '#666', fontSize: '0.85em', flexShrink: 0, marginRight: '1em' }}>
          {editContent.trim() ? editContent.trim().split(/\s+/).length : 0} words
        </span>
      </div>

      {/* Scrollable editor area */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1em',
        minHeight: 0,
      }}>
        {editorMode === 'normal' ? (
          <EditorNormal
            ref={normalEditorRef}
            content={editContent}
            onContentChange={handleContentChange}
            onSave={handleSave}
            onUndo={handleUndo}
            onRedo={handleRedo}
            remoteUsers={remoteUsers}
            onCursorChange={updateCursor}
          />
        ) : editorMode === 'monospace' ? (
          <EditorMonospace
            ref={monoEditorRef}
            content={editContent}
            onContentChange={handleContentChange}
            onSave={handleSave}
            onUndo={handleUndo}
            onRedo={handleRedo}
            remoteUsers={remoteUsers}
            onCursorChange={updateCursor}
          />
        ) : (
          <EditorVi
            ref={viEditorRef}
            content={editContent}
            onContentChange={handleContentChange}
            onSave={handleSave}
            onQuit={onCancel}
            onForceQuit={() => {
              // Reset content to original and cancel without confirm
              if (!isNew && netdoc) {
                setEditContent(netdoc.content || '');
                setEditTitle(netdoc.name || '');
              }
              onCancel?.(true);
            }}
            onUndo={handleUndo}
            onRedo={handleRedo}
            remoteUsers={remoteUsers}
            onCursorChange={updateCursor}
          />
        )}
      </div>

      {jacketMissingLinks && (
        <ConfirmDialogue
          message={`Jacket is missing ${jacketMissingLinks.links.length} space link${jacketMissingLinks.links.length > 1 ? 's' : ''}: ${jacketMissingLinks.links.join(', ')}!`}
          confirmLabel="Auto-append"
          cancelLabel="I'll do it myself"
          onConfirm={() => {
            const appended = jacketMissingLinks.links.join('\n');
            const newContent = editContent ? `${editContent}\n${appended}` : appended;
            setEditContent(newContent);
            setJacketMissingLinks(null);
            // Re-save with appended content after state updates
            setTimeout(async () => {
              setSaveStatus('saving');
              try {
                const res = await apiFetch(`/api/netdoc/${netdoc.id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ userId: profileId, name: editTitle, content: newContent })
                });
                if (res.ok) {
                  const updated = await res.json();
                  setEditContent(updated.content);
                  setEditTitle(updated.name || editTitle);
                  setSaveStatus('success');
                  onNetdocUpdate?.(updated);
                  onSaveComplete?.();
                } else {
                  setSaveStatus('error');
                }
              } catch {
                setSaveStatus('error');
              }
            }, 0);
          }}
          onCancel={() => setJacketMissingLinks(null)}
        />
      )}

    </div>
  );
});

EditorTemplate.displayName = 'EditorTemplate';
export default EditorTemplate;
