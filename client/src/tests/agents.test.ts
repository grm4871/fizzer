import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  agentsAfterLoadFailure,
  CHAT_AGENT_MODEL_PRESETS,
  CHAT_REPLY_BREVITY,
  chatAgentConversation,
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
    expect(agentsAfterLoadFailure(cached)).toBe(cached);
  });

  it('does not resurrect removed registrations from legacy local state', () => {
    expect(agentsAfterLoadFailure(undefined)).toEqual([]);
  });
});

describe('agent editor layout', () => {
  it('keeps save actions in document flow instead of overlaying scrolled fields', () => {
    const styles = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    const actions = styles.match(/\.chat-agent-editor \.chat-agent-menu-actions \{([^}]+)\}/)?.[1] || '';
    expect(actions).not.toMatch(/position:\s*sticky/);
    expect(actions).not.toMatch(/backdrop-filter/);
  });
});

describe('agent conversation isolation', () => {
  it('keeps normal channel turns sticky', () => {
    expect(chatAgentConversation('reg-terra', 'channel-session', undefined)).toEqual({
      conversationId: 'channel-session',
      watermarkKey: 'reg-terra:channel-session',
      adoptConversation: false,
    });
  });

  it('gives each mission task a stable isolated conversation', () => {
    const first = chatAgentConversation('reg-terra', 'multi-day-channel-session', 'task-1');
    const retry = chatAgentConversation('reg-terra', 'multi-day-channel-session', 'task-1');
    const next = chatAgentConversation('reg-terra', 'multi-day-channel-session', 'task-2');
    expect(first).toEqual(retry);
    expect(first.conversationId).toBe('mission:task-1');
    expect(next.conversationId).toBe('mission:task-2');
    expect(next.watermarkKey).not.toBe(first.watermarkKey);
    expect(first.adoptConversation).toBe(false);
  });

  it('isolates simultaneous calls to the same agent across channels and vaults', () => {
    const first = chatAgentConversation('vault-a:channel-one:sol', 'session-a', undefined);
    const second = chatAgentConversation('vault-b:channel-two:sol', 'session-b', undefined);
    expect(first.watermarkKey).not.toBe(second.watermarkKey);
    expect(first.conversationId).toBe('session-a');
    expect(second.conversationId).toBe('session-b');
  });
});

describe('selective Cascade context', () => {
  it('requests history only for unresolved references', () => {
    expect(needsRecentChatContext('continue where you left off')).toBe(true);
    expect(needsRecentChatContext('also fix that thing')).toBe(true);
    expect(needsRecentChatContext('bump')).toBe(true);
    expect(needsRecentChatContext('what about now?')).toBe(true);
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
    expect(prompt).toContain(CHAT_REPLY_BREVITY);
    expect(prompt).toContain('cascade-scratchpad');
    expect(prompt).toMatch(/only for a durable root cause/i);
    expect(prompt).not.toMatch(/final answer (is|there)/i);
  });

  it('short pings use the same full path', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'hey is deploy green?', 'alice');
    expect(prompt).toContain('verification before replying');
    expect(prompt).toContain(CHAT_REPLY_BREVITY);
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
    expect(prompt).toContain('Handle clear requests directly');
    expect(prompt).toMatch(/clarification card/i);
    expect(prompt).toContain('cascade-chat mission start');
    expect(prompt).toContain('cascade-chat mission delegate');
    expect(prompt).toContain('--after');
    expect(prompt).toContain('--anonymous');
    expect(prompt).toContain('parallel clones');
    expect(prompt).toContain('user responsive while workers run');
    expect(prompt).toContain('cascade-chat mission finish');
    expect(prompt).toContain('Keep mission summaries short');
    expect(prompt).toContain('implementation authority');
    expect(prompt).toContain('clarification');
  });

  it('continuations keep normal completion guidance', () => {
    const prompt = formatAgentChatPrompt('dev', registration, 'ok cool', 'alice', true);
    expect(prompt).toContain('Finish the request with judgment');
    expect(prompt).toContain(CHAT_REPLY_BREVITY);
    expect(prompt).not.toContain('cascade-chat send');
  });

  it('does not repay the full coordinator contract on a resumed session', () => {
    const coordinator = { ...registration, orchestrator: true };
    const fresh = formatAgentChatPrompt('dev', coordinator, 'take care of the release', 'alice', false);
    const continued = formatAgentChatPrompt('dev', coordinator, 'and publish android', 'alice', true);
    expect(continued).toMatch(/clarify only a user-requested mission\/kanban|material ambiguity/i);
    expect(continued).toMatch(/Delegate when another session adds value/i);
    expect(continued).toContain('Keep replies short');
    expect(continued).not.toContain('cascade-chat mission delegate');
    // Compact ship/attachment reminders stay on continuation; the long mission contract does not.
    expect(continued).toMatch(/green Deploy|Ship only after/i);
    expect(fresh).toMatch(/wait for green Deploy/i);
    expect(fresh).toMatch(/clarification/i);
    expect(fresh).toMatch(/cascade-chat attachment/i);
    expect(fresh.length - continued.length).toBeGreaterThan(400);
    expect(fresh.length - 'take care of the release'.length).toBeLessThan(1_600);
  });

  it('leaves Akron scratchpad guidance to the native harness tool', () => {
    const akron = { ...registration, agentId: 'akron-grok', mention: 'akron', displayName: 'Akron' };
    const fresh = formatAgentChatPrompt('dev', akron, 'fix the runner and deploy', 'alice', false);
    const continued = formatAgentChatPrompt('dev', akron, 'fix the runner and deploy', 'alice', true);

    expect(fresh).toContain('harness `scratchpad`');
    for (const prompt of [fresh, continued]) {
      expect(prompt).toContain(CHAT_REPLY_BREVITY);
      expect(prompt).not.toContain('cascade-scratchpad');
      expect(prompt).not.toContain('cascade-note memory');
    }
  });

  it.each([
    ['hermes', 'hermes', 'Hermes'],
    ['omp', 'omp', 'OMP'],
    ['pi', 'pi', 'Pi'],
  ])('keeps %s close to its direct CLI prompt', (agentId, mention, displayName) => {
    const nativeCli = { ...registration, agentId, mention, displayName };
    const request = 'fix the runner and deploy';
    const prompt = formatAgentChatPrompt('dev', nativeCli, request, 'alice', false);

    expect(prompt).toContain(request);
    expect(prompt).toContain(CHAT_REPLY_BREVITY);
    expect(prompt).toContain('Keep progress in the run trace');
    expect(prompt).not.toContain('cascade-scratchpad');
    // Compact path: short channel header + shared brevity rule only.
    expect(prompt.length - request.length).toBeLessThan(260);
  });
});
