import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { buildDecorations } from '../components/noteEditorDecorations';
import { formatImageMarkdown, parseImageAlt } from '../components/noteEditorMedia';

function getParsedDecorations(text: string, cursorHead: number = -1) {
  const fullText = text + '\n';
  const state = EditorState.create({ doc: fullText });
  const head = cursorHead !== -1 ? cursorHead : fullText.length;
  const mockState = {
    doc: state.doc,
    selection: {
      main: {
        head,
      },
    },
  } as unknown as EditorState;

  const set = buildDecorations(mockState);
  const decos: { from: number; to: number; type: string; width?: number | null; alt?: string; url?: string }[] = [];

  const iter = set.iter();
  while (iter.value) {
    const val = iter.value as any;
    const widget = val.spec?.widget;
    const decoInfo: any = {
      from: iter.from,
      to: iter.to,
      type: val.spec?.class || (widget ? widget.constructor?.name || 'widget' : 'unknown'),
    };
    if (widget && typeof widget.width !== 'undefined') {
      decoInfo.width = widget.width;
      decoInfo.alt = widget.alt;
      decoInfo.url = widget.url;
    }
    decos.push(decoInfo);
    iter.next();
  }
  return decos;
}

describe('parseImageAlt / formatImageMarkdown', () => {
  it('parses plain alt without size', () => {
    expect(parseImageAlt('screenshot')).toEqual({ alt: 'screenshot', width: null });
  });

  it('parses Obsidian-style width suffix', () => {
    expect(parseImageAlt('shot|320')).toEqual({ alt: 'shot', width: 320 });
    expect(parseImageAlt('shot|320x180')).toEqual({ alt: 'shot', width: 320 });
    expect(parseImageAlt('|400')).toEqual({ alt: '', width: 400 });
  });

  it('formats markdown with and without width', () => {
    expect(formatImageMarkdown('', 'photo', '/api/notes/n/assets/a.png', null))
      .toBe('![photo](/api/notes/n/assets/a.png)');
    expect(formatImageMarkdown('  ', 'photo', '/api/notes/n/assets/a.png', 280))
      .toBe('  ![photo|280](/api/notes/n/assets/a.png)');
  });

  it('strips stray pipes from alt when formatting', () => {
    expect(formatImageMarkdown('', 'a|b', 'u', 100)).toBe('![a b|100](u)');
  });
});

describe('image widget decorations', () => {
  it('builds an ImageWidget for a plain image line', () => {
    const decos = getParsedDecorations('![hello](https://example.com/a.png)');
    const img = decos.find((d) => d.type === 'ImageWidget');
    expect(img).toMatchObject({
      type: 'ImageWidget',
      from: 0,
      alt: 'hello',
      url: 'https://example.com/a.png',
      width: null,
    });
  });

  it('reads width from alt and exposes it on the widget', () => {
    const decos = getParsedDecorations('![diagram|420](/api/notes/n1/assets/x.png)');
    const img = decos.find((d) => d.type === 'ImageWidget');
    expect(img).toMatchObject({
      type: 'ImageWidget',
      alt: 'diagram',
      url: '/api/notes/n1/assets/x.png',
      width: 420,
    });
  });

  it('does not replace the image line when the cursor is on it', () => {
    const text = '![x|100](https://example.com/a.png)';
    const decos = getParsedDecorations(text, 0);
    expect(decos.find((d) => d.type === 'ImageWidget')).toBeUndefined();
  });
});
