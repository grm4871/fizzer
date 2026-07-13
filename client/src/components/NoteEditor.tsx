import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import type { Note, NoteSummary } from '../api';
import { api, formatRelativeDate, type NotePublishInfo } from '../api';
import { findEmbeddedNote, normalizeDocEmbedTarget, NOTE_DND_TYPE, noteEmbedMarkdown } from '../docEmbeds';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, placeholder as cmPlaceholder, Decoration, type DecorationSet, WidgetType, drawSelection } from '@codemirror/view';
import { EditorState, type Extension, RangeSetBuilder, Prec, StateField } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, defaultHighlightStyle } from '@codemirror/language';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { closeBrackets } from '@codemirror/autocomplete';
import { languages } from '@codemirror/language-data';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { FileText, Link2, Box, Globe, ExternalLink } from 'lucide-react';

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
  notes?: NoteSummary[];
  onOpenNote?: (id: string) => void;
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
    border: '1px solid hsl(25, 7%, 20%)',
    padding: '5px 11px',
    textAlign: 'left',
    verticalAlign: 'top',
  },
  '.cm-md-table th': {
    background: 'hsl(22, 8%, 12%)',
    color: 'hsl(35, 12%, 92%)',
    fontWeight: '600',
  },
  '.cm-md-table tbody tr:nth-child(even) td, .cm-md-table tbody tr:nth-child(even) td': {
    background: 'hsla(22, 8%, 14%, 0.4)',
  },
  '.cm-md-table code': {
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
    fontSize: '0.85em',
    background: 'hsl(22, 8%, 13%)',
    padding: '1px 5px',
    borderRadius: '3px',
    color: 'hsl(38, 75%, 65%)',
  },
  '.cm-doc-embed': {
    display: 'block',
    margin: '10px 0',
    padding: '10px 12px',
    border: '1px solid hsl(25, 7%, 20%)',
    borderRadius: '6px',
    background: 'hsl(22, 8%, 10%)',
    color: 'hsl(35, 10%, 86%)',
    cursor: 'pointer',
  },
  '.cm-doc-embed:hover': {
    borderColor: 'hsl(33, 38%, 36%)',
    background: 'hsl(22, 8%, 12%)',
  },
  '.cm-doc-embed.is-missing': {
    cursor: 'default',
    color: 'hsl(25, 5%, 55%)',
    borderStyle: 'dashed',
  },
  '.cm-doc-embed-title': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    color: 'hsl(35, 12%, 92%)',
    fontWeight: '600',
    fontSize: '0.92rem',
    lineHeight: '1.3',
  },
  '.cm-doc-embed-preview': {
    marginTop: '6px',
    color: 'hsl(25, 6%, 62%)',
    fontSize: '0.85rem',
    lineHeight: '1.45',
  },
  '.cm-md-image-wrap': {
    display: 'block',
    margin: '12px 0',
    maxWidth: '100%',
  },
  '.cm-md-image': {
    display: 'block',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: '8px',
    border: '1px solid hsl(22, 7%, 18%)',
    background: 'hsl(22, 8%, 10%)',
  },
  '.cm-md-image.is-loading': {
    minHeight: '120px',
  },
  '.cm-md-image.is-error': {
    minHeight: '48px',
    padding: '12px',
    color: 'hsl(25, 6%, 55%)',
    fontSize: '0.85rem',
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

const NOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const NOTE_AUDIO_MAX_BYTES = 8 * 1024 * 1024;

function imageFileFromDataTransfer(dataTransfer: DataTransfer | null): File | null {
  if (!dataTransfer) return null;
  const fromFiles = Array.from(dataTransfer.files || []).find((file) => file.type.startsWith('image/'));
  if (fromFiles) return fromFiles;
  for (const item of Array.from(dataTransfer.items || [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read image'));
    reader.readAsDataURL(file);
  });
}

function resolveAssetUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  const apiBase = import.meta.env.VITE_API_URL || '';
  return `${apiBase}${url.startsWith('/') ? url : `/${url}`}`;
}

/* ─── Image Widget ───────────────────────────────────────── */
class ImageWidget extends WidgetType {
  constructor(private alt: string, private url: string) {
    super();
  }

  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-image-wrap';

    const img = document.createElement('img');
    img.className = 'cm-md-image is-loading';
    img.alt = this.alt || 'image';

    const resolved = resolveAssetUrl(this.url);
    if (/^https?:\/\//i.test(resolved) && !resolved.includes('/api/notes/')) {
      img.src = resolved;
      img.onload = () => img.classList.remove('is-loading');
      img.onerror = () => {
        img.classList.remove('is-loading');
        img.classList.add('is-error');
        img.alt = 'Failed to load image';
      };
      wrap.appendChild(img);
      return wrap;
    }

    const token = localStorage.getItem('docs_token');
    fetch(resolved, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error('load failed');
        return res.blob();
      })
      .then((blob) => {
        img.src = URL.createObjectURL(blob);
        img.onload = () => img.classList.remove('is-loading');
      })
      .catch(() => {
        img.classList.remove('is-loading');
        img.classList.add('is-error');
        img.alt = 'Failed to load image';
      });

    wrap.appendChild(img);
    return wrap;
  }

  eq(other: ImageWidget) {
    return this.alt === other.alt && this.url === other.url;
  }
}

