import { io, type Socket } from 'socket.io-client';
import type { RunEvent } from './api';

const API_BASE = import.meta.env.VITE_API_URL || '';

export function connectRunSocket(): Socket<ServerEvents, ClientEvents> {
  return io(`${API_BASE}/runs`, {
    auth: { token: localStorage.getItem('docs_token') },
    transports: ['websocket', 'polling'],
  });
}

type ServerEvents = {
  event: (event: RunEvent) => void;
  status: (message: { runId: number; status?: string }) => void;
  'workspace:changed': (message: { workspaceId: number }) => void;
};

type ClientEvents = {
  join: (runId: number) => void;
  leave: (runId: number) => void;
  joinWorkspace: (workspaceId: number) => void;
  leaveWorkspace: (workspaceId: number) => void;
};
