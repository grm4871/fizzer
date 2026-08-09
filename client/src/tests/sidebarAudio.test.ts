import { describe, expect, it } from 'vitest';
import { isMp3Link, youtubeVideoId } from '../components/Sidebar';

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

describe('youtubeVideoId', () => {
  it('recognizes share, watch, shorts, live, and embed URLs', () => {
    expect(youtubeVideoId('https://youtu.be/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://www.youtube.com/watch?v=jK-tt-3XJ7c&t=12')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://youtube.com/shorts/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://youtube.com/live/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
    expect(youtubeVideoId('https://youtube.com/embed/jK-tt-3XJ7c')).toBe('jK-tt-3XJ7c');
  });

  it('rejects lookalike hosts and malformed IDs', () => {
    expect(youtubeVideoId('https://youtube.example/watch?v=jK-tt-3XJ7c')).toBeNull();
    expect(youtubeVideoId('https://youtube.com/watch?v=no')).toBeNull();
  });
});
