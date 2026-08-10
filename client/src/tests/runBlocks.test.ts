import { describe, expect, it } from 'vitest';
import { honestAgentChatBody, mergeRemoteChatMessage } from '../chat/runBlocks';
import type { ChatMessage } from '../components/ChatView';

function chatMessage(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    channelId: 'channel-1',
    author: 'tester',
    body: '',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('honestAgentChatBody', () => {
  it('uses the latest runner summary instead of accumulated progress text', () => {
    expect(honestAgentChatBody(
      'I will inspect the files.\n\nThe fix is complete.',
      'The fix is complete.',
      'completed',
    )).toBe('The fix is complete.');
  });

  it('preserves a nuanced multiline final summary exactly', () => {
    const finalSummary = [
      'The behavior is fixed, with two caveats:',
      '',
      '- Existing traces remain available on demand.',
      '- Failed runs still open their diagnostics automatically.',
      '',
      'No run data is deleted.',
    ].join('\n');

    expect(honestAgentChatBody(
      'First I inspected the renderer. Then I updated it.',
      finalSummary,
      'completed',
    )).toBe(finalSummary);
  });

  it('falls back to streamed text for generic summaries', () => {
    expect(honestAgentChatBody('Useful final answer.', 'Done.', 'completed'))
      .toBe('Useful final answer.');
  });

  it('never surfaces the legacy note-operations placeholder as chat body', () => {
    expect(honestAgentChatBody('', 'Completed note operations successfully.', 'completed'))
      .toBe('Done.');
    expect(honestAgentChatBody(
      'Completed note operations successfully.',
      'Completed note operations successfully.',
      'completed',
    )).toBe('Done.');
    expect(honestAgentChatBody(
      'Completed note operations successfully.',
      'Steered into the continuation below.',
      'canceled',
    )).toBe('Steered into the continuation below.');
  });

  it('still suppresses a run body after an explicit chat send', () => {
    expect(honestAgentChatBody('duplicate', 'duplicate', 'completed', {
      suppressChatBody: true,
    })).toBe('');
  });

  it('suppresses automatic cancellation instead of blaming the user', () => {
    expect(honestAgentChatBody(
      'Redundant review started.',
      'Mission review wake closed automatically.',
      'canceled',
      { suppressChatBody: true },
    )).toBe('');
  });
});

describe('mergeRemoteChatMessage media hydration', () => {
  it('keeps hydrated images when a reconnect returns a slim transcript row', () => {
    const image = 'data:image/png;base64,cGVyc2lzdGVk';
    const local = chatMessage('m1', { body: 'screenshot', images: [image], seq: 1 });
    const slimRemote = chatMessage('m1', { body: 'screenshot', hasImages: true, seq: 1 });

    const merged = mergeRemoteChatMessage(local, slimRemote);

    expect(merged.images).toEqual([image]);
    expect(merged.hasImages).toBeUndefined();
  });

  it('accepts full images when hydrating a slim transcript row', () => {
    const image = 'data:image/png;base64,aHlkcmF0ZWQ=';
    const slimLocal = chatMessage('m2', { hasImages: true, seq: 2 });
    const fullRemote = chatMessage('m2', { images: [image], seq: 2 });

    const merged = mergeRemoteChatMessage(slimLocal, fullRemote);

    expect(merged.images).toEqual([image]);
    expect(merged.hasImages).toBeUndefined();
  });
});
