import { useState, useCallback, useRef } from 'react';
import {
  getLineInfo, getLineNumber, getPositionFromLineCol, getFirstNonWhitespace,
  getLinePosition, getNewPosition, getMotionRange, keyToMotion,
  findCharOnLine, searchText,
} from './viMotions';

export type ViMode = 'normal' | 'insert' | 'replace' | 'search' | 'command' | 'visual' | 'visual-block';

// Repeatable action for '.' command
interface RepeatableAction {
  type: 'delete' | 'change' | 'insert';
  motion?: string; // 'w', '$', '0', 'G', 'gg', 'e', 'b'
  insertedText?: string; // for change/insert operations
}

// Editor adapter interface - abstracts cursor/text operations
export interface EditorAdapter {
  getText: () => string;
  setText: (text: string) => void;
  getCursor: () => { start: number; end: number };
  setCursor: (start: number, end?: number) => void;
  // Simulate a native key press (for hjkl -> arrow key mapping in contenteditable)
  simulateKey?: (key: string) => void;
}

interface UseViModeOptions {
  adapter: EditorAdapter;
  onContentChange?: (content: string) => void;
  onModeChange?: (mode: ViMode) => void;
  onSave?: () => void;
  onQuit?: () => void;
  onForceQuit?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  enabled?: boolean;
}

interface UseViModeReturn {
  mode: ViMode;
  handleKeyDown: (e: React.KeyboardEvent) => void;
  searchQuery: string;
  searchDirection: 1 | -1;
  commandQuery: string;
  pendingKey: string | null;
  enterVisualMode: (anchor: number) => void;
  enterVisualBlockMode: (pos: number) => void;
  visualBlockAnchor: { line: number; col: number };
}

