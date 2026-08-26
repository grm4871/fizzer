import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { buildDecorations } from '../components/noteEditorDecorations';

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
  const decos: { from: number; to: number; className?: string; type: string; url?: string }[] = [];
  
  const iter = set.iter();
  while (iter.value) {
    const val = iter.value as any;
    const decoInfo: any = {
      from: iter.from,
      to: iter.to,
      type: val.spec?.class || (val.spec?.widget ? 'widget' : 'unknown')
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

  it('should parse code blocks, hide fences when cursor is not on them, and apply cm-code-block-line', () => {
    const text = '```json\n{\n  "key": "value"\n}\n```';
    const decos = getParsedDecorations(text);

    // Fences should be hidden (since cursor is at the end, not on them)
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-md-hidden',
      from: 0,
      to: 7
    }));
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-md-hidden',
      from: 29,
      to: 32
    }));

    // Body lines should have cm-code-block-line line decorations
    // Line 2 starts at 8
    expect(decos).toContainEqual(expect.objectContaining({
      type: 'cm-code-block-line',
      from: 8,
      to: 8
    }));
  });

  it('treats legacy cascade-widget fences as inert code blocks', () => {
    const decos = getParsedDecorations('```cascade-widget\n<button>Legacy widget</button>\n```');

    expect(decos).not.toContainEqual(expect.objectContaining({ type: 'widget' }));
    expect(decos).toContainEqual(expect.objectContaining({ type: 'cm-code-block-line' }));
  });

  it('collapses private blocks when the cursor is outside and reveals them for editing', () => {
    const text = 'Visible\n:::private\nAPI_KEY=secret\n:::\nTail';
    const collapsed = getParsedDecorations(text);
    expect(collapsed).toContainEqual(expect.objectContaining({
      type: 'widget',
      from: 8,
      to: 37,
    }));

    const active = getParsedDecorations(text, 22);
    expect(active).not.toContainEqual(expect.objectContaining({
      type: 'widget',
      from: 8,
      to: 37,
    }));
  });
});
