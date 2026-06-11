// WYSIWYG markdown parsing utilities

// Ordered list type system: I → A → 1 → a → i (cycle of 5)
export type OlType = 'upper-roman' | 'upper-alpha' | 'decimal' | 'lower-alpha' | 'lower-roman';
const OL_CYCLE: OlType[] = ['upper-roman', 'upper-alpha', 'decimal', 'lower-alpha', 'lower-roman'];

// Roman numeral conversion
const ROMAN_VALUES: [string, number][] = [
  ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
  ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
  ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1],
];

export const toRoman = (n: number, upper: boolean): string => {
  let result = '';
  let remaining = n;
  for (const [numeral, value] of ROMAN_VALUES) {
    while (remaining >= value) {
      result += numeral;
      remaining -= value;
    }
  }
  return upper ? result : result.toLowerCase();
};

export const fromRoman = (s: string): number => {
  const upper = s.toUpperCase();
  let result = 0;
  let i = 0;
  for (const [numeral, value] of ROMAN_VALUES) {
    while (i < upper.length && upper.startsWith(numeral, i)) {
      result += value;
      i += numeral.length;
    }
  }
  return result;
};

// Alpha conversion: a=1, b=2, ..., z=26
export const toAlpha = (n: number, upper: boolean): string => {
  let result = '';
  let remaining = n;
  while (remaining > 0) {
    remaining--;
    result = String.fromCharCode((remaining % 26) + (upper ? 65 : 97)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
};

export const fromAlpha = (s: string): number => {
  let result = 0;
  const upper = s.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    result = result * 26 + (upper.charCodeAt(i) - 64);
  }
  return result;
};

// Check if a string is a valid roman numeral (round-trips through conversion)
const isValidRoman = (s: string): boolean => {
  const upper = s.toUpperCase();
  if (!/^[IVXLCDM]+$/.test(upper)) return false;
  const num = fromRoman(upper);
  return num > 0 && toRoman(num, true) === upper;
};

// Detect which OlType a marker string is.
// Single ambiguous characters (C, D, I, L, M, V, X) default to alpha.
// Only multi-char patterns that are unambiguously roman (II, IV, IX, XI, etc.)
// or the specific single char 'I'/'i' (most common roman start) are treated as roman.
export const detectOlType = (marker: string): OlType => {
  if (/^\d+$/.test(marker)) return 'decimal';
  if (/^[a-z]+$/.test(marker)) {
    // Only 'i' as single char is roman (common list start), others are alpha
    if (marker.length === 1) return marker === 'i' ? 'lower-roman' : 'lower-alpha';
    return isValidRoman(marker) ? 'lower-roman' : 'lower-alpha';
  }
  if (/^[A-Z]+$/.test(marker)) {
    if (marker.length === 1) return marker === 'I' ? 'upper-roman' : 'upper-alpha';
    return isValidRoman(marker) ? 'upper-roman' : 'upper-alpha';
  }
  return 'decimal';
};

// Convert a marker string to its numeric value based on type
export const markerToNum = (marker: string, type: OlType): number => {
  switch (type) {
    case 'decimal': return parseInt(marker, 10);
    case 'lower-alpha': return fromAlpha(marker);
    case 'upper-alpha': return fromAlpha(marker);
    case 'lower-roman': return fromRoman(marker);
    case 'upper-roman': return fromRoman(marker);
  }
};

// Convert a numeric value to a marker string based on type
export const numToMarker = (n: number, type: OlType): string => {
  switch (type) {
    case 'decimal': return String(n);
    case 'lower-alpha': return toAlpha(n, false);
    case 'upper-alpha': return toAlpha(n, true);
    case 'lower-roman': return toRoman(n, false);
    case 'upper-roman': return toRoman(n, true);
  }
};

// Get the child OlType given a parent's type (next in cycle)
export const childOlType = (parentType: OlType): OlType => {
  const idx = OL_CYCLE.indexOf(parentType);
  return OL_CYCLE[(idx + 1) % OL_CYCLE.length];
};

// Get the parent OlType given a child's type (previous in cycle)
export const parentOlType = (childType: OlType): OlType => {
  const idx = OL_CYCLE.indexOf(childType);
  return OL_CYCLE[(idx - 1 + OL_CYCLE.length) % OL_CYCLE.length];
};

// Match any ordered list marker: decimal, alpha, or roman
// Captures: (indent)(marker). rest
const OL_LINE_RE = /^( *)([a-zA-Z]+|\d+)\. /;

// Renumber consecutive ordered list blocks so markers are sequential.
// Returns the text unchanged if no renumbering is needed.
export const renumberOrderedLists = (text: string): string => {
  const lines = text.split('\n');
  let changed = false;
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(OL_LINE_RE);
    if (m) {
      const indent = m[1];
      const type = detectOlType(m[2]);
      const startNum = markerToNum(m[2], type);
      let expected = startNum;
      const indentPattern = new RegExp(`^${indent}([a-zA-Z]+|\\d+)\\. `);
      while (i < lines.length) {
        const lm = lines[i].match(indentPattern);
        if (!lm) break;
        // Only renumber if same type
        const lmType = detectOlType(lm[1]);
        if (lmType !== type) break;
        const actual = markerToNum(lm[1], type);
        if (actual !== expected) {
          const newMarker = numToMarker(expected, type);
          lines[i] = indent + newMarker + '. ' + lines[i].slice(lm[0].length);
          changed = true;
        }
        expected++;
        i++;
      }
    } else {
      i++;
    }
  }
  return changed ? lines.join('\n') : text;
};

