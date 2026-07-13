import { describe, expect, it } from 'vitest';
import { formatAgentChatPrompt, isLightweightChatRequest } from '../chat/agents';

const registration = {
  agentId: 'codex',
  mention: 'terra',
  displayName: 'Terra',
  contextPrompt: '',
};

describe('isLightweightChatRequest', () => {
  it('treats short social / Q&A pings as lightweight', () => {
    expect(isLightweightChatRequest('hey is the deploy up?')).toBe(true);
    expect(isLightweightChatRequest('thanks')).toBe(true);
    expect(isLightweightChatRequest('is the app more efficient now?')).toBe(true);
  });

  it('treats engineering tasks as heavy', () => {
    expect(isLightweightChatRequest('fix the scrolling regression in ChatView.tsx')).toBe(false);
    expect(isLightweightChatRequest('implement dark mode and deploy')).toBe(false);
    expect(isLightweightChatRequest('```ts\nconst x = 1\n```')).toBe(false);
    expect(isLightweightChatRequest('agents pinging other agents broke recently. even when i have the setting on it doesnt happen')).toBe(false);
    expect(isLightweightChatRequest("the toggle doesn't work")).toBe(false);
    expect(isLightweightChatRequest('can you make that happen')).toBe(false);
    expect(isLightweightChatRequest('alright can you make the swap')).toBe(false);
    expect(isLightweightChatRequest('can you test it by pinging hermes')).toBe(false);
    expect(isLightweightChatRequest('wait setting was off. try again')).toBe(false);
    expect(isLightweightChatRequest('hide this view unless i click an mp3 file')).toBe(false);
    expect(isLightweightChatRequest('do this here')).toBe(false);
  });
});

describe('formatAgentChatPrompt', () => {
  it('heavy tasks keep multi-step progress guidance', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'fix the runner and deploy', 'alice', false);
    expect(prompt).toContain('do not stop mid-task');
    expect(prompt).toContain('continue through the work and verification');
    expect(prompt).toContain('cascade-chat send');
    expect(prompt).not.toContain('Run `cascade-chat history');
  });

  it('lightweight pings ask for one short send and no tools', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'hey is deploy green?', 'alice');
    expect(prompt).toContain('one');
    expect(prompt).toContain('no tools');
    expect(prompt).toContain('cascade-chat send');
    expect(prompt).toMatch(/multiuser chat/i);
    expect(prompt).toContain("First resolve the user's intent");
    expect(prompt).toContain('mentioned @handle');
  });

  it('continuation lightweight stays snappy', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'ok cool', 'alice', true);
    expect(prompt).toContain('quick chat reply');
    expect(prompt).toContain('cascade-chat send');
  });
});
