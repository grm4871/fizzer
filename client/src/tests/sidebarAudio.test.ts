import { describe, expect, it } from 'vitest';
import { isMp3Link } from '../components/Sidebar';

describe('isMp3Link', () => {
  it('recognizes uploaded note assets by their visible filename', () => {
    expect(isMp3Link('field recording.mp3', '/api/notes/n1/assets/a1')).toBe(true);
  });

  it('recognizes chat data URLs and direct MP3 URLs', () => {
    expect(isMp3Link('audio', 'data:audio/mpeg;base64,AAAA')).toBe(true);
    expect(isMp3Link('track', 'https://example.test/music/song.mp3?download=1')).toBe(true);
  });

  it('does not intercept ordinary attachments', () => {
    expect(isMp3Link('notes.pdf', '/files/notes.pdf')).toBe(false);
  });
});
