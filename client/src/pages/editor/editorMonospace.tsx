import { useRef, useEffect, forwardRef, useImperativeHandle, useCallback } from 'react';
import CursorOverlay from '../../components/CursorOverlay';
import { EditorHandle, EditorProps } from '../../types';
import '../netdoc-editor.css';

const EditorMonospace = forwardRef<EditorHandle, EditorProps>(({ content, onContentChange, onSave, onUndo, onRedo, remoteUsers, onCursorChange }, ref) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus()
  }));

  // Track cursor position for Yjs awareness
  useEffect(() => {
    if (!onCursorChange) return;
    const handler = () => {
      const ta = textareaRef.current;
      if (!ta || document.activeElement !== ta) return;
      onCursorChange(ta.selectionStart, ta.selectionEnd - ta.selectionStart);
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [onCursorChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+S: save
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    // Ctrl+Z: undo
    if (e.ctrlKey && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      onUndo?.();
      return;
    }
    // Ctrl+Y or Ctrl+Shift+Z: redo
    if ((e.ctrlKey && e.key === 'y') || (e.ctrlKey && e.shiftKey && (e.key === 'z' || e.key === 'Z'))) {
      e.preventDefault();
      onRedo?.();
      return;
    }
    // Tab: insert 2 spaces
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = textareaRef.current;
      if (!ta) return;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const spaces = '  ';
      const newValue = content.slice(0, start) + spaces + content.slice(end);
      onContentChange(newValue);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + spaces.length;
      });
    }
  }, [content, onContentChange, onSave, onUndo, onRedo]);

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={textareaRef}
        value={content}
        onChange={(e) => onContentChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type here to edit the document content..."
        className="netdoc-editor"
        style={{
          width: '100%',
          height: '100%',
          background: 'transparent',
          color: 'inherit',
          border: 'none',
          padding: 0,
          fontSize: '0.95em',
          fontFamily: 'monospace',
          lineHeight: '1.6',
          outline: 'none',
          resize: 'none',
          whiteSpace: 'pre-wrap',
          wordWrap: 'break-word',
        }}
      />
      {remoteUsers && remoteUsers.length > 0 && (
        <CursorOverlay
          containerRef={textareaRef as React.RefObject<HTMLTextAreaElement>}
          remoteUsers={remoteUsers}
          text={content}
          mode="textarea"
        />
      )}
    </div>
  );
});

EditorMonospace.displayName = 'EditorMonospace';
export default EditorMonospace;
