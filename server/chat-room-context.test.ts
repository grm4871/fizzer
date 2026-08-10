import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatAgentRegistration, ChatMessage, ChatMission } from './chat.js';
import {
  buildAgentRoomContext,
  inferChatRelationship,
  inferNaturalChatLink,
} from './chat-room-context.js';

const registration = (
  id: string,
  displayName: string,
  mention: string,
  orchestrator = false,
): ChatAgentRegistration => ({
  id,
  vaultAgentId: `vault-${id}`,
  ownerUserId: 1,
  agentId: 'codex',
  displayName,
  avatarUrl: '',
  mention,
  model: '',
  reasoningEffort: '',
  priorityServiceTier: false,
  cwd: '',
  contextPrompt: '',
  taggableByAgents: true,
  replyToEveryMessage: orchestrator,
  orchestrator,
  pingableByOthers: false,
  yolo: false,
  conversationId: '',
});

const message = (
  id: string,
  author: string,
  body: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  channelId: 'channel-1',
  author,
  body,
  createdAt: `2026-08-10T00:00:${id.replace(/\D/g, '').padStart(2, '0') || '00'}.000Z`,
  ...extra,
});

test('relationship inference recognizes contextual intent without linking standalone work', () => {
  assert.equal(inferChatRelationship('@terra, what do you think?'), 'review_request');
  assert.equal(inferChatRelationship('@claude push back on this claim'), 'contradiction');
  assert.equal(inferChatRelationship('@sol make the call between these options'), 'decision');
  assert.equal(inferChatRelationship('@terra build on this result'), 'builds_on');
  assert.equal(inferChatRelationship('@terra why did this fail?'), 'question');
  assert.equal(inferChatRelationship('@terra deploy the server'), undefined);
  assert.equal(inferChatRelationship('how is the deployment?'), undefined);
});

test('natural contextual mentions link the latest substantive evidence while assignments stay standalone', () => {
  const sol = registration('reg-sol', 'Sol', 'sol', true);
  const terra = registration('reg-terra', 'Terra', 'terra');
  const source = message('m1', 'Sol', 'The room snapshot should be injected on every run.', {
    registrationId: sol.id,
    agentId: 'codex',
  });
  const interveningHuman = message('m2', 'asdfasdf', 'interesting');
  const review = inferNaturalChatLink(
    message('m3', 'asdfasdf', '@terra, what do you think?'),
    [source, interveningHuman],
    [sol, terra],
  );
  assert.deepEqual(review.replyTo, {
    messageId: source.id,
    author: 'Sol',
    mention: 'sol',
    preview: source.body,
    relationship: 'review_request',
  });

  const standalone = inferNaturalChatLink(
    message('m4', 'asdfasdf', '@terra deploy the server'),
    [source, interveningHuman],
    [sol, terra],
  );
  assert.equal(standalone.replyTo, undefined);

  const proposal = message('m5', 'asdfasdf', 'Use the latest substantive human proposal as the evidence source.');
  const humanReview = inferNaturalChatLink(
    message('m6', 'asdfasdf', '@terra, thoughts on this?'),
    [source, proposal],
    [sol, terra],
  );
  assert.equal(humanReview.replyTo?.messageId, proposal.id);
  assert.equal(humanReview.replyTo?.relationship, 'review_request');
});

test('ordinary replies gain inferred semantics without changing their selected parent', () => {
  const input = message('m2', 'asdfasdf', 'Can you challenge this claim?', {
    replyTo: { messageId: 'm1', author: 'Sol', mention: 'sol', preview: 'Claim' },
  });
  const linked = inferNaturalChatLink(input, [], []);
  assert.equal(linked.replyTo?.messageId, 'm1');
  assert.equal(linked.replyTo?.relationship, 'contradiction');
});