// Parse markdown and return HTML with styled spans
export const parseMarkdownToHtml = (text: string): string => {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Bold+Italic: ***text*** or ___text___
  html = html.replace(/(\*\*\*|___)(.+?)\1/g,
    '$1<span class="md-bold-italic">$2</span>$1');

  // Bold: **text** (not preceded/followed by *)
  html = html.replace(/(?<!\*)\*\*(?!\*)(.+?)(?<!\*)\*\*(?!\*)/g,
    '**<span class="md-bold">$1</span>**');

  // Bold: __text__ (not preceded/followed by _)
  html = html.replace(/(?<!_)__(?!_)(.+?)(?<!_)__(?!_)/g,
    '__<span class="md-bold">$1</span>__');

  // Italic: *text* (not preceded/followed by *)
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    '*<span class="md-italic">$1</span>*');

  // Italic: _text_ (not preceded/followed by _)
  html = html.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
    '_<span class="md-italic">$1</span>_');

  // Inline code: `text` (not preceded/followed by `)
  html = html.replace(/(?<!`)(`)((?!`).+?)(`)/g,
    '`<span class="md-code">$2</span>`');

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g,
    '~~<span class="md-strike">$1</span>~~');

  // Blockquotes: > at start of line
  html = html.replace(/(^|\n)(&gt; )(.+?)(?=\n|$)/g, (match, pre, marker, text) => {
    return `${pre}<span class="md-blockquote">${marker}${text}</span>`;
  });

  // Headings: # through ###### at start of line
  // Process before newline conversion
  html = html.replace(/(^|\n)(#{1,6}) (.+?)(?=\n|$)/g, (match, pre, hashes, text) => {
    const level = hashes.length;
    return `${pre}<span class="md-h${level}">${hashes} ${text}</span>`;
  });

  // Group consecutive list lines into nested <ul>/<ol> with <li> elements
  // Supports indentation: each 4 spaces = one nesting level
  // Process before \n -> <br> conversion

  interface ParsedListItem {
    indent: number;
    type: 'ul' | 'ol';
    prefix: string;
    content: string;
    olNum?: number;
    olType?: OlType;
  }

  const parseListLine = (line: string): ParsedListItem | null => {
    const ulM = line.match(/^( *)([-*] )(.*)/);
    if (ulM) {
      return { indent: Math.floor(ulM[1].length / 4), type: 'ul', prefix: ulM[1] + ulM[2], content: ulM[3] };
    }
    // Match any ordered marker: digits, letters (alpha or roman)
    const olM = line.match(/^( *)([a-zA-Z]+|\d+)\. (.*)/);
    if (olM) {
      const olType = detectOlType(olM[2]);
      const olNum = markerToNum(olM[2], olType);
      return { indent: Math.floor(olM[1].length / 4), type: 'ol', prefix: olM[1] + olM[2] + '. ', content: olM[3], olNum, olType };
    }
    return null;
  };

  const buildNestedListHtml = (items: ParsedListItem[]): string => {
    let idx = 0;
    const build = (atIndent: number): string => {
      let out = '';
      while (idx < items.length && items[idx].indent >= atIndent) {
        if (items[idx].indent > atIndent) {
          // Orphan deeper items — wrap in their own list
          const t = items[idx].type;
          const olStyle = t === 'ol' && items[idx].olType ? ` style="list-style-type:${items[idx].olType}"` : '';
          const start = t === 'ol' ? ` start="${items[idx].olNum ?? 1}"` : '';
          out += `<${t} class="md-list"${start}${olStyle}>`;
          out += build(items[idx].indent);
          out += `</${t}>`;
          continue;
        }
        // Group consecutive same-type items at this indent
        const groupType = items[idx].type;
        const startNum = items[idx].olNum ?? 1;
        const olType = items[idx].olType;
        const startAttr = groupType === 'ol' ? ` start="${startNum}"` : '';
        const olStyle = groupType === 'ol' && olType ? ` style="list-style-type:${olType}"` : '';
        out += `<${groupType} class="md-list"${startAttr}${olStyle}>`;
        while (idx < items.length && items[idx].indent === atIndent && items[idx].type === groupType) {
          out += `<li data-prefix="${items[idx].prefix}">${items[idx].content}`;
          idx++;
          // Children at deeper indent
          if (idx < items.length && items[idx].indent > atIndent) {
            out += build(atIndent + 1);
          }
          out += '</li>';
        }
        out += `</${groupType}>`;
      }
      return out;
    };
    return build(Math.min(...items.map(it => it.indent)));
  };

  const lines = html.split('\n');
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const parsed = parseListLine(lines[i]);
    if (parsed) {
      // Collect all consecutive list lines (at any indent)
      const listItems: ParsedListItem[] = [];
      while (i < lines.length) {
        const p = parseListLine(lines[i]);
        if (!p) break;
        listItems.push(p);
        i++;
      }
      result.push(buildNestedListHtml(listItems));
    } else {
      result.push(lines[i]);
      i++;
    }
  }
  // Join with <br>, but skip <br> after block elements (ul/ol) since they
  // already create a line break. This prevents double-spacing after lists.
  html = '';
  for (let j = 0; j < result.length; j++) {
    if (j > 0) {
      const prevIsBlock = /(<\/ul>|<\/ol>)$/.test(result[j - 1]);
      if (!prevIsBlock) {
        html += '<br>';
      }
    }
    html += result[j];
  }
  // Trailing <br> is invisible in contenteditable — add phantom BR to make it render
  if (result.length > 0 && result[result.length - 1] === '') {
    html += '<br class="tml">';
  }
  return html;
};

