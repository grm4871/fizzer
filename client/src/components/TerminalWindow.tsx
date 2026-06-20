import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, Square, Terminal, Trash2 } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';

type TerminalIpcResult = {
  success: boolean;
  error?: string;
};

type TerminalDataPayload = {
  id: string;
  data: string;
};

type TerminalExitPayload = {
  id: string;
  code: number | null;
  signal: string | null;
};

type ElectronTerminalApi = {
  startTerminal?: (input: { id: string; cwd?: string; cols?: number; rows?: number }) => Promise<TerminalIpcResult>;
  writeTerminal?: (input: { id: string; data: string }) => Promise<TerminalIpcResult>;
  resizeTerminal?: (input: { id: string; cols: number; rows: number }) => Promise<TerminalIpcResult>;
  stopTerminal?: (id: string) => Promise<TerminalIpcResult>;
  onTerminalData?: (callback: (payload: TerminalDataPayload) => void) => () => void;
  onTerminalExit?: (callback: (payload: TerminalExitPayload) => void) => () => void;
};

interface TerminalWindowProps {
  id: string;
  history: string;
  onHistoryChange: (history: string) => void;
  onTitleChange?: (title: string) => void;
}

function getElectronApi(): ElectronTerminalApi | undefined {
  return (window as unknown as { electronAPI?: ElectronTerminalApi }).electronAPI;
}

function formatTerminalStartError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || 'Could not start terminal');
  if (message.includes("No handler registered for 'terminal:start'")) {
    return 'Terminal support was updated, but the Electron main process is still running the old code. Restart Cascade and open the terminal again.\r\n';
  }
  return `[terminal error] ${message}\r\n`;
}

function trimSerializedTerminal(value: string) {
  return value.length > 100000 ? value.slice(value.length - 100000) : value;
}

export function TerminalWindow({ id, history, onHistoryChange, onTitleChange }: TerminalWindowProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const onTitleChangeRef = useRef(onTitleChange);
  const [status, setStatus] = useState<'starting' | 'running' | 'stopped' | 'unavailable'>('starting');

  onHistoryChangeRef.current = onHistoryChange;
  onTitleChangeRef.current = onTitleChange;

  const persistSnapshot = useCallback(() => {
    const serialized = serializeRef.current?.serialize() ?? '';
    onHistoryChangeRef.current(trimSerializedTerminal(serialized));
  }, []);

  const fitAndResize = useCallback(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      const electronApi = getElectronApi();
      void electronApi?.resizeTerminal?.({ id, cols: term.cols, rows: term.rows });
    } catch {
      // xterm can throw while hidden or during first layout; ResizeObserver retries.
    }
  }, [id]);

  const start = useCallback(() => {
    const electronApi = getElectronApi();
    const term = termRef.current;
    if (!electronApi?.startTerminal || !term) {
      setStatus('unavailable');
      term?.writeln('Terminal windows are only available in the Electron desktop app.');
      persistSnapshot();
      return;
    }

    setStatus('starting');
    void electronApi.startTerminal({ id, cols: term.cols, rows: term.rows })
      .then((result) => {
        if (result.success) {
          setStatus('running');
          onTitleChangeRef.current?.('Terminal');
          term.focus();
          fitAndResize();
        } else {
          setStatus('stopped');
          term.write(formatTerminalStartError(result.error || 'Could not start terminal'), persistSnapshot);
        }
      })
      .catch((error) => {
        setStatus('stopped');
        term.write(formatTerminalStartError(error), persistSnapshot);
      });
  }, [fitAndResize, id, persistSnapshot]);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new XTerm({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'JetBrains Mono, SF Mono, Cascadia Code, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5000,
      theme: {
        background: '#0c0d0e',
        foreground: '#e7e2d8',
        cursor: '#f4b35f',
        selectionBackground: '#5f4428',
        black: '#191919',
        red: '#d75f5f',
        green: '#87af5f',
        yellow: '#d7af5f',
        blue: '#5f87d7',
        magenta: '#af87d7',
        cyan: '#5fafaf',
        white: '#d7d7d7',
        brightBlack: '#5f5f5f',
        brightRed: '#ff8787',
        brightGreen: '#afff87',
        brightYellow: '#ffd787',
        brightBlue: '#87afff',
        brightMagenta: '#d7afff',
        brightCyan: '#87ffff',
        brightWhite: '#ffffff',
      },
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();

    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    serializeRef.current = serialize;

    if (history) term.write(history);
    fitAndResize();
    term.focus();

    const electronApi = getElectronApi();
    const dataDisposable = term.onData((data) => {
      void electronApi?.writeTerminal?.({ id, data });
    });

    // xterm collapses Enter and Shift+Enter to the same "\r", so the modifier
    // never reaches the pty. Intercept Shift+Enter and emit a real newline so
    // apps that support multi-line input (e.g. shells, REPLs) can see it.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && event.key === 'Enter' && event.shiftKey) {
        void electronApi?.writeTerminal?.({ id, data: '\n' });
        return false;
      }
      return true;
    });
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      void electronApi?.resizeTerminal?.({ id, cols, rows });
    });

    const unsubscribeData = electronApi?.onTerminalData?.((payload) => {
      if (payload.id !== id) return;
      term.write(payload.data, persistSnapshot);
    });
    const unsubscribeExit = electronApi?.onTerminalExit?.((payload) => {
      if (payload.id !== id) return;
      setStatus('stopped');
      term.writeln(`\r\n[process exited${payload.code === null ? '' : ` with code ${payload.code}`}${payload.signal ? `, signal ${payload.signal}` : ''}]`);
      persistSnapshot();
    });

    const observer = new ResizeObserver(() => fitAndResize());
    observer.observe(hostRef.current);
    start();

    return () => {
      observer.disconnect();
      unsubscribeData?.();
      unsubscribeExit?.();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      serializeRef.current = null;
    };
  }, [fitAndResize, id, persistSnapshot, start]);

  const stop = () => {
    const electronApi = getElectronApi();
    void electronApi?.stopTerminal?.(id);
  };

  const clear = () => {
    termRef.current?.clear();
    persistSnapshot();
    termRef.current?.focus();
  };

  return (
    <div className="terminal-window">
      <div className="terminal-toolbar">
        <div className="terminal-title">
          <Terminal size={14} />
          <span>Terminal</span>
          <span className={`terminal-status terminal-status-${status}`}>{status}</span>
        </div>
        <div className="terminal-actions">
          <button className="btn-icon terminal-action" onClick={start} title="Restart terminal">
            <RotateCw size={14} />
          </button>
          <button className="btn-icon terminal-action" onClick={stop} title="Stop terminal" disabled={status !== 'running'}>
            <Square size={13} />
          </button>
          <button className="btn-icon terminal-action" onClick={clear} title="Clear scrollback">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div ref={hostRef} className="terminal-xterm" onMouseDown={() => termRef.current?.focus()} />
    </div>
  );
}
