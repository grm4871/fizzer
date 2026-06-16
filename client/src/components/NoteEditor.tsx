import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import type { Note } from '../api';
import { formatRelativeDate } from '../api';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, WidgetType, drawSelection } from '@codemirror/view';
import { EditorState, type Extension, RangeSetBuilder, Prec } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, defaultHighlightStyle } from '@codemirror/language';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { FileText, Link2 } from 'lucide-react';

/* ═══════════════════════════════════════════════════════════
   NoteEditor — CodeMirror 6 Live Preview Markdown Editor
   ═══════════════════════════════════════════════════════════ */

interface NoteEditorProps {
  note: Note | null;
  content: string;
  onContentChange: (content: string) => void;
  onSave: () => void;
  onRename?: (title: string) => Promise<void>;
  onExecuteDirective?: (prompt: string) => void;
  onOpenWikilink?: (title: string) => void;
  onOpenWebView?: (url: string) => void;
}

/* ─── Custom Dark Theme ──────────────────────────────────── */
const cascadeTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.9375rem',
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
  },
  '.cm-content': {
    padding: '16px 26px 80px',
    fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
    lineHeight: '1.8',
    caretColor: 'hsl(33, 68%, 55%)',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'hsl(33, 68%, 55%)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    background: 'hsla(33, 65%, 50%, 0.22) !important',
  },
  '.cm-activeLine': {
    background: 'hsla(22, 8%, 14%, 0.45)',
  },
  '.cm-activeLineGutter': {
    background: 'hsla(22, 8%, 14%, 0.45)',
  },
  '.cm-gutters': {
    background: 'hsl(22, 8%, 7%)',
    color: 'hsl(25, 5%, 28%)',
    borderRight: '1px solid hsl(22, 7%, 13%)',
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
    fontWeight: '300',
    lineHeight: '1.3',
    letterSpacing: '-0.03em',
    color: 'hsl(35, 12%, 95%)',
  },
  '.cm-heading-2': {
    fontSize: '1.4em',
    fontWeight: '400',
    lineHeight: '1.35',
    letterSpacing: '-0.02em',
    color: 'hsl(35, 10%, 92%)',
  },
  '.cm-heading-3': {
    fontSize: '1.2em',
    fontWeight: '500',
    lineHeight: '1.4',
    color: 'hsl(35, 10%, 88%)',
  },
  '.cm-heading-4': {
    fontSize: '1.05em',
    fontWeight: '600',
    color: 'hsl(35, 8%, 85%)',
  },
  /* Bold / Italic */
  '.cm-md-bold': {
    fontWeight: '700',
    color: 'hsl(35, 14%, 95%)',
  },
  '.cm-md-italic': {
    fontStyle: 'italic',
    color: 'hsl(35, 10%, 85%)',
  },
  /* Inline code — warm amber */
  '.cm-md-inline-code': {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.875em',
    background: 'hsl(22, 8%, 13%)',
    padding: '1px 5px',
    borderRadius: '3px',
    color: 'hsl(38, 75%, 65%)',
  },
  /* Hidden markers */
  '.cm-md-hidden': {
    fontSize: '0',
    width: '0',
    display: 'inline',
    overflow: 'hidden',
    color: 'transparent',
  },
  /* Wiki-link chip — copper */
  '.cm-wikilink': {
    color: 'hsl(33, 72%, 65%)',
    background: 'hsla(33, 68%, 52%, 0.13)',
    padding: '1px 6px',
    borderRadius: '3px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  '.cm-wikilink:hover': {
    background: 'hsla(33, 68%, 52%, 0.22)',
  },
  /* External Link — cool blue for contrast in the warm world */
  '.cm-external-link': {
    color: 'hsl(205, 75%, 68%)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  '.cm-external-link:hover': {
    color: 'hsl(205, 85%, 78%)',
  },
  /* AI directive chip — teal, visually distinct from copper context */
  '.cm-directive': {
    color: 'hsl(185, 65%, 62%)',
    background: 'hsla(185, 65%, 50%, 0.12)',
    padding: '2px 8px',
    borderRadius: '5px',
    border: '1px solid hsla(185, 65%, 50%, 0.28)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.85em',
  },
  '.cm-checkbox': {
    cursor: 'pointer',
  },
  '.cm-hr-widget': {
    display: 'block',
    height: '1px',
    background: 'hsl(25, 7%, 20%)',
    margin: '14px 0',
    border: 'none',
  },
  '.cm-code-block-line': {
    background: 'hsl(22, 8%, 8%)',
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.875em',
    borderLeft: '2px solid hsl(25, 7%, 20%)',
    paddingLeft: '12px',
  },
}, { dark: true });

