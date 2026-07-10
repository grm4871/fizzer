/**
 * Read-only xterm.js terminal for agent harness output in chat.
 *
 * Renders raw process stdout/stderr (or Claude SDK stream transcript) with
 * full ANSI/VT support. Not an interactive PTY — stdin is disabled because
 * agents run headless over pipes.
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const TERMINAL_THEME = {
  background: '#0c0b0a',
  foreground: '#e0d9ce',
  cursor: '#e0d9ce',
  cursorAccent: '#0c0b0a',
  selectionBackground: 'rgba(201, 140, 54, 0.35)',
  black: '#1a1816',
  red: '#d16b5c',
  green: '#5cb88a',
  yellow: '#d4c35a',
  blue: '#6a9fd4',
  magenta: '#b88ad4',
  cyan: '#5cb8b0',
  white: '#e0d9ce',
  brightBlack: '#6b6560',
  brightRed: '#e88a7c',
  brightGreen: '#7dd4a4',
  brightYellow: '#e8d97a',
  brightBlue: '#8ab8e8',
  brightMagenta: '#d4a8e8',
  brightCyan: '#7dd4cc',
  brightWhite: '#f5f0e8',
};

/** Normalize newlines so xterm's convertEol handles them consistently. */
function toXtermText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function HarnessTerminal({
  content,
  active = false,
  className = '',
}: {
  /** Full terminal buffer (ANSI allowed). Incremental writes when content grows. */
  content: string;
  /** When true, auto-scroll to bottom on new output. */
  active?: boolean;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  /** Last `content` string successfully written to the terminal. */
  const writtenRef = useRef('');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'underline',
      fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: TERMINAL_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    writtenRef.current = '';

    const fitSoon = () => {
      try {
        fit.fit();
      } catch {
        // Container may be zero-sized while collapsed.
      }
    };
    requestAnimationFrame(fitSoon);

    const ro = new ResizeObserver(() => fitSoon());
    ro.observe(host);

    return () => {
      ro.disconnect();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      writtenRef.current = '';
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const text = content || '';
    const prev = writtenRef.current;

    if (!text) {
      if (prev) {
        term.reset();
        writtenRef.current = '';
      }
      return;
    }

    // Common case: content only grows — write the delta.
    if (prev && text.startsWith(prev)) {
      const delta = text.slice(prev.length);
      if (delta) {
        term.write(toXtermText(delta));
        writtenRef.current = text;
        // Follow the tail while running; keep position when scrubbing history.
        if (active) term.scrollToBottom();
      }
      return;
    }

    // Truncation (size cap) or first paint / replace: rebuild.
    term.reset();
    term.write(toXtermText(text));
    writtenRef.current = text;
    // Open at the end so the latest harness output is visible immediately.
    term.scrollToBottom();
  }, [content, active]);

  return (
    <div
      className={`harness-terminal ${className}`.trim()}
      ref={hostRef}
      role="log"
      aria-label="Agent harness terminal"
      aria-live={active ? 'polite' : 'off'}
    />
  );
}
