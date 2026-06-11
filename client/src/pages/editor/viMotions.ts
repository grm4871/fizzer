// Get line info at position
export function getLineInfo(text: string, pos: number): { lineStart: number; lineEnd: number; column: number } {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  let lineEnd = text.indexOf('\n', pos);
  if (lineEnd === -1) lineEnd = text.length;
  return { lineStart, lineEnd, column: pos - lineStart };
}

// Get line number (0-indexed) from position
export function getLineNumber(text: string, pos: number): number {
  return text.slice(0, pos).split('\n').length - 1;
}

// Get position from line number and column
export function getPositionFromLineCol(text: string, line: number, col: number): number {
  const lines = text.split('\n');
  let pos = 0;
  for (let i = 0; i < Math.min(line, lines.length); i++) {
    pos += lines[i].length + 1;
  }
  if (line < lines.length) {
    pos += Math.min(col, lines[line].length);
  }
  return Math.min(pos, text.length);
}

// Get first non-whitespace position on current line
export function getFirstNonWhitespace(text: string, pos: number): number {
  const { lineStart, lineEnd } = getLineInfo(text, pos);
  const line = text.slice(lineStart, lineEnd);
  const match = line.match(/^\s*/);
  return lineStart + (match ? match[0].length : 0);
}

// Calculate position on adjacent line, preserving column
export function getLinePosition(text: string, pos: number, direction: 1 | -1): number {
  const { lineStart, lineEnd, column } = getLineInfo(text, pos);

  if (direction === -1) {
    if (lineStart === 0) return pos; // already on first line
    const prevLineEnd = lineStart - 1;
    const prevLineStart = text.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const prevLineLen = prevLineEnd - prevLineStart;
    return prevLineStart + Math.min(column, prevLineLen);
  } else {
    if (lineEnd === text.length) return pos; // already on last line
    const nextLineStart = lineEnd + 1;
    let nextLineEnd = text.indexOf('\n', nextLineStart);
    if (nextLineEnd === -1) nextLineEnd = text.length;
    const nextLineLen = nextLineEnd - nextLineStart;
    return nextLineStart + Math.min(column, nextLineLen);
  }
}

// Move by word (w/b)
export function getWordPosition(text: string, pos: number, direction: 1 | -1): number {
  if (direction === 1) {
    const after = text.slice(pos);
    const match = after.match(/^(\w*\W*|\W+)/);
    return match ? Math.min(pos + match[0].length, text.length) : pos;
  } else {
    const before = text.slice(0, pos);
    const match = before.match(/(\w+|\W+)$/);
    return match ? Math.max(pos - match[0].length, 0) : pos;
  }
}

// Move by WORD (W/B) - whitespace delimited
export function getWORDPosition(text: string, pos: number, direction: 1 | -1): number {
  if (direction === 1) {
    const after = text.slice(pos);
    const match = after.match(/^\S*\s*/);
    return match ? Math.min(pos + match[0].length, text.length) : pos;
  } else {
    const before = text.slice(0, pos);
    const match = before.match(/\s*\S*$/);
    return match ? Math.max(pos - match[0].length, 0) : pos;
  }
}

// Move to end of word (e)
export function getEndOfWordPosition(text: string, pos: number): number {
  const after = text.slice(pos + 1);
  const match = after.match(/^\w*|\W*\w*/);
  return match ? Math.min(pos + 1 + match[0].length, text.length) : pos;
}

// Move to end of WORD (E)
export function getEndOfWORDPosition(text: string, pos: number): number {
  const after = text.slice(pos + 1);
  const match = after.match(/^\S*|\s*\S*/);
  return match ? Math.min(pos + 1 + match[0].length, text.length) : pos;
}

// Move by paragraph
export function getParagraphPosition(text: string, pos: number, direction: 1 | -1): number {
  const paragraphBreak = /\n\s*\n/g;

  if (direction === 1) {
    paragraphBreak.lastIndex = pos;
    const match = paragraphBreak.exec(text);
    return match ? match.index + match[0].length : text.length;
  } else {
    const before = text.slice(0, pos);
    const matches = [...before.matchAll(/\n\s*\n/g)];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const paragraphStart = lastMatch.index || 0;
      if (paragraphStart < pos - 1) return paragraphStart;
      if (matches.length > 1) return matches[matches.length - 2].index || 0;
    }
    return 0;
  }
}

// Move by sentence
export function getSentencePosition(text: string, pos: number, direction: 1 | -1): number {
  const sentenceEnd = /[.!?][\s\n]/g;

  if (direction === 1) {
    sentenceEnd.lastIndex = pos;
    const match = sentenceEnd.exec(text);
    return match ? match.index + match[0].length : text.length;
  } else {
    const before = text.slice(0, pos);
    const matches = [...before.matchAll(/[.!?][\s\n]/g)];
    if (matches.length > 0) {
      const lastMatch = matches[matches.length - 1];
      const sentenceStart = (lastMatch.index || 0) + lastMatch[0].length;
      if (sentenceStart < pos) return sentenceStart;
      if (matches.length > 1) {
        const prevMatch = matches[matches.length - 2];
        return (prevMatch.index || 0) + prevMatch[0].length;
      }
    }
    return 0;
  }
}

// Search for pattern
export function searchText(text: string, pos: number, query: string, direction: 1 | -1): number {
  if (!query) return pos;

  if (direction === 1) {
    const idx = text.indexOf(query, pos + 1);
    if (idx !== -1) return idx;
    const wrapIdx = text.indexOf(query, 0);
    return wrapIdx !== -1 ? wrapIdx : pos;
  } else {
    const before = text.slice(0, pos);
    const idx = before.lastIndexOf(query);
    if (idx !== -1) return idx;
    const wrapIdx = text.lastIndexOf(query);
    return wrapIdx !== -1 ? wrapIdx : pos;
  }
}

