import { describe, expect, it } from 'vitest';
import {
  bodyHasNoteRefs,
  findEmbeddedNote,
  splitDocEmbeds,
  splitWikilinks,
} from '../docEmbeds';

describe('splitDocEmbeds / splitWikilinks', () => {
  it('splits block embeds', () => {
    const parts = splitDocEmbeds('See ![[One Room]] please');
    expect(parts).toEqual([
      { type: 'text', value: 'See ' },
      { type: 'embed', value: 'One Room' },
      { type: 'text', value: ' please' },
    ]);
  });

  it('splits inline wikilinks with colons in titles', () => {
    const body = 'Made [[One Room: social presence without audience capture]]. Done.';
    expect(bodyHasNoteRefs(body)).toBe(true);
    expect(splitWikilinks(body)).toEqual([
      { type: 'text', value: 'Made ' },
      { type: 'wikilink', value: 'One Room: social presence without audience capture' },
      { type: 'text', value: '. Done.' },
    ]);
  });

  it('does not treat embeds as wikilinks', () => {
    // After embed split, residual text has no wikilink; raw still has ![[.
    const raw = 'x ![[Embedded Note]] y';
    const textOnly = splitDocEmbeds(raw)
      .filter((p) => p.type === 'text')
      .map((p) => p.value)
      .join('');
    expect(splitWikilinks(textOnly)).toEqual([{ type: 'text', value: 'x  y' }]);
  });

  it('resolves notes by title case-insensitively', () => {
    const notes = [
      { id: '1', title: 'One Room: social presence without audience capture', content_preview: '' },
    ] as any;
    expect(findEmbeddedNote(notes, 'one room: social presence without audience capture')?.id).toBe('1');
  });
});