// Extract plain text from contenteditable using a recursive walk.
// This must handle both our clean generated DOM and whatever the browser
// produces after contenteditable mutations (Enter splitting <li>, etc.).
export const htmlToPlainText = (element: HTMLElement): string => {
  const parts: string[] = [];

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || '');
      return;
    }

    const el = node as HTMLElement;
    const tag = el.nodeName;

    if (tag === 'BR') {
      if ((el as Element).classList?.contains('tml')) return; // phantom trailing BR
      parts.push('\n');
      return;
    }

    // <li>: re-add the stripped prefix from data attribute
    if (tag === 'LI') {
      if (el.previousElementSibling) {
        parts.push('\n');
      }
      const prefix = el.getAttribute('data-prefix');
      if (prefix) {
        parts.push(prefix);
      }
    }

    // Nested <ul>/<ol> inside <li>: newline before the nested list
    if ((tag === 'UL' || tag === 'OL') && node.previousSibling && (node.parentNode as Element)?.nodeName === 'LI') {
      parts.push('\n');
    }

    // <div> after preceding content = newline (browser sometimes wraps lines in divs)
    if (tag === 'DIV' && node.previousSibling) {
      parts.push('\n');
    }

    let child = node.firstChild;
    while (child) {
      walk(child);
      child = child.nextSibling;
    }

    // Top-level block elements (ul/ol not nested in li) need a trailing \n
    // since we skip <br> after them in the HTML join
    if ((tag === 'UL' || tag === 'OL') && (node.parentNode as Element)?.nodeName !== 'LI' && node.nextSibling) {
      parts.push('\n');
    }
  }

  let child = element.firstChild;
  while (child) {
    walk(child);
    child = child.nextSibling;
  }
  return parts.join('');
};

