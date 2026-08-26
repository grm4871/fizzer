/** CodeMirror theme and syntax palette for the note editor. */
import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/* ─── Custom Dark Theme ──────────────────────────────────── */
export const cascadeTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.9375rem',
    fontFamily: 'var(--font-sans)',
  },
  /* CodeMirror's default focused outline rings the entire note — kill it.
     Keyboard focus is already clear from the caret / active line. */
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-content': {
    padding: '16px 26px 80px',
    fontFamily: 'var(--font-sans)',
    lineHeight: '1.8',
    caretColor: 'var(--accent)',
    outline: 'none',
  },
  '.cm-content:focus, .cm-content:focus-visible': {
    outline: 'none',
    boxShadow: 'none',
  },
  '&.cm-focused .cm-cursor': {
    borderLeftColor: 'var(--accent)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    background: 'hsla(38, 92%, 55%, 0.22) !important',
  },
  /* Default search match highlight is neon green; tone it down. */
  '.cm-selectionMatch': {
    backgroundColor: 'hsla(38, 70%, 50%, 0.18)',
  },
  '.cm-selectionMatch-main': {
    backgroundColor: 'hsla(38, 80%, 50%, 0.28)',
  },
  '.cm-activeLine': {
    background: 'hsla(226, 14%, 16%, 0.5)',
  },
  '.cm-activeLineGutter': {
    background: 'hsla(226, 14%, 16%, 0.5)',
  },
  '.cm-gutters': {
    background: 'var(--bg-base)',
    color: 'hsl(224, 8%, 30%)',
    borderRight: '1px solid var(--border-subtle)',
    fontFamily: 'var(--font-mono)',
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
  /* WYSIWYG heading styles — badge type, obliqued, like a model designation */
  '.cm-heading-1': {
    fontFamily: 'var(--font-display)',
    fontSize: '1.75em',
    fontWeight: '700',
    fontStyle: 'italic',
    lineHeight: '1.25',
    letterSpacing: '0.01em',
    color: 'hsl(222, 16%, 96%)',
  },
  '.cm-heading-2': {
    fontFamily: 'var(--font-display)',
    fontSize: '1.35em',
    fontWeight: '700',
    fontStyle: 'italic',
    lineHeight: '1.3',
    letterSpacing: '0.02em',
    color: 'hsl(222, 14%, 93%)',
  },
  '.cm-heading-3': {
    fontFamily: 'var(--font-display)',
    fontSize: '1.15em',
    fontWeight: '600',
    fontStyle: 'italic',
    lineHeight: '1.4',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: 'hsl(222, 12%, 88%)',
  },
  '.cm-heading-4': {
    fontFamily: 'var(--font-display)',
    fontSize: '1em',
    fontWeight: '600',
    fontStyle: 'italic',
    letterSpacing: '0.07em',
    textTransform: 'uppercase',
    color: 'hsl(222, 10%, 84%)',
  },
  /* Bold / Italic */
  '.cm-md-bold': {
    fontWeight: '700',
    color: 'hsl(222, 16%, 96%)',
  },
  '.cm-md-italic': {
    fontStyle: 'italic',
    color: 'hsl(222, 12%, 86%)',
  },
  /* Inline code — amber backlight on black */
  '.cm-md-inline-code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    background: 'var(--bg-deep)',
    padding: '1px 5px',
    borderRadius: '2px',
    color: 'hsl(38, 88%, 66%)',
  },
  /* Hidden markers */
  '.cm-md-hidden': {
    fontSize: '0',
    width: '0',
    display: 'inline',
    overflow: 'hidden',
    color: 'transparent',
  },
  /* Wiki-link chip — amber, the in-world reference */
  '.cm-wikilink': {
    color: 'hsl(38, 88%, 68%)',
    background: 'hsla(38, 92%, 55%, 0.13)',
    padding: '1px 6px',
    borderRadius: '2px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  '.cm-wikilink:hover': {
    background: 'hsla(38, 92%, 55%, 0.22)',
  },
  /* External Link — ice, the third decal band */
  '.cm-external-link': {
    color: 'hsl(192, 78%, 66%)',
    textDecoration: 'underline',
    cursor: 'pointer',
  },
  '.cm-external-link:hover': {
    color: 'hsl(192, 88%, 76%)',
  },
  /* AI directive chip — magenta, the second decal band */
  '.cm-directive': {
    color: 'hsl(338, 82%, 70%)',
    background: 'hsla(338, 78%, 55%, 0.13)',
    padding: '2px 8px',
    borderRadius: '2px',
    border: '1px solid hsla(338, 78%, 55%, 0.32)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
  },
  '.cm-checkbox': {
    cursor: 'pointer',
    accentColor: 'hsl(38, 92%, 55%)',
  },
  '.cm-hr-widget': {
    display: 'block',
    height: '1px',
    background: 'var(--border)',
    margin: '14px 0',
    border: 'none',
  },
  '.cm-private-block': {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    width: '100%',
    boxSizing: 'border-box',
    margin: '8px 0',
    padding: '11px 12px',
    border: '1px solid hsla(38, 88%, 60%, 0.34)',
    borderRadius: '4px',
    background: 'hsla(38, 72%, 45%, 0.08)',
    color: 'hsl(38, 74%, 72%)',
    cursor: 'pointer',
  },
  '.cm-private-block strong': {
    display: 'block',
    fontSize: '0.8rem',
    letterSpacing: '0.04em',
  },
  '.cm-private-block small': {
    display: 'block',
    marginTop: '1px',
    color: 'var(--text-tertiary)',
    fontSize: '0.7rem',
  },
  /* Code blocks read as a data plate: dead black, amber rule down the edge */
  '.cm-code-block-line': {
    background: 'var(--bg-deep)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.875em',
    borderLeft: '2px solid hsla(38, 92%, 55%, 0.4)',
    paddingLeft: '12px',
  },
  /* GFM tables (rendered live-preview widget) */
  '.cm-md-table-wrap': {
    margin: '10px 0',
    overflowX: 'auto',
  },
  '.cm-md-table': {
    borderCollapse: 'collapse',
    width: '100%',
    fontSize: '0.9em',
    lineHeight: '1.5',
  },
  '.cm-md-table th, .cm-md-table td': {
    border: '1px solid var(--border)',
    padding: '5px 11px',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  /* Table headers are spec-sheet column labels */
  '.cm-md-table th': {
    background: 'var(--bg-raised)',
    color: 'hsl(222, 14%, 92%)',
    fontFamily: 'var(--font-display)',
    fontWeight: '600',
    fontStyle: 'italic',
    fontSize: '0.85em',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
  },
  '.cm-md-table td': {
    fontVariantNumeric: 'tabular-nums',
  },
  '.cm-md-table tbody tr:nth-child(even) td, .cm-md-table tbody tr:nth-child(even) td': {
    background: 'hsla(226, 14%, 16%, 0.45)',
  },
  '.cm-md-table code': {
    fontFamily: 'var(--font-mono)',
    fontSize: '0.85em',
    background: 'var(--bg-deep)',
    padding: '1px 5px',
    borderRadius: '2px',
    color: 'hsl(38, 88%, 66%)',
  },
  '.cm-doc-embed': {
    display: 'block',
    margin: '10px 0',
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: '2px',
    background: 'var(--bg-surface)',
    color: 'hsl(222, 12%, 86%)',
    cursor: 'pointer',
  },
  '.cm-doc-embed:hover': {
    borderColor: 'hsla(38, 92%, 55%, 0.45)',
    background: 'var(--bg-raised)',
  },
  '.cm-doc-embed.is-missing': {
    cursor: 'default',
    color: 'hsl(224, 8%, 55%)',
    borderStyle: 'dashed',
  },
  '.cm-doc-embed-title': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: 'hsl(222, 14%, 92%)',
    fontFamily: 'var(--font-display)',
    fontWeight: '700',
    fontStyle: 'italic',
    fontSize: '0.92rem',
    lineHeight: '1.3',
  },
  '.cm-doc-embed-preview': {
    marginTop: '6px',
    color: 'hsl(222, 9%, 62%)',
    fontSize: '0.85rem',
    lineHeight: '1.45',
  },
  '.cm-md-image-wrap': {
    position: 'relative',
    display: 'inline-block',
    margin: '12px 0',
    maxWidth: '100%',
    verticalAlign: 'top',
    lineHeight: '0',
  },
  '.cm-md-image-wrap.is-resizing': {
    userSelect: 'none',
  },
  '.cm-md-image': {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '2px',
    border: '1px solid var(--border)',
    background: 'var(--bg-surface)',
    cursor: 'default',
  },
  '.cm-md-image.is-loading': {
    minHeight: '120px',
  },
  '.cm-md-image.is-error': {
    minHeight: '48px',
    padding: '12px',
    color: 'hsl(222, 9%, 55%)',
    fontSize: '0.85rem',
  },
  '.cm-md-image-resize': {
    position: 'absolute',
    right: '4px',
    bottom: '4px',
    width: '14px',
    height: '14px',
    borderRadius: '2px',
    border: '1px solid hsla(38, 92%, 55%, 0.85)',
    background: 'linear-gradient(135deg, transparent 45%, hsla(38, 92%, 55%, 0.95) 45%, hsla(38, 92%, 55%, 0.95) 55%, transparent 55%), linear-gradient(135deg, transparent 65%, hsla(38, 92%, 55%, 0.75) 65%, hsla(38, 92%, 55%, 0.75) 75%, transparent 75%)',
    backgroundColor: 'hsla(226, 14%, 12%, 0.85)',
    cursor: 'nwse-resize',
    opacity: '0',
    transition: 'opacity 0.12s ease',
    boxShadow: '0 0 0 1px hsla(0, 0%, 0%, 0.35)',
    zIndex: '2',
  },
  '.cm-md-image-wrap:hover .cm-md-image-resize, .cm-md-image-wrap.is-resizing .cm-md-image-resize, .cm-md-image-wrap:focus-within .cm-md-image-resize': {
    opacity: '1',
  },
  '.cm-md-image-size': {
    position: 'absolute',
    left: '6px',
    bottom: '6px',
    padding: '1px 6px',
    borderRadius: '3px',
    background: 'hsla(226, 14%, 10%, 0.82)',
    color: 'hsl(38, 88%, 72%)',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.7rem',
    lineHeight: '1.4',
    pointerEvents: 'none',
    opacity: '0',
    transition: 'opacity 0.12s ease',
    zIndex: '2',
  },
  '.cm-md-image-wrap.is-resizing .cm-md-image-size': {
    opacity: '1',
  },
}, { dark: true });

