import { useEffect, useRef, useMemo, useCallback } from 'react';
import type { Note } from '../api';
import { formatRelativeDate } from '../api';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, WidgetType, drawSelection } from '@codemirror/view';
import { EditorState, type Extension, RangeSetBuilder } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, defaultHighlightStyle } from '@codemirror/language';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { FileText, Link2, Sparkles, Zap } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════
   NoteEditor — CodeMirror 6 Live Preview Markdown Editor
   ═══════════════════════════════════════════════════════════ */

interface NoteEditorProps {
  note: Note | null;
  content: string;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onRunDirectives?: () => void;
  onOpenWikilink?: (title: string) => void;
}

/* ─── Custom Dark Theme ──────────────────────────────────── */
const cascadeTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.9375rem',
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
  },
  '.cm-content': {
    padding: '16px 24px 80px',
    fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
    lineHeight: '1.7',
    caretColor: 'hsl(260, 60%, 60%)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'hsl(260, 60%, 60%)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    background: 'hsla(260, 50%, 55%, 0.25) !important',
  },
  '.cm-activeLine': {
    background: 'hsla(225, 12%, 14%, 0.5)',
  },
  '.cm-activeLineGutter': {
    background: 'hsla(225, 12%, 14%, 0.5)',
  },
  '.cm-gutters': {
    background: 'hsl(225, 15%, 7%)',
    color: 'hsl(220, 8%, 30%)',
    borderRight: '1px solid hsl(225, 10%, 14%)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.75rem',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 12px 0 8px',
    minWidth: '3em',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  /* Markdown-specific styles */
  '.cm-line': {
    padding: '0 2px',
  },
  /* WYSIWYG heading styles */
  '.cm-heading-1': {
    fontSize: '1.8em',
    fontWeight: '700',
    lineHeight: '1.3',
    letterSpacing: '-0.02em',
    color: 'hsl(40, 15%, 95%)',
  },
  '.cm-heading-2': {
    fontSize: '1.4em',
    fontWeight: '600',
    lineHeight: '1.35',
    letterSpacing: '-0.01em',
    color: 'hsl(40, 15%, 92%)',
  },
  '.cm-heading-3': {
    fontSize: '1.2em',
    fontWeight: '600',
    lineHeight: '1.4',
    color: 'hsl(40, 15%, 88%)',
  },
  '.cm-heading-4': {
    fontSize: '1.05em',
    fontWeight: '600',
    color: 'hsl(40, 15%, 85%)',
  },
  /* Bold / Italic */
  '.cm-md-bold': {
    fontWeight: '700',
    color: 'hsl(40, 20%, 95%)',
  },
  '.cm-md-italic': {
    fontStyle: 'italic',
    color: 'hsl(40, 18%, 85%)',
  },
  /* Inline code */
  '.cm-md-inline-code': {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.875em',
    background: 'hsl(225, 12%, 16%)',
    padding: '1px 5px',
    borderRadius: '4px',
    color: 'hsl(150, 50%, 65%)',
  },
  /* Hidden markers */
  '.cm-md-hidden': {
    fontSize: '0',
    width: '0',
    display: 'inline',
    overflow: 'hidden',
    color: 'transparent',
  },
  /* Wiki-link chip */
  '.cm-wikilink': {
    color: 'hsl(260, 60%, 68%)',
    background: 'hsla(260, 60%, 60%, 0.12)',
    padding: '1px 6px',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  '.cm-wikilink:hover': {
    background: 'hsla(260, 60%, 60%, 0.2)',
  },
  /* LLM directive chip */
  '.cm-directive': {
    color: 'hsl(260, 60%, 72%)',
    background: 'hsla(260, 60%, 60%, 0.15)',
    padding: '2px 8px',
    borderRadius: '6px',
    border: '1px solid hsla(260, 60%, 60%, 0.3)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.85em',
  },
  /* Checkboxes */
  '.cm-checkbox': {
    cursor: 'pointer',
  },
  /* Horizontal rule */
  '.cm-hr-widget': {
    display: 'block',
    height: '1px',
    background: 'hsl(225, 10%, 22%)',
    margin: '12px 0',
    border: 'none',
  },
  /* Fenced code blocks */
  '.cm-code-block-line': {
    background: 'hsl(225, 15%, 9%)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.875em',
    borderLeft: '2px solid hsl(225, 10%, 22%)',
    paddingLeft: '12px',
  },
}, { dark: true });