/* ─── GFM Table support ──────────────────────────────────── */
type CellAlign = 'left' | 'center' | 'right' | null;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal inline markdown → HTML for table cells (escape first, then format). */
function renderCellInline(raw: string): string {
  let s = escapeHtml(raw.trim());
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<span class="cm-external-link" data-url="$2">$1</span>');
  s = s.replace(/\[\[([^\]]+)\]\]/g, '<span class="cm-wikilink">$1</span>');
  return s;
}

/** Split a `| a | b |` row into trimmed cells, dropping the outer pipes. */
function splitTableRow(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** True if the line is a GFM delimiter row, e.g. `|---|:--:|` (must have a pipe,
 * so a bare `---` horizontal rule isn't mistaken for a 1-column table). */
function isTableDelimiter(text: string): boolean {
  if (!text.includes('|')) return false;
  const cells = splitTableRow(text);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function cellAlign(delimCell: string): CellAlign {
  const c = delimCell.trim();
  const l = c.startsWith(':');
  const r = c.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return null;
}

class TableWidget extends WidgetType {
  constructor(
    private header: string[],
    private align: CellAlign[],
    private rows: string[][],
    private key: string,
  ) {
    super();
  }
  eq(other: TableWidget) {
    return this.key === other.key;
  }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'cm-md-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    this.header.forEach((cell, i) => {
      const th = document.createElement('th');
      th.innerHTML = renderCellInline(cell);
      const a = this.align[i];
      if (a) th.style.textAlign = a;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of this.rows) {
      const tr = document.createElement('tr');
      for (let i = 0; i < this.header.length; i++) {
        const td = document.createElement('td');
        td.innerHTML = renderCellInline(row[i] ?? '');
        const a = this.align[i];
        if (a) td.style.textAlign = a;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }
}

class DocEmbedWidget extends WidgetType {
  constructor(
    private target: string,
    private note: NoteSummary | null,
  ) {
    super();
  }
  eq(other: DocEmbedWidget) {
    return this.target === other.target && this.note?.id === other.note?.id && this.note?.content_preview === other.note?.content_preview;
  }
  toDOM() {
    const root = document.createElement('div');
    root.className = `cm-doc-embed${this.note ? '' : ' is-missing'}`;
    root.setAttribute('data-note-id', this.note?.id ?? '');

    const title = document.createElement('div');
    title.className = 'cm-doc-embed-title';
    title.textContent = this.note?.title ?? `Missing note: ${this.target}`;
    root.appendChild(title);

    const previewText = this.note?.content_preview?.trim();
    if (previewText) {
      const preview = document.createElement('div');
      preview.className = 'cm-doc-embed-preview';
      preview.textContent = previewText.length > 220 ? `${previewText.slice(0, 219)}…` : previewText;
      root.appendChild(preview);
    }
    return root;
  }
}

type CascadeWidgetMeta = {
  title?: string;
  runtime?: string;
  autorun?: boolean;
};

function parseCascadeWidget(source: string): { meta: CascadeWidgetMeta; body: string } {
  const trimmedStart = source.replace(/^\s*\n/, '');
  if (!trimmedStart.startsWith('---\n')) return { meta: {}, body: source };

  const close = trimmedStart.indexOf('\n---', 4);
  if (close === -1) return { meta: {}, body: source };

  const metaText = trimmedStart.slice(4, close);
  const body = trimmedStart.slice(close + 4).replace(/^\n/, '');
  const meta: CascadeWidgetMeta = {};

  for (const line of metaText.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    if (key === 'title') meta.title = value;
    if (key === 'runtime') meta.runtime = value;
    if (key === 'autorun') meta.autorun = value === 'true';
  }

  return { meta, body };
}

function buildWidgetSrcDoc(body: string): string {
  const bridge = `
<script>
(() => {
  const send = (message) => parent.postMessage({ __cascadeWidget: true, ...message }, '*');
  const requestHost = (type, payload) => {
    const requestId = Math.random().toString(36).slice(2);
    send({ type, requestId, ...payload });
    return new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const data = event.data || {};
        if (!data.__cascadeWidget || data.type !== type + '-result' || data.requestId !== requestId) return;
        window.removeEventListener('message', onMessage);
        if (data.error) reject(new Error(data.error));
        else resolve(data.result);
      };
      window.addEventListener('message', onMessage);
    });
  };
  window.cascade = {
    agent(payload) {
      const prompt = typeof payload === 'string' ? payload : payload && payload.prompt;
      send({ type: 'agent', prompt: String(prompt || '') });
    },
    feed(payload) {
      const url = typeof payload === 'string' ? payload : payload && payload.url;
      const force = Boolean(payload && payload.force);
      return requestHost('feed', { url: String(url || ''), force });
    },
    setHeight(height) {
      send({ type: 'height', height: Number(height) || 0 });
    }
  };
  const reportHeight = () => {
    const doc = document.documentElement;
    const body = document.body;
    const height = Math.max(
      doc ? doc.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      doc ? doc.offsetHeight : 0,
      body ? body.offsetHeight : 0,
      220
    );
    window.cascade.setHeight(height);
  };
  window.addEventListener('load', reportHeight);
  window.addEventListener('resize', reportHeight);
  if ('ResizeObserver' in window) {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }
  setTimeout(reportHeight, 0);
  setTimeout(reportHeight, 250);
})();
</script>`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none';" />
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; background: transparent; color: #f2eee8; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    button, input, select, textarea { font: inherit; }
    button { cursor: pointer; }
  </style>
  ${bridge}
</head>
<body>
${body}
</body>
</html>`;
}

class CascadeHtmlWidget extends WidgetType {
  constructor(
    private source: string,
    private from: number,
    private to: number,
    private requestAgent: (prompt: string) => void,
    private fetchFeed: (url: string, force?: boolean) => Promise<unknown>,
    private enableAutorun: (from: number, to: number, source: string) => void,
  ) {
    super();
  }

  eq(other: CascadeHtmlWidget) {
    return this.source === other.source && this.from === other.from && this.to === other.to;
  }

  toDOM() {
    const { meta, body } = parseCascadeWidget(this.source);
    const root = document.createElement('div');
    root.className = 'cm-cascade-widget';

    const header = document.createElement('div');
    header.className = 'cm-cascade-widget-header';

    const title = document.createElement('span');
    title.className = 'cm-cascade-widget-title';
    title.textContent = meta.title || 'Widget';
    header.appendChild(title);

    const runtime = document.createElement('span');
    runtime.className = 'cm-cascade-widget-runtime';
    runtime.textContent = meta.runtime || 'iframe';
    header.appendChild(runtime);

    const runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.className = 'cm-cascade-widget-action';
    runButton.textContent = 'Run';
    header.appendChild(runButton);

    const stopButton = document.createElement('button');
    stopButton.type = 'button';
    stopButton.className = 'cm-cascade-widget-action';
    stopButton.textContent = 'Stop';
    stopButton.hidden = true;
    header.appendChild(stopButton);

    const enableButton = document.createElement('button');
    enableButton.type = 'button';
    enableButton.className = 'cm-cascade-widget-action';
    enableButton.textContent = 'Enable';
    enableButton.hidden = Boolean(meta.autorun);
    enableButton.title = 'Always run this widget when the note opens';
    header.appendChild(enableButton);

    root.appendChild(header);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'cm-cascade-widget-body';

    const placeholder = document.createElement('div');
    placeholder.className = 'cm-cascade-widget-placeholder';
    placeholder.textContent = 'Widget code is sandboxed and runs on demand.';
    bodyEl.appendChild(placeholder);
    root.appendChild(bodyEl);

    let frame: HTMLIFrameElement | null = null;

    const onMessage = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow || !event.data?.__cascadeWidget) return;
      if (event.data.type === 'height') {
        const next = Math.max(180, Math.min(1200, Number(event.data.height) || 0));
        frame.style.height = `${next}px`;
      }
      if (event.data.type === 'agent') {
        const prompt = String(event.data.prompt || '').trim();
        if (!prompt) return;
        this.requestAgent([
          prompt,
          '',
          'Current widget block:',
          '```cascade-widget',
          this.source,
          '```',
          '',
          'Update only this widget block unless I explicitly ask for broader note changes. Keep it as valid cascade-widget HTML.',
        ].join('\n'));
      }
      if (event.data.type === 'feed') {
        const requestId = String(event.data.requestId || '');
        const url = String(event.data.url || '').trim();
        const force = Boolean(event.data.force);
        const respond = (payload: Record<string, unknown>) => {
          frame?.contentWindow?.postMessage({ __cascadeWidget: true, type: 'feed-result', requestId, ...payload }, '*');
        };
        if (!requestId || !url) {
          respond({ error: 'Feed URL is required.' });
          return;
        }
        this.fetchFeed(url, force).then(
          (result) => respond({ result }),
          (error) => respond({ error: error instanceof Error ? error.message : String(error) }),
        );
      }
    };

    const stopWidget = () => {
      if (frame) {
        frame.remove();
        frame = null;
      }
      root.classList.remove('is-running');
      stopButton.hidden = true;
      runButton.hidden = false;
      placeholder.hidden = false;
    };

    const showError = (message: string) => {
      stopWidget();
      placeholder.hidden = false;
      placeholder.textContent = message;
      placeholder.classList.add('is-error');
    };

    const runWidget = () => {
      try {
        placeholder.hidden = true;
        placeholder.classList.remove('is-error');
        placeholder.textContent = 'Widget code is sandboxed and runs on demand.';
        if (frame) frame.remove();

        frame = document.createElement('iframe');
        frame.className = 'cm-cascade-widget-frame';
        frame.setAttribute('sandbox', 'allow-scripts allow-forms');
        frame.setAttribute('title', meta.title || 'Cascade widget');
        frame.srcdoc = buildWidgetSrcDoc(body);
        bodyEl.appendChild(frame);
        root.classList.add('is-running');
        runButton.hidden = true;
        stopButton.hidden = false;
      } catch (error) {
        showError(error instanceof Error ? error.message : 'Widget failed to render.');
      }
    };

    const enableAutorunClick = () => this.enableAutorun(this.from, this.to, this.source);
    runButton.addEventListener('click', runWidget);
    stopButton.addEventListener('click', stopWidget);
    enableButton.addEventListener('click', enableAutorunClick);
    window.addEventListener('message', onMessage);
    (root as any).__cascadeWidgetCleanup = () => {
      runButton.removeEventListener('click', runWidget);
      stopButton.removeEventListener('click', stopWidget);
      enableButton.removeEventListener('click', enableAutorunClick);
      window.removeEventListener('message', onMessage);
      stopWidget();
    };

    if (meta.autorun) {
      setTimeout(runWidget, 0);
    }

    return root;
  }

  destroy(dom: HTMLElement) {
    (dom as any).__cascadeWidgetCleanup?.();
  }
}

