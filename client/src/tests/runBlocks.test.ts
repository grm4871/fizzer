import { describe, expect, it } from 'vitest';
import { honestAgentChatBody } from '../chat/runBlocks';

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

  it('still suppresses a run body after an explicit chat send', () => {
    expect(honestAgentChatBody('duplicate', 'duplicate', 'completed', {
      suppressChatBody: true,
    })).toBe('');
  });
});