/* ─── Syntax Highlighting ────────────────────────────────── */
const cascadeHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'hsl(40, 15%, 95%)', fontWeight: '700', fontSize: '1.8em' },
  { tag: tags.heading2, color: 'hsl(40, 15%, 92%)', fontWeight: '600', fontSize: '1.4em' },
  { tag: tags.heading3, color: 'hsl(40, 15%, 88%)', fontWeight: '600', fontSize: '1.2em' },
  { tag: tags.heading4, color: 'hsl(40, 15%, 85%)', fontWeight: '600' },
  { tag: tags.heading5, color: 'hsl(40, 15%, 82%)', fontWeight: '600' },
  { tag: tags.heading6, color: 'hsl(40, 15%, 78%)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700', color: 'hsl(40, 20%, 95%)' },
  { tag: tags.emphasis, fontStyle: 'italic', color: 'hsl(40, 18%, 85%)' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'hsl(220, 10%, 50%)' },
  { tag: tags.link, color: 'hsl(260, 60%, 68%)', textDecoration: 'underline' },
  { tag: tags.url, color: 'hsl(260, 50%, 55%)' },
  { tag: tags.monospace, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: 'hsl(150, 50%, 65%)', fontSize: '0.875em' },
  { tag: tags.processingInstruction, color: 'hsl(260, 60%, 60%)' },
  { tag: tags.quote, color: 'hsl(220, 10%, 60%)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'hsl(260, 60%, 68%)' },
  { tag: tags.string, color: 'hsl(150, 50%, 65%)' },
  { tag: tags.number, color: 'hsl(35, 80%, 65%)' },
  { tag: tags.comment, color: 'hsl(220, 8%, 40%)' },
  { tag: tags.meta, color: 'hsl(220, 8%, 45%)' },
  { tag: tags.punctuation, color: 'hsl(220, 8%, 40%)' },
  { tag: tags.contentSeparator, color: 'hsl(225, 10%, 30%)' },
]);

/* ─── Checkbox Widget ────────────────────────────────────── */
class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean) {
    super();
  }
  toDOM() {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = this.checked;
    cb.className = 'cm-checkbox';
    cb.setAttribute('aria-label', this.checked ? 'Checked' : 'Unchecked');
    return cb;
  }
  eq(other: CheckboxWidget) {
    return this.checked === other.checked;
  }
}

/* ─── HR Widget ──────────────────────────────────────────── */
class HRWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-hr-widget';
    return hr;
  }
}

