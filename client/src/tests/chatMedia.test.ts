import { describe, expect, it } from 'vitest';
import { CHAT_MEDIA_MAX_BYTES, isMp4Attachment, isVideoMediaType } from '../components/ChatComposer';

describe('chat video attachments', () => {
  it('allows files up to 64 MB', () => {
    expect(CHAT_MEDIA_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('recognizes video/* and mp4 filenames/urls', () => {
    expect(isVideoMediaType('video/mp4')).toBe(true);
    expect(isVideoMediaType('image/png')).toBe(false);
    expect(isMp4Attachment({ media_type: 'video/mp4', name: 'clip.mp4', url: '/x' })).toBe(true);
    expect(isMp4Attachment({ media_type: 'application/octet-stream', name: 'demo.mp4', url: '' })).toBe(true);
    expect(isMp4Attachment({ media_type: 'application/pdf', name: 'a.pdf', url: '/a.pdf' })).toBe(false);
  });
});
