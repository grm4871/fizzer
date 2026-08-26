/**
 * Small CodeMirror widgets used by live preview. Private blocks are replaced
 * while unfocused so their contents never enter the rendered DOM; focusing the
 * block restores ordinary editable Markdown.
 */
import { WidgetType } from '@codemirror/view';
import type { NoteSummary } from '../api';

/* ─── Checkbox Widget ────────────────────────────────────── */
export class CheckboxWidget extends WidgetType {
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
export class HRWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement('hr');
    hr.className = 'cm-hr-widget';
    return hr;
  }
}

export class PrivateBlockWidget extends WidgetType {
  constructor(private from: number) {
    super();
  }
  toDOM() {
    const root = document.createElement('div');
    root.className = 'cm-private-block';
    root.dataset.privateFrom = String(this.from);
    root.setAttribute('role', 'button');
    root.setAttribute('aria-label', 'Private block. Hidden from agents. Click to edit.');
    root.innerHTML = '<span aria-hidden="true">🔒</span><span><strong>Private block</strong><small>Hidden from agents · click to edit</small></span>';
    return root;
  }
  eq(other: PrivateBlockWidget) {
    return this.from === other.from;
  }
  ignoreEvent() {
    return false;
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
export class TableWidget extends WidgetType {
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

export class DocEmbedWidget extends WidgetType {
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