export function useViMode({ adapter, onContentChange, onModeChange, onSave, onQuit, onForceQuit, onUndo, onRedo, enabled = true }: UseViModeOptions): UseViModeReturn {
  const [mode, setMode] = useState<ViMode>('normal');
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [countBuffer, setCountBuffer] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [commandQuery, setCommandQuery] = useState('');
  const [searchDirection, setSearchDirection] = useState<1 | -1>(1);
  const [lastSearch, setLastSearch] = useState('');
  const [visualAnchor, setVisualAnchor] = useState<number>(0);
  const [visualBlockAnchor, setVisualBlockAnchor] = useState<{ line: number; col: number }>({ line: 0, col: 0 });
  const [searchFromVisual, setSearchFromVisual] = useState(false);
  const [lastFindChar, setLastFindChar] = useState<{ char: string; type: 'f' | 'F' | 't' | 'T' } | null>(null);
  const [marks, setMarks] = useState<Record<string, number>>({});
  const [lastJumpPos, setLastJumpPos] = useState<number>(0);

  // For repeat (.) command
  const lastActionRef = useRef<RepeatableAction | null>(null);
  const insertStartPosRef = useRef<number>(0);
  const textBeforeInsertRef = useRef<string>('');

  // Get count from buffer and reset it
  const getCount = useCallback(() => {
    const count = parseInt(countBuffer) || 1;
    setCountBuffer('');
    return count;
  }, [countBuffer]);

  const changeMode = useCallback((newMode: ViMode) => {
    // When leaving insert/replace mode, capture what was inserted for repeat
    if ((mode === 'insert' || mode === 'replace') && newMode !== 'insert' && newMode !== 'replace') {
      const currentText = adapter.getText();
      const { start: cursorPos } = adapter.getCursor();
      const insertedText = currentText.slice(insertStartPosRef.current, cursorPos);
      if (lastActionRef.current?.type === 'change') {
        lastActionRef.current.insertedText = insertedText;
      } else if (insertedText) {
        lastActionRef.current = { type: 'insert', insertedText };
      }
    }
    // When entering insert/replace mode, track position
    if (newMode === 'insert' || newMode === 'replace') {
      const { start: cursorPos } = adapter.getCursor();
      insertStartPosRef.current = cursorPos;
      textBeforeInsertRef.current = adapter.getText();
    }
    setMode(newMode);
    setPendingKey(null);
    setCountBuffer('');
    if (newMode !== 'search') setSearchQuery('');
    if (newMode !== 'command') setCommandQuery('');
    onModeChange?.(newMode);
  }, [onModeChange, mode, adapter]);

  // Helper to update content and cursor
  const updateContent = useCallback((newText: string, cursorPos: number) => {
    adapter.setText(newText);
    adapter.setCursor(cursorPos);
    onContentChange?.(newText);
  }, [adapter, onContentChange]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!enabled) return;

    const text = adapter.getText();
    const { start: pos, end: selEnd } = adapter.getCursor();

    // Command mode
    if (mode === 'command') {
      if (e.key === 'Escape') {
        e.preventDefault();
        changeMode('normal');
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = commandQuery.trim();
        if (cmd === 'w' || cmd === 'write') {
          onSave?.();
        } else if (cmd === 'wq' || cmd === 'x') {
          Promise.resolve(onSave?.()).then(() => onForceQuit?.());
        } else if (cmd === 'q') {
          onQuit?.();
        } else if (cmd === 'q!') {
          onForceQuit?.();
        } else if (/^\d+$/.test(cmd)) {
          // :lineno - go to line
          const lineNum = parseInt(cmd);
          const lines = text.split('\n');
          const targetLine = Math.max(1, Math.min(lineNum, lines.length));
          let targetPos = 0;
          for (let i = 0; i < targetLine - 1; i++) {
            targetPos += lines[i].length + 1;
          }
          adapter.setCursor(targetPos);
        } else if (/^d\s*\d+$/.test(cmd)) {
          // :d lineno - delete line
          const lineNum = parseInt(cmd.replace(/^d\s*/, ''));
          const lines = text.split('\n');
          const targetLine = Math.max(1, Math.min(lineNum, lines.length));
          let lineStart = 0;
          for (let i = 0; i < targetLine - 1; i++) {
            lineStart += lines[i].length + 1;
          }
          const lineEnd = lineStart + lines[targetLine - 1].length;
          const deleteEnd = lineEnd < text.length ? lineEnd + 1 : lineEnd;
          const deleteStart = lineStart === 0 && deleteEnd === text.length ? 0 : (lineStart > 0 && deleteEnd === text.length ? lineStart - 1 : lineStart);
          const newText = text.slice(0, deleteStart) + text.slice(deleteEnd);
          updateContent(newText, Math.min(deleteStart, newText.length));
        }
        changeMode('normal');
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (commandQuery.length === 0) changeMode('normal');
        else setCommandQuery(q => q.slice(0, -1));
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        setCommandQuery(q => q + e.key);
        return;
      }
      return;
    }

    // Visual mode
    if (mode === 'visual') {
      if (e.key === 'Escape') {
        e.preventDefault();
        adapter.setCursor(pos);
        changeMode('normal');
        return;
      }
      e.preventDefault();

      const cursor = selEnd === visualAnchor ? pos : selEnd;
      const vStart = Math.min(visualAnchor, cursor);
      const vEnd = Math.max(visualAnchor, cursor);

      // Alt+Up/Down switches to visual-block mode
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const anchorLine = getLineNumber(text, visualAnchor);
        const { column: anchorCol } = getLineInfo(text, visualAnchor);
        setVisualBlockAnchor({ line: anchorLine, col: anchorCol });
        const newCursor = e.key === 'ArrowUp' ? getLinePosition(text, cursor, -1) : getLinePosition(text, cursor, 1);
        adapter.setCursor(newCursor);
        setMode('visual-block');
        onModeChange?.('visual-block');
        return;
      }

      // Check for movement key first
      const movePos = getNewPosition(text, cursor, e.key);
      if (movePos !== null) {
        const start = Math.min(visualAnchor, movePos);
        const end = Math.max(visualAnchor, movePos);
        adapter.setCursor(start, end);
        return;
      }

      // Action keys
      switch (e.key) {
        case 'g':
          setPendingKey('g');
          return;
        case 'y':
          navigator.clipboard?.writeText(text.slice(vStart, vEnd));
          adapter.setCursor(vStart);
          changeMode('normal');
          return;
        case 'd':
        case 'x':
        case 'c': {
          navigator.clipboard?.writeText(text.slice(vStart, vEnd));
          const newText = text.slice(0, vStart) + text.slice(vEnd);
          updateContent(newText, vStart);
          changeMode(e.key === 'c' ? 'insert' : 'normal');
          return;
        }
        case '~': {
          const toggled = text.slice(vStart, vEnd).split('').map(c =>
            c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()
          ).join('');
          const newText = text.slice(0, vStart) + toggled + text.slice(vEnd);
          updateContent(newText, vStart);
          changeMode('normal');
          return;
        }
        case '/':
        case '?':
          setSearchDirection(e.key === '/' ? 1 : -1);
          setSearchQuery('');
          setSearchFromVisual(true);
          changeMode('search');
          return;
        case 'n':
        case 'N': {
          if (lastSearch) {
            const dir = e.key === 'n' ? searchDirection : (searchDirection === 1 ? -1 : 1);
            const newCursor = searchText(text, cursor, lastSearch, dir);
            const start = Math.min(visualAnchor, newCursor);
            const end = Math.max(visualAnchor, newCursor);
            adapter.setCursor(start, end);
          }
          return;
        }
      }
      return;
    }

    // Visual block mode
    if (mode === 'visual-block') {
      if (e.key === 'Escape') {
        e.preventDefault();
        adapter.setCursor(pos);
        changeMode('normal');
        return;
      }
      e.preventDefault();

      const cursorLine = getLineNumber(text, pos);
      const { column: cursorCol } = getLineInfo(text, pos);
      const { line: anchorLine, col: anchorCol } = visualBlockAnchor;

      // Helper to get block text
      const getBlockText = () => {
        const lines = text.split('\n');
        const startLine = Math.min(anchorLine, cursorLine);
        const endLine = Math.max(anchorLine, cursorLine);
        const startCol = Math.min(anchorCol, cursorCol);
        const endCol = Math.max(anchorCol, cursorCol);
        let blockText = '';
        for (let i = startLine; i <= endLine; i++) {
          if (i < lines.length) {
            blockText += lines[i].slice(startCol, endCol) + '\n';
          }
        }
        return blockText;
      };

      // Movement - update cursor position
      if (e.key === 'h' || e.key === 'ArrowLeft') {
        const newCol = Math.max(0, cursorCol - 1);
        const newPos = getPositionFromLineCol(text, cursorLine, newCol);
        adapter.setCursor(newPos);
        return;
      }
      if (e.key === 'l' || e.key === 'ArrowRight') {
        const lines = text.split('\n');
        const maxCol = cursorLine < lines.length ? lines[cursorLine].length : 0;
        const newCol = Math.min(maxCol, cursorCol + 1);
        const newPos = getPositionFromLineCol(text, cursorLine, newCol);
        adapter.setCursor(newPos);
        return;
      }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        const lines = text.split('\n');
        if (cursorLine < lines.length - 1) {
          const newPos = getPositionFromLineCol(text, cursorLine + 1, cursorCol);
          adapter.setCursor(newPos);
        }
        return;
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        if (cursorLine > 0) {
          const newPos = getPositionFromLineCol(text, cursorLine - 1, cursorCol);
          adapter.setCursor(newPos);
        }
        return;
      }

      // Actions
      switch (e.key) {
        case 'y':
          navigator.clipboard?.writeText(getBlockText());
          adapter.setCursor(pos);
          changeMode('normal');
          return;
        case 'd':
        case 'x':
        case 'c': {
          navigator.clipboard?.writeText(getBlockText());
          const lines = text.split('\n');
          const startLine = Math.min(anchorLine, cursorLine);
          const endLine = Math.max(anchorLine, cursorLine);
          const startCol = Math.min(anchorCol, cursorCol);
          const endCol = Math.max(anchorCol, cursorCol);
          for (let i = startLine; i <= endLine && i < lines.length; i++) {
            lines[i] = lines[i].slice(0, startCol) + lines[i].slice(endCol);
          }
          const newText = lines.join('\n');
          const newPos = getPositionFromLineCol(newText, startLine, startCol);
          updateContent(newText, newPos);
          changeMode(e.key === 'c' ? 'insert' : 'normal');
          return;
        }
      }
      return;
    }

    // Search mode
    if (mode === 'search') {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSearchFromVisual(false);
        changeMode('normal');
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (searchQuery) {
          setLastSearch(searchQuery);
          const newPos = searchText(text, pos, searchQuery, searchDirection);
          if (searchFromVisual) {
            // Extend visual selection to search result
            const start = Math.min(visualAnchor, newPos);
            const end = Math.max(visualAnchor, newPos);
            adapter.setCursor(start, end);
            setSearchFromVisual(false);
            changeMode('visual');
          } else {
            adapter.setCursor(newPos);
            changeMode('normal');
          }
        } else {
          setSearchFromVisual(false);
          changeMode('normal');
        }
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        setSearchQuery(q => q.slice(0, -1));
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        setSearchQuery(q => q + e.key);
        return;
      }
      return;
    }

    // Escape always goes to normal mode
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      changeMode('normal');
      return;
    }

    // Insert mode - let everything through
    if (mode === 'insert') {
      return;
    }

    // Replace mode - overwrite characters instead of inserting
    if (mode === 'replace') {
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (pos < text.length) {
          const newText = text.slice(0, pos) + e.key + text.slice(pos + 1);
          updateContent(newText, pos + 1);
        } else {
          const newText = text + e.key;
          updateContent(newText, pos + 1);
        }
        return;
      }
      // Allow backspace to work normally in replace mode
      if (e.key === 'Backspace') {
        return;
      }
      return;
    }

    // Normal mode
    e.preventDefault();

    // Handle r prefix (replace single char)
    if (pendingKey === 'r') {
      setPendingKey(null);
      if (e.key.length === 1 && pos < text.length) {
        const count = getCount();
        const newText = text.slice(0, pos) + e.key.repeat(Math.min(count, text.length - pos)) + text.slice(pos + Math.min(count, text.length - pos));
        updateContent(newText, pos + Math.min(count, text.length - pos) - 1);
      }
      return;
    }

    // Handle digit for count buffer (but not 0 at start - that's line start)
    if (/[1-9]/.test(e.key) || (e.key === '0' && countBuffer.length > 0)) {
      setCountBuffer(cb => cb + e.key);
      return;
    }

    // Handle f/F/t/T (find char)
    if (pendingKey === 'f' || pendingKey === 'F' || pendingKey === 't' || pendingKey === 'T') {
      setPendingKey(null);
      if (e.key.length === 1) {
        const findType = pendingKey as 'f' | 'F' | 't' | 'T';
        setLastFindChar({ char: e.key, type: findType });
        const newPos = findCharOnLine(text, pos, e.key, findType);
        adapter.setCursor(newPos);
      }
      return;
    }

    // Handle ZZ (save and quit) and ZQ (quit without saving)
    if (pendingKey === 'Z') {
      setPendingKey(null);
      if (e.key === 'Z') {
        Promise.resolve(onSave?.()).then(() => onForceQuit?.());
      } else if (e.key === 'Q') {
        onForceQuit?.();
      }
      return;
    }

    // Handle m (set mark)
    if (pendingKey === 'm') {
      setPendingKey(null);
      if (/[a-z]/.test(e.key)) {
        setMarks(m => ({ ...m, [e.key]: pos }));
      }
      return;
    }

    // Handle ' (jump to mark line) and ` (jump to mark position)
    if (pendingKey === "'" || pendingKey === '`') {
      const jumpType = pendingKey;
      setPendingKey(null);
      if (e.key === "'" || e.key === '`') {
        // '' or `` - jump back to last position
        const target = lastJumpPos;
        setLastJumpPos(pos);
        if (jumpType === "'") {
          const { lineStart } = getLineInfo(text, target);
          adapter.setCursor(lineStart);
        } else {
          adapter.setCursor(target);
        }
      } else if (/[a-z]/.test(e.key) && marks[e.key] !== undefined) {
        setLastJumpPos(pos);
        const target = marks[e.key];
        if (jumpType === "'") {
          const { lineStart } = getLineInfo(text, target);
          adapter.setCursor(lineStart);
        } else {
          adapter.setCursor(target);
        }
      }
      return;
    }

    // Handle y prefix (yank)
    if (pendingKey === 'y') {
      setPendingKey(null);
      if (e.key === 'g') { setPendingKey('yg'); return; }
      const motion = e.key === 'y' ? 'y' : keyToMotion(e.key);
      const range = getMotionRange(text, pos, motion);
      if (range) navigator.clipboard?.writeText(text.slice(range.start, range.end));
      return;
    }

    // Handle yg prefix (ygg)
    if (pendingKey === 'yg') {
      setPendingKey(null);
      if (e.key === 'g') navigator.clipboard?.writeText(text.slice(0, pos));
      return;
    }

    // Handle d prefix (delete)
    if (pendingKey === 'd') {
      setPendingKey(null);
      if (e.key === 'g') { setPendingKey('dg'); return; }
      const motion = e.key === 'd' ? 'd' : keyToMotion(e.key);
      const range = getMotionRange(text, pos, motion);
      if (range) {
        navigator.clipboard?.writeText(text.slice(range.start, range.end));
        const newText = text.slice(0, range.start) + text.slice(range.end);
        updateContent(newText, Math.min(range.newPos, newText.length));
        lastActionRef.current = { type: 'delete', motion };
      }
      return;
    }

    // Handle dg prefix (dgg)
    if (pendingKey === 'dg') {
      setPendingKey(null);
      if (e.key === 'g') {
        const range = getMotionRange(text, pos, 'gg');
        if (range) {
          navigator.clipboard?.writeText(text.slice(range.start, range.end));
          updateContent(text.slice(range.end), 0);
          lastActionRef.current = { type: 'delete', motion: 'gg' };
        }
      }
      return;
    }

    // Handle c prefix (change)
    if (pendingKey === 'c') {
      setPendingKey(null);
      if (e.key === 'g') { setPendingKey('cg'); return; }
      const motion = e.key === 'c' ? 'c' : keyToMotion(e.key);

      // cc is special - preserve indent
      if (motion === 'c') {
        const { lineStart, lineEnd } = getLineInfo(text, pos);
        const nw = getFirstNonWhitespace(text, pos);
        const indent = text.slice(lineStart, nw);
        const newText = text.slice(0, lineStart) + indent + text.slice(lineEnd);
        updateContent(newText, lineStart + indent.length);
        lastActionRef.current = { type: 'change', motion: 'c' };
        changeMode('insert');
        return;
      }

      const range = getMotionRange(text, pos, motion);
      if (range) {
        const newText = text.slice(0, range.start) + text.slice(range.end);
        updateContent(newText, range.newPos);
        lastActionRef.current = { type: 'change', motion };
        changeMode('insert');
      }
      return;
    }

    // Handle cg prefix (cgg)
    if (pendingKey === 'cg') {
      setPendingKey(null);
      if (e.key === 'g') {
        const range = getMotionRange(text, pos, 'gg');
        if (range) {
          updateContent(text.slice(range.end), 0);
          lastActionRef.current = { type: 'change', motion: 'gg' };
          changeMode('insert');
        }
      }
      return;
    }

    // Handle g prefix
    if (pendingKey === 'g') {
      setPendingKey(null);
      switch (e.key) {
        case 'g':
          adapter.setCursor(0);
          break;
        case 'j':
          // gj = display line down - use native arrow if available
          if (adapter.simulateKey) {
            adapter.simulateKey('ArrowDown');
          } else {
            adapter.setCursor(getLinePosition(text, pos, 1));
          }
          break;
        case 'k':
          // gk = display line up - use native arrow if available
          if (adapter.simulateKey) {
            adapter.simulateKey('ArrowUp');
          } else {
            adapter.setCursor(getLinePosition(text, pos, -1));
          }
          break;
        case '$': {
          const end = getLineInfo(text, pos).lineEnd;
          adapter.setCursor(end);
          break;
        }
        case '^': {
          const nw = getFirstNonWhitespace(text, pos);
          adapter.setCursor(nw);
          break;
        }
        case '0': {
          const start = getLineInfo(text, pos).lineStart;
          adapter.setCursor(start);
          break;
        }
      }
      return;
    }

    // Check for movement key first (except 0 which needs count check)
    if (e.key !== '0' || countBuffer.length === 0) {
      // For h/l and arrow keys, use Selection.modify if available (contenteditable)
      // j/k use true lines (handled by getNewPosition), gj/gk use display lines
      if (adapter.simulateKey) {
        const arrowMap: Record<string, string> = {
          h: 'ArrowLeft', l: 'ArrowRight',
          ArrowLeft: 'ArrowLeft', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowRight: 'ArrowRight',
        };
        if (arrowMap[e.key]) {
          adapter.simulateKey(arrowMap[e.key]);
          setCountBuffer('');
          return;
        }
      }
      const movePos = getNewPosition(text, pos, e.key);
      if (movePos !== null) {
        adapter.setCursor(movePos);
        setCountBuffer('');
        return;
      }
    }

    // Main normal mode keys
    switch (e.key) {
      // Enter insert mode
      case 'i':
        changeMode('insert');
        break;
      case 'a':
        adapter.setCursor(pos + 1);
        changeMode('insert');
        break;
      case 'I': {
        const nw = getFirstNonWhitespace(text, pos);
        adapter.setCursor(nw);
        changeMode('insert');
        break;
      }
      case 'A': {
        const end = getLineInfo(text, pos).lineEnd;
        adapter.setCursor(end);
        changeMode('insert');
        break;
      }
      case 'o': {
        const { lineEnd } = getLineInfo(text, pos);
        const newText = text.slice(0, lineEnd) + '\n' + text.slice(lineEnd);
        updateContent(newText, lineEnd + 1);
        changeMode('insert');
        break;
      }
      case 'O': {
        const { lineStart } = getLineInfo(text, pos);
        const newText = text.slice(0, lineStart) + '\n' + text.slice(lineStart);
        updateContent(newText, lineStart);
        changeMode('insert');
        break;
      }

      // Join lines
      case 'J': {
        const { lineEnd } = getLineInfo(text, pos);
        if (lineEnd < text.length) {
          // Find the start of next line content (skip leading whitespace)
          let nextContentStart = lineEnd + 1;
          while (nextContentStart < text.length && (text[nextContentStart] === ' ' || text[nextContentStart] === '\t')) {
            nextContentStart++;
          }
          // Replace newline and leading whitespace with single space
          const newText = text.slice(0, lineEnd) + ' ' + text.slice(nextContentStart);
          updateContent(newText, lineEnd);
        }
        break;
      }

      // Delete key - delete char under cursor (like x)
      case 'Delete':
        if (pos < text.length) {
          navigator.clipboard?.writeText(text[pos]);
          const newText = text.slice(0, pos) + text.slice(pos + 1);
          updateContent(newText, Math.min(pos, newText.length));
        }
        break;
      case 'g':
        setPendingKey('g');
        break;

      // Search
      case '/':
      case '?':
        setSearchDirection(e.key === '/' ? 1 : -1);
        setSearchQuery('');
        changeMode('search');
        break;
      case 'n':
      case 'N': {
        if (lastSearch) {
          const dir = e.key === 'n' ? searchDirection : (searchDirection === 1 ? -1 : 1);
          const newPos = searchText(text, pos, lastSearch, dir);
          adapter.setCursor(newPos);
        }
        break;
      }

      // Command mode
      case ':':
        setCommandQuery('');
        changeMode('command');
        break;

      // Toggle case
      case '~':
        if (pos < text.length) {
          const char = text[pos];
          const toggled = char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase();
          const newText = text.slice(0, pos) + toggled + text.slice(pos + 1);
          updateContent(newText, pos + 1);
        }
        break;

      // Delete/cut (x deletes selection if present, otherwise single char)
      case 'x':
        if (pos !== selEnd) {
          // Selection exists - delete it
          const start = Math.min(pos, selEnd);
          const end = Math.max(pos, selEnd);
          navigator.clipboard?.writeText(text.slice(start, end));
          const newText = text.slice(0, start) + text.slice(end);
          updateContent(newText, start);
          lastActionRef.current = { type: 'delete', motion: 'x' };
        } else if (pos < text.length) {
          // No selection - delete char at cursor
          navigator.clipboard?.writeText(text[pos]);
          const newText = text.slice(0, pos) + text.slice(pos + 1);
          updateContent(newText, Math.min(pos, newText.length));
          lastActionRef.current = { type: 'delete', motion: 'x' };
        }
        break;
      case 'X':
        if (pos > 0) {
          navigator.clipboard?.writeText(text[pos - 1]);
          const newText = text.slice(0, pos - 1) + text.slice(pos);
          updateContent(newText, pos - 1);
        }
        break;

      // Paste
      case 'p':
        navigator.clipboard?.readText().then(clipText => {
          if (!clipText) return;
          // Don't go past newline - if at end of line or end of text, paste at pos
          const insertPos = (pos >= text.length || text[pos] === '\n') ? pos : pos + 1;
          const newText = text.slice(0, insertPos) + clipText + text.slice(insertPos);
          updateContent(newText, insertPos + clipText.length - 1);
        });
        break;
      case 'P':
        navigator.clipboard?.readText().then(clipText => {
          if (!clipText) return;
          const newText = text.slice(0, pos) + clipText + text.slice(pos);
          updateContent(newText, pos + clipText.length - 1);
        });
        break;

      // Yank
      case 'y':
        setPendingKey('y');
        break;

      // Delete with motion
      case 'd':
        setPendingKey('d');
        break;

      // Change with motion
      case 'c':
        setPendingKey('c');
        break;

      // Undo
      case 'u':
        onUndo?.();
        break;

      // Replace single char
      case 'r':
        setPendingKey('r');
        break;

      // Replace mode (overwrite)
      case 'R':
        changeMode('replace');
        break;

      // Substitute char (delete + insert, like cl)
      case 's': {
        const count = getCount();
        if (pos < text.length) {
          const deleteEnd = Math.min(pos + count, text.length);
          navigator.clipboard?.writeText(text.slice(pos, deleteEnd));
          const newText = text.slice(0, pos) + text.slice(deleteEnd);
          updateContent(newText, pos);
          lastActionRef.current = { type: 'change', motion: 'l' };
          changeMode('insert');
        }
        break;
      }

      // Substitute line (like cc)
      case 'S': {
        const { lineStart, lineEnd } = getLineInfo(text, pos);
        const nw = getFirstNonWhitespace(text, pos);
        const indent = text.slice(lineStart, nw);
        const newText = text.slice(0, lineStart) + indent + text.slice(lineEnd);
        updateContent(newText, lineStart + indent.length);
        lastActionRef.current = { type: 'change', motion: 'c' };
        changeMode('insert');
        break;
      }

      // Delete/change to end of line (D = d$, C = c$)
      case 'D':
      case 'C': {
        const isChange = e.key === 'C';
        const { lineEnd } = getLineInfo(text, pos);
        navigator.clipboard?.writeText(text.slice(pos, lineEnd));
        const newText = text.slice(0, pos) + text.slice(lineEnd);
        updateContent(newText, isChange ? pos : Math.max(0, pos - 1));
        lastActionRef.current = { type: isChange ? 'change' : 'delete', motion: '$' };
        if (isChange) changeMode('insert');
        break;
      }

      // Find char forward/backward
      case 'f':
      case 'F':
      case 't':
      case 'T':
        setPendingKey(e.key);
        break;

      // Repeat last f/F/t/T
      case ';':
      case ',': {
        if (lastFindChar) {
          const { char, type } = lastFindChar;
          const reverse = e.key === ',';
          const effectiveType: 'f' | 'F' | 't' | 'T' = reverse
            ? (type === 'f' ? 'F' : type === 'F' ? 'f' : type === 't' ? 'T' : 't')
            : type;
          const newPos = findCharOnLine(text, pos, char, effectiveType);
          adapter.setCursor(newPos);
        }
        break;
      }

      // Set mark
      case 'm':
        setPendingKey('m');
        break;

      // Jump to mark
      case "'":
      case '`':
        setPendingKey(e.key);
        break;

      // Jump to matching bracket
      case '%': {
        const brackets: Record<string, string> = { '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{' };
        const char = text[pos];
        if (brackets[char]) {
          const isOpen = '([{'.includes(char);
          const target = brackets[char];
          let depth = 1;
          let i = pos + (isOpen ? 1 : -1);
          while (i >= 0 && i < text.length && depth > 0) {
            if (text[i] === char) depth++;
            else if (text[i] === target) depth--;
            if (depth > 0) i += isOpen ? 1 : -1;
          }
          if (depth === 0) {
            setLastJumpPos(pos);
            adapter.setCursor(i);
          }
        }
        break;
      }

      // ZZ - save and quit
      case 'Z':
        setPendingKey('Z');
        break;

      // Repeat last action
      case '.': {
        const action = lastActionRef.current;
        if (!action) break;

        if (action.type === 'delete') {
          // Special case for x (single char delete)
          if (action.motion === 'x') {
            if (pos < text.length) {
              const newText = text.slice(0, pos) + text.slice(pos + 1);
              updateContent(newText, Math.min(pos, newText.length));
            }
            break;
          }
          const range = getMotionRange(text, pos, action.motion || 'd');
          if (range) {
            const newText = text.slice(0, range.start) + text.slice(range.end);
            updateContent(newText, Math.min(range.newPos, newText.length));
          }
        } else if (action.type === 'change') {
          const insertText = action.insertedText || '';
          // Special case for cc (preserve indent)
          if (action.motion === 'c') {
            const { lineStart, lineEnd } = getLineInfo(text, pos);
            const nw = getFirstNonWhitespace(text, pos);
            const indent = text.slice(lineStart, nw);
            const newText = text.slice(0, lineStart) + indent + insertText + text.slice(lineEnd);
            updateContent(newText, lineStart + indent.length + insertText.length);
            break;
          }
          const range = getMotionRange(text, pos, action.motion || 'c');
          if (range) {
            const newText = text.slice(0, range.start) + insertText + text.slice(range.end);
            updateContent(newText, range.start + insertText.length);
          }
        } else if (action.type === 'insert' && action.insertedText) {
          const newText = text.slice(0, pos) + action.insertedText + text.slice(pos);
          updateContent(newText, pos + action.insertedText.length);
        }
        break;
      }

      // Visual mode
      case 'v':
        setVisualAnchor(pos);
        changeMode('visual');
        break;

      // Visual line mode (V) - select entire line
      case 'V': {
        const { lineStart, lineEnd } = getLineInfo(text, pos);
        setVisualAnchor(lineStart);
        adapter.setCursor(lineStart, lineEnd);
        changeMode('visual');
        break;
      }
    }
  }, [mode, enabled, adapter, changeMode, pendingKey, searchQuery, searchDirection, lastSearch, onSave, onQuit, onForceQuit, onUndo, onRedo, visualAnchor, searchFromVisual, updateContent, onContentChange, commandQuery, countBuffer, getCount, lastFindChar, marks, lastJumpPos, visualBlockAnchor, onModeChange]);

  // Allow entering visual mode from outside (e.g., mouse selection)
  const enterVisualMode = useCallback((anchor: number) => {
    setVisualAnchor(anchor);
    setMode('visual');
    setPendingKey(null);
    onModeChange?.('visual');
  }, [onModeChange]);

  // Allow entering visual block mode from outside (e.g., Alt+click)
  const enterVisualBlockMode = useCallback((pos: number) => {
    const text = adapter.getText();
    const line = getLineNumber(text, pos);
    const { column } = getLineInfo(text, pos);
    setVisualBlockAnchor({ line, col: column });
    setVisualAnchor(pos);
    setMode('visual-block');
    setPendingKey(null);
    onModeChange?.('visual-block');
  }, [onModeChange, adapter]);

  return { mode, handleKeyDown, searchQuery, searchDirection, commandQuery, pendingKey, enterVisualMode, enterVisualBlockMode, visualBlockAnchor };
}

export default useViMode;
