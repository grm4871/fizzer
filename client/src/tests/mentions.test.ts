import { describe, expect, it } from 'vitest';
import { addressedMentions, buildQuotedReplyPrompt, hasRegistrationForMention, isCompactCommand, precedingMessageBatch, precedingMessageBatchText, replyQuoteTargetsAgent, resolveAgentMessageRegistration } from '../chat/mentions';
import { prepareReplyForSend } from '../components/ChatComposer';

const registrations = [
  { id: 'terra-reg', agentId: 'codex', displayName: 'Terra', mention: 'terra', taggableByAgents: true },
  { id: 'sol-reg', agentId: 'codex', displayName: 'Sol', mention: 'sol', taggableByAgents: true },
];

describe('compact command', () => {
  it('recognizes bare and explicitly targeted compact commands', () => {
    expect(isCompactCommand('/compact', registrations)).toBe(true);
    expect(isCompactCommand('/compact @terra @sol', registrations)).toBe(true);
    expect(isCompactCommand('@terra /COMPACT', registrations)).toBe(true);
  });

  it('does not swallow ordinary messages that merely mention compacting', () => {
    expect(isCompactCommand('/compact now', registrations)).toBe(false);
    expect(isCompactCommand('please /compact @terra', registrations)).toBe(false);
  });
});

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

describe('replyQuoteTargetsAgent', () => {
  const quotedMessages = [
    { id: 'msg-human', agentId: undefined, registrationId: undefined },
    { id: 'msg-agent', agentId: 'codex', registrationId: 'sol-reg' },
    { id: 'msg-legacy-agent', agentId: 'codex' },
  ];

  it('does not treat a reply to a person as a failed agent call', () => {
    expect(replyQuoteTargetsAgent(
      { messageId: 'msg-human', mention: 'asdfasdf' },
      quotedMessages,
    )).toBe(false);
  });

  it('still reports agent-authored quotes, including legacy helper messages', () => {
    expect(replyQuoteTargetsAgent({ messageId: 'msg-agent', mention: 'sol' }, quotedMessages)).toBe(true);
    expect(replyQuoteTargetsAgent({ messageId: 'msg-legacy-agent', mention: 'sol' }, quotedMessages)).toBe(true);
  });

  it('defers to the server when the quote is outside the loaded page', () => {
    expect(replyQuoteTargetsAgent({ messageId: 'msg-gone', mention: 'sol' }, quotedMessages)).toBe(false);
    expect(replyQuoteTargetsAgent({ messageId: 'msg-gone', mention: '' }, quotedMessages)).toBe(false);
    expect(replyQuoteTargetsAgent(undefined, quotedMessages)).toBe(false);
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

  it('bounds a long mention-only batch while preserving the newest request text', () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      author: 'alice',
      body: `part-${index}-${'x'.repeat(60)}`,
    }));
    const prompt = precedingMessageBatchText(messages, { author: 'alice', body: '@terra' }, 240, 4);
    expect(prompt.length).toBeLessThanOrEqual(240);
    expect(prompt).toContain('part-99');
    expect(prompt).not.toContain('part-0-');
    expect(prompt.startsWith('…')).toBe(true);
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

  it('carries the typed relationship into the agent prompt', () => {
    expect(buildQuotedReplyPrompt({ ...replyTo, relationship: 'review_request' }, []))
      .toBe('Review requested for alice:\n> clipped questio…');
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
    const prompt = buildQuotedReplyPrompt(replyTo, messages, 1_200, 2);
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

  it('keeps only the newest bounded messages', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      id: `m${index}`,
      author: 'asdfasdf',
      body: String(index),
    }));
    const batch = precedingMessageBatch(messages, { author: 'asdfasdf', body: '@sol' }, 3);
    expect(batch.map((message) => message.id)).toEqual(['m9', 'm10', 'm11']);
  });
});

describe('reply ancestors addressed to another agent', () => {
  // The bug: one prompt was built for every recipient, so a chain carrying
  // "@claude do X" reached @sol under a header that read like a live ask, and
  // @sol answered it.
  const chain = [
    { id: 'm1', body: '@claude these QUESTION headers are obnoxious. can you remove?' },
    { id: 'm2', body: '@sol my active agents list seems shared across vaults', replyTo: { messageId: 'm1', author: 'asdfasdf', mention: 'asdfasdf', preview: '' } },
  ];
  const replyTo = { messageId: 'm2', author: 'asdfasdf', mention: 'asdfasdf', preview: '' };

  it('flags an ancestor aimed at someone else as context only', () => {
    const prompt = buildQuotedReplyPrompt(replyTo, chain, 1_200, 4, 'sol');
    expect(prompt).toContain('addressed to @claude, not you — context only');
  });

  it('judges each ancestor independently, leaving the recipient own ask unflagged', () => {
    const prompt = buildQuotedReplyPrompt(replyTo, chain, 1_200, 4, 'claude');
    const claudeLine = prompt.split('\n').find((line) => line.startsWith('…which was itself replying'));
    // @claude's own ask carries no aside...
    expect(claudeLine).toBe('…which was itself replying to asdfasdf:');
    // ...while the @sol hop in the same chain still does.
    expect(prompt).toContain('addressed to @sol, not you — context only');
  });

  it('says nothing when the recipient is unknown, preserving old behaviour', () => {
    expect(buildQuotedReplyPrompt(replyTo, chain)).not.toContain('context only');
  });

  it('reads the handles a message is addressed to', () => {
    expect(addressedMentions('@sol and @claude2 please look')).toEqual(['sol', 'claude2']);
    expect(addressedMentions('no mentions here')).toEqual([]);
    expect(addressedMentions('email a@b.com is not a mention')).toEqual([]);
  });
});
