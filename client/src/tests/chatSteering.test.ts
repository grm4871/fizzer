import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ChatView,
  dataUrlsToRunImages,
  getRunningMessageState,
  getSteeringPromptLabels,
  shouldRenderRunPanel,
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

describe('chat run panel lifecycle', () => {
  it('hides a successful completed harness without discarding its trace', () => {
    const completed = message('1', {
      author: 'Sol',
      agentId: 'codex',
      runId: 42,
      body: 'A complete final answer.',
      blocks: [{ type: 'text', text: 'A complete final answer.' }],
      harnessLog: '# complete run trace\n',
      hasHarness: true,
    });

    expect(shouldRenderRunPanel(completed, false, true)).toBe(false);
    expect(shouldRenderRunPanel(completed, true, true)).toBe(true);
    expect(completed.harnessLog).toBe('# complete run trace\n');
    expect(completed.blocks).toEqual([{ type: 'text', text: 'A complete final answer.' }]);
  });

  it('keeps live and failed run diagnostics visible', () => {
    expect(shouldRenderRunPanel(message('1', { status: 'running' }), false, true)).toBe(true);
    expect(shouldRenderRunPanel(message('2', { status: 'running' }), false, false)).toBe(false);
    expect(shouldRenderRunPanel(message('3', { status: 'failed' }), false, true)).toBe(true);
    expect(shouldRenderRunPanel(message('4', { status: 'canceled' }), false, true)).toBe(true);
  });

  it('renders a successful final reply without an automatic Harness view', () => {
    const markup = renderToStaticMarkup(createElement(ChatView, {
      channelId: 'channel',
      channelName: 'cascade-dev',
      messages: [message('1', {
        author: 'Sol',
        agentId: 'codex',
        runId: 42,
        body: 'A complete final answer with nuance.',
        harnessLog: '# complete run trace\n',
        hasHarness: true,
      })],
      currentUser: 'asdfasdf',
      presence: { participants: [], online: [] },
      availableAgents: [],
      registeredAgents: [],
      runningAgents: [],
      onRegisterAgent: () => {},
      onRemoveAgent: () => {},
      onCreateInviteLink: async () => '',
      onInviteUser: async () => {},
      onSendMessage: () => {},
      onCancelRun: () => {},
    }));

    expect(markup).toContain('A complete final answer with nuance.');
    expect(markup).not.toContain('cascade-run-panel');
    expect(markup).not.toContain('Harness');
  });
});

describe('dataUrlsToRunImages', () => {
  it('decodes stored data URLs into run image parts', () => {
    expect(dataUrlsToRunImages(['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'])).toEqual([
      { media_type: 'image/png', data: 'AAAA' },
      { media_type: 'image/jpeg', data: 'BBBB' },
    ]);
  });

  it('skips non-image and non-data sources', () => {
    expect(dataUrlsToRunImages(['https://example.com/a.png', 'data:text/plain;base64,AAAA'])).toEqual([]);
    expect(dataUrlsToRunImages(undefined)).toEqual([]);
  });
});
