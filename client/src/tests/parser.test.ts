import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { buildDecorations } from '../components/NoteEditor';

/**
 * Helper to parse a markdown text block and extract all active CodeMirror decorations.
 * Appends a dummy second line by default and places the cursor on it so the main tested line is inactive.
 */
function getParsedDecorations(text: string, cursorHead: number = -1) {
  const fullText = text + '\n';
  const state = EditorState.create({ doc: fullText });
  const head = cursorHead !== -1 ? cursorHead : fullText.length;
  const mockState = {
    doc: state.doc,
    selection: {
      main: {
        head
      }
    }
  } as unknown as EditorState;

  const set = buildDecorations(mockState);
  const decos: { from: number; to: number; className?: string; type: string; url?: string; widgetName?: string }[] = [];
  
  const iter = set.iter();
  while (iter.value) {
    const val = iter.value as any;
    const decoInfo: any = {
      from: iter.from,
      to: iter.to,
      type: val.spec?.class || (val.spec?.widget ? 'widget' : 'unknown'),
      widgetName: val.spec?.widget?.constructor?.name,
    };
    if (val.spec?.attributes?.['data-url']) {
      decoInfo.url = val.spec.attributes['data-url'];
    }
    decos.push(decoInfo);
    iter.next();
  }
  return decos;
}

describe('Markdown Decoration Parser Tests', () => {
  it('should parse headings and hide markers when cursor is not on the heading line', () => {
    const decos = getParsedDecorations('# Hello World'); // cursor on dummy second line
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-heading-1',
      from: 0,
      to: 13
    }));
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-md-hidden',
      from: 0,
      to: 2
    }));
  });

  it('should parse external links with parentheses in the label', () => {
    const text = '[Arch User Repository (AUR)](https://aur.archlinux.org/)';
    const decos = getParsedDecorations(text);

    // Label should be decorated as external link and have the correct url attribute
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-external-link',
      url: 'https://aur.archlinux.org/',
      from: 1,
      to: 27
    }));

    // Brackets and URL target should be hidden
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-md-hidden',
      from: 0,
      to: 1
    }));
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-md-hidden',
      from: 27,
      to: 56
    }));
  });

  it('should parse nested formatting: links inside bold text', () => {
    const text = '**[Arch User Repository (AUR)](https://aur.archlinux.org/)**';
    const decos = getParsedDecorations(text);

    // The whole inner part should be bold
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-md-bold',
      from: 2,
      to: 58
    }));

    // The link itself should still be parsed and decorated
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-external-link',
      url: 'https://aur.archlinux.org/',
      from: 3,
      to: 29
    }));
  });

  it('should render a plain wikilink as a chip over its inner title', () => {
    const decos = getParsedDecorations('[[Cascade]]');
    // [[ hidden, "Cascade" chip, ]] hidden
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 0, to: 2 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-wikilink', from: 2, to: 9 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 9, to: 11 }));
  });

  it('should render an aliased wikilink showing only the display text', () => {
    // [[Cascade|the effect]] — hide "[[", hide "Cascade|", chip over "the effect", hide "]]"
    const decos = getParsedDecorations('[[Cascade|the effect]]');
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 0, to: 2 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 2, to: 10 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-wikilink', from: 10, to: 20 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 20, to: 22 }));
  });

  it('should sort decorations strictly by start position to prevent CodeMirror RangeError', () => {
    // A line with a checkbox and preceding/following bold styles
    const text = '**bold** - [ ] **more bold**';
    const decos = getParsedDecorations(text);

    // Check that all decoration start indices are non-decreasing
    for (let i = 0; i < decos.length - 1; i++) {
      expect(decos[i].from).toBeLessThanOrEqual(decos[i + 1].from);
      if (decos[i].from === decos[i + 1].from) {
        expect(decos[i].to).toBeGreaterThanOrEqual(decos[i + 1].to);
      }
    }
  });

  it('should replace malformed empty-header pipe tables with a table widget', () => {
    const text = [
      '||',
      '|---|---|',
      '| Campaign | **Atomic Arch** |',
      '| Payload | Rust `deps` ELF stealer |',
    ].join('\n');
    const decos = getParsedDecorations(text);

    expect(decos).toContainEqual(expect.objectContaining({
      type: 'widget',
      widgetName: 'TableWidget',
      from: 0,
      to: text.length,
    }));
  });

  it('should leave a table editable when the cursor is inside it', () => {
    const text = [
      '||',
      '|---|---|',
      '| Campaign | **Atomic Arch** |',
    ].join('\n');
    const decos = getParsedDecorations(text, 1);

    expect(decos).not.toContainEqual(expect.objectContaining({
      type: 'widget',
      widgetName: 'TableWidget',
    }));
  });

  it('should style fenced code block contents and hide fences outside the active block', () => {
    const text = [
      '```',
      'orphaned package -> attacker adopts',
      '-> npm/Bun pulls malicious package',
      '```',
    ].join('\n');
    const decos = getParsedDecorations(text);

    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 0, to: 3 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-code-block-line', from: 4, to: 39 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-code-block-line', from: 40, to: 74 }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 75, to: 78 }));
  });

  it('should leave fenced code blocks raw when the cursor is inside them', () => {
    const text = [
      '```',
      'orphaned package -> attacker adopts',
      '```',
    ].join('\n');
    const decos = getParsedDecorations(text, 5);

    expect(decos).not.toContainEqual(expect.objectContaining({ type: 'cm-md-hidden', from: 0, to: 3 }));
    expect(decos).not.toContainEqual(expect.objectContaining({ type: 'cm-code-block-line' }));
  });
});