/* ─── WYSIWYG Decorations Plugin ─────────────────────────── */
function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const cursorLine = view.state.selection.main.head;
  const activeLine = doc.lineAt(cursorLine).number;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const isActive = i === activeLine;

    // Headings: Apply class and optionally hide markers
    const headingMatch = text.match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const cls = `cm-heading-${Math.min(level, 4)}`;
      builder.add(line.from, line.to, Decoration.mark({ class: cls }));
      if (!isActive) {
        // Hide the # markers
        builder.add(line.from, line.from + headingMatch[0].length, Decoration.mark({ class: 'cm-md-hidden' }));
      }
    }

    // Horizontal rule
    if (/^---+$/.test(text.trim()) && !isActive) {
      builder.add(line.from, line.to, Decoration.replace({ widget: new HRWidget() }));
      continue;
    }

    // Checkboxes
    const checkMatch = text.match(/^(\s*[-*+]\s)\[([xX ])\]/);
    if (checkMatch) {
      const checked = checkMatch[2].toLowerCase() === 'x';
      const cbStart = line.from + checkMatch[1].length;
      const cbEnd = cbStart + 3; // [x] or [ ]
      builder.add(cbStart, cbEnd, Decoration.replace({ widget: new CheckboxWidget(checked) }));
    }

    if (isActive) continue; // Don't hide markers on the active line

    // Inline patterns — only apply when cursor is not on this line
    let pos = 0;
    while (pos < text.length) {
      // Bold: **text**
      const boldIdx = text.indexOf('**', pos);
      if (boldIdx !== -1) {
        const endBold = text.indexOf('**', boldIdx + 2);
        if (endBold !== -1 && endBold > boldIdx + 2) {
          // Hide opening **
          builder.add(line.from + boldIdx, line.from + boldIdx + 2, Decoration.mark({ class: 'cm-md-hidden' }));
          // Mark bold text
          builder.add(line.from + boldIdx + 2, line.from + endBold, Decoration.mark({ class: 'cm-md-bold' }));
          // Hide closing **
          builder.add(line.from + endBold, line.from + endBold + 2, Decoration.mark({ class: 'cm-md-hidden' }));
          pos = endBold + 2;
          continue;
        }
      }

      // Italic: *text* (but not **)
      const italicIdx = text.indexOf('*', pos);
      if (italicIdx !== -1 && text[italicIdx + 1] !== '*') {
        const endItalic = text.indexOf('*', italicIdx + 1);
        if (endItalic !== -1 && endItalic > italicIdx + 1 && text[endItalic - 1] !== '*') {
          builder.add(line.from + italicIdx, line.from + italicIdx + 1, Decoration.mark({ class: 'cm-md-hidden' }));
          builder.add(line.from + italicIdx + 1, line.from + endItalic, Decoration.mark({ class: 'cm-md-italic' }));
          builder.add(line.from + endItalic, line.from + endItalic + 1, Decoration.mark({ class: 'cm-md-hidden' }));
          pos = endItalic + 1;
          continue;
        }
      }

      // Inline code: `code`
      const codeIdx = text.indexOf('`', pos);
      if (codeIdx !== -1 && text[codeIdx + 1] !== '`') {
        const endCode = text.indexOf('`', codeIdx + 1);
        if (endCode !== -1 && endCode > codeIdx + 1) {
          builder.add(line.from + codeIdx, line.from + codeIdx + 1, Decoration.mark({ class: 'cm-md-hidden' }));
          builder.add(line.from + codeIdx + 1, line.from + endCode, Decoration.mark({ class: 'cm-md-inline-code' }));
          builder.add(line.from + endCode, line.from + endCode + 1, Decoration.mark({ class: 'cm-md-hidden' }));
          pos = endCode + 1;
          continue;
        }
      }

      // Wikilinks: [[title]]
      const wikiIdx = text.indexOf('[[', pos);
      if (wikiIdx !== -1) {
        const endWiki = text.indexOf(']]', wikiIdx + 2);
        if (endWiki !== -1) {
          builder.add(line.from + wikiIdx, line.from + wikiIdx + 2, Decoration.mark({ class: 'cm-md-hidden' }));
          builder.add(line.from + wikiIdx + 2, line.from + endWiki, Decoration.mark({ class: 'cm-wikilink' }));
          builder.add(line.from + endWiki, line.from + endWiki + 2, Decoration.mark({ class: 'cm-md-hidden' }));
          pos = endWiki + 2;
          continue;
        }
      }

      // LLM Directives: {{ai: prompt}}
      const dirIdx = text.indexOf('{{ai:', pos);
      if (dirIdx !== -1) {
        const endDir = text.indexOf('}}', dirIdx + 5);
        if (endDir !== -1) {
          builder.add(line.from + dirIdx, line.from + endDir + 2, Decoration.mark({ class: 'cm-directive' }));
          pos = endDir + 2;
          continue;
        }
      }

      pos++;
    }
  }

  return builder.finish();
}

const wysiwygPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  },
);

/* ─── Checkbox Click Handler ─────────────────────────────── */
const checkboxClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target as HTMLElement;
    if (target.nodeName === 'INPUT' && target.classList.contains('cm-checkbox')) {
      event.preventDefault();
      const pos = view.posAtDOM(target);
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const match = text.match(/^(\s*[-*+]\s)\[([xX ])\]/);
      if (match) {
        const checked = match[2].toLowerCase() === 'x';
        const replacement = checked ? '[ ]' : '[x]';
        const start = line.from + match[1].length;
        const end = start + 3;
        view.dispatch({
          changes: { from: start, to: end, insert: replacement },
        });
      }
      return true;
    }
    return false;
  },
});