// Get range for a motion - returns null if motion is invalid
export type MotionRange = { start: number; end: number; newPos: number };

export function getMotionRange(text: string, pos: number, motion: string): MotionRange | null {
  const { lineStart, lineEnd } = getLineInfo(text, pos);

  switch (motion) {
    case 'd': case 'c': case 'y': { // line motion (dd, cc, yy)
      const nextLineStart = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      // If empty last line, delete the preceding newline instead
      if (lineStart === lineEnd && lineStart > 0) {
        return { start: lineStart - 1, end: lineEnd, newPos: Math.max(0, lineStart - 1) };
      }
      return { start: lineStart, end: nextLineStart, newPos: lineStart };
    }
    case 'w': {
      const end = getWordPosition(text, pos, 1);
      return { start: pos, end, newPos: pos };
    }
    case 'e': {
      const end = getEndOfWordPosition(text, pos);
      return { start: pos, end, newPos: pos };
    }
    case 'b': {
      const start = getWordPosition(text, pos, -1);
      return { start, end: pos, newPos: start };
    }
    case '$':
      return { start: pos, end: lineEnd, newPos: pos };
    case '0':
      return { start: lineStart, end: pos, newPos: lineStart };
    case '^': {
      const nw = getFirstNonWhitespace(text, pos);
      return { start: nw, end: pos, newPos: nw };
    }
    case 'G':
      return { start: pos, end: text.length, newPos: pos };
    case 'gg':
      return { start: 0, end: pos, newPos: 0 };
    case 'h':
      return pos > 0 ? { start: pos - 1, end: pos, newPos: pos - 1 } : null;
    case 'l':
      return pos < text.length ? { start: pos, end: pos + 1, newPos: pos } : null;
    case 'j': {
      const nextLineEnd = text.indexOf('\n', lineEnd + 1);
      const end = nextLineEnd === -1 ? text.length : nextLineEnd + 1;
      return { start: lineStart, end, newPos: lineStart };
    }
    case 'k': {
      if (lineStart === 0) return null;
      const prevLineStart = text.lastIndexOf('\n', lineStart - 2) + 1;
      const end = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      return { start: prevLineStart, end, newPos: prevLineStart };
    }
    case '(': {
      const sentenceStart = getSentencePosition(text, pos, -1);
      return { start: sentenceStart, end: pos, newPos: sentenceStart };
    }
    case ')': {
      const sentenceEnd = getSentencePosition(text, pos, 1);
      return { start: pos, end: sentenceEnd, newPos: sentenceEnd };
    }
    case '{': {
      const paragraphStart = getParagraphPosition(text, pos, -1);
      return { start: paragraphStart, end: pos, newPos: paragraphStart };
    }
    case '}': {
      const paragraphEnd = getParagraphPosition(text, pos, 1);
      return { start: pos, end: paragraphEnd, newPos: paragraphEnd };
    }
    default:
      return null;
  }
}

// Find char on current line (f/F/t/T logic)
export function findCharOnLine(text: string, pos: number, char: string, type: 'f' | 'F' | 't' | 'T'): number {
  const { lineStart, lineEnd } = getLineInfo(text, pos);
  if (type === 'f' || type === 't') {
    const idx = text.indexOf(char, pos + 1);
    if (idx !== -1 && idx < lineEnd) return type === 't' ? idx - 1 : idx;
  } else {
    const beforeCursor = text.slice(lineStart, pos);
    const idx = beforeCursor.lastIndexOf(char);
    if (idx !== -1) return lineStart + (type === 'T' ? idx + 1 : idx);
  }
  return pos;
}

// Map arrow keys to motion chars
export function keyToMotion(key: string): string {
  switch (key) {
    case 'ArrowLeft': return 'h';
    case 'ArrowRight': return 'l';
    case 'ArrowDown': return 'j';
    case 'ArrowUp': return 'k';
    default: return key;
  }
}

// Get new cursor position for movement key, returns null if not a movement key
export function getNewPosition(text: string, pos: number, key: string): number | null {
  switch (key) {
    case 'h':
    case 'ArrowLeft':
    case 'Backspace':
      return Math.max(0, pos - 1);
    case 'l':
    case 'ArrowRight':
      return Math.min(text.length, pos + 1);
    case 'j':
    case 'ArrowDown':
      return getLinePosition(text, pos, 1);
    case 'k':
    case 'ArrowUp':
      return getLinePosition(text, pos, -1);
    case 'w':
      return getWordPosition(text, pos, 1);
    case 'b':
      return getWordPosition(text, pos, -1);
    case 'W':
      return getWORDPosition(text, pos, 1);
    case 'B':
      return getWORDPosition(text, pos, -1);
    case 'e':
      return getEndOfWordPosition(text, pos);
    case 'E':
      return getEndOfWORDPosition(text, pos);
    case '0':
      return getLineInfo(text, pos).lineStart;
    case '$':
      return getLineInfo(text, pos).lineEnd;
    case '^':
      return getFirstNonWhitespace(text, pos);
    case '{':
      return getParagraphPosition(text, pos, -1);
    case '}':
      return getParagraphPosition(text, pos, 1);
    case '(':
      return getSentencePosition(text, pos, -1);
    case ')':
      return getSentencePosition(text, pos, 1);
    case 'G':
      return text.length;
    default:
      return null;
  }
}
