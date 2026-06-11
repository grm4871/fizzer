import { useCallback } from 'react';

// Count leading/trailing asterisks or underscores
const countMarkers = (text: string, side: 'start' | 'end'): { count: number; char: '*' | '_' | null } => {
  const chars = side === 'start' ? text : text.split('').reverse().join('');
  let count = 0;
  let char: '*' | '_' | null = null;

  for (const c of chars) {
    if (c === '*' || c === '_') {
      if (char === null) char = c;
      if (c === char) count++;
      else break;
    } else break;
  }

  return { count, char };
};

// Get selection info including surrounding markers
const getSelectionWithMarkers = (
  text: string,
  selStart: number,
  selEnd: number
): {
  before: string;
  selected: string;
  after: string;
  leadingMarkers: number;
  trailingMarkers: number;
  markerChar: '*' | '_' | null;
} => {
  // Expand selection to include surrounding markers
  let expandedStart = selStart;
  let expandedEnd = selEnd;

  // Count markers before selection
  while (expandedStart > 0 && (text[expandedStart - 1] === '*' || text[expandedStart - 1] === '_')) {
    expandedStart--;
  }

  // Count markers after selection
  while (expandedEnd < text.length && (text[expandedEnd] === '*' || text[expandedEnd] === '_')) {
    expandedEnd++;
  }

  const before = text.slice(0, expandedStart);
  const selected = text.slice(expandedStart, expandedEnd);
  const after = text.slice(expandedEnd);

  const leading = countMarkers(selected, 'start');
  const trailing = countMarkers(selected, 'end');

  // Use the minimum of leading/trailing as the actual marker count
  const markerCount = Math.min(leading.count, trailing.count);

  return {
    before,
    selected,
    after,
    leadingMarkers: markerCount,
    trailingMarkers: markerCount,
    markerChar: leading.char || trailing.char
  };
};

// Generic asterisk marker transform - shared by italic, bold, and cycle
type MarkerCountFn = (currentCount: number) => number;

const transformAsteriskMarkers = (
  text: string,
  selStart: number,
  selEnd: number,
  getNewCount: MarkerCountFn
): { text: string; newSelStart: number; newSelEnd: number } => {
  if (selStart === selEnd) return { text, newSelStart: selStart, newSelEnd: selEnd };

  const selectedText = text.slice(selStart, selEnd);
  const leadingSpaces = selectedText.match(/^(\s*)/)?.[1] || '';
  const trailingSpaces = selectedText.match(/(\s*)$/)?.[1] || '';
  const trimmedStart = selStart + leadingSpaces.length;
  const trimmedEnd = selEnd - trailingSpaces.length;

  if (trimmedStart >= trimmedEnd) return { text, newSelStart: selStart, newSelEnd: selEnd };

  const info = getSelectionWithMarkers(text, trimmedStart, trimmedEnd);
  const innerText = info.selected.slice(info.leadingMarkers, info.selected.length - info.trailingMarkers);
  const char = info.markerChar || '*';
  const newMarkerCount = getNewCount(info.leadingMarkers);

  const newMarkers = char.repeat(newMarkerCount);
  const newSelected = newMarkers + innerText + newMarkers;
  const newText = info.before + newSelected + info.after;

  return {
    text: newText,
    newSelStart: info.before.length - leadingSpaces.length,
    newSelEnd: info.before.length + newSelected.length + trailingSpaces.length
  };
};

// Toggle italic: 0→1, 1→0, 2→3, 3→2
export const toggleItalic = (text: string, selStart: number, selEnd: number) =>
  transformAsteriskMarkers(text, selStart, selEnd, n => [1, 0, 3, 2][n] ?? n);

// Toggle bold: 0→2, 1→3, 2→0, 3→1
export const toggleBold = (text: string, selStart: number, selEnd: number) =>
  transformAsteriskMarkers(text, selStart, selEnd, n => [2, 3, 0, 1][n] ?? n);

// Cycle asterisks: 0→1→2→3→0
export const cycleAsterisk = (text: string, selStart: number, selEnd: number) =>
  transformAsteriskMarkers(text, selStart, selEnd, n => (n + 1) % 4);

