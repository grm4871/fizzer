import { describe, expect, it } from 'vitest';
import { CHAT_AGENT_MODEL_PRESETS, formatAgentChatPrompt, isLightweightChatRequest } from '../chat/agents';

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

describe('OMP model presets', () => {
  it('uses provider-qualified ids for the major authenticated catalogs', () => {
    const ids = CHAT_AGENT_MODEL_PRESETS.omp.map(({ id }) => id);
    expect(ids).toContain('openai-codex/gpt-5.6-sol');
    expect(ids).toContain('anthropic/claude-sonnet-5');
    expect(ids).toContain('google-antigravity/gemini-3.5-flash');
    expect(ids).toEqual(expect.arrayContaining([
      'xai-oauth/grok-build',
      'xai-oauth/grok-build-0.1',
      'xai-oauth/grok-4.3',
      'xai-oauth/grok-4.5',
      'xai-oauth/grok-4.20-multi-agent-0309',
      'xai-oauth/grok-4.20-0309-reasoning',
      'xai-oauth/grok-4.20-0309-non-reasoning',
      'xai-oauth/grok-composer-2.5-fast',
    ]));
    expect(ids.every((id) => id.includes('/'))).toBe(true);
  });
});

describe('formatAgentChatPrompt', () => {
  it('heavy tasks keep multi-step progress guidance', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'fix the runner and deploy', 'alice', false);
    expect(prompt).toContain('do not stop mid-task');
    expect(prompt).toContain('continue through the work and verification');
    expect(prompt).toContain('cascade-chat send');
    expect(prompt).not.toContain('Run `cascade-chat history');
    expect(prompt).toContain('run `cascade-chat send --message "$MESSAGE"`');
    expect(prompt).toContain('cascade-scratchpad');
    expect(prompt).toContain('recall');
    expect(prompt).toMatch(/jot liberally mid-task/i);
    expect(prompt).toMatch(/do not save it for the end/i);
    expect(prompt).toMatch(/cascade-scratchpad open/i);
    expect(prompt).toMatch(/close <id>/i);
    expect(prompt).toMatch(/never ask the user about threads/i);
  });

  it('lightweight pings ask for one short send and no tools', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'hey is deploy green?', 'alice');
    expect(prompt).toContain('one');
    expect(prompt).toContain('no tools');
    expect(prompt).toContain('cascade-chat send');
    expect(prompt).toMatch(/multiuser chat/i);
    expect(prompt).toContain("First resolve the user's intent");
    expect(prompt).toContain('mentioned @handle');
    expect(prompt).toContain('run `cascade-chat send --message "$MESSAGE"`');
  });

  it('continuation lightweight stays snappy', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'ok cool', 'alice', true);
    expect(prompt).toContain('quick chat reply');
    expect(prompt).toContain('cascade-chat send');
    expect(prompt).toContain('run `cascade-chat send --message "$MESSAGE"`');
  });

  it('leaves Akron scratchpad guidance to the native harness tool', () => {
    const akron = { ...registration, agentId: 'akron-grok', mention: 'akron', displayName: 'Akron' };
    const fresh = formatAgentChatPrompt('dev', akron, 'fix the runner and deploy', 'alice', false);
    const continued = formatAgentChatPrompt('dev', akron, 'fix the runner and deploy', 'alice', true);

    for (const prompt of [fresh, continued]) {
      expect(prompt).toContain('harness-provided `scratchpad` tool');
      expect(prompt).not.toContain('cascade-scratchpad');
      expect(prompt).not.toContain('cascade-note memory');
    }
  });
});
