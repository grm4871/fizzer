import { describe, expect, it } from 'vitest';
import { precedingMessageBatchText, resolveAgentMessageRegistration } from '../chat/mentions';

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
