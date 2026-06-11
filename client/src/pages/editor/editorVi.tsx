import { useRef, forwardRef, useImperativeHandle, useState, useEffect, useCallback, useMemo } from 'react';
import { useViMode, EditorAdapter, ViMode } from './vi';
import CursorOverlay from '../../components/CursorOverlay';
import { EditorHandle, EditorViProps as EditorProps } from '../../types';
import '../netdoc-editor.css';

export interface ViStatusBarProps {
  mode: string;
  searchQuery: string;
  searchDirection: 1 | -1;
  commandQuery: string;
}

// Exported for use in editorTemplate
export function ViStatusBar({ mode, searchQuery, searchDirection, commandQuery }: ViStatusBarProps) {
  return (
    <div style={{
      padding: '0.3em 1em',
      background: '#1a1a1a',
      borderTop: '1px solid #333',
      fontFamily: 'monospace',
      fontSize: '0.85em',
      color: mode === 'insert' ? '#6b98c1' : mode === 'visual' || mode === 'visual-block' ? '#c1a263' : mode === 'replace' ? '#c17263' : '#888',
      flexShrink: 0,
    }}>
      {mode === 'search' && `${searchDirection === 1 ? '/' : '?'}${searchQuery}`}
      {mode === 'command' && `:${commandQuery}`}
      {mode === 'normal' && '-- NORMAL --'}
      {mode === 'insert' && '-- INSERT --'}
      {mode === 'replace' && '-- REPLACE --'}
      {mode === 'visual' && '-- VISUAL --'}
      {mode === 'visual-block' && '-- VISUAL BLOCK --'}
    </div>
  );
}

export interface EditorViRef extends EditorHandle {
  getViStatus: () => ViStatusBarProps;
}

