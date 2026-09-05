import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { connectRunsSocket } from '../socket';
import { useChatDispatch } from '../chat/dispatch';
import { chatMessageStore } from '../chat/messageStore';
import { resetSessionTurnHandlesForTests } from '../chat/sessionTurns';
import type { ChatAgentRegistration, ChatMessage } from '../chat/types';

vi.mock('../api', async (original) => ({ ...await original<typeof import('../api')>(), api: vi.fn() }));
vi.mock('../socket', () => ({ connectRunsSocket: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  resetSessionTurnHandlesForTests();
  chatMessageStore.remove('deferred-room');
});

it('a deferred checkpoint leaves no spinner, retry, patch, or session lock and a human can still get a reply', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const registration = {
    id: 'astra', agentId: 'codex', displayName: 'Astra', mention: 'astra',
    conversationId: 'astra-chat', contextPrompt: '', cwd: '',
  } as ChatAgentRegistration;
  const source: ChatMessage = {
    id: 'sys-next-completed-mission', channelId: 'deferred-room', author: 'Astra',
    registrationId: registration.id, body: 'Consider next work', createdAt: '2026-09-05T09:08:00Z',
  };
  const ref = <T,>(current: T) => ({ current });
  const options: Parameters<typeof useChatDispatch>[0] = {
    activeVaultIdRef: ref('vault'), notesRef: ref([]),
    chatStateRef: ref({ agentModelsByAgent: {}, registeredAgentsByChannel: {} }),
    setChatState: vi.fn(), setNotice: vi.fn(), user: { username: 'owner' },
    handleRegisterChatAgent: vi.fn(), runSocketsRef: ref(new Map()),
    streamingChatMessageIdsRef: ref(new Set()), serverOwnedChatMessageIdsRef: ref(new Set()),
    agentContextWatermarkRef: ref(new Map()), agentSessionTailRef: ref(new Map()),
    activeAgentSessionRunRef: ref(new Map()), interruptedAgentSessionRunRef: ref(new Map()),
    pendingAgentSteerRef: ref(new Set()), pendingChatPatchRef: ref(new Map()),
    chatPatchTimerRef: ref(new Map()), startingChatDispatchesRef: ref(new Set()),
  };
  let actions!: ReturnType<typeof useChatDispatch>;
  function Harness() { actions = useChatDispatch(options); return null; }
  renderToStaticMarkup(createElement(Harness));
  chatMessageStore.set(source.channelId, []);
  const deliver = (message: ChatMessage, id: string) => actions.dispatchChatAgentIntents(
    source.channelId, message, [registration],
    [{ id, messageId: message.id, channelId: source.channelId, registration, message, runId: null, createdAt: message.createdAt }], [],
  );

  vi.mocked(api).mockRejectedValue(new ApiError('Waiting for current work', 409, { code: 'dispatch_deferred' }));
  const deferred = deliver(source, 'checkpoint');
  await vi.runAllTimersAsync();
  await deferred;
  expect(api).toHaveBeenCalledTimes(1);
  expect(connectRunsSocket).not.toHaveBeenCalled();
  expect(chatMessageStore.getChannel(source.channelId)).toEqual([]);
  expect(options.agentSessionTailRef.current.size).toBe(0);
  expect(options.pendingChatPatchRef.current.size).toBe(0);
  expect(options.startingChatDispatchesRef.current.size).toBe(0);

  vi.mocked(api).mockImplementation(async (path) => {
    if (path.endsWith('/events')) return { events: [{ seq: 1, type: 'status', payload_json: JSON.stringify({ status: 'completed', summary: 'Here is your answer.' }) }] };
    if (path.endsWith('/runs')) return { run: { id: 1, status: 'running', conversation_id: 'astra-chat' } };
    throw new Error(`Unexpected request: ${path}`);
  });
  vi.mocked(connectRunsSocket).mockReturnValue({ on: vi.fn(), off: vi.fn(), emit: vi.fn(), disconnect: vi.fn() } as unknown as ReturnType<typeof connectRunsSocket>);
  await deliver({ ...source, id: 'human', author: 'owner', registrationId: undefined, body: '@astra answer me' }, 'human');
  await vi.runAllTimersAsync();
  const [reply] = chatMessageStore.getChannel(source.channelId);
  expect(reply.body).toBe('Here is your answer.');
  expect(reply.status).toBeUndefined();
  expect(options.agentSessionTailRef.current.size).toBe(0);
});