// Generic single-char marker transform (for tildes, etc.)
const transformSingleCharMarkers = (
  text: string,
  selStart: number,
  selEnd: number,
  markerChar: string,
  getNewCount: MarkerCountFn
): { text: string; newSelStart: number; newSelEnd: number } => {
  if (selStart === selEnd) return { text, newSelStart: selStart, newSelEnd: selEnd };

  const selectedText = text.slice(selStart, selEnd);
  const leadingSpaces = selectedText.match(/^(\s*)/)?.[1] || '';
  const trailingSpaces = selectedText.match(/(\s*)$/)?.[1] || '';
  const trimmedStart = selStart + leadingSpaces.length;
  const trimmedEnd = selEnd - trailingSpaces.length;

  if (trimmedStart >= trimmedEnd) return { text, newSelStart: selStart, newSelEnd: selEnd };

  // Expand selection to include surrounding markers
  let expandedStart = trimmedStart;
  let expandedEnd = trimmedEnd;
  while (expandedStart > 0 && text[expandedStart - 1] === markerChar) expandedStart--;
  while (expandedEnd < text.length && text[expandedEnd] === markerChar) expandedEnd++;

  const before = text.slice(0, expandedStart);
  const selected = text.slice(expandedStart, expandedEnd);
  const after = text.slice(expandedEnd);

  // Count leading/trailing markers
  let leading = 0;
  for (const c of selected) { if (c === markerChar) leading++; else break; }
  let trailing = 0;
  for (let i = selected.length - 1; i >= 0; i--) { if (selected[i] === markerChar) trailing++; else break; }

  const markerCount = Math.min(leading, trailing);
  const innerText = selected.slice(markerCount, selected.length - markerCount);
  const newMarkerCount = getNewCount(markerCount);

  const newMarkers = markerChar.repeat(newMarkerCount);
  const newSelected = newMarkers + innerText + newMarkers;
  const newText = before + newSelected + after;

  return {
    text: newText,
    newSelStart: before.length - leadingSpaces.length,
    newSelEnd: before.length + newSelected.length + trailingSpaces.length
  };
};

// Toggle strikethrough: 0→2, 1→2, 2→0
export const toggleStrikethrough = (text: string, selStart: number, selEnd: number) =>
  transformSingleCharMarkers(text, selStart, selEnd, '~', n => n === 2 ? 0 : 2);

// Find a DOM position (node + offset) for a given plain-text offset,
// accounting for <li> boundaries and hidden data-prefix attributes.
const findDomPosition = (
  element: HTMLElement,
  targetOffset: number
): { node: Node; offset: number } | null => {
  let remaining = targetOffset;
  let result: { node: Node; offset: number } | null = null;

  function visit(node: Node): boolean {
    if (result) return true;

    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length || 0;
      if (remaining <= len) {
        result = { node, offset: remaining };
        return true;
      }
      remaining -= len;
      return false;
    }

    const tag = node.nodeName;

    if (tag === 'BR') {
      if ((node as Element).classList?.contains('tml')) return false; // phantom trailing BR
      if (remaining <= 0) {
        // Position after the BR
        result = { node: node.parentNode!, offset: Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode) + 1 };
        return true;
      }
      remaining -= 1;
      return false;
    }

    if (tag === 'LI') {
      if ((node as Element).previousElementSibling) {
        if (remaining <= 0) {
          result = { node, offset: 0 };
          return true;
        }
        remaining -= 1;
      }
      const prefix = (node as Element).getAttribute('data-prefix');
      if (prefix) {
        if (remaining <= prefix.length) {
          result = { node, offset: 0 };
          return true;
        }
        remaining -= prefix.length;
      }
    }

    // Nested <ul>/<ol> inside <li>: newline before the nested list
    if ((tag === 'UL' || tag === 'OL') && node.previousSibling && (node.parentNode as Element)?.nodeName === 'LI') {
      if (remaining <= 0) {
        result = { node, offset: 0 };
        return true;
      }
      remaining -= 1;
    }

    if (tag === 'DIV' && node.previousSibling) {
      if (remaining <= 0) {
        result = { node, offset: 0 };
        return true;
      }
      remaining -= 1;
    }

    let child = node.firstChild;
    while (child) {
      if (visit(child)) return true;
      child = child.nextSibling;
    }

    // Top-level block elements (ul/ol not nested in li) need trailing \n
    if ((tag === 'UL' || tag === 'OL') && (node.parentNode as Element)?.nodeName !== 'LI' && node.nextSibling) {
      if (remaining <= 0) {
        result = { node: node.parentNode!, offset: Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode) + 1 };
        return true;
      }
      remaining -= 1;
    }

    return false;
  }

  let child = element.firstChild;
  while (child) {
    if (visit(child)) break;
    child = child.nextSibling;
  }
  return result;
};

// Restore selection range in contenteditable
const restoreSelection = (element: HTMLElement, start: number, end: number) => {
  const selection = window.getSelection();
  if (!selection) return;

  const startPos = findDomPosition(element, start);
  const endPos = start === end ? startPos : findDomPosition(element, end);
  if (!startPos || !endPos) return;

  const range = document.createRange();
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  selection.removeAllRanges();
  selection.addRange(range);
};

