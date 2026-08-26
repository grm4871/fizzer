/**
 * Deterministic live-preview decoration parser. It intentionally handles a
 * bounded Markdown subset (headings, emphasis, links, media, tables, embeds,
 * private fences, and checkboxes) and leaves the active line editable.
 * Decorations are sorted by source position; zero-width line decorations win
 * ties so CodeMirror's RangeSet contract stays stable.
 */
import { EditorView, Decoration, type DecorationSet } from '@codemirror/view';
import { EditorState, RangeSetBuilder, StateField } from '@codemirror/state';
import type { NoteSummary } from '../api';
import { findEmbeddedNote, normalizeDocEmbedTarget } from '../docEmbeds';
import { CheckboxWidget, HRWidget, PrivateBlockWidget, TableWidget, DocEmbedWidget } from './noteEditorWidgets';
import { ImageWidget, VideoWidget, IMAGE_LINE_RE, isVideoMarkdownTarget, parseImageAlt } from './noteEditorMedia';

type CellAlign = 'left' | 'center' | 'right' | null;

/** Split a `| a | b |` row into trimmed cells, dropping the outer pipes. */
function splitTableRow(text: string): string[] {
  let t = text.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** True if the line is a GFM delimiter row, e.g. `|---|:--:|`. */
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

/* ─── WYSIWYG Decorations Plugin ─────────────────────────── */
export function buildDecorations(
  state: EditorState,
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

  const privateBlocks: { from: number; to: number }[] = [];
  let privateStart: number | null = null;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const marker = line.text.trim().toLowerCase();
    if (privateStart === null && marker === ':::private') {
      privateStart = line.from;
    } else if (privateStart !== null && marker === ':::') {
      privateBlocks.push({ from: privateStart, to: line.to });
      privateStart = null;
    }
  }
  if (privateStart !== null) privateBlocks.push({ from: privateStart, to: doc.length });
  const inPrivateBlock = (from: number, to: number) =>
    privateBlocks.some((block) => from >= block.from && to <= block.to);
  for (const block of privateBlocks) {
    if (activeLine < doc.lineAt(block.from).number || activeLine > doc.lineAt(block.to).number) {
      decos.push({
        from: block.from,
        to: block.to,
        deco: Decoration.replace({
          block: true,
          widget: new PrivateBlockWidget(block.from),
        }),
      });
    }
  }

  // GFM tables: a header row, a delimiter row, then 0+ body rows. Rendered as a
  // block widget when the cursor is outside (raw source stays editable inside).
  const tableBlocks: { from: number; to: number }[] = [];
  for (let i = 1; i + 1 <= doc.lines; i++) {
    const headerLine = doc.line(i);
    const delimLine = doc.line(i + 1);
    if (inPrivateBlock(headerLine.from, headerLine.to)) continue;
    if (!headerLine.text.includes('|')) continue;
    if (!isTableDelimiter(delimLine.text)) continue;

    const header = splitTableRow(headerLine.text);
    const align = splitTableRow(delimLine.text).map(cellAlign);
    if (header.length !== align.length) continue; // not a real table
    const rows: string[][] = [];
    let lastLine = i + 1;
    for (let j = i + 2; j <= doc.lines; j++) {
      const bl = doc.line(j);
      if (!bl.text.trim() || !bl.text.includes('|')) break;
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
    if (inPrivateBlock(line.from, line.to)) continue;
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

    const imageMatch = text.match(IMAGE_LINE_RE);
    if (imageMatch) {
      const { alt, width } = parseImageAlt(imageMatch[2]);
      const url = imageMatch[3];
      if (isVideoMarkdownTarget(alt, url)) {
        decos.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({
            block: true,
            widget: new VideoWidget(alt, url),
          }),
        });
      } else {
        decos.push({
          from: line.from,
          to: line.to,
          deco: Decoration.replace({
            block: true,
            widget: new ImageWidget(alt, url, width),
          }),
        });
      }
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

    // Paired inline delimiters: hide the open/close markers and style the span
    // between them. `strict` rejects empty spans; `breakOnFail` stops at the
    // first unmatched opener; `okStart`/`okEnd` are per-delimiter guards.
    const scanInline = (
      open: string,
      close: string,
      deco: typeof hidden,
      opts: { strict?: boolean; breakOnFail?: boolean; okStart?: (i: number) => boolean; okEnd?: (i: number) => boolean } = {},
    ) => {
      const { strict = true, breakOnFail = false, okStart, okEnd } = opts;
      let idx = text.indexOf(open, inlineStart);
      while (idx !== -1) {
        if (!okStart || okStart(idx)) {
          const end = text.indexOf(close, idx + open.length);
          const longEnough = strict ? end > idx + open.length : end >= idx + open.length;
          if (end !== -1 && longEnough && (!okEnd || okEnd(end))) {
            collectDeco(line.from + idx, line.from + idx + open.length, hidden);
            collectDeco(line.from + idx + open.length, line.from + end, deco);
            collectDeco(line.from + end, line.from + end + close.length, hidden);
            idx = text.indexOf(open, end + close.length);
            continue;
          }
        }
        if (breakOnFail) break;
        idx = text.indexOf(open, idx + open.length);
      }
    };

    scanInline('**', '**', boldDeco, { breakOnFail: true }); // Bold
    scanInline('*', '*', italicDeco, { // Italic (ignore bold **)
      okStart: (i) => text[i + 1] !== '*' && text[i - 1] !== '*',
      okEnd: (i) => text[i + 1] !== '*' && text[i - 1] !== '*',
    });
    scanInline('`', '`', codeDeco, { okStart: (i) => text[i + 1] !== '`' }); // Inline code
    scanInline('[[', ']]', wikilinkDeco, { strict: false, breakOnFail: true }); // Wikilinks

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

export function createWysiwygDecorations(
  /** Live notes list via getter so vault soft-refreshes don't reconfigure CM. */
  getNotes: () => NoteSummary[] = () => [],
) {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return buildDecorations(state, getNotes());
    },
    update(decorations, transaction) {
      // Full rebuild is O(doc). Only do it when the doc changed, or when the
      // active line changed (live-preview hides markers on the cursor line).
      // Pure same-line selection moves used to re-scan the whole note every
      // click/drag and froze large notes for 1–2s.
      if (transaction.docChanged) {
        return buildDecorations(
          transaction.state,
          getNotes(),
        );
      }
      if (transaction.selection) {
        const prev = transaction.startState;
        const oldLine = prev.doc.lineAt(prev.selection.main.head).number;
        const newLine = transaction.state.doc.lineAt(transaction.state.selection.main.head).number;
        if (oldLine !== newLine) {
          return buildDecorations(
            transaction.state,
            getNotes(),
          );
        }
      }
      return decorations;
    },
    provide: (f) => EditorView.decorations.from(f),
  });

  return field;
}

/* ─── Checkbox Click Handler ─────────────────────────────── */
export const checkboxClickHandler = EditorView.domEventHandlers({
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
