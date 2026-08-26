import { useEffect, useRef, useMemo, useCallback, useState, memo } from 'react';
import type { Note, NoteSummary } from '../api';
import { api, formatRelativeDate, type NotePublishInfo } from '../api';
import { NOTE_DND_TYPE, noteEmbedMarkdown } from '../docEmbeds';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder, drawSelection } from '@codemirror/view';
import { EditorState, Prec, StateEffect, type Extension } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, indentOnInput, bracketMatching, defaultHighlightStyle } from '@codemirror/language';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { FileText, Link2, Save, Search, X } from 'lucide-react';
import { KanbanView } from './KanbanView';
import { hasObsidianKanbanMarker } from './kanbanMarkdown';
import { NoteEditorToolbar } from './NoteEditorToolbar';
import { cascadeTheme, cascadeHighlightStyle } from './noteEditorTheme';
import { NOTE_IMAGE_MAX_BYTES, NOTE_AUDIO_MAX_BYTES, imageFileFromDataTransfer, readFileAsBase64 } from './noteEditorMedia';
import { createWysiwygDecorations, checkboxClickHandler } from './noteEditorDecorations';
import { filterLinkableNotes } from './noteEditorLinks';
import { toggleInlineFormat, toggleLinePrefix, insertLink, insertAtCursor, insertPrivateBlock, directiveAtCursor } from './noteEditorCommands';
interface NoteEditorProps {
  note: Note | null;
  content: string;
  onContentChange: (content: string) => void;
  onSave: () => void | Promise<unknown>;
  onRename?: (title: string) => Promise<void>;
  onExecuteDirective?: (prompt: string) => void;
  onOpenWikilink?: (title: string) => void;
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
}
export const NoteEditor = memo(function NoteEditor({ note, content, onContentChange, onSave, onRename, onExecuteDirective, onOpenWikilink, notes = [], onOpenNote }: NoteEditorProps) {
  const [publishInfo, setPublishInfo] = useState<NotePublishInfo>({ published: false });
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishNotice, setPublishNotice] = useState('');
  const [viewMode, setViewMode] = useState<'editor' | 'kanban'>('editor');
  const [noteLinkPickerOpen, setNoteLinkPickerOpen] = useState(false);
  const [noteLinkQuery, setNoteLinkQuery] = useState('');
  const [mobileSaveState, setMobileSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  const onSaveRef = useRef(onSave);
  const onExecuteDirectiveRef = useRef(onExecuteDirective);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  const onOpenNoteRef = useRef(onOpenNote);
  const insertImageFromFileRef = useRef<(file: File, view?: EditorView, coords?: { x: number; y: number }) => Promise<boolean>>(async () => false);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const saveFeedbackTimerRef = useRef<number | null>(null);
  // Keep notes off the extensions dependency graph — setNotes from vault soft
  // refresh was reconfigure-ing CodeMirror (full destroy/rebuild of plugins)
  // and freezing the UI for a second or two on every background return.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const linkableNotes = useMemo(
    () => filterLinkableNotes(notes, note?.id, noteLinkQuery),
    [notes, note?.id, noteLinkQuery],
  );
  const kanbanBoardCount = useMemo(() => (
    notes.filter((candidate) => candidate.id !== note?.id && hasObsidianKanbanMarker(candidate.content_preview)).length
      + (hasObsidianKanbanMarker(content) ? 1 : 0)
  ), [content, note?.id, notes]);

  useEffect(() => () => {
    if (saveFeedbackTimerRef.current !== null) window.clearTimeout(saveFeedbackTimerRef.current);
  }, []);

  // Inline, editable note title (Obsidian-style). Synced from the note.
  const [titleDraft, setTitleDraft] = useState(note?.title ?? '');
  useEffect(() => { setTitleDraft(note?.title ?? ''); }, [note?.id, note?.title]);
  useEffect(() => {
    if (!note?.id || typeof localStorage === 'undefined') {
      setViewMode(hasObsidianKanbanMarker(content) ? 'kanban' : 'editor');
      return;
    }
    const savedMode = localStorage.getItem(`cascade_note_view:${note.id}`);
    if (savedMode === 'kanban' || savedMode === 'editor') {
      setViewMode(savedMode);
      return;
    }
    setViewMode(hasObsidianKanbanMarker(content) ? 'kanban' : 'editor');
  }, [content, note?.id]);

  const selectViewMode = useCallback((mode: 'editor' | 'kanban') => {
    setViewMode(mode);
    if (note?.id && typeof localStorage !== 'undefined') {
      localStorage.setItem(`cascade_note_view:${note.id}`, mode);
    }
    if (mode === 'editor') requestAnimationFrame(() => viewRef.current?.focus());
  }, [note?.id]);

  const commitTitle = useCallback(() => {
    const next = titleDraft.trim();
    if (!note || !next || next === note.title) {
      setTitleDraft(note?.title ?? '');
      return;
    }
    onRename?.(next)?.catch(() => setTitleDraft(note.title));
  }, [titleDraft, note, onRename]);

  useEffect(() => {
    if (!note?.id) {
      setPublishInfo({ published: false });
      return;
    }
    let cancelled = false;
    api<NotePublishInfo>(`/api/notes/${note.id}/publish`)
      .then((info) => { if (!cancelled) setPublishInfo(info); })
      .catch(() => { if (!cancelled) setPublishInfo({ published: false }); });
    return () => { cancelled = true; };
  }, [note?.id, note?.updated_at]);

  const flashPublishNotice = useCallback((message: string) => {
    setPublishNotice(message);
    window.setTimeout(() => setPublishNotice(''), 2400);
  }, []);

  const copyPublicUrl = useCallback(async (url: string) => {
    await navigator.clipboard.writeText(url);
    flashPublishNotice('Copied public link');
  }, [flashPublishNotice]);

  const handlePublish = useCallback(async () => {
    if (!note || publishBusy) return;
    setPublishBusy(true);
    try {
      const result = await api<{ slug: string; url: string; published_at: string; updated_at: string }>(
        `/api/notes/${note.id}/publish`,
        {
          method: 'POST',
          body: JSON.stringify({ title: titleDraft.trim() || note.title, content }),
        },
      );
      setPublishInfo({
        published: true,
        slug: result.slug,
        url: result.url,
        published_at: result.published_at,
        updated_at: result.updated_at,
      });
      await copyPublicUrl(result.url);
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : 'Publish failed');
    } finally {
      setPublishBusy(false);
    }
  }, [note, publishBusy, titleDraft, content, copyPublicUrl, flashPublishNotice]);

  const handleUnpublish = useCallback(async () => {
    if (!note || publishBusy || !publishInfo.published) return;
    if (!window.confirm('Unpublish this note? The public link will stop working.')) return;
    setPublishBusy(true);
    try {
      await api(`/api/notes/${note.id}/publish`, { method: 'DELETE' });
      setPublishInfo({ published: false });
      flashPublishNotice('Unpublished');
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : 'Unpublish failed');
    } finally {
      setPublishBusy(false);
    }
  }, [note, publishBusy, publishInfo.published, flashPublishNotice]);

  const insertMediaFromFile = useCallback(async (
    file: File,
    config: {
      accept: (file: File) => boolean;
      maxBytes: number;
      tooLargeLabel: string;
      uploadingLabel: string;
      mediaType: string;
      buildMarkdown: (file: File, url: string) => string;
      successLabel: string;
      failLabel: string;
    },
    view?: EditorView,
    coords?: { x: number; y: number },
  ) => {
    const editorView = view ?? viewRef.current;
    if (!note?.id || !editorView) return false;
    if (!config.accept(file)) return false;
    if (file.size > config.maxBytes) {
      flashPublishNotice(`${config.tooLargeLabel} is too large (max ${config.maxBytes / (1024 * 1024)}MB)`);
      return false;
    }

    flashPublishNotice(`Uploading ${config.uploadingLabel}...`);
    try {
      const data = await readFileAsBase64(file);
      const result = await api<{ url: string }>(`/api/notes/${note.id}/assets`, {
        method: 'POST',
        body: JSON.stringify({ media_type: config.mediaType, data, filename: file.name }),
      });
      const markdown = config.buildMarkdown(file, result.url);
      const pos = coords ? editorView.posAtCoords(coords) : null;
      const from = pos ?? editorView.state.selection.main.from;
      const to = pos ?? editorView.state.selection.main.to;
      const line = editorView.state.doc.lineAt(from);
      const prefix = line.text.trim() ? '\n\n' : '';
      const insert = `${prefix}${markdown}\n`;
      editorView.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      editorView.focus();
      flashPublishNotice(config.successLabel);
      return true;
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : config.failLabel);
      return false;
    }
  }, [note, flashPublishNotice]);

  const insertImageFromFile = useCallback((file: File, view?: EditorView, coords?: { x: number; y: number }) =>
    insertMediaFromFile(file, {
      accept: (f) => f.type.startsWith('image/'),
      maxBytes: NOTE_IMAGE_MAX_BYTES,
      tooLargeLabel: 'Image',
      uploadingLabel: 'image',
      mediaType: file.type,
      buildMarkdown: (f, url) => `![${(f.name || 'image').replace(/\.[^.]+$/, '') || 'image'}](${url})`,
      successLabel: 'Image pasted',
      failLabel: 'Image upload failed',
    }, view, coords),
  [insertMediaFromFile]);

  const insertAudioFromFile = useCallback((file: File) =>
    insertMediaFromFile(file, {
      accept: (f) => f.type === 'audio/mpeg' || f.name.toLowerCase().endsWith('.mp3'),
      maxBytes: NOTE_AUDIO_MAX_BYTES,
      tooLargeLabel: 'MP3',
      uploadingLabel: 'MP3',
      mediaType: 'audio/mpeg',
      buildMarkdown: (f, url) => `[${f.name || 'audio.mp3'}](${url})`,
      successLabel: 'MP3 attached',
      failLabel: 'MP3 upload failed',
    }),
  [insertMediaFromFile]);

  const insertVideoFromFile = useCallback((file: File) =>
    insertMediaFromFile(file, {
      accept: (f) => f.type === 'video/mp4' || f.name.toLowerCase().endsWith('.mp4'),
      maxBytes: NOTE_AUDIO_MAX_BYTES,
      tooLargeLabel: 'MP4',
      uploadingLabel: 'MP4',
      mediaType: 'video/mp4',
      buildMarkdown: (f, url) => `![${f.name || 'video.mp4'}](${url})`,
      successLabel: 'MP4 embedded',
      failLabel: 'MP4 upload failed',
    }),
  [insertMediaFromFile]);

  insertImageFromFileRef.current = insertImageFromFile;

  const insertNoteEmbed = useCallback((noteId: string, coords?: { x: number; y: number }) => {
    const view = viewRef.current;
    if (!view) return false;
    const embedded = notesRef.current.find((item) => item.id === noteId);
    if (!embedded) return false;
    const insert = noteEmbedMarkdown(embedded);
    const pos = coords ? view.posAtCoords(coords) : null;
    const from = pos ?? view.state.selection.main.from;
    const to = pos ?? view.state.selection.main.to;
    const needsPrefix = from > 0 && !/\s/.test(view.state.doc.sliceString(from - 1, from)) ? ' ' : '';
    const needsSuffix = to < view.state.doc.length && !/\s/.test(view.state.doc.sliceString(to, to + 1)) ? ' ' : '';
    const text = `${needsPrefix}${insert}${needsSuffix}`;
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
      scrollIntoView: true,
    });
    view.focus();
    return true;
  }, []);

  // Keep refs updated
  contentRef.current = content;
  onContentChangeRef.current = onContentChange;
  onSaveRef.current = onSave;
  onExecuteDirectiveRef.current = onExecuteDirective;
  onOpenWikilinkRef.current = onOpenWikilink;
  onOpenNoteRef.current = onOpenNote;

  // Word count and stats
  const stats = useMemo(() => {
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    const chars = content.length;
    const readingTime = Math.max(1, Math.ceil(words / 200));
    return { words, chars, readingTime };
  }, [content]);

  // Build extensions
  const extensions: Extension[] = useMemo(
    () => [
      cascadeTheme,
      syntaxHighlighting(cascadeHighlightStyle),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      highlightSelectionMatches(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      history(),
      EditorView.lineWrapping,
      cmPlaceholder('Start writing...'),
      createWysiwygDecorations(
        () => notesRef.current,
      ),
      checkboxClickHandler,
      EditorView.domEventHandlers({
        dragover(event) {
          const hasNote = event.dataTransfer?.types.includes(NOTE_DND_TYPE);
          const hasImage = Array.from(event.dataTransfer?.items || [])
            .some((item) => item.kind === 'file' && item.type.startsWith('image/'));
          if (!hasNote && !hasImage) return false;
          event.preventDefault();
          event.dataTransfer!.dropEffect = 'copy';
          return true;
        },
        drop(event) {
          const noteId = event.dataTransfer?.getData(NOTE_DND_TYPE);
          if (noteId) {
            event.preventDefault();
            return insertNoteEmbed(noteId, { x: event.clientX, y: event.clientY });
          }
          const image = imageFileFromDataTransfer(event.dataTransfer);
          if (image) {
            event.preventDefault();
            void insertImageFromFileRef.current(image, undefined, { x: event.clientX, y: event.clientY });
            return true;
          }
          return false;
        },
        paste(event, view) {
          const image = imageFileFromDataTransfer(event.clipboardData);
          if (!image) return false;
          event.preventDefault();
          void insertImageFromFileRef.current(image, view);
          return true;
        },
        mousedown(event, view) {
          const target = event.target as HTMLElement;
          const privateBlock = target.closest('.cm-private-block') as HTMLElement | null;
          if (privateBlock) {
            const from = Number(privateBlock.dataset.privateFrom);
            if (Number.isFinite(from)) {
              event.preventDefault();
              const line = view.state.doc.lineAt(Math.min(from, view.state.doc.length));
              view.dispatch({
                selection: { anchor: Math.min(line.to + 1, view.state.doc.length) },
                scrollIntoView: true,
              });
              view.focus();
              return true;
            }
          }
          const docEmbed = target.closest('.cm-doc-embed');
          if (docEmbed) {
            const noteId = docEmbed.getAttribute('data-note-id');
            if (noteId) {
              event.preventDefault();
              onOpenNoteRef.current?.(noteId);
              return true;
            }
          }
          const wikilink = target.closest('.cm-wikilink');
          if (wikilink) {
            const title = wikilink.textContent?.trim();
            if (title) {
              event.preventDefault();
              onOpenWikilinkRef.current?.(title);
              return true;
            }
          }
          const extLink = target.closest('.cm-external-link');
          if (extLink) {
            const url = extLink.getAttribute('data-url');
            if (url) {
              event.preventDefault();
              window.open(url, '_blank', 'noopener,noreferrer');
              return true;
            }
          }
          return false;
        },
      }),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
        {
          key: 'Mod-s',
          run: () => {
            onSaveRef.current();
            return true;
          },
        },
        {
          key: 'Mod-b',
          run: (view) => {
            toggleInlineFormat(view, '**');
            return true;
          },
        },
        {
          key: 'Mod-i',
          run: (view) => {
            toggleInlineFormat(view, '*');
            return true;
          },
        },
        {
          key: 'Mod-k',
          run: (view) => {
            insertLink(view);
            return true;
          },
        },
      ]),
      // Highest precedence so it beats defaultKeymap's Mod-Enter (insertBlankLine):
      // run the {{ai: …}} directive at the cursor through the agent panel.
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              const prompt = directiveAtCursor(view);
              if (!prompt) return false;
              onExecuteDirectiveRef.current?.(prompt);
              return true;
            },
          },
        ])
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newDoc = update.state.doc.toString();
          contentRef.current = newDoc;
          onContentChangeRef.current(newDoc);
        }
      }),
    ],
    [insertNoteEmbed],
  );

  // Create/destroy editor
  useEffect(() => {
    if (!editorRef.current) return;

    const state = EditorState.create({
      doc: contentRef.current,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [note?.id]);

  // Reconfigure extensions dynamically when they change (callbacks only —
  // notes are read via notesRef so vault refresh never hits this path).
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: StateEffect.reconfigure.of(extensions),
      });
    }
  }, [extensions, note?.id]);

  // Update content when note changes externally
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== content) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    }
  }, [note?.id, content]);

  // Toolbar actions
  const toolbarAction = useCallback((action: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.focus();

    switch (action) {
      case 'bold':
        toggleInlineFormat(view, '**');
        break;
      case 'italic':
        toggleInlineFormat(view, '*');
        break;
      case 'strikethrough':
        toggleInlineFormat(view, '~~');
        break;
      case 'code':
        toggleInlineFormat(view, '`');
        break;
      case 'link':
        insertLink(view);
        break;
      case 'image':
        imageInputRef.current?.click();
        break;
      case 'h1':
        toggleLinePrefix(view, '# ');
        break;
      case 'h2':
        toggleLinePrefix(view, '## ');
        break;
      case 'h3':
        toggleLinePrefix(view, '### ');
        break;
      case 'checklist':
        toggleLinePrefix(view, '- [ ] ');
        break;
      case 'bullet':
        toggleLinePrefix(view, '- ');
        break;
      case 'numbered':
        toggleLinePrefix(view, '1. ');
        break;
      case 'hr':
        insertAtCursor(view, '\n---\n');
        break;
      case 'private':
        insertPrivateBlock(view);
        break;
    }
  }, []);

  const handleMobileSave = useCallback(async () => {
    if (mobileSaveState === 'saving') return;
    setMobileSaveState('saving');
    if (saveFeedbackTimerRef.current !== null) window.clearTimeout(saveFeedbackTimerRef.current);
    try {
      await Promise.resolve(onSaveRef.current());
      setMobileSaveState('saved');
      saveFeedbackTimerRef.current = window.setTimeout(() => setMobileSaveState('idle'), 1800);
    } catch {
      setMobileSaveState('error');
    }
  }, [mobileSaveState]);

  const insertNoteLink = useCallback((target: NoteSummary) => {
    const view = viewRef.current;
    if (!view) return;
    insertAtCursor(view, `[[${target.title.replace(/\]\]/g, '')}]]`);
    setNoteLinkPickerOpen(false);
    setNoteLinkQuery('');
    requestAnimationFrame(() => view.focus());
  }, []);

  if (!note) {
    return (
      <div className="editor-container">
        <div className="editor-empty">
          <span className="empty-icon"><FileText size={32} /></span>
          <span className="empty-title">No note selected</span>
          <span className="empty-hint">
            Choose a note from the sidebar or press <kbd>Ctrl+N</kbd> to create one
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="editor-container" id="editor-container">
      <NoteEditorToolbar
        toolbarAction={toolbarAction}
        imageInputRef={imageInputRef}
        insertImageFromFile={(file) => { void insertImageFromFile(file); }}
        insertVideoFromFile={(file) => { void insertVideoFromFile(file); }}
        insertAudioFromFile={(file) => { void insertAudioFromFile(file); }}
        publishInfo={publishInfo}
        publishBusy={publishBusy}
        handlePublish={() => { void handlePublish(); }}
        copyPublicUrl={(url) => { void copyPublicUrl(url); }}
        viewMode={viewMode}
        selectViewMode={selectViewMode}
      />

      {/* Inline editable title */}
      <input
        id="editor-title"
        className="editor-title"
        value={titleDraft}
        spellCheck={false}
        placeholder="Untitled"
        onChange={(e) => setTitleDraft(e.target.value)}
        onBlur={commitTitle}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitTitle(); viewRef.current?.focus(); }
          else if (e.key === 'Escape') { setTitleDraft(note.title); (e.target as HTMLInputElement).blur(); }
        }}
      />

      {/* Editor */}
      <div className={`editor-codemirror${viewMode === 'kanban' ? ' is-hidden' : ''}`} id="editor-codemirror" ref={editorRef} />
      {viewMode === 'kanban' && (
        <KanbanView content={content} onContentChange={onContentChange} showSuperkanbanToggle={kanbanBoardCount > 1} />
      )}

      <div className="mobile-note-actions" aria-label="Note actions">
        <button type="button" className="mobile-note-action" onClick={() => { void handleMobileSave(); }} disabled={mobileSaveState === 'saving'}>
          <Save size={18} />
          <span>{mobileSaveState === 'saving' ? 'Saving…' : mobileSaveState === 'saved' ? 'Saved' : mobileSaveState === 'error' ? 'Retry save' : 'Save'}</span>
        </button>
        <button type="button" className="mobile-note-action" onClick={() => setNoteLinkPickerOpen(true)}>
          <Link2 size={18} />
          <span>Link note</span>
        </button>
      </div>

      {noteLinkPickerOpen && (
        <div className="note-link-picker-backdrop" onMouseDown={() => setNoteLinkPickerOpen(false)}>
          <section className="note-link-picker" role="dialog" aria-modal="true" aria-label="Link a note" onMouseDown={(event) => event.stopPropagation()}>
            <div className="note-link-picker-header">
              <div>
                <strong>Link a note</strong>
                <span>Insert a link at the cursor</span>
              </div>
              <button type="button" className="note-link-picker-close" aria-label="Close note picker" onClick={() => setNoteLinkPickerOpen(false)}><X size={20} /></button>
            </div>
            <label className="note-link-picker-search">
              <Search size={17} />
              <input autoFocus value={noteLinkQuery} onChange={(event) => setNoteLinkQuery(event.target.value)} placeholder="Search notes" />
            </label>
            <div className="note-link-picker-list">
              {linkableNotes.map((candidate) => (
                <button type="button" key={candidate.id} onClick={() => insertNoteLink(candidate)}>
                  <FileText size={17} />
                  <span>{candidate.title}</span>
                </button>
              ))}
              {linkableNotes.length === 0 && <p>{noteLinkQuery ? 'No matching notes' : 'No other notes yet'}</p>}
            </div>
          </section>
        </div>
      )}

      {/* Status bar */}
      <div className="editor-status-bar" id="editor-status-bar">
        <span className="status-item">{stats.words} words</span>
        <span className="status-item">{stats.chars} chars</span>
        <span className="status-item">~{stats.readingTime} min read</span>
        {viewMode === 'kanban' && <span className="status-item">Kanban · Markdown backed</span>}
        {note.updated_at && (
          <span className="status-item status-saved">
            Saved {formatRelativeDate(note.updated_at)}
          </span>
        )}
        {publishInfo.published && publishInfo.updated_at && (
          <button
            type="button"
            className="status-item status-public"
            onClick={() => { void handleUnpublish(); }}
            title="Click to unpublish"
          >
            Public · {formatRelativeDate(publishInfo.updated_at)}
          </button>
        )}
        {publishNotice && <span className="status-item status-notice">{publishNotice}</span>}
      </div>
    </div>
  );
});