/* ─── Syntax Highlighting ────────────────────────────────── */
const cascadeHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'hsl(35, 12%, 95%)', fontWeight: '300', fontSize: '1.8em' },
  { tag: tags.heading2, color: 'hsl(35, 10%, 92%)', fontWeight: '400', fontSize: '1.4em' },
  { tag: tags.heading3, color: 'hsl(35, 10%, 88%)', fontWeight: '500', fontSize: '1.2em' },
  { tag: tags.heading4, color: 'hsl(35, 8%, 85%)', fontWeight: '600' },
  { tag: tags.heading5, color: 'hsl(35, 8%, 82%)', fontWeight: '600' },
  { tag: tags.heading6, color: 'hsl(35, 8%, 78%)', fontWeight: '600' },
  { tag: tags.strong, fontWeight: '700', color: 'hsl(35, 14%, 95%)' },
  { tag: tags.emphasis, fontStyle: 'italic', color: 'hsl(35, 10%, 85%)' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'hsl(25, 5%, 45%)' },
  { tag: tags.link, color: 'hsl(33, 72%, 65%)', textDecoration: 'underline' },
  { tag: tags.url, color: 'hsl(33, 60%, 55%)' },
  { tag: tags.monospace, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: 'hsl(38, 75%, 65%)', fontSize: '0.875em' },
  { tag: tags.processingInstruction, color: 'hsl(33, 68%, 58%)' },
  { tag: tags.quote, color: 'hsl(25, 6%, 55%)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'hsl(195, 65%, 62%)' },
  { tag: tags.string, color: 'hsl(150, 45%, 62%)' },
  { tag: tags.number, color: 'hsl(38, 80%, 65%)' },
  { tag: tags.comment, color: 'hsl(25, 5%, 38%)' },
  { tag: tags.meta, color: 'hsl(25, 5%, 42%)' },
  { tag: tags.punctuation, color: 'hsl(25, 5%, 36%)' },
  { tag: tags.contentSeparator, color: 'hsl(25, 7%, 25%)' },
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
export function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const cursorLine = view.state.selection.main.head;
  const activeLine = doc.lineAt(cursorLine).number;

  const hidden = Decoration.mark({ class: 'cm-md-hidden' });
  const boldDeco = Decoration.mark({ class: 'cm-md-bold' });
  const italicDeco = Decoration.mark({ class: 'cm-md-italic' });
  const codeDeco = Decoration.mark({ class: 'cm-md-inline-code' });
  const wikilinkDeco = Decoration.mark({ class: 'cm-wikilink' });
  const directiveDeco = Decoration.mark({ class: 'cm-directive' });

  // Flat list to collect all decoration ranges
  const decos: { from: number; to: number; deco: Decoration }[] = [];

  // Helper to collect a decoration range safely
  const collectDeco = (from: number, to: number, deco: Decoration) => {
    if (from < to) {
      decos.push({ from, to, deco });
    }
  };

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const isActive = i === activeLine;

    // Headings: Apply class and optionally hide markers
    const headingMatch = text.match(/^(#{1,6})\s/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const cls = `cm-heading-${Math.min(level, 4)}`;
      collectDeco(line.from, line.to, Decoration.mark({ class: cls }));
      if (!isActive) {
        // Hide the # markers
        collectDeco(line.from, line.from + headingMatch[0].length, hidden);
      }
    }

    // Horizontal rule
    if (/^---+$/.test(text.trim()) && !isActive) {
      if (line.from < line.to) {
        decos.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({ widget: new HRWidget() }),
        });
      }
      continue;
    }

    // Checkboxes
    const checkMatch = text.match(/^(\s*[-*+]\s)\[([xX ])\]/);
    if (checkMatch) {
      const checked = checkMatch[2].toLowerCase() === 'x';
      const cbStart = line.from + checkMatch[1].length;
      const cbEnd = cbStart + 3; // [x] or [ ]
      if (cbStart < cbEnd) {
        decos.push({
          from: cbStart,
          to: cbEnd,
          deco: Decoration.replace({ widget: new CheckboxWidget(checked) }),
        });
      }
    }

    if (isActive) continue; // Don't hide/decorate formatting markers on the active line

    // Determine starting index for inline pattern scanning to avoid matching block prefixes
    let inlineStart = 0;
    const listMatch = text.match(/^(\s*[-*+]|\d+\.)\s/);

    if (headingMatch) {
      inlineStart = headingMatch[0].length;
    } else if (checkMatch) {
      inlineStart = checkMatch[0].length;
    } else if (listMatch) {
      inlineStart = listMatch[0].length;
    }

    // Bold: **text**
    let boldIdx = text.indexOf('**', inlineStart);
    while (boldIdx !== -1) {
      const endBold = text.indexOf('**', boldIdx + 2);
      if (endBold !== -1 && endBold > boldIdx + 2) {
        collectDeco(line.from + boldIdx, line.from + boldIdx + 2, hidden);
        collectDeco(line.from + boldIdx + 2, line.from + endBold, boldDeco);
        collectDeco(line.from + endBold, line.from + endBold + 2, hidden);
        boldIdx = text.indexOf('**', endBold + 2);
      } else {
        break;
      }
    }

    // Italic: *text* (but ignore bold **)
    let italicIdx = text.indexOf('*', inlineStart);
    while (italicIdx !== -1) {
      if (text[italicIdx + 1] !== '*' && text[italicIdx - 1] !== '*') {
        const endItalic = text.indexOf('*', italicIdx + 1);
        if (endItalic !== -1 && endItalic > italicIdx + 1 && text[endItalic + 1] !== '*' && text[endItalic - 1] !== '*') {
          collectDeco(line.from + italicIdx, line.from + italicIdx + 1, hidden);
          collectDeco(line.from + italicIdx + 1, line.from + endItalic, italicDeco);
          collectDeco(line.from + endItalic, line.from + endItalic + 1, hidden);
          italicIdx = text.indexOf('*', endItalic + 1);
          continue;
        }
      }
      italicIdx = text.indexOf('*', italicIdx + 1);
    }

    // Inline Code: `code`
    let codeIdx = text.indexOf('`', inlineStart);
    while (codeIdx !== -1) {
      if (text[codeIdx + 1] !== '`') {
        const endCode = text.indexOf('`', codeIdx + 1);
        if (endCode !== -1 && endCode > codeIdx + 1) {
          collectDeco(line.from + codeIdx, line.from + codeIdx + 1, hidden);
          collectDeco(line.from + codeIdx + 1, line.from + endCode, codeDeco);
          collectDeco(line.from + endCode, line.from + endCode + 1, hidden);
          codeIdx = text.indexOf('`', endCode + 1);
          continue;
        }
      }
      codeIdx = text.indexOf('`', codeIdx + 1);
    }

    // Wikilinks: [[title]]
    let wikiIdx = text.indexOf('[[', inlineStart);
    while (wikiIdx !== -1) {
      const endWiki = text.indexOf(']]', wikiIdx + 2);
      if (endWiki !== -1) {
        collectDeco(line.from + wikiIdx, line.from + wikiIdx + 2, hidden);
        collectDeco(line.from + wikiIdx + 2, line.from + endWiki, wikilinkDeco);
        collectDeco(line.from + endWiki, line.from + endWiki + 2, hidden);
        wikiIdx = text.indexOf('[[', endWiki + 2);
      } else {
        break;
      }
    }

    // External links: [text](https://...)
    let extIdx = text.indexOf('[', inlineStart);
    while (extIdx !== -1) {
      if (text[extIdx + 1] !== '[') {
        const sub = text.slice(extIdx);
        const match = sub.match(/^\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/);
        if (match) {
          const label = match[1];
          const destUrl = match[2];
          collectDeco(line.from + extIdx, line.from + extIdx + 1, hidden);
          collectDeco(line.from + extIdx + 1, line.from + extIdx + 1 + label.length, Decoration.mark({
            class: 'cm-external-link',
            attributes: { 'data-url': destUrl }
          }));
          collectDeco(line.from + extIdx + 1 + label.length, line.from + extIdx + match[0].length, hidden);
          extIdx += match[0].length;
          continue;
        }
      }
      extIdx = text.indexOf('[', extIdx + 1);
    }

    // AI Directives: {{ai: prompt}}
    let dirIdx = text.indexOf('{{ai:', inlineStart);
    while (dirIdx !== -1) {
      const endDir = text.indexOf('}}', dirIdx + 5);
      if (endDir !== -1) {
        collectDeco(line.from + dirIdx, line.from + endDir + 2, directiveDeco);
        dirIdx = text.indexOf('{{ai:', endDir + 2);
      } else {
        break;
      }
    }
  }

  // Sort decorations by start position ascending, then end position descending
  decos.sort((a, b) => {
    if (a.from !== b.from) {
      return a.from - b.from;
    }
    return b.to - a.to;
  });

  // Add all sorted decorations to builder
  for (const item of decos) {
    builder.add(item.from, item.to, item.deco);
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
export function NoteEditor({ note, content, onContentChange, onSave, onRename, onExecuteDirective, onOpenWikilink, onOpenWebView }: NoteEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const contentRef = useRef(content);
  const onContentChangeRef = useRef(onContentChange);
  const onSaveRef = useRef(onSave);
  const onExecuteDirectiveRef = useRef(onExecuteDirective);
  const onOpenWikilinkRef = useRef(onOpenWikilink);
  const onOpenWebViewRef = useRef(onOpenWebView);

  // Inline, editable note title (Obsidian-style). Synced from the note.
  const [titleDraft, setTitleDraft] = useState(note?.title ?? '');
  useEffect(() => { setTitleDraft(note?.title ?? ''); }, [note?.id, note?.title]);

  const commitTitle = useCallback(() => {
    const next = titleDraft.trim();
    if (!note || !next || next === note.title) {
      setTitleDraft(note?.title ?? '');
      return;
    }
    onRename?.(next)?.catch(() => setTitleDraft(note.title));
  }, [titleDraft, note, onRename]);

  // Keep refs updated
  contentRef.current = content;
  onContentChangeRef.current = onContentChange;
  onSaveRef.current = onSave;
  onExecuteDirectiveRef.current = onExecuteDirective;
  onOpenWikilinkRef.current = onOpenWikilink;
  onOpenWebViewRef.current = onOpenWebView;

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
          const extLink = target.closest('.cm-external-link');
          if (extLink) {
            const url = extLink.getAttribute('data-url');
            if (url) {
              event.preventDefault();
              onOpenWebViewRef.current?.(url);
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
      </div>

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

// Extract the prompt of the {{ai: …}} directive on the cursor's line. Prefers a
// directive the cursor sits inside; otherwise falls back to the first on the line.
function directiveAtCursor(view: EditorView): string | null {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const col = head - line.from;
  const re = /\{\{ai:([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null;
  let fallback: string | null = null;
  while ((match = re.exec(line.text))) {
    const prompt = match[1].trim();
    if (!prompt) continue;
    if (col >= match.index && col <= match.index + match[0].length) return prompt;
    if (fallback === null) fallback = prompt;
  }
  return fallback;
}