test('room snapshots preserve state and only the interleaved changes since the target spoke', () => {
  const sol = registration('reg-sol', 'Sol', 'sol', true);
  const terra = registration('reg-terra', 'Terra', 'terra');
  const messages = [
    message('m1', 'asdfasdf', 'Make collaboration feel natural.'),
    message('m2', 'Sol', 'I will use a bounded room snapshot.', {
      registrationId: sol.id,
      agentId: 'codex',
      replyTo: {
        messageId: 'm1', author: 'asdfasdf', mention: 'asdfasdf', preview: 'Make collaboration feel natural.',
        relationship: 'decision',
      },
    }),
    message('m3', 'Terra', 'The session still misses interleaved turns.', {
      registrationId: terra.id,
      agentId: 'codex',
      replyTo: {
        messageId: 'm2', author: 'Sol', mention: 'sol', preview: 'bounded room snapshot',
        relationship: 'contradiction',
      },
    }),
    message('m4', 'asdfasdf', '@terra review this result', {
      replyTo: {
        messageId: 'm3', author: 'Terra', mention: 'terra', preview: 'interleaved turns',
        relationship: 'review_request',
      },
    }),
    message('m-running', 'Terra', 'Thinking...', {
      registrationId: terra.id,
      agentId: 'codex',
      status: 'running',
    }),
    message('m5', 'asdfasdf', 'focused trigger that should not be duplicated'),
  ];
  const mission: ChatMission = {
    id: 'mission-1',
    rootMessageId: 'm1',
    title: 'Natural room context',
    objective: 'Make every invocation rejoin current shared state.',
    status: 'active',
    coordinator: sol.id,
    coordinatorMention: sol.mention,
    tasks: [{
      id: 'task-1',
      title: 'Implement bounded snapshot',
      assignee: terra.id,
      assigneeMention: terra.mention,
      assigneeModel: terra.model,
      status: 'running',
      summary: '',
      dependsOn: [],
      waitingFor: [],
      priority: 0,
      reasoningEffort: '',
      anonymous: false,
      queueReason: '',
      attempt: 0,
      updatedAt: '2026-08-10T00:00:00.000Z',
    }],
    summary: '',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };

  const context = buildAgentRoomContext({
    messages,
    registrations: [sol, terra],
    missions: [mission],
    targetRegistrationId: sol.id,
    excludeMessageIds: ['m5'],
  });

  assert.match(context, /Participants: asdfasdf; Sol \(@sol, coordinator\); Terra \(@terra\)/);
  assert.match(context, /Active goals:\n- Natural room context \(active\)/);
  assert.match(context, /Active work:\n- @terra is running \[m-running\]/);
  assert.match(context, /Recent decisions:[\s\S]*I will use a bounded room snapshot/);
  assert.match(context, /Recent disagreements:[\s\S]*session still misses interleaved turns/);
  assert.match(context, /Open questions and reviews:[\s\S]*@terra review this result/);
  assert.match(context, /Since @sol last spoke:[\s\S]*m3[\s\S]*m4/);
  assert.doesNotMatch(context, /focused trigger that should not be duplicated/);
  assert.match(context, /cascade-chat history --around-message-id <id> --include-reply-context/);
  assert.ok(context.length <= 2_800);
});

test('continued sessions append only new room activity plus an exact cursor', () => {
  const sol = registration('reg-sol', 'Sol', 'sol', true);
  const terra = registration('reg-terra', 'Terra', 'terra');
  const messages = [
    message('m1', 'asdfasdf', 'Old context already stored in the provider transcript.'),
    message('m2', 'Terra', 'An old disagreement must not be repeated.', {
      registrationId: terra.id,
      agentId: 'codex',
      replyTo: { messageId: 'm1', author: 'asdfasdf', mention: 'asdfasdf', preview: 'old', relationship: 'contradiction' },
    }),
    message('m3', 'Sol', 'Prior assistant response now cached.', { registrationId: sol.id, agentId: 'codex' }),
    message('m4', 'asdfasdf', 'New room fact since Sol replied.'),
    message('m5', 'Terra', 'New review evidence.', {
      registrationId: terra.id,
      agentId: 'codex',
      replyTo: { messageId: 'm4', author: 'asdfasdf', mention: 'asdfasdf', preview: 'new', relationship: 'review_request' },
    }),
    message('trigger-6', 'asdfasdf', '@sol continue'),
  ];
  const context = buildAgentRoomContext({
    messages,
    registrations: [sol, terra],
    targetRegistrationId: sol.id,
    excludeMessageIds: ['trigger-6'],
    continuation: true,
    sessionTurn: 7,
    cursorMessageId: 'trigger-6',
    maxChars: 1_200,
  });
  const coldContext = buildAgentRoomContext({
    messages,
    registrations: [sol, terra],
    targetRegistrationId: sol.id,
    excludeMessageIds: ['trigger-6'],
    cursorMessageId: 'trigger-6',
    maxChars: 2_800,
  });

  assert.match(context, /^Shared room delta \(append-only cursor message trigger-6 · provider turn 7 · 2 new room messages\):/);
  assert.match(context, /New room fact since Sol replied/);
  assert.match(context, /New review evidence/);
  assert.doesNotMatch(context, /Old context already stored/);
  assert.doesNotMatch(context, /old disagreement/i);
  assert.doesNotMatch(context, /Participants:/);
  assert.match(context, /cascade-chat history --around-message-id trigger-6 --include-reply-context/);
  assert.ok(context.length < coldContext.length, `${context.length} should be smaller than ${coldContext.length}`);
  assert.ok(context.length <= 1_200);
});
