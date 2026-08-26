/** Pure CodeMirror command helpers; each command edits source Markdown only. */
import type { EditorView } from '@codemirror/view';

/* ─── Editor Helpers ─────────────────────────────────────── */
export function toggleInlineFormat(view: EditorView, marker: string) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);

  if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2) {
    // Remove format
    view.dispatch({
      changes: { from, to, insert: selected.slice(marker.length, -marker.length) },
    });
  } else {
    // Add format
    view.dispatch({
      changes: { from, to, insert: `${marker}${selected || 'text'}${marker}` },
      selection: { anchor: from + marker.length, head: to + marker.length },
    });
  }
}

export function toggleLinePrefix(view: EditorView, prefix: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const text = line.text;

  // Check if any heading prefix exists
  const headingMatch = text.match(/^(#{1,6}\s|[-*+]\s(\[.\]\s)?|\d+\.\s)/);
  if (headingMatch) {
    // Remove existing prefix
    view.dispatch({
      changes: { from: line.from, to: line.from + headingMatch[0].length, insert: '' },
    });
    // Add new prefix if it's different
    if (headingMatch[0] !== prefix) {
      view.dispatch({
        changes: { from: line.from, insert: prefix },
      });
    }
  } else {
    view.dispatch({
      changes: { from: line.from, insert: prefix },
    });
  }
}

export function insertLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const insert = selected ? `[${selected}](url)` : '[link text](url)';
  view.dispatch({
    changes: { from, to, insert },
  });
}

export function insertAtCursor(view: EditorView, text: string) {
  const { from } = view.state.selection.main;
  view.dispatch({
    changes: { from, insert: text },
    selection: { anchor: from + text.length },
  });
}

export function insertPrivateBlock(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  const prefix = from > 0 && view.state.sliceDoc(from - 1, from) !== '\n' ? '\n' : '';
  const body = selected || 'credential=value';
  const insert = `${prefix}:::private\n${body}\n:::\n`;
  const bodyFrom = from + prefix.length + ':::private\n'.length;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: bodyFrom, head: bodyFrom + body.length },
  });
}

// Extract the prompt of the {{ai: …}} directive on the cursor's line. Prefers a
// directive the cursor sits inside; otherwise falls back to the first on the line.
export function directiveAtCursor(view: EditorView): string | null {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const col = head - line.from;
  const re = /\{\{ai:([\s\S]*?)\}\}/g;
  let match: RegExpExecArray | null;
  let fallback: string | null = null;
  while ((match = re.exec(line.text))) {
    const prompt = match[1].trim();
    if (!prompt) continue;
    if (col >= match.index && col <= match.index + match[0].length) return prompt;
    if (fallback === null) fallback = prompt;
  }
  return fallback;
}