/* ─── Syntax Highlighting ────────────────────────────────── */
export const cascadeHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'hsl(222, 16%, 96%)', fontFamily: 'var(--font-display)', fontWeight: '700', fontStyle: 'italic', fontSize: '1.75em' },
  { tag: tags.heading2, color: 'hsl(222, 14%, 93%)', fontFamily: 'var(--font-display)', fontWeight: '700', fontStyle: 'italic', fontSize: '1.35em' },
  { tag: tags.heading3, color: 'hsl(222, 12%, 88%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic', fontSize: '1.15em' },
  { tag: tags.heading4, color: 'hsl(222, 10%, 84%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic' },
  { tag: tags.heading5, color: 'hsl(222, 10%, 80%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic' },
  { tag: tags.heading6, color: 'hsl(222, 9%, 76%)', fontFamily: 'var(--font-display)', fontWeight: '600', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700', color: 'hsl(222, 16%, 96%)' },
  { tag: tags.emphasis, fontStyle: 'italic', color: 'hsl(222, 12%, 86%)' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'hsl(224, 8%, 46%)' },
  { tag: tags.link, color: 'hsl(38, 88%, 68%)', textDecoration: 'underline' },
  { tag: tags.url, color: 'hsl(38, 70%, 56%)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', color: 'hsl(38, 88%, 66%)', fontSize: '0.875em' },
  { tag: tags.processingInstruction, color: 'hsl(38, 88%, 60%)' },
  { tag: tags.quote, color: 'hsl(222, 9%, 58%)', fontStyle: 'italic' },
  /* Code palette borrowed from the decal set so nothing reads as a stray hue */
  { tag: tags.keyword, color: 'hsl(338, 78%, 68%)' },
  { tag: tags.string, color: 'hsl(152, 62%, 60%)' },
  { tag: tags.number, color: 'hsl(38, 92%, 66%)' },
  { tag: tags.comment, color: 'hsl(224, 8%, 40%)' },
  { tag: tags.meta, color: 'hsl(192, 40%, 52%)' },
  { tag: tags.punctuation, color: 'hsl(224, 8%, 44%)' },
  { tag: tags.contentSeparator, color: 'hsl(226, 11%, 26%)' },
]);