/* ─── WYSIWYG Decorations Plugin ─────────────────────────── */
export function buildDecorations(
  state: EditorState,
  requestWidgetAgent?: (prompt: string) => void,
  fetchWidgetFeed?: (url: string, force?: boolean) => Promise<unknown>,
  enableWidgetAutorun?: (from: number, to: number, source: string) => void,
  notes: NoteSummary[] = [],
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  const cursorLine = state.selection.main.head;
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

  const widgetBlocks: { from: number; to: number; source: string }[] = [];
  let widgetStartLine: number | null = null;
  let widgetStartPos = 0;
  let widgetContentStart = 0;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (widgetStartLine === null && line.text.trim() === '```cascade-widget') {
      widgetStartLine = i;
      widgetStartPos = line.from;
      widgetContentStart = line.to + 1;
      continue;
    }
    if (widgetStartLine !== null && line.text.trim() === '```') {
      widgetBlocks.push({
        from: widgetStartPos,
        to: line.to,
        source: doc.sliceString(widgetContentStart, Math.max(widgetContentStart, line.from - 1)),
      });
      widgetStartLine = null;
    }
  }

  for (const block of widgetBlocks) {
    if (cursorLine < doc.lineAt(block.from).number || cursorLine > doc.lineAt(block.to).number) {
      decos.push({
        from: block.from,
        to: block.to,
        deco: Decoration.replace({
          block: true,
          widget: new CascadeHtmlWidget(
            block.source,
            block.from,
            block.to,
            (prompt) => requestWidgetAgent?.(prompt),
            (url, force) => fetchWidgetFeed?.(url, force) ?? Promise.reject(new Error('Feed API is not available.')),
            (from, to, source) => enableWidgetAutorun?.(from, to, source),
          ),
        }),
      });
    }
  }

  // GFM tables: a header row, a delimiter row, then 0+ body rows. Rendered as a
  // block widget when the cursor is outside (raw source stays editable inside).
  const inWidgetBlock = (from: number, to: number) =>
    widgetBlocks.some((b) => from >= b.from && to <= b.to);
  const tableBlocks: { from: number; to: number }[] = [];
  for (let i = 1; i + 1 <= doc.lines; i++) {
    const headerLine = doc.line(i);
    const delimLine = doc.line(i + 1);
    if (inWidgetBlock(headerLine.from, headerLine.to)) continue;
    if (!headerLine.text.includes('|')) continue;
    if (!isTableDelimiter(delimLine.text)) continue;

    const header = splitTableRow(headerLine.text);
    const align = splitTableRow(delimLine.text).map(cellAlign);
    if (header.length !== align.length) continue; // not a real table
    const rows: string[][] = [];
    let lastLine = i + 1;
    for (let j = i + 2; j <= doc.lines; j++) {
      const bl = doc.line(j);
      if (!bl.text.trim() || !bl.text.includes('|') || inWidgetBlock(bl.from, bl.to)) break;
      rows.push(splitTableRow(bl.text));
      lastLine = j;
    }

    const from = headerLine.from;
    const to = doc.line(lastLine).to;
    tableBlocks.push({ from, to });
    if (cursorLine < doc.lineAt(from).number || cursorLine > doc.lineAt(to).number) {
      decos.push({
        from,
        to,
        deco: Decoration.replace({
          block: true,
          widget: new TableWidget(header, align, rows, doc.sliceString(from, to)),
        }),
      });
    }
    i = lastLine; // skip past the consumed table
  }
  const inTableBlock = (from: number, to: number) =>
    tableBlocks.some((b) => from >= b.from && to <= b.to);

  let inCodeBlock = false;
  let codeBlockFenceChar = '';
  let codeBlockFenceLength = 0;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;
    const isActive = i === activeLine;
    if (widgetBlocks.some((block) => line.from >= block.from && line.to <= block.to)) continue;
    if (inTableBlock(line.from, line.to)) continue;

    if (inCodeBlock) {
      const endFenceMatch = text.match(/^(\s*)(`{3,}|~{3,})\s*$/);
      if (endFenceMatch && endFenceMatch[2][0] === codeBlockFenceChar && endFenceMatch[2].length >= codeBlockFenceLength) {
        inCodeBlock = false;
        if (!isActive) {
          collectDeco(line.from, line.to, hidden);
        } else {
          decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-code-block-line' }) });
        }
        continue;
      }

      decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-code-block-line' }) });
      continue;
    }

    const startFenceMatch = text.match(/^(\s*)(`{3,}|~{3,})([^\s`~]*)\s*$/);
    if (startFenceMatch) {
      inCodeBlock = true;
      codeBlockFenceChar = startFenceMatch[2][0];
      codeBlockFenceLength = startFenceMatch[2].length;
      if (!isActive) {
        collectDeco(line.from, line.to, hidden);
      } else {
        decos.push({ from: line.from, to: line.from, deco: Decoration.line({ class: 'cm-code-block-line' }) });
      }
      continue;
    }

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

    const imageMatch = text.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (imageMatch) {
      decos.push({
        from: line.from,
        to: line.to,
        deco: Decoration.replace({
          block: true,
          widget: new ImageWidget(imageMatch[1], imageMatch[2]),
        }),
      });
      continue;
    }

    const embedMatch = text.trim().match(/^!\[\[([^\]]+)\]\]$/);
    if (embedMatch) {
      const target = normalizeDocEmbedTarget(embedMatch[1]);
      decos.push({
        from: line.from,
        to: line.to,
        deco: Decoration.replace({
          widget: new DocEmbedWidget(target, findEmbeddedNote(notes, target)),
        }),
      });
      continue;
    }

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

  // Sort decorations by start position ascending, then end position descending.
  // Line decorations (from === to) must always precede mark decorations (from < to) starting at the same position.
  decos.sort((a, b) => {
    if (a.from !== b.from) {
      return a.from - b.from;
    }
    const aIsLine = a.from === a.to;
    const bIsLine = b.from === b.to;
    if (aIsLine && !bIsLine) return -1;
    if (!aIsLine && bIsLine) return 1;
    return b.to - a.to;
  });

  // Add all sorted decorations to builder
  for (const item of decos) {
    builder.add(item.from, item.to, item.deco);
  }

  return builder.finish();
}

function createWysiwygDecorations(
  requestWidgetAgent?: (prompt: string) => void,
  fetchWidgetFeed?: (url: string, force?: boolean) => Promise<unknown>,
  enableWidgetAutorun?: (from: number, to: number, source: string) => void,
  notes: NoteSummary[] = [],
) {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, requestWidgetAgent, fetchWidgetFeed, enableWidgetAutorun, notes);
    },
    update(decorations, transaction) {
      if (transaction.docChanged || transaction.selection) {
        return buildDecorations(transaction.state, requestWidgetAgent, fetchWidgetFeed, enableWidgetAutorun, notes);
      }
      return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return field;
}

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
export function NoteEditor({ note, content, onContentChange, onSave, onRename, onExecuteDirective, onOpenWikilink, notes = [], onOpenNote }: NoteEditorProps) {
  const [publishInfo, setPublishInfo] = useState<NotePublishInfo>({ published: false });
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishNotice, setPublishNotice] = useState('');
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

  const requestWidgetAgent = useCallback((prompt: string) => {
    onExecuteDirectiveRef.current?.(prompt);
  }, []);

  const fetchWidgetFeed = useCallback(async (url: string, force?: boolean) => {
    if (!note?.vault_id) throw new Error('No active vault for widget feed.');
    const data = await api<{ feed: unknown }>(`/api/vaults/${note.vault_id}/feed`, {
      method: 'POST',
      body: JSON.stringify({ url, force }),
    });
    return data.feed;
  }, [note?.vault_id]);

  const enableWidgetAutorun = useCallback((from: number, to: number, source: string) => {
    const view = viewRef.current;
    if (!view) return;
    const ok = window.confirm('Enable this widget to run automatically when the note opens?');
    if (!ok) return;
    const nextSource = setWidgetAutorun(source);
    view.dispatch({
      changes: {
        from,
        to,
        insert: ['```cascade-widget', nextSource, '```'].join('\n'),
      },
    });
  }, []);

  const insertImageFromFile = useCallback(async (file: File, view?: EditorView, coords?: { x: number; y: number }) => {
    const editorView = view ?? viewRef.current;
    if (!note?.id || !editorView) return false;
    if (!file.type.startsWith('image/')) return false;
    if (file.size > NOTE_IMAGE_MAX_BYTES) {
      flashPublishNotice(`Image is too large (max ${NOTE_IMAGE_MAX_BYTES / (1024 * 1024)}MB)`);
      return false;
    }

    flashPublishNotice('Uploading image...');
    try {
      const data = await readFileAsBase64(file);
      const result = await api<{ url: string }>(`/api/notes/${note.id}/assets`, {
        method: 'POST',
        body: JSON.stringify({
          media_type: file.type,
          data,
          filename: file.name,
        }),
      });
      const alt = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
      const markdown = `![${alt}](${result.url})`;
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
      flashPublishNotice('Image pasted');
      return true;
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : 'Image upload failed');
      return false;
    }
  }, [note, flashPublishNotice]);

  const insertAudioFromFile = useCallback(async (file: File) => {
    const editorView = viewRef.current;
    if (!note?.id || !editorView) return false;
    const isMp3 = file.type === 'audio/mpeg' || file.name.toLowerCase().endsWith('.mp3');
    if (!isMp3) return false;
    if (file.size > NOTE_AUDIO_MAX_BYTES) {
      flashPublishNotice(`MP3 is too large (max ${NOTE_AUDIO_MAX_BYTES / (1024 * 1024)}MB)`);
      return false;
    }
    flashPublishNotice('Uploading MP3...');
    try {
      const data = await readFileAsBase64(file);
      const result = await api<{ url: string }>(`/api/notes/${note.id}/assets`, {
        method: 'POST',
        body: JSON.stringify({ media_type: 'audio/mpeg', data, filename: file.name }),
      });
      const label = file.name || 'audio.mp3';
      const from = editorView.state.selection.main.from;
      const to = editorView.state.selection.main.to;
      const line = editorView.state.doc.lineAt(from);
      const prefix = line.text.trim() ? '\n\n' : '';
      const insert = `${prefix}[${label}](${result.url})\n`;
      editorView.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        scrollIntoView: true,
      });
      editorView.focus();
      flashPublishNotice('MP3 attached');
      return true;
    } catch (err) {
      flashPublishNotice(err instanceof Error ? err.message : 'MP3 upload failed');
      return false;
    }
  }, [note, flashPublishNotice]);

  insertImageFromFileRef.current = insertImageFromFile;

  const insertNoteEmbed = useCallback((noteId: string, coords?: { x: number; y: number }) => {
    const view = viewRef.current;
    if (!view) return false;
    const embedded = notes.find((item) => item.id === noteId);
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
  }, [notes]);

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
      createWysiwygDecorations(requestWidgetAgent, fetchWidgetFeed, enableWidgetAutorun, notes),
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
        mousedown(event) {
          const target = event.target as HTMLElement;
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
    [requestWidgetAgent, fetchWidgetFeed, enableWidgetAutorun, notes, insertNoteEmbed],
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
      case 'widget':
        insertAtCursor(view, sampleWidgetBlock());
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
        <button id="toolbar-image" className="toolbar-btn" onClick={() => toolbarAction('image')} title="Upload image or MP3 (images also support paste/drop)">📎</button>
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*,audio/mpeg,.mp3"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file?.type.startsWith('image/')) void insertImageFromFile(file);
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
        <button id="toolbar-widget" className="toolbar-btn" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => toolbarAction('widget')} title="Insert widget"><Box size={15} /></button>

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

function sampleWidgetBlock() {
  return `\n\`\`\`cascade-widget\n---\ntitle: Feed widget\nruntime: iframe\nautorun: false\nfeed_url: https://example.com/feed.xml\nnotify: false\ninterval_minutes: 30\npermissions:\n  network: feed\n  actions: feed\n---\n<div class="widget">\n  <div class="bar">\n    <strong id="title">Feed widget</strong>\n    <button id="refresh">Refresh</button>\n  </div>\n  <ol id="items"></ol>\n  <p id="status">Click refresh to fetch RSS, Atom, or JSON Feed data through Cascade.</p>\n</div>\n\n<style>\n  .widget { padding: 12px 0; }\n  .bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }\n  strong { font-size: 15px; }\n  button {\n    border: 1px solid rgba(245, 158, 64, 0.35);\n    border-radius: 5px;\n    background: rgba(245, 158, 64, 0.12);\n    color: #f5c58b;\n    padding: 5px 9px;\n  }\n  ol { margin: 0; padding-left: 22px; }\n  li { margin: 8px 0; }\n  a { color: #8ec7ff; text-decoration: none; }\n  p { margin: 10px 0 0; color: #a99f94; font-size: 13px; }\n</style>\n\n<script type="module">\n  const feedUrl = 'https://example.com/feed.xml';\n  const title = document.querySelector('#title');\n  const items = document.querySelector('#items');\n  const status = document.querySelector('#status');\n\n  async function refresh(force = false) {\n    status.textContent = 'Refreshing...';\n    const feed = await cascade.feed({ url: feedUrl, force });\n    title.textContent = feed.title || 'Feed';\n    items.replaceChildren(...feed.items.slice(0, 8).map((item) => {\n      const li = document.createElement('li');\n      const link = document.createElement(item.url ? 'a' : 'span');\n      link.textContent = item.title;\n      if (item.url) link.href = item.url;\n      li.append(link);\n      return li;\n    }));\n    status.textContent = 'Updated ' + new Date(feed.fetched_at).toLocaleTimeString();\n    cascade.setHeight(document.body.scrollHeight);\n  }\n\n  document.querySelector('#refresh').addEventListener('click', () => refresh(true).catch((error) => {\n    status.textContent = error.message;\n  }));\n</script>\n\`\`\`\n`;
}

function setWidgetAutorun(source: string): string {
  const trimmedStart = source.replace(/^\s*\n/, '');
  if (!trimmedStart.startsWith('---\n')) {
    return ['---', 'autorun: true', '---', source.replace(/^\n/, '')].join('\n');
  }

  const close = trimmedStart.indexOf('\n---', 4);
  if (close === -1) {
    return ['---', 'autorun: true', '---', source.replace(/^\n/, '')].join('\n');
  }

  const metaText = trimmedStart.slice(4, close);
  const body = trimmedStart.slice(close + 4).replace(/^\n/, '');
  const lines = metaText.split('\n');
  const existing = lines.findIndex((line) => /^autorun\s*:/.test(line));
  if (existing === -1) lines.push('autorun: true');
  else lines[existing] = 'autorun: true';
  return ['---', ...lines, '---', body].join('\n');
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