// Hook for editor hotkeys
export const useEditorHotkeys = (
  handleSave: () => void,
  editContent: string,
  setEditContent: (content: string) => void,
  editorRef: React.RefObject<HTMLDivElement | null>,
  saveCursorPosition: () => number,
  _restoreCursorPosition: (pos: number) => void,
  parseMarkdownToHtml: (text: string) => string
) => {
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Note: Enter is handled in editorNormal.tsx before this hook is called

    // Alt + ArrowUp: Move line up
    if (e.altKey && e.key === 'ArrowUp') {
      e.preventDefault();
      const lines = editContent.split('\n');
      const cursorPos = saveCursorPosition();

      // Find which line cursor is on
      let charCount = 0;
      let lineIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        if (charCount + lines[i].length >= cursorPos) {
          lineIndex = i;
          break;
        }
        charCount += lines[i].length + 1; // +1 for newline
      }

      if (lineIndex === 0) return; // Already at top

      // Swap with line above
      const prevLineLength = lines[lineIndex - 1].length;
      [lines[lineIndex - 1], lines[lineIndex]] = [lines[lineIndex], lines[lineIndex - 1]];

      const newText = lines.join('\n');
      // Cursor moves up by previous line length + 1 (newline)
      const newCursorPos = cursorPos - prevLineLength - 1;

      setEditContent(newText);
      if (editorRef.current) {
        editorRef.current.innerHTML = parseMarkdownToHtml(newText);
        restoreSelection(editorRef.current, newCursorPos, newCursorPos);
      }
      return;
    }

    // Alt + ArrowDown: Move line down
    if (e.altKey && e.key === 'ArrowDown') {
      e.preventDefault();
      const lines = editContent.split('\n');
      const cursorPos = saveCursorPosition();

      // Find which line cursor is on
      let charCount = 0;
      let lineIndex = 0;
      for (let i = 0; i < lines.length; i++) {
        if (charCount + lines[i].length >= cursorPos) {
          lineIndex = i;
          break;
        }
        charCount += lines[i].length + 1; // +1 for newline
      }

      if (lineIndex >= lines.length - 1) return; // Already at bottom

      // Swap with line below
      const nextLineLength = lines[lineIndex + 1].length;
      [lines[lineIndex], lines[lineIndex + 1]] = [lines[lineIndex + 1], lines[lineIndex]];

      const newText = lines.join('\n');
      // Cursor moves down by next line length + 1 (newline)
      const newCursorPos = cursorPos + nextLineLength + 1;

      setEditContent(newText);
      if (editorRef.current) {
        editorRef.current.innerHTML = parseMarkdownToHtml(newText);
        restoreSelection(editorRef.current, newCursorPos, newCursorPos);
      }
      return;
    }

    // Helper: apply a text transform to selection
    type TransformFn = (text: string, start: number, end: number) => { text: string; newSelStart: number; newSelEnd: number };
    const applySelectionTransform = (transform: TransformFn): boolean => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;

      const cursorPos = saveCursorPosition();
      const selText = selection.toString();
      const selStart = editContent.indexOf(selText, Math.max(0, cursorPos - selText.length - 10));
      if (selStart === -1) return false;

      const selEnd = selStart + selText.length;
      const result = transform(editContent, selStart, selEnd);

      setEditContent(result.text);
      if (editorRef.current) {
        editorRef.current.innerHTML = parseMarkdownToHtml(result.text);
        restoreSelection(editorRef.current, result.newSelStart, result.newSelEnd);
      }
      return true;
    };

    // Shift+8 (*): Cycle asterisks 0→1→2→3→0
    if (e.shiftKey && e.key === '*') {
      if (applySelectionTransform(cycleAsterisk)) e.preventDefault();
      return;
    }

    // Shift+` (~): Toggle strikethrough
    if (e.shiftKey && e.key === '~') {
      if (applySelectionTransform(toggleStrikethrough)) e.preventDefault();
      return;
    }

    const isMod = e.metaKey || e.ctrlKey;
    if (!isMod) return;

    // Ctrl/Cmd + S: Save
    if (e.key === 's') {
      e.preventDefault();
      handleSave();
      return;
    }

    // Ctrl/Cmd + I: Toggle italic
    if (e.key === 'i') {
      e.preventDefault();
      applySelectionTransform(toggleItalic);
      return;
    }

    // Ctrl/Cmd + B: Toggle bold
    if (e.key === 'b') {
      e.preventDefault();
      applySelectionTransform(toggleBold);
      return;
    }
  }, [handleSave, editContent, setEditContent, editorRef, saveCursorPosition, parseMarkdownToHtml]);

  return handleKeyDown;
};
