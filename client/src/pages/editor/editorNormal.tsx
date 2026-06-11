import { useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { parseMarkdownToHtml, htmlToPlainText, realignTable, renumberOrderedLists, detectOlType, markerToNum, numToMarker, childOlType, parentOlType } from '../../utils/markdown';
import { useEditorHotkeys } from './hotkeys';
import CursorOverlay from '../../components/CursorOverlay';
import { EditorHandle, EditorProps } from '../../types';
import '../netdoc-editor.css';

// Hook for cursor management in contenteditable
function useEditorCursor(editorRef: React.RefObject<HTMLDivElement>) {
  const saveCursorPosition = useCallback((): number => {
    const selection = window.getSelection();
    if (!selection || !editorRef.current || selection.rangeCount === 0) return 0;

    const range = selection.getRangeAt(0);
    const preCaretRange = range.cloneRange();
    preCaretRange.selectNodeContents(editorRef.current);
    preCaretRange.setEnd(range.startContainer, range.startOffset);

    const tempDiv = document.createElement('div');
    tempDiv.appendChild(preCaretRange.cloneContents());
    return htmlToPlainText(tempDiv).length;
  }, [editorRef]);

  const saveSelectionRange = useCallback((): { start: number; end: number } => {
    const selection = window.getSelection();
    if (!selection || !editorRef.current || selection.rangeCount === 0) return { start: 0, end: 0 };

    const range = selection.getRangeAt(0);
    const startRange = range.cloneRange();
    startRange.selectNodeContents(editorRef.current);
    startRange.setEnd(range.startContainer, range.startOffset);
    const startDiv = document.createElement('div');
    startDiv.appendChild(startRange.cloneContents());
    const start = htmlToPlainText(startDiv).length;

    const endRange = range.cloneRange();
    endRange.selectNodeContents(editorRef.current);
    endRange.setEnd(range.endContainer, range.endOffset);
    const endDiv = document.createElement('div');
    endDiv.appendChild(endRange.cloneContents());
    const end = htmlToPlainText(endDiv).length;

    return { start, end };
  }, [editorRef]);

  const restoreCursorPosition = useCallback((offset: number) => {
    if (!editorRef.current) return;

    const selection = window.getSelection();
    if (!selection) return;

    // Walk the clean DOM (just set by parseMarkdownToHtml) to find the
    // text node at the given plain-text offset. Uses the same boundary
    // rules as htmlToPlainText so save/restore are symmetric.
    let remaining = offset;

    function visit(node: Node): boolean {
      if (node.nodeType === Node.TEXT_NODE) {
        const len = node.textContent?.length || 0;
        if (remaining <= len) {
          const r = document.createRange();
          r.setStart(node, remaining);
          r.collapse(true);
          selection!.removeAllRanges();
          selection!.addRange(r);
          return true;
        }
        remaining -= len;
        return false;
      }

      const tag = node.nodeName;

      if (tag === 'BR') {
        if ((node as Element).classList?.contains('tml')) return false; // phantom trailing BR
        if (remaining <= 0) {
          const r = document.createRange();
          r.setStartBefore(node);
          r.collapse(true);
          selection!.removeAllRanges();
          selection!.addRange(r);
          return true;
        }
        remaining -= 1;
        return false;
      }

      if (tag === 'LI') {
        if ((node as Element).previousElementSibling) {
          if (remaining <= 0) {
            const r = document.createRange();
            r.setStart(node, 0);
            r.collapse(true);
            selection!.removeAllRanges();
            selection!.addRange(r);
            return true;
          }
          remaining -= 1;
        }
        // Account for the hidden prefix (stripped from DOM but present in markdown)
        const prefix = (node as Element).getAttribute('data-prefix');
        if (prefix) {
          if (remaining <= prefix.length) {
            // Cursor lands within the prefix — place at start of <li> content
            const r = document.createRange();
            r.setStart(node, 0);
            r.collapse(true);
            selection!.removeAllRanges();
            selection!.addRange(r);
            return true;
          }
          remaining -= prefix.length;
        }
      }

      // Nested <ul>/<ol> inside <li>: newline before the nested list
      if ((tag === 'UL' || tag === 'OL') && node.previousSibling && (node.parentNode as Element)?.nodeName === 'LI') {
        if (remaining <= 0) {
          const r = document.createRange();
          r.setStart(node, 0);
          r.collapse(true);
          selection!.removeAllRanges();
          selection!.addRange(r);
          return true;
        }
        remaining -= 1;
      }

      if (tag === 'DIV' && node.previousSibling) {
        if (remaining <= 0) {
          const r = document.createRange();
          r.setStart(node, 0);
          r.collapse(true);
          selection!.removeAllRanges();
          selection!.addRange(r);
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
      // since we skip <br> after them in HTML join
      if ((tag === 'UL' || tag === 'OL') && (node.parentNode as Element)?.nodeName !== 'LI' && node.nextSibling) {
        if (remaining <= 0) {
          const r = document.createRange();
          r.setStartAfter(node);
          r.collapse(true);
          selection!.removeAllRanges();
          selection!.addRange(r);
          return true;
        }
        remaining -= 1;
      }

      return false;
    }

    // Visit top-level children (not the root itself, matching htmlToPlainText)
    let child = editorRef.current.firstChild;
    while (child) {
      if (visit(child)) return;
      child = child.nextSibling;
    }

    // Fallback: cursor at end
    const range = document.createRange();
    range.selectNodeContents(editorRef.current);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, [editorRef]);

  return { saveCursorPosition, saveSelectionRange, restoreCursorPosition };
}

const EditorNormal = forwardRef<EditorHandle, EditorProps>(({ content, onContentChange, onSave, onUndo, onRedo, remoteUsers, onCursorChange }, ref) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const isUpdatingRef = useRef(false);
  const contentRef = useRef(content);
  contentRef.current = content;
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  const { saveCursorPosition, saveSelectionRange, restoreCursorPosition } = useEditorCursor(editorRef);
  const saveCursorRef = useRef(saveCursorPosition);
  saveCursorRef.current = saveCursorPosition;
  const saveSelectionRef = useRef(saveSelectionRange);
  saveSelectionRef.current = saveSelectionRange;
  const restoreCursorRef = useRef(restoreCursorPosition);
  restoreCursorRef.current = restoreCursorPosition;

  // Track cursor position for Yjs awareness (live cursors)
  useEffect(() => {
    if (!onCursorChange) return;
    const handler = () => {
      if (!editorRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      // Only track if selection is inside our editor
      if (!editorRef.current.contains(selection.anchorNode)) return;
      const { start, end } = saveSelectionRef.current();
      onCursorChange(start, end - start);
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [onCursorChange]);

  // Central helper: update content, re-render HTML, restore cursor.
  // Every content mutation in this editor should go through this.
  const applyEdit = useCallback((newText: string, cursorPos: number) => {
    isUpdatingRef.current = true;
    onContentChange(newText);
    if (editorRef.current) {
      editorRef.current.innerHTML = parseMarkdownToHtml(newText);
      restoreCursorPosition(cursorPos);
    }
    isUpdatingRef.current = false;
  }, [onContentChange, restoreCursorPosition]);

  // Expose focus method
  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus()
  }));

  // Intercept all browser input types that mutate the DOM in ways that
  // break our htmlToPlainText round-trip (paragraph splits, word deletes, etc.).
  // We handle these ourselves via content splicing.
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    // Splice content from deleteFrom..pos, re-render, restore cursor
    const spliceDelete = (deleteFrom: number, pos: number) => {
      const c = contentRef.current;
      const newText = c.slice(0, deleteFrom) + c.slice(pos);
      isUpdatingRef.current = true;
      onContentChangeRef.current(newText);
      el.innerHTML = parseMarkdownToHtml(newText);
      restoreCursorRef.current(deleteFrom);
      isUpdatingRef.current = false;
    };
    const handler = (e: InputEvent) => {
      const t = e.inputType;
      if (t === 'insertParagraph' || t === 'insertLineBreak') {
        e.preventDefault();
        return;
      }
      if (t === 'deleteWordBackward') {
        e.preventDefault();
        const pos = saveCursorRef.current();
        if (pos > 0) {
          const c = contentRef.current;
          let i = pos - 1;
          while (i > 0 && /\s/.test(c[i - 1])) i--;
          while (i > 0 && /\S/.test(c[i - 1])) i--;
          spliceDelete(i, pos);
        }
        return;
      }
      if (t === 'deleteSoftLineBackward') {
        e.preventDefault();
        const pos = saveCursorRef.current();
        if (pos > 0) {
          const lineStart = contentRef.current.lastIndexOf('\n', pos - 1) + 1;
          spliceDelete(lineStart, pos);
        }
        return;
      }
    };
    el.addEventListener('beforeinput', handler);
    return () => el.removeEventListener('beforeinput', handler);
  }, []);

  // Update editor HTML when content changes programmatically
  useEffect(() => {
    if (!editorRef.current || isUpdatingRef.current) return;
    const html = parseMarkdownToHtml(content);
    if (editorRef.current.innerHTML !== html) {
      editorRef.current.innerHTML = html;
    }
  }, [content]);

  // Handle input in the contenteditable
  const handleEditorInput = useCallback(() => {
    if (!editorRef.current) return;
    isUpdatingRef.current = true;

    const cursorPos = saveCursorPosition();
    let plainText = htmlToPlainText(editorRef.current);
    plainText = renumberOrderedLists(plainText);
    onContentChange(plainText);

    const html = parseMarkdownToHtml(plainText);
    editorRef.current.innerHTML = html;

    restoreCursorPosition(cursorPos);
    isUpdatingRef.current = false;
  }, [saveCursorPosition, restoreCursorPosition, onContentChange]);

  // Handle paste to ensure plain text only
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  // Editor hotkeys (Ctrl+S save, Ctrl+B bold, Ctrl+I italic)
  const baseHotkeys = useEditorHotkeys(
    onSave,
    content,
    onContentChange,
    editorRef,
    saveCursorPosition,
    restoreCursorPosition,
    parseMarkdownToHtml
  );

  // Shared helper: handle empty list item exit/un-indent.
  // lineStart = index of the first char of this line in content.
  // lineContent = the full text of the line (prefix + any trailing text).
  // leadingSpaces = whitespace before the bullet/number.
  // after = content after the cursor (rest of line + everything after).
  // Returns true if it handled it.
  const exitOrUnindentListItem = useCallback((lineStart: number, lineContent: string, leadingSpaces: string, after: string) => {
    if (leadingSpaces.length >= 4) {
      // Nested: un-indent by removing 4 leading spaces
      applyEdit(content.slice(0, lineStart) + lineContent.slice(4) + after, lineStart + lineContent.length - 4);
    } else {
      // Top level: strip the prefix, stay on same line
      const trimmedAfter = after.startsWith('\n') ? after.slice(1) : after;
      applyEdit(content.slice(0, lineStart) + trimmedAfter, lineStart);
    }
    return true;
  }, [content, applyEdit]);

  // Wrap hotkeys to add undo/redo
  const handleEditorHotkeys = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Enter: splice newline into text directly, bypass execCommand entirely
    // to prevent browser from splitting <ul>/<li> elements.
    // If cursor is on a list line, continue the list prefix.
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      const { start, end } = saveSelectionRange();
      // If there's a selection, collapse it first
      const workingContent = start !== end ? content.slice(0, start) + content.slice(end) : content;
      const pos = start;

      // Find the current line to detect list prefixes
      const before = workingContent.slice(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const currentLine = before.slice(lineStart);

      let insert = '\n';
      let after = workingContent.slice(pos);
      const ulMatch = currentLine.match(/^(\s*)([-*]) /);
      const olMatch = currentLine.match(/^(\s*)([a-zA-Z]+|\d+)\. /);

      // Empty list item: if nested, un-indent one level (remove 4 spaces);
      // if already at top level, exit the list by stripping the prefix.
      const fullLine = currentLine + after.split('\n')[0];
      const isEmptyUl = ulMatch && fullLine.match(/^(\s*)[-*] $/);
      const isEmptyOl = olMatch && fullLine.match(/^(\s*)(?:[a-zA-Z]+|\d+)\. $/);

      if (isEmptyUl || isEmptyOl) {
        exitOrUnindentListItem(lineStart, currentLine, (isEmptyUl || isEmptyOl)![1], after);
        return;
      }

      if (ulMatch) {
        insert = '\n' + ulMatch[1] + ulMatch[2] + ' ';
      } else if (olMatch) {
        const olType = detectOlType(olMatch[2]);
        const curNum = markerToNum(olMatch[2], olType);
        const newNum = curNum + 1;
        const newMarker = numToMarker(newNum, olType);
        insert = '\n' + olMatch[1] + newMarker + '. ';
        // Renumber subsequent ordered list items
        after = after.replace(/^(\n?)/, '$1');
        const afterLines = after.split('\n');
        let num = newNum + 1;
        const olLineRe = /^([a-zA-Z]+|\d+)\. /;
        for (let i = 0; i < afterLines.length; i++) {
          const m = afterLines[i].match(olLineRe);
          if (m && detectOlType(m[1]) === olType) {
            afterLines[i] = numToMarker(num, olType) + '. ' + afterLines[i].slice(m[0].length);
            num++;
          } else {
            break;
          }
        }
        after = afterLines.join('\n');
      }

      applyEdit(before + insert + after, pos + insert.length);
      return;
    }
    // Backspace at start of list item: remove the bullet/number prefix
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey) {
      const sel = window.getSelection();
      if (sel && sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        // Check if cursor is at offset 0 inside an <li>
        let liEl: HTMLElement | null = null;
        let node: Node | null = range.startContainer;
        while (node && node !== editorRef.current) {
          if (node.nodeName === 'LI') { liEl = node as HTMLElement; break; }
          node = node.parentNode;
        }
        // Check if cursor is at effective offset 0 of the <li> content.
        // The browser may place the cursor inside a nested span, so walk
        // up to verify no text precedes the cursor within the <li>.
        const isAtLiStart = liEl && (() => {
          let node: Node | null = range.startContainer;
          let off = range.startOffset;
          // If in a text node, any offset > 0 means not at start
          if (node.nodeType === Node.TEXT_NODE && off > 0) return false;
          // Walk up: every ancestor up to the <li> must be the first child
          while (node && node !== liEl) {
            if (node.previousSibling) return false;
            node = node.parentNode;
          }
          return node === liEl;
        })();
        if (isAtLiStart) {
          const prefix = liEl.getAttribute('data-prefix');
          if (prefix) {
            e.preventDefault();
            const pos = saveCursorPosition();
            const prefixStart = pos - prefix.length;
            const afterPrefix = content.slice(pos);
            const restOfLine = afterPrefix.split('\n')[0];
            const leadingSpaces = prefix.match(/^(\s*)/)?.[1] || '';
            // Backspace always strips the prefix and keeps content on same line
            applyEdit(content.slice(0, prefixStart) + afterPrefix, prefixStart);
            return;
          }
        }
      }
    }
    // General Backspace: intercept ALL backspace to prevent browser DOM mutations
    // that cause stray newlines in blockquotes, inline code, etc.
    // Note: Alt+Backspace (word delete) and Cmd+Backspace (line delete) are
    // handled in the beforeinput handler above.
    if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const { start, end } = saveSelectionRange();
      if (start !== end) {
        applyEdit(content.slice(0, start) + content.slice(end), start);
      } else if (start > 0) {
        applyEdit(content.slice(0, start - 1) + content.slice(start), start - 1);
      }
      return;
    }
    // Delete key: forward delete, also selection-aware
    if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const { start, end } = saveSelectionRange();
      if (start !== end) {
        applyEdit(content.slice(0, start) + content.slice(end), start);
      } else if (start < content.length) {
        applyEdit(content.slice(0, start) + content.slice(start + 1), start);
      }
      return;
    }
    // Tab: indent current line. List lines use 4 spaces (nesting level), others use 2.
    // Shift+Tab: unindent by the same amount.
    if (e.key === 'Tab') {
      e.preventDefault();
      const pos = saveCursorPosition();
      const before = content.slice(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const lineToEnd = content.slice(lineStart).split('\n')[0];
      const isListLine = /^\s*([-*] |(?:[a-zA-Z]+|\d+)\. )/.test(lineToEnd);
      const indentSize = isListLine ? 4 : 2;

      // Check if this is an ordered list line for marker cycling
      const olTabMatch = lineToEnd.match(/^(\s*)([a-zA-Z]+|\d+)\. /);

      if (e.shiftKey) {
        // Unindent: remove up to indentSize leading spaces
        const line = content.slice(lineStart);
        const leadingSpaces = line.match(new RegExp(`^( {1,${indentSize}})`));
        if (leadingSpaces) {
          const removeCount = leadingSpaces[1].length;

          // Convert OL marker to parent type when unindenting
          if (olTabMatch) {
            const olType = detectOlType(olTabMatch[2]);
            const pType = parentOlType(olType);
            const num = markerToNum(olTabMatch[2], olType);
            const newMarker = numToMarker(num, pType);
            const oldPrefix = olTabMatch[1] + olTabMatch[2] + '. ';
            const restOfLine = lineToEnd.slice(oldPrefix.length);
            const newIndent = olTabMatch[1].slice(removeCount);
            const newPrefix = newIndent + newMarker + '. ';
            const newLine = newPrefix + restOfLine + content.slice(lineStart + lineToEnd.length);
            const newPos = lineStart + newPrefix.length + (pos - lineStart - oldPrefix.length);
            applyEdit(content.slice(0, lineStart) + newLine, Math.max(lineStart, newPos));
          } else {
            applyEdit(content.slice(0, lineStart) + content.slice(lineStart + removeCount), Math.max(lineStart, pos - removeCount));
          }
        }
      } else {
        // Indent: add indentSize spaces at line start
        if (olTabMatch) {
          // Convert OL marker to child type when indenting
          const olType = detectOlType(olTabMatch[2]);
          const cType = childOlType(olType);
          // Reset to 1 when indenting into a new child type
          const newMarker = numToMarker(1, cType);
          const oldPrefix = olTabMatch[1] + olTabMatch[2] + '. ';
          const restOfLine = lineToEnd.slice(oldPrefix.length);
          const newPrefix = olTabMatch[1] + ' '.repeat(indentSize) + newMarker + '. ';
          const newLine = newPrefix + restOfLine;
          const newPos = lineStart + newPrefix.length + (pos - lineStart - oldPrefix.length);
          applyEdit(content.slice(0, lineStart) + newLine + content.slice(lineStart + lineToEnd.length), Math.max(lineStart, newPos));
        } else {
          const spaces = ' '.repeat(indentSize);
          applyEdit(content.slice(0, lineStart) + spaces + content.slice(lineStart), pos + indentSize);
        }
      }
      return;
    }
    // Ctrl+Z for undo
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      onUndo?.();
      return;
    }
    // Ctrl+Y or Ctrl+Shift+Z for redo
    if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && e.key === 'z') || (e.ctrlKey && e.shiftKey && e.key === 'Z')) {
      e.preventDefault();
      onRedo?.();
      return;
    }
    baseHotkeys(e);
  }, [baseHotkeys, onUndo, onRedo, content, saveCursorPosition, saveSelectionRange, applyEdit, exitOrUnindentListItem]);

  // Auto-realign tables every 200ms
  useEffect(() => {
    const interval = setInterval(() => {
      if (!editorRef.current || isUpdatingRef.current) return;
      const cursorPos = saveCursorPosition();
      const result = realignTable(content, cursorPos);
      if (result.text !== content) {
        applyEdit(result.text, result.newCursorPos);
      }
    }, 200);
    return () => clearInterval(interval);
  }, [content, saveCursorPosition, applyEdit]);

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={editorRef}
        contentEditable
        onInput={handleEditorInput}
        onPaste={handlePaste}
        onKeyDown={handleEditorHotkeys}
        data-placeholder="Type here to edit the document content..."
        className="netdoc-editor"
        style={{
          width: '100%',
          minHeight: '300px',
          background: 'transparent',
          color: 'inherit',
          border: 'none',
          padding: 0,
          fontSize: '0.95em',
          fontFamily: 'monospace',
          lineHeight: '1.6',
          outline: 'none',
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
        }}
      />
      {remoteUsers && remoteUsers.length > 0 && (
        <CursorOverlay
          containerRef={editorRef as React.RefObject<HTMLDivElement>}
          remoteUsers={remoteUsers}
          text={content}
        />
      )}
    </div>
  );
});

EditorNormal.displayName = 'EditorNormal';
export default EditorNormal;