// Check if a line is part of a markdown table (must have at least 2 pipes)
const isTableLine = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed.length >= 2 && trimmed.startsWith('|') && trimmed.endsWith('|');
};

// Check if a line is a separator line (|---|---|)
// Only matches if user has actually typed at least one dash or colon
const isSeparatorLine = (line: string): boolean => {
  return /^\s*\|[\s\-:]+\|/.test(line) && !/[^|\s\-:]/.test(line) && (line.includes('-') || line.includes(':'));
};

// Parse alignment from separator cell (GFM spec)
// :---  or --- = left (default)
// :---: = center
// ---:  = right
type Alignment = 'left' | 'center' | 'right';

const parseAlignment = (cell: string): Alignment => {
  const trimmed = cell.trim();
  const hasLeft = trimmed.startsWith(':');
  const hasRight = trimmed.endsWith(':');
  if (hasLeft && hasRight) return 'center';
  if (hasRight) return 'right';
  return 'left';
};

// Pad text according to alignment
const padAligned = (text: string, width: number, align: Alignment): string => {
  if (text.length >= width) return text;
  const diff = width - text.length;
  switch (align) {
    case 'right':
      return ' '.repeat(diff) + text;
    case 'center': {
      const left = Math.floor(diff / 2);
      const right = diff - left;
      return ' '.repeat(left) + text + ' '.repeat(right);
    }
    default:
      return text + ' '.repeat(diff);
  }
};

// Parse a table line into cells
const parseTableRow = (line: string): string[] => {
  const trimmed = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '');
  return trimmed.split('|').map(cell => cell.trim());
};

