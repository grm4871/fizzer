import { describe, expect, it } from 'vitest';
import { formatAgentChatPrompt } from '../chat/agents';

const registration = {
  agentId: 'codex',
  mention: 'terra',
  displayName: 'Terra',
  contextPrompt: '',
};

describe('formatAgentChatPrompt', () => {
  it.each([false, true])('tells agents to continue after progress updates (continuation=%s)', (continuation) => {
    const prompt = formatAgentChatPrompt('dev', registration, 'make the change', 'alice', continuation);
    expect(prompt).toContain('do not stop after an update');
    expect(prompt).toContain('complete');
    expect(prompt).toContain('Send the final response there');
  });

  it('uses injected context instead of requiring a history tool round-trip', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'make the change', 'alice');
    expect(prompt).toContain('recent channel context included below');
    expect(prompt).toContain('only when needed');
    expect(prompt).not.toContain('Run `cascade-chat history');
  });
});
