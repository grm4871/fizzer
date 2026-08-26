/** Presentational toolbar; command callbacks keep editor state in NoteEditor. */
import type { RefObject } from 'react';
import type { NotePublishInfo } from '../api';
import { FileText, Link2, Columns3, Globe, ExternalLink, LockKeyhole } from 'lucide-react';

interface NoteEditorToolbarProps {
  toolbarAction: (action: string) => void;
  imageInputRef: RefObject<HTMLInputElement | null>;
  insertImageFromFile: (file: File) => void;
  insertVideoFromFile: (file: File) => void;
  insertAudioFromFile: (file: File) => void;
  publishInfo: NotePublishInfo;
  publishBusy: boolean;
  handlePublish: () => void;
  copyPublicUrl: (url: string) => void;
  viewMode: 'editor' | 'kanban';
  selectViewMode: (mode: 'editor' | 'kanban') => void;
}

export function NoteEditorToolbar({ toolbarAction, imageInputRef, insertImageFromFile, insertVideoFromFile, insertAudioFromFile, publishInfo, publishBusy, handlePublish, copyPublicUrl, viewMode, selectViewMode }: NoteEditorToolbarProps) {
  return (
      <div className="editor-toolbar" id="editor-toolbar">
        <button id="toolbar-bold" className="toolbar-btn" onClick={() => toolbarAction('bold')} title="Bold (Ctrl+B)"><strong>B</strong></button>
        <button id="toolbar-italic" className="toolbar-btn" onClick={() => toolbarAction('italic')} title="Italic (Ctrl+I)"><em>I</em></button>
        <button id="toolbar-strike" className="toolbar-btn" onClick={() => toolbarAction('strikethrough')} title="Strikethrough"><s>S</s></button>
        <button id="toolbar-code" className="toolbar-btn mono" onClick={() => toolbarAction('code')} title="Inline Code">&lt;/&gt;</button>
        <button id="toolbar-link" className="toolbar-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => toolbarAction('link')} title="Insert Link (Ctrl+K)"><Link2 size={16} /></button>
        <button id="toolbar-image" className="toolbar-btn" onClick={() => toolbarAction('image')} title="Upload image, MP3, or MP4 (images also support paste/drop)">📎</button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*,audio/mpeg,.mp3,video/mp4,.mp4"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file?.type.startsWith('image/')) void insertImageFromFile(file);
            else if (file?.type === 'video/mp4' || file?.name.toLowerCase().endsWith('.mp4')) void insertVideoFromFile(file);
            else if (file) void insertAudioFromFile(file);
          }}
        />

        <div className="toolbar-divider" />

        <button id="toolbar-h1" className="toolbar-btn" onClick={() => toolbarAction('h1')} title="Heading 1">H1</button>
        <button id="toolbar-h2" className="toolbar-btn" onClick={() => toolbarAction('h2')} title="Heading 2">H2</button>
        <button id="toolbar-h3" className="toolbar-btn" onClick={() => toolbarAction('h3')} title="Heading 3">H3</button>

        <div className="toolbar-divider" />

        <button id="toolbar-checklist" className="toolbar-btn" onClick={() => toolbarAction('checklist')} title="Checklist">☑</button>
        <button id="toolbar-bullet" className="toolbar-btn" onClick={() => toolbarAction('bullet')} title="Bullet List">•</button>
        <button id="toolbar-numbered" className="toolbar-btn" onClick={() => toolbarAction('numbered')} title="Numbered List">1.</button>

        <div className="toolbar-divider" />

        <button id="toolbar-hr" className="toolbar-btn" onClick={() => toolbarAction('hr')} title="Horizontal Rule">―</button>
        <button id="toolbar-private" className="toolbar-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => toolbarAction('private')} title="Insert private block (hidden from agents)"><LockKeyhole size={15} /></button>

        <div className="toolbar-divider" />

        <button
          id="toolbar-publish"
          className={`toolbar-btn${publishInfo.published ? ' active' : ''}`}
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => { void handlePublish(); }}
          disabled={publishBusy}
          title={publishInfo.published ? 'Republish snapshot & copy link' : 'Publish to public view'}
        >
          <Globe size={15} />
        </button>
        {publishInfo.published && publishInfo.url && (
          <>
            <button
              id="toolbar-copy-public-link"
              className="toolbar-btn"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => { void copyPublicUrl(publishInfo.url!); }}
              title="Copy public link"
            >
              <Link2 size={15} />
            </button>
            <button
              id="toolbar-open-public"
              className="toolbar-btn"
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              onClick={() => window.open(publishInfo.url, '_blank', 'noopener,noreferrer')}
              title="Open public view"
            >
              <ExternalLink size={15} />
            </button>
          </>
        )}
        <div className="toolbar-spacer" />
        <div className="editor-view-toggle" role="group" aria-label="Note view">
          <button
            type="button"
            className={`toolbar-btn${viewMode === 'editor' ? ' active' : ''}`}
            onClick={() => selectViewMode('editor')}
            title="Markdown view"
            aria-pressed={viewMode === 'editor'}
          >
            <FileText size={15} />
          </button>
          <button
            type="button"
            className={`toolbar-btn${viewMode === 'kanban' ? ' active' : ''}`}
            onClick={() => selectViewMode('kanban')}
            title="Kanban view"
            aria-pressed={viewMode === 'kanban'}
          >
            <Columns3 size={15} />
          </button>
        </div>
      </div>
  );
}