/* ─── Component ──────────────────────────────────────────── */
export function NoteEditor({ note, content, onContentChange, onSave, onRunDirectives, onOpenWikilink }: NoteEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  const onSaveRef = useRef(onSave);
  const onRunDirectivesRef = useRef(onRunDirectives);
  const onOpenWikilinkRef = useRef(onOpenWikilink);

  // Keep refs updated
  contentRef.current = content;
  onContentChangeRef.current = onContentChange;
  onSaveRef.current = onSave;
  onRunDirectivesRef.current = onRunDirectives;
  onOpenWikilinkRef.current = onOpenWikilink;

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
      wysiwygPlugin,
      checkboxClickHandler,
      EditorView.domEventHandlers({
        mousedown(event) {
          const target = event.target as HTMLElement;
          const wikilink = target.closest('.cm-wikilink');
          if (wikilink) {
            const title = wikilink.textContent?.trim();
            if (title) {
              event.preventDefault();
              onOpenWikilinkRef.current?.(title);
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
          key: 'Mod-Shift-Enter',
          run: () => {
            onRunDirectivesRef.current?.();
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
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          const newDoc = update.state.doc.toString();
          contentRef.current = newDoc;
          onContentChangeRef.current(newDoc);
        }
      }),
    ],
    [],
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
  }, [note?.id, extensions]);

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
        insertAtCursor(view, '![alt](url)');
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
      case 'directive':
        insertAtCursor(view, '{{ai: }}');
        break;
      case 'run-directives':
        onRunDirectivesRef.current?.();
        break;
      case 'hr':
        insertAtCursor(view, '\n---\n');
        break;
    }
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
      {/* Toolbar */}
      <div className="editor-toolbar" id="editor-toolbar">
        <button id="toolbar-bold" className="toolbar-btn" onClick={() => toolbarAction('bold')} title="Bold (Ctrl+B)"><strong>B</strong></button>
        <button id="toolbar-italic" className="toolbar-btn" onClick={() => toolbarAction('italic')} title="Italic (Ctrl+I)"><em>I</em></button>
        <button id="toolbar-strike" className="toolbar-btn" onClick={() => toolbarAction('strikethrough')} title="Strikethrough"><s>S</s></button>
        <button id="toolbar-code" className="toolbar-btn mono" onClick={() => toolbarAction('code')} title="Inline Code">&lt;/&gt;</button>
        <button id="toolbar-link" className="toolbar-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => toolbarAction('link')} title="Insert Link (Ctrl+K)"><Link2 size={16} /></button>
        <button id="toolbar-image" className="toolbar-btn" onClick={() => toolbarAction('image')} title="Insert Image">🖼</button>

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
        <button id="toolbar-directive" className="toolbar-btn accent" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => toolbarAction('directive')} title="Insert AI Directive"><Sparkles size={16} /></button>
        {onRunDirectives && (
          <button id="toolbar-run-directives" className="toolbar-btn accent" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }} onClick={() => toolbarAction('run-directives')} title="Run AI Directives (Ctrl+Shift+Enter)"><Zap size={16} /> Run AI</button>
        )}
      </div>

      {/* Editor */}
      <div className="editor-codemirror" id="editor-codemirror" ref={editorRef} />

      {/* Status bar */}
      <div className="editor-status-bar" id="editor-status-bar">
        <span className="status-item">{stats.words} words</span>
        <span className="status-item">{stats.chars} chars</span>
        <span className="status-item">~{stats.readingTime} min read</span>
        {note.updated_at && (
          <span className="status-item status-saved">
            Saved {formatRelativeDate(note.updated_at)}
          </span>
        )}
      </div>
    </div>
  );
}

/* ─── Editor Helpers ─────────────────────────────────────── */
function toggleInlineFormat(view: EditorView, marker: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
    // Remove format
    view.dispatch({
      changes: { from, to, insert: selected.slice(marker.length, -marker.length) },
    });
  } else {
    // Add format
    view.dispatch({
      changes: { from, to, insert: `${marker}${selected || 'text'}${marker}` },
      selection: { anchor: from + marker.length, head: to + marker.length },
    });
  }
}

function toggleLinePrefix(view: EditorView, prefix: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;

  // Check if any heading prefix exists
  const headingMatch = text.match(/^(#{1,6}\s|[-*+]\s(\[.\]\s)?|\d+\.\s)/);
  if (headingMatch) {
    // Remove existing prefix
    view.dispatch({
      changes: { from: line.from, to: line.from + headingMatch[0].length, insert: '' },
    });
    // Add new prefix if it's different
    if (headingMatch[0] !== prefix) {
      view.dispatch({
        changes: { from: line.from, insert: prefix },
      });
    }
  } else {
    view.dispatch({
      changes: { from: line.from, insert: prefix },
    });
  }
}

function insertLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = selected ? `[${selected}](url)` : '[link text](url)';
  view.dispatch({
    changes: { from, to, insert },
  });
}

function insertAtCursor(view: EditorView, text: string) {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
}
