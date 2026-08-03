import { describe, expect, it } from 'vitest';
import {
  agentsAfterLoadFailure,
  CHAT_AGENT_MODEL_PRESETS,
  formatAgentChatPrompt,
  needsCascadeWorkspaceContext,
  needsRecentChatContext,
} from '../chat/agents';

const registration = {
  agentId: 'codex',
  mention: 'terra',
  displayName: 'Terra',
  contextPrompt: '',
};

describe('agent member hydration', () => {
  it('preserves loaded registrations when a reconnect fetch fails', () => {
    const cached = [{ id: 'ocsol', mention: 'ocsol' }];
    expect(agentsAfterLoadFailure(cached, [])).toBe(cached);
  });

  it('falls back to legacy registrations only when no server state was loaded', () => {
    const legacy = [{ id: 'legacy', mention: 'legacy' }];
    expect(agentsAfterLoadFailure(undefined, legacy)).toBe(legacy);
  });
});

describe('selective Cascade context', () => {
  it('requests history only for unresolved references', () => {
    expect(needsRecentChatContext('continue where you left off')).toBe(true);
    expect(needsRecentChatContext('also fix that thing')).toBe(true);
    expect(needsRecentChatContext('implement drag ordering in Sidebar.tsx')).toBe(false);
    expect(needsRecentChatContext('Replying to alice:\n> fix the tab order')).toBe(false);
  });

  it('requests live workspace context only for live-vault operations', () => {
    expect(needsCascadeWorkspaceContext('create a live note for the release')).toBe(true);
    expect(needsCascadeWorkspaceContext('make a kanban inside Cascade')).toBe(true);
    expect(needsCascadeWorkspaceContext('make a kanban for Cascade')).toBe(true);
    expect(needsCascadeWorkspaceContext('fix Cascade sidebar ordering in App.tsx')).toBe(false);
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
  it('all requests keep full task and progress guidance', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'fix the runner and deploy', 'alice', false);
    expect(prompt).toContain('verification before replying');
    expect(prompt).toContain('Keep progress in the run trace');
    expect(prompt).not.toContain('cascade-chat send');
    expect(prompt).toContain('Reply normally with the final answer');
    expect(prompt).toContain('cascade-scratchpad');
    expect(prompt).toMatch(/only for a durable root cause/i);
    expect(prompt).not.toMatch(/final answer (is|there)/i);
  });

  it('short pings use the same full path', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'hey is deploy green?', 'alice');
    expect(prompt).toContain('verification before replying');
    expect(prompt).toContain('cascade-scratchpad');
    expect(prompt).not.toContain('no tools');
  });

  it('gives a coordinator an explicit zero-hop/direct-or-mission contract', () => {
    const prompt = formatAgentChatPrompt(
      'dev',
      { ...registration, orchestrator: true },
      'take care of the release',
      'alice',
      false,
    );
    expect(prompt).toContain('Handle simple requests directly with no delegation hop');
    expect(prompt).toContain('cascade-chat mission start');
    expect(prompt).toContain('cascade-chat mission delegate');
    expect(prompt).toContain('cascade-chat mission finish');
  });

  it('continuations keep normal completion guidance', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'ok cool', 'alice', true);
    expect(prompt).toContain('Finish the request with judgment');
    expect(prompt).not.toContain('cascade-chat send');
  });

  it('leaves Akron scratchpad guidance to the native harness tool', () => {
    const akron = { ...registration, agentId: 'akron-grok', mention: 'akron', displayName: 'Akron' };
    const fresh = formatAgentChatPrompt('dev', akron, 'fix the runner and deploy', 'alice', false);
    const continued = formatAgentChatPrompt('dev', akron, 'fix the runner and deploy', 'alice', true);

    expect(fresh).toContain('harness `scratchpad`');
    for (const prompt of [fresh, continued]) {
      expect(prompt).not.toContain('cascade-scratchpad');
      expect(prompt).not.toContain('cascade-note memory');
    }
  });

  it.each([
    ['hermes', 'hermes', 'Hermes'],
    ['omp', 'omp', 'OMP'],
  ])('keeps %s close to its direct CLI prompt', (agentId, mention, displayName) => {
    const nativeCli = { ...registration, agentId, mention, displayName };
    const request = 'fix the runner and deploy';
    const prompt = formatAgentChatPrompt('dev', nativeCli, request, 'alice', false);

    expect(prompt).toContain(request);
    expect(prompt).toContain('Keep progress in the run trace');
    expect(prompt).not.toContain('cascade-scratchpad');
    expect(prompt.length - request.length).toBeLessThan(180);
  });
});