// realignTable: auto-format markdown tables
//
// Algorithm:
//   1. Find cursor position → check if on a table line (starts/ends with |, length >= 2)
//   2. Walk up/down to find all contiguous table lines
//   3. If standalone line (no neighbors), don't modify - return early
//   4. Parse cells, find max columns and max width per column (minimum 1)
//   5. Check first two rows for separator line (must contain - or :)
//      - Parse alignment per column: :--- or --- = left, :---: = center, ---: = right
//      - Fill separator cells with dashes based on column width
//   6. Rebuild rows with alignment-aware padding
//   7. Remap cursor to same cell in new layout
//
export const realignTable = (
  text: string,
  cursorPos: number
): { text: string; newCursorPos: number } => {
  const lines = text.split('\n');

  // Find cursor line and column
  let charCount = 0;
  let cursorLine = 0;
  let cursorCol = 0;
  for (let i = 0; i < lines.length; i++) {
    if (charCount + lines[i].length >= cursorPos) {
      cursorLine = i;
      cursorCol = cursorPos - charCount;
      break;
    }
    charCount += lines[i].length + 1;
  }

  // Check if cursor is in a table
  if (!isTableLine(lines[cursorLine])) {
    return { text, newCursorPos: cursorPos };
  }

  // Find table bounds
  let tableStart = cursorLine;
  let tableEnd = cursorLine;
  while (tableStart > 0 && isTableLine(lines[tableStart - 1])) tableStart--;
  while (tableEnd < lines.length - 1 && isTableLine(lines[tableEnd + 1])) tableEnd++;

  // Standalone line (no other table lines) - don't modify
  if (tableStart === tableEnd) {
    return { text, newCursorPos: cursorPos };
  }

  // Check if cursor is on a separator row (don't move cursor in this case)
  const cursorRowInTable = cursorLine - tableStart;
  const cursorOnSeparator = cursorRowInTable < 2 && isSeparatorLine(lines[cursorLine]);

  // Parse all rows (only first two rows can be separators)
  const tableLines = lines.slice(tableStart, tableEnd + 1);
  const rows = tableLines.map((line, idx) => {
    // Preserve trailing whitespace after last pipe
    const trailingMatch = line.match(/\|(\s*)$/);
    const trailing = trailingMatch ? trailingMatch[1] : '';
    return {
      cells: parseTableRow(line),
      isSeparator: idx < 2 && isSeparatorLine(line),
      trailing
    };
  });

  // Find max columns and widths
  const maxCols = Math.max(...rows.map(r => r.cells.length));
  const colWidths: number[] = new Array(maxCols).fill(1);
  for (const row of rows) {
    if (!row.isSeparator) {
      row.cells.forEach((cell, i) => {
        colWidths[i] = Math.max(colWidths[i], cell.length);
      });
    }
  }

  // Find alignments from separator line (check first two rows)
  const alignments: Alignment[] = new Array(maxCols).fill('left');
  for (let i = 0; i < Math.min(2, rows.length); i++) {
    if (rows[i].isSeparator) {
      rows[i].cells.forEach((cell, j) => {
        alignments[j] = parseAlignment(cell);
      });
      break;
    }
  }

  // Find cursor cell
  const cursorRowIdx = cursorLine - tableStart;
  let cursorCellIdx = 0;
  let cellStartCol = 0;
  const cursorLineText = lines[cursorLine];
  let pipeCount = 0;
  for (let i = 0; i < cursorCol && i < cursorLineText.length; i++) {
    if (cursorLineText[i] === '|') {
      pipeCount++;
      cursorCellIdx = pipeCount - 1;
      cellStartCol = i + 1;
    }
  }
  const cursorOffsetInCell = cursorCol - cellStartCol;

  // Rebuild table with padding
  const newTableLines = rows.map(row => {
    const paddedCells = row.cells.map((cell, i) => {
      const width = colWidths[i] || 1;
      if (row.isSeparator) {
        const hasLeft = cell.startsWith(':');
        const hasRight = cell.endsWith(':');
        if (hasLeft && hasRight) return ':' + '-'.repeat(Math.max(1, width - 2)) + ':';
        if (hasLeft) return ':' + '-'.repeat(Math.max(1, width - 1));
        if (hasRight) return '-'.repeat(Math.max(1, width - 1)) + ':';
        return '-'.repeat(width);
      }
      return padAligned(cell, width, alignments[i] || 'left');
    });
    return '| ' + paddedCells.join(' | ') + ' |' + row.trailing;
  });

  // Calculate new cursor position
  let newCursorPos = 0;
  for (let i = 0; i < tableStart; i++) newCursorPos += lines[i].length + 1;
  for (let i = 0; i < cursorRowIdx; i++) newCursorPos += newTableLines[i].length + 1;

  const newCursorLine = newTableLines[cursorRowIdx];
  const cursorRow = rows[cursorRowIdx];
  let newPipeCount = 0;
  let newCellStart = 0;
  let newCellEnd = 0;
  for (let i = 0; i < newCursorLine.length; i++) {
    if (newCursorLine[i] === '|') {
      newPipeCount++;
      if (newPipeCount - 1 === cursorCellIdx) {
        newCellStart = i + 2;
      } else if (newPipeCount - 1 === cursorCellIdx + 1) {
        newCellEnd = i - 1;
        break;
      }
    }
  }
  if (newCellEnd === 0) newCellEnd = newCursorLine.length - 2;

  // For separator rows: move cursor to end only on first padding (short cell), otherwise keep position
  if (cursorOnSeparator) {
    const originalCell = rows[cursorRowIdx]?.cells[cursorCellIdx] || '';
    if (originalCell.length < 3) {
      // First time padding - move to end of dashes
      newCursorPos += newCellEnd;
    } else {
      // Already padded - keep cursor where it was relative to line start
      const lineStart = newCursorPos;
      newCursorPos = lineStart + Math.min(cursorCol, newCursorLine.length);
    }
  } else {
    const clampedOffset = Math.min(cursorOffsetInCell, colWidths[cursorCellIdx] || 1);
    newCursorPos += newCellStart + Math.max(0, clampedOffset - 1);
  }

  // Rebuild full text
  const newLines = [
    ...lines.slice(0, tableStart),
    ...newTableLines,
    ...lines.slice(tableEnd + 1)
  ];

  return { text: newLines.join('\n'), newCursorPos };
};
