import { describe, expect, it } from 'vitest';
import {
  getRunningMessageState,
  getSteeringPromptLabels,
  shouldDetachStickyForTouch,
  shouldDetachStickyForWheel,
  type ChatAgentRegistration,
  type ChatMessage,
} from '../components/ChatView';

const agent: ChatAgentRegistration = {
  id: 'reg-sol',
  vaultAgentId: 'agent-sol',
  agentId: 'codex',
  displayName: 'Sol',
  avatarUrl: '',
  mention: 'sol',
  model: 'gpt-test',
  cwd: '',
  contextPrompt: '',
  taggableByAgents: true,
  replyToEveryMessage: false,
  pingableByOthers: true,
  yolo: false,
  conversationId: 'conversation-1',
};

function message(id: string, partial: Partial<ChatMessage>): ChatMessage {
  return { id, channelId: 'channel', author: 'asdfasdf', body: '', createdAt: id, ...partial };
}

describe('chat sticky bottom intent', () => {
  it('only detaches for upward history scrolling', () => {
    expect(shouldDetachStickyForWheel(-1)).toBe(true);
    expect(shouldDetachStickyForWheel(12)).toBe(false);
    expect(shouldDetachStickyForTouch(100, 112)).toBe(true);
    expect(shouldDetachStickyForTouch(100, 88)).toBe(false);
  });
});

describe('agent steering presentation', () => {
  it('marks the newest active response and its triggering follow-up', () => {
    const messages = [
      message('1', { author: 'Sol', agentId: 'codex', registrationId: agent.id, status: 'running', body: 'Thinking…' }),
      message('2', { body: '@sol also check mobile' }),
      message('3', { author: 'Sol', agentId: 'codex', registrationId: agent.id, status: 'running', body: 'Thinking…' }),
    ];
    const state = getRunningMessageState(messages);
    expect(state.get(agent.id)).toEqual({ latestId: '3', count: 2 });
    expect(getSteeringPromptLabels(messages, [agent], state).get('2')).toBe('sol');
  });

  it('does not call the first prompt steering', () => {
    const messages = [
      message('1', { body: '@sol start' }),
      message('2', { author: 'Sol', agentId: 'codex', registrationId: agent.id, status: 'running' }),
    ];
    expect(getSteeringPromptLabels(messages, [agent]).size).toBe(0);
  });
});
