import { describe, expect, it } from 'vitest';
import { applyRemoteChatMessage, honestAgentChatBody, mergeRemoteChatMessage } from '../chat/runBlocks';
import type { ChatMessage } from '../chat/types';

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

  it('never surfaces placeholder success text as chat body', () => {
    expect(honestAgentChatBody('', 'Completed note operations successfully.', 'completed'))
      .toBe('');
    expect(honestAgentChatBody('', 'Done.', 'completed')).toBe('');
    expect(honestAgentChatBody(
      'Completed note operations successfully.',
      'Completed note operations successfully.',
      'completed',
    )).toBe('');
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

describe('mergeRemoteChatMessage local-first live rows', () => {
  it('keeps a live local answer when the fold is still Thinking...', () => {
    const local = chatMessage('m3', {
      body: 'The tests pass.',
      status: 'running',
      agentId: 'codex',
      runId: 9,
    });
    const remote = chatMessage('m3', {
      body: 'Thinking...',
      status: 'running',
      agentId: 'codex',
      runId: 9,
      seq: 44,
    });

    const merged = mergeRemoteChatMessage(local, remote);

    expect(merged.body).toBe('The tests pass.');
    expect(merged.status).toBe('running');
    expect(merged.seq).toBe(44);
    expect(merged.runId).toBe(9);
  });

  it('does not rewind a longer live body to a shorter fold snapshot', () => {
    const local = chatMessage('m4', {
      body: 'I checked both files and the leak is in the socket handler.',
      status: 'running',
      agentId: 'codex',
    });
    const remote = chatMessage('m4', {
      body: 'I checked both files',
      status: 'running',
      agentId: 'codex',
      seq: 8,
    });

    expect(mergeRemoteChatMessage(local, remote).body).toBe(local.body);
    expect(mergeRemoteChatMessage(local, remote).seq).toBe(8);
  });

  it('lets a remote cancel settle a live local row', () => {
    const local = chatMessage('m5', {
      body: 'Still working on it.',
      status: 'running',
      agentId: 'codex',
      runId: 3,
    });
    const remote = chatMessage('m5', {
      body: 'Run canceled by user.',
      status: 'canceled',
      agentId: 'codex',
      runId: 3,
      seq: 12,
    });

    const merged = mergeRemoteChatMessage(local, remote);
    expect(merged.status).toBe('canceled');
    expect(merged.body).toBe('Run canceled by user.');
    expect(merged.seq).toBe(12);
  });

  it('does not drop a live answer when a settled empty shell arrives', () => {
    const local = chatMessage('m6', {
      body: 'Here is the patch.',
      status: 'running',
      agentId: 'codex',
      runId: 5,
    });
    const remote = chatMessage('m6', {
      body: '',
      agentId: 'codex',
      runId: 5,
      seq: 20,
    });
    const next = applyRemoteChatMessage([local], remote);
    expect(next).toHaveLength(1);
    expect(next[0].body).toBe('Here is the patch.');
    expect(next[0].seq).toBe(20);
  });

  it('still removes a settled empty agent shell when the local row is not live', () => {
    const local = chatMessage('m7', {
      body: 'Thinking...',
      agentId: 'codex',
      runId: 5,
    });
    const remote = chatMessage('m7', {
      body: '',
      agentId: 'codex',
      runId: 5,
    });
    expect(applyRemoteChatMessage([local], remote)).toEqual([]);
  });
});
