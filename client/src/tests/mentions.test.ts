import { describe, expect, it } from 'vitest';
import { buildQuotedReplyPrompt, precedingMessageBatchText, resolveAgentMessageRegistration } from '../chat/mentions';

const registrations = [
  { id: 'terra-reg', agentId: 'codex', displayName: 'Terra', mention: 'terra', taggableByAgents: true },
  { id: 'sol-reg', agentId: 'codex', displayName: 'Sol', mention: 'sol', taggableByAgents: true },
];

describe('resolveAgentMessageRegistration', () => {
  it('uses the authoritative registration id when present', () => {
    expect(resolveAgentMessageRegistration({ registrationId: 'terra-reg' }, registrations)?.id).toBe('terra-reg');
  });

  it('accepts legacy helper messages with an unambiguous agent identity', () => {
    expect(resolveAgentMessageRegistration({ agentId: 'codex', author: 'Terra' }, registrations)?.id).toBe('terra-reg');
  });

  it('does not infer a source from ambiguous or human messages', () => {
    expect(resolveAgentMessageRegistration({ author: 'Terra' }, registrations)).toBeUndefined();
    expect(resolveAgentMessageRegistration({ agentId: 'codex', author: 'Unknown' }, registrations)).toBeUndefined();
  });
});

describe('precedingMessageBatchText', () => {
  it('collects the contiguous same-author batch for a later bare agent ping', () => {
    const messages = [
      { author: 'alice', body: 'older request' },
      { author: 'bob', body: 'interrupting reply' },
      { author: 'alice', body: 'first part' },
      { author: 'alice', body: 'second part' },
    ];

    expect(precedingMessageBatchText(messages, { author: 'alice', body: '@terra' }))
      .toBe('first part\nsecond part');
  });

  it('does not cross an author or agent-identity boundary', () => {
    expect(precedingMessageBatchText(
      [{ author: 'Terra', body: 'agent output', agentId: 'codex', registrationId: 'terra-reg' }],
      { author: 'Terra', body: '@sol', agentId: 'codex', registrationId: 'sol-reg' },
    )).toBe('');
  });
});

describe('buildQuotedReplyPrompt', () => {
  const replyTo = { messageId: 'msg-1', author: 'alice', mention: 'alice', preview: 'clipped questio…' };

  it('quotes the full body of the message the reply points at', () => {
    expect(buildQuotedReplyPrompt(replyTo, [{ id: 'msg-1', body: 'you think forking OMP is "very hard?"' }]))
      .toBe('Replying to alice:\n> you think forking OMP is "very hard?"');
  });

  it('falls back to the stored preview when the message is out of loaded history', () => {
    expect(buildQuotedReplyPrompt(replyTo, [])).toBe('Replying to alice:\n> clipped questio…');
  });

  it('quotes every line so a multi-line ask stays readable', () => {
    expect(buildQuotedReplyPrompt(replyTo, [{ id: 'msg-1', body: 'first\nsecond' }]))
      .toBe('Replying to alice:\n> first\n> second');
  });

  it('returns nothing when there is no quotable text', () => {
    expect(buildQuotedReplyPrompt({ ...replyTo, preview: '' }, [{ id: 'msg-1', body: '   ' }])).toBe('');
  });
});
