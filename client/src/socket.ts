import { io, type Socket } from 'socket.io-client';

const API_BASE = import.meta.env.VITE_API_URL || '';

type ServerEvents = {
  'vault:noteChanged': (data: { noteId: string; vaultId: string }) => void;
  'vault:noteCreated': (data: { noteId: string; vaultId: string }) => void;
  'vault:noteDeleted': (data: { noteId: string; vaultId: string }) => void;
  'directive:chunk': (data: { noteId: string; content: string }) => void;
  'directive:done': (data: { noteId: string; directiveId: string }) => void;
};

type ClientEvents = {
  joinVault: (vaultId: string) => void;
  leaveVault: (vaultId: string) => void;
};

export function connectVaultSocket(): Socket<ServerEvents, ClientEvents> {
  return io(`${API_BASE}/vault`, {
    auth: { token: localStorage.getItem('docs_token') },
    transports: ['websocket', 'polling'],
  });
}

export function connectRunsSocket(): Socket {
  return io(`${API_BASE}/runs`, {
    auth: { token: localStorage.getItem('docs_token') },
    transports: ['websocket', 'polling'],
  });
}
