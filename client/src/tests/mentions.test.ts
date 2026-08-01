import { describe, expect, it } from 'vitest';
import { buildQuotedReplyPrompt, hasRegistrationForMention, precedingMessageBatch, precedingMessageBatchText, resolveAgentMessageRegistration } from '../chat/mentions';
import { prepareReplyForSend } from '../components/ChatView';

const registrations = [
  { id: 'terra-reg', agentId: 'codex', displayName: 'Terra', mention: 'terra', taggableByAgents: true },
  { id: 'sol-reg', agentId: 'codex', displayName: 'Sol', mention: 'sol', taggableByAgents: true },
];

describe('reply agent notification', () => {
  const reply = { messageId: 'msg-agent', author: 'Sol', mention: 'sol', preview: 'Original answer' };

  it('keeps the implicit mention on by default', () => {
    expect(prepareReplyForSend(reply, true)).toEqual(reply);
  });

  it('removes routing mention without removing reply context', () => {
    expect(prepareReplyForSend(reply, false)).toEqual({ ...reply, mention: '' });
  });

  it('detects when an author-derived reply mention needs roster hydration', () => {
    expect(hasRegistrationForMention('ocsol', [])).toBe(false);
    expect(hasRegistrationForMention('@sol', registrations)).toBe(true);
  });
});

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

  it('walks the reply chain so the failure being pointed at is not lost', () => {
    const messages = [
      { id: 'msg-0', author: 'alice', body: 'the reply banner hides the last message' },
      {
        id: 'msg-1',
        author: 'sol',
        body: 'fixed and shipped as b0a5c05',
        replyTo: { messageId: 'msg-0', author: 'alice', mention: 'alice', preview: 'the reply banner…' },
      },
    ];
    expect(buildQuotedReplyPrompt({ ...replyTo, author: 'sol', mention: 'sol' }, messages)).toBe(
      'Replying to sol:\n> fixed and shipped as b0a5c05\n\n'
      + '…which was itself replying to alice:\n> the reply banner hides the last message',
    );
  });

  it('stops walking at the ancestor limit', () => {
    const link = (id: string, parent: string) => ({
      id,
      body: id,
      replyTo: { messageId: parent, author: parent, mention: parent, preview: parent },
    });
    const messages = [
      { id: 'msg-4', body: 'msg-4' },
      link('msg-3', 'msg-4'),
      link('msg-2', 'msg-3'),
      link('msg-1', 'msg-2'),
    ];
    const prompt = buildQuotedReplyPrompt(replyTo, messages);
    expect(prompt.match(/replying to/gi)).toHaveLength(3);
    expect(prompt).not.toContain('msg-4');
  });

  it('returns nothing when there is no quotable text', () => {
    expect(buildQuotedReplyPrompt({ ...replyTo, preview: '' }, [{ id: 'msg-1', body: '   ' }])).toBe('');
  });
});

describe('precedingMessageBatch', () => {
  it('returns only the contiguous same-author run, so an older screenshot is not pulled in', () => {
    const messages = [
      { id: 'm1', author: 'asdfasdf', body: 'old screenshot', images: ['data:image/png;base64,OLD'] },
      { id: 'm2', author: 'Claude', body: 'answer', agentId: 'claude', registrationId: 'reg' },
      { id: 'm3', author: 'asdfasdf', body: 'this also seems like a failure', images: ['data:image/png;base64,NEW'] },
    ];
    const batch = precedingMessageBatch(messages, { author: 'asdfasdf', body: '@claude diagnose and fix' });
    expect(batch.map((message) => message.id)).toEqual(['m3']);
  });
});
