/**
 * @file socket.ts — Socket.IO connection factories
 *
 * Provides two socket factory functions for real-time communication:
 *
 * 1. **Vault socket** (`/vault` namespace) — note CRUD, feeds, and chat
 *    message/member/presence events for a joined vault room.
 *
 * 2. **Runs socket** (`/runs` namespace) — streams AI agent run events
 *    (status updates, text/tool output, follow-ups) for a joined run room.
 *
 * Both sockets authenticate via the JWT token stored in `localStorage` and
 * prefer WebSocket transport with a polling fallback.
 *
 * @module
 */

import { io, type Socket } from 'socket.io-client';
import type { ChatMessage, ChatAgentRegistration } from './components/ChatView';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Events emitted by the server on the `/vault` namespace. */
type ServerEvents = {
  /** A relevant terminal message, note mutation, deletion, or read-state change occurred. */
  'community:changed': (data: Record<string, never>) => void;
  'vault:noteChanged': (data: { noteId: string; vaultId: string; title?: string }) => void;
  'vault:noteCreated': (data: { noteId: string; vaultId: string; title?: string }) => void;
  'vault:noteDeleted': (data: { noteId: string; vaultId: string; title?: string }) => void;
  'vault:feedNotify': (data: { noteId: string; feedTitle: string; item?: { title?: string } }) => void;
  /** A new chat message was persisted for a channel in this vault. */
  'vault:chatMessageCreated': (data: { vaultId: string; channelId: string; message: ChatMessagePayload }) => void;
  /** An existing chat message was updated (merge, agent stream, etc.). */
  'vault:chatMessageUpdated': (data: { vaultId: string; channelId: string; message: ChatMessagePayload }) => void;
  /** A chat message was deleted for everyone with access to the channel. */
  'vault:chatMessageDeleted': (data: { vaultId: string; channelId: string; messageId: string }) => void;
  /** A chat channel agent member was registered or updated. */
  'vault:chatAgentMemberUpserted': (data: { vaultId: string; channelId: string; registration: ChatAgentMemberPayload }) => void;
  /** A chat channel agent member was removed. */
  'vault:chatAgentMemberRemoved': (data: { vaultId: string; channelId: string; registrationId: string }) => void;
  /** Online participants for a chat channel (who has Cascade open). */
  'vault:chatPresence': (data: { vaultId: string; channelId: string; participants: string[]; online: string[] }) => void;
};

/**
 * Wire shapes for vault socket payloads. These mirror the canonical chat types
 * exactly, so we alias them rather than redefine (a redefinition drifted before:
 * `blocks[].type` was widened to `string`, which then failed to assign to the
 * narrow `ChatBlock` union in the event handlers).
 */
export type ChatAgentMemberPayload = ChatAgentRegistration;
export type ChatMessagePayload = ChatMessage;

/** Events emitted by the client on the `/vault` namespace. */
type ClientEvents = {
  /** Join a vault room to receive its real-time events. */
  joinVault: (vaultId: string) => void;
  /** Leave a vault room to stop receiving events. */
  leaveVault: (vaultId: string) => void;
  /** Join a chat channel presence room (user is viewing this channel). */
  joinChatChannel: (channelId: string) => void;
  /** Leave a chat channel presence room. */
  leaveChatChannel: (channelId: string) => void;
};

/**
 * Create a new Socket.IO connection to the `/vault` namespace.
 * Callers should `emit('joinVault', vaultId)` on every `connect` event
 * (including reconnects) so room membership is restored after backgrounding.
 */
export function connectVaultSocket(): Socket<ServerEvents, ClientEvents> {
  return io(`${API_BASE}/vault`, {
    auth: { token: localStorage.getItem('docs_token') },
    // Polling first: some networks/middleboxes break the websocket upgrade
    // while HTTPS long-poll still works. engine.io upgrades to WS when able.
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
  });
}

/**
 * Create a new Socket.IO connection to the `/runs` namespace.
 * Callers should `emit('joinRun', runId)` on every `connect` event
 * (including reconnects) to receive streamed agent events.
 */
export function connectRunsSocket(): Socket {
  return io(`${API_BASE}/runs`, {
    auth: { token: localStorage.getItem('docs_token') },
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 2000,
  });
}