// Hook for cursor management in plain-text contenteditable
function useContentEditableCursor(editorRef: React.RefObject<HTMLDivElement | null>) {
  // Get character offset from DOM selection
  const saveCursorPosition = useCallback((): { start: number; end: number } => {
    const selection = window.getSelection();
    if (!selection || !editorRef.current || selection.rangeCount === 0) {
      return { start: 0, end: 0 };
    }

    const range = selection.getRangeAt(0);

    // Use a TreeWalker to count characters up to the cursor
    function getOffset(container: Node, offset: number): number {
      let charCount = 0;
      const walker = document.createTreeWalker(
        editorRef.current!,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node) => {
            if (node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR') {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node === container) {
          // Found the container - add the offset within it
          return charCount + offset;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          // Check if container is parent and we've passed the offset child
          if (container.contains(node)) {
            const idx = Array.from(container.childNodes).indexOf(node as ChildNode);
            if (idx >= offset) {
              return charCount;
            }
          }
          charCount += node.textContent?.length || 0;
        } else if (node.nodeName === 'BR') {
          if (container.contains(node)) {
            const idx = Array.from(container.childNodes).indexOf(node as ChildNode);
            if (idx >= offset) {
              return charCount;
            }
          }
          charCount += 1;
        }
      }

      // If we're at the end of content
      if (container === editorRef.current) {
        return charCount;
      }

      return charCount;
    }

    const start = getOffset(range.startContainer, range.startOffset);
    const end = range.collapsed ? start : getOffset(range.endContainer, range.endOffset);

    return { start, end };
  }, [editorRef]);

  // Set cursor to character offset
  const restoreCursorPosition = useCallback((start: number, end?: number) => {
    if (!editorRef.current) return;

    const selection = window.getSelection();
    if (!selection) return;

    const actualEnd = end ?? start;

    function findPosition(targetOffset: number): { node: Node; offset: number } | null {
      let remaining = targetOffset;
      const walker = document.createTreeWalker(
        editorRef.current!,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node) => {
            if (node.nodeType === Node.TEXT_NODE || node.nodeName === 'BR') {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.TEXT_NODE) {
          const len = node.textContent?.length || 0;
          if (remaining <= len) {
            return { node, offset: remaining };
          }
          remaining -= len;
        } else if (node.nodeName === 'BR') {
          if (remaining === 0) {
            // Position right before the BR
            const parent = node.parentNode!;
            const idx = Array.from(parent.childNodes).indexOf(node as ChildNode);
            return { node: parent, offset: idx };
          }
          remaining -= 1;
        }
      }

      // Past end - return end of last text node or container
      if (editorRef.current.lastChild) {
        if (editorRef.current.lastChild.nodeType === Node.TEXT_NODE) {
          return {
            node: editorRef.current.lastChild,
            offset: editorRef.current.lastChild.textContent?.length || 0
          };
        }
      }
      return { node: editorRef.current, offset: editorRef.current.childNodes.length };
    }

    const startPos = findPosition(start);
    const endPos = start === actualEnd ? startPos : findPosition(actualEnd);

    if (startPos && endPos) {
      const range = document.createRange();
      range.setStart(startPos.node, startPos.offset);
      range.setEnd(endPos.node, endPos.offset);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [editorRef]);

  return { saveCursorPosition, restoreCursorPosition };
}

// Convert plain text to HTML (preserve newlines as <br>)
function textToHtml(text: string): string {
  // Escape HTML entities and convert newlines to <br>
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

// Get plain text from contenteditable
function getPlainText(el: HTMLElement): string {
  // innerText handles <br> as newlines
  return el.innerText || '';
}

const EditorVi = forwardRef<EditorViRef, EditorProps>(({ content, onContentChange, onSave, onQuit, onForceQuit, onModeChange, onUndo, onRedo, remoteUsers, onCursorChange }, ref) => {
  const editorRef = useRef<HTMLDivElement>(null);
  const isUpdatingRef = useRef(false);
  const contentRef = useRef(content);
  contentRef.current = content;

  const { saveCursorPosition, restoreCursorPosition } = useContentEditableCursor(editorRef);

  // Track cursor position for Yjs awareness
  useEffect(() => {
    if (!onCursorChange) return;
    const handler = () => {
      if (!editorRef.current) return;
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      if (!editorRef.current.contains(selection.anchorNode)) return;
      const { start, end } = saveCursorPosition();
      onCursorChange(start, end - start);
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [onCursorChange, saveCursorPosition]);

  // Create adapter for vi mode
  const adapter: EditorAdapter = useMemo(() => ({
    // Read directly from DOM to avoid stale contentRef
    getText: () => editorRef.current ? getPlainText(editorRef.current) : '',
    setText: (text: string) => {
      if (editorRef.current) {
        isUpdatingRef.current = true;
        editorRef.current.innerHTML = textToHtml(text);
        isUpdatingRef.current = false;
      }
    },
    getCursor: () => saveCursorPosition(),
    setCursor: (start: number, end?: number) => restoreCursorPosition(start, end),
    // Move cursor using Selection.modify - enables display-line movement
    simulateKey: (key: string) => {
      const sel = window.getSelection();
      if (!sel) return;
      // Selection.modify moves by visual lines, not text lines
      switch (key) {
        case 'ArrowLeft':
          sel.modify('move', 'backward', 'character');
          break;
        case 'ArrowRight':
          sel.modify('move', 'forward', 'character');
          break;
        case 'ArrowUp':
          sel.modify('move', 'backward', 'line');
          break;
        case 'ArrowDown':
          sel.modify('move', 'forward', 'line');
          break;
      }
    },
  }), [saveCursorPosition, restoreCursorPosition]);

  const {
    mode: viMode,
    handleKeyDown: handleViKeyDown,
    searchQuery,
    searchDirection,
    commandQuery,
    enterVisualMode,
    enterVisualBlockMode,
    visualBlockAnchor,
  } = useViMode({
    adapter,
    onContentChange,
    onModeChange: onModeChange as (mode: ViMode) => void,
    onSave,
    onQuit,
    onForceQuit,
    onUndo,
    onRedo,
    enabled: true,
  });

  // Expose focus method and vi status
  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    getViStatus: () => ({ mode: viMode, searchQuery, searchDirection, commandQuery })
  }));

  // Update editor HTML when content changes externally
  useEffect(() => {
    if (!editorRef.current || isUpdatingRef.current) return;
    const currentText = getPlainText(editorRef.current);
    if (currentText !== content) {
      const { start, end } = saveCursorPosition();
      editorRef.current.innerHTML = textToHtml(content);
      restoreCursorPosition(start, end);
    }
  }, [content, saveCursorPosition, restoreCursorPosition]);

  // Handle input in contenteditable
  const handleInput = useCallback(() => {
    if (!editorRef.current || isUpdatingRef.current) return;
    const text = getPlainText(editorRef.current);
    if (text !== contentRef.current) {
      onContentChange(text);
    }
  }, [onContentChange]);

  // Handle Ctrl+S for save, Ctrl+Z for undo, Ctrl+Y for redo
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Ctrl+S to save (works in all modes)
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    // Ctrl+Z for undo (works in all modes)
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      onUndo?.();
      return;
    }
    // Ctrl+Y or Ctrl+Shift+Z for redo (works in all modes)
    if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z'))) {
      e.preventDefault();
      onRedo?.();
      return;
    }
    handleViKeyDown(e);
  }, [handleViKeyDown, onSave, onUndo, onRedo]);

  // Handle mouse selection - enter visual mode if text is selected
  const handleSelect = useCallback(() => {
    if (!editorRef.current) return;
    const { start, end } = saveCursorPosition();
    // Only trigger on actual selection (not just cursor placement)
    if (start !== end && (viMode === 'normal' || viMode === 'visual')) {
      enterVisualMode(start);
    }
  }, [viMode, enterVisualMode, saveCursorPosition]);

  // Handle Alt+click for visual block mode
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (e.altKey && (viMode === 'normal' || viMode === 'visual' || viMode === 'visual-block')) {
      // Let the click happen first to set cursor position, then enter visual-block
      setTimeout(() => {
        const { start } = saveCursorPosition();
        enterVisualBlockMode(start);
      }, 0);
    }
  }, [viMode, enterVisualBlockMode, saveCursorPosition]);

  // Handle paste to ensure plain text only
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
  }, []);

  // Calculate block highlight regions for visual-block mode
  const [charSize, setCharSize] = useState({ width: 8, height: 19.2 });
  const [cursorPos, setCursorPos] = useState(0);

  // Measure character size on mount
  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const fontSize = parseFloat(style.fontSize);
    const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.6;
    // Create a measurement span
    const span = document.createElement('span');
    span.style.font = style.font;
    span.style.position = 'absolute';
    span.style.visibility = 'hidden';
    span.textContent = 'M';
    document.body.appendChild(span);
    const charWidth = span.offsetWidth;
    document.body.removeChild(span);
    setCharSize({ width: charWidth, height: lineHeight });
  }, []);

  // Track cursor position for block highlight
  const updateCursorPos = useCallback(() => {
    const { start } = saveCursorPosition();
    setCursorPos(start);
  }, [saveCursorPosition]);

  // Get block highlights for visual-block mode
  const getBlockHighlights = () => {
    if (viMode !== 'visual-block') return null;
    const lines = content.split('\n');

    // Get cursor line and column
    let cursorLine = 0, cursorCol = 0, charCount = 0;
    for (let i = 0; i < lines.length; i++) {
      if (charCount + lines[i].length >= cursorPos) {
        cursorLine = i;
        cursorCol = cursorPos - charCount;
        break;
      }
      charCount += lines[i].length + 1;
    }

    const { line: anchorLine, col: anchorCol } = visualBlockAnchor;
    const startLine = Math.min(anchorLine, cursorLine);
    const endLine = Math.max(anchorLine, cursorLine);
    const startCol = Math.min(anchorCol, cursorCol);
    const endCol = Math.max(anchorCol, cursorCol);

    const highlights = [];
    for (let i = startLine; i <= endLine && i < lines.length; i++) {
      const lineLen = lines[i].length;
      const left = startCol * charSize.width;
      const width = Math.max(1, (Math.min(endCol, lineLen) - startCol + 1)) * charSize.width;
      highlights.push(
        <div
          key={i}
          style={{
            position: 'absolute',
            top: i * charSize.height,
            left,
            width,
            height: charSize.height,
            background: 'rgba(193, 162, 99, 0.3)',
            pointerEvents: 'none',
          }}
        />
      );
    }
    return highlights;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'auto' }}>
        <div
          ref={editorRef}
          contentEditable
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onSelect={() => { handleSelect(); updateCursorPos(); }}
          onMouseDown={handleMouseDown}
          onMouseUp={updateCursorPos}
          onPaste={handlePaste}
          data-placeholder="Type here to edit the document content..."
          className="netdoc-editor"
          style={{
            width: '100%',
            minHeight: '100%',
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
          suppressContentEditableWarning
        />
        {/* Block selection overlay */}
        <div style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
          {getBlockHighlights()}
        </div>
        {remoteUsers && remoteUsers.length > 0 && (
          <CursorOverlay
            containerRef={editorRef as React.RefObject<HTMLDivElement>}
            remoteUsers={remoteUsers}
            text={content}
          />
        )}
      </div>
      <ViStatusBar
        mode={viMode}
        searchQuery={searchQuery}
        searchDirection={searchDirection}
        commandQuery={commandQuery}
      />
    </div>
  );
});

EditorVi.displayName = 'EditorVi';
export default EditorVi;
