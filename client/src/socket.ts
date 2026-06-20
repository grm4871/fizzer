/**
 * @file socket.ts — Socket.IO connection factories
 *
 * Provides two socket factory functions for real-time communication:
 *
 * 1. **Vault socket** (`/vault` namespace) — Delivers note CRUD events
 *    (`noteChanged`, `noteCreated`, `noteDeleted`) and AI directive streaming
 *    (`directive:chunk`, `directive:done`) for a joined vault room.
 *
 * 2. **Runs socket** (`/runs` namespace) — Streams AI agent run events
 *    (status updates, text/tool output, follow-ups) for a joined run room.
 *
 * Both sockets authenticate via the JWT token stored in `localStorage` and
 * prefer WebSocket transport with a polling fallback.
 *
 * @module
 */

import { io, type Socket } from 'socket.io-client';

const API_BASE = import.meta.env.VITE_API_URL || '';

/** Events emitted by the server on the `/vault` namespace. */
type ServerEvents = {
  'vault:noteChanged': (data: { noteId: string; vaultId: string }) => void;
  'vault:noteCreated': (data: { noteId: string; vaultId: string }) => void;
  'vault:noteDeleted': (data: { noteId: string; vaultId: string }) => void;
  'vault:feedNotify': (data: { noteId: string; feedTitle: string; item?: { title?: string } }) => void;
  /** Streamed chunk of an AI directive response. */
  'directive:chunk': (data: { noteId: string; content: string }) => void;
  /** Signals an AI directive has finished processing. */
  'directive:done': (data: { noteId: string; directiveId: string }) => void;
};

/** Events emitted by the client on the `/vault` namespace. */
type ClientEvents = {
  /** Join a vault room to receive its real-time events. */
  joinVault: (vaultId: string) => void;
  /** Leave a vault room to stop receiving events. */
  leaveVault: (vaultId: string) => void;
};

/**
 * Create a new Socket.IO connection to the `/vault` namespace.
 * Callers should `emit('joinVault', vaultId)` after connecting.
 */
export function connectVaultSocket(): Socket<ServerEvents, ClientEvents> {
  return io(`${API_BASE}/vault`, {
    auth: { token: localStorage.getItem('docs_token') },
    transports: ['websocket', 'polling'],
  });
}

/**
 * Create a new Socket.IO connection to the `/runs` namespace.
 * Callers should `emit('joinRun', runId)` after connecting to receive
 * streamed agent events (status, text, user/tool_result).
 */
export function connectRunsSocket(): Socket {
  return io(`${API_BASE}/runs`, {
    auth: { token: localStorage.getItem('docs_token') },
    transports: ['websocket', 'polling'],
  });
}
