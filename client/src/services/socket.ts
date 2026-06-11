/// <reference types="vite/client" />
// src/socket.ts
import { io } from 'socket.io-client';
import { debug } from '../utils/debug';

// Point to your backend socket server
// Uses VITE_SOCKET_URL from .env if set, otherwise connects to current origin
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || window.location.origin;

export const socket = io(SOCKET_URL, {
  autoConnect: false,    // we'll connect manually when userId is available
  transports: ['websocket', 'polling'],  // Add polling as fallback
  withCredentials: true,  // Enable credentials for CORS
  auth: {
    userId: null  // Will be set before connecting
  }
});

// Helper to set userId and connect
export function connectSocket(userId: string) {
  if (!userId) return;

  // Update auth with userId
  socket.auth = { userId };

  // Connect if not already connected
  if (!socket.connected) {
    socket.connect();
  }
}

// Helper to disconnect socket
export function disconnectSocket() {
  debug('[Socket] disconnectSocket() called, connected:', socket.connected);
  if (socket.connected) {
    socket.disconnect();
    debug('[Socket] disconnect() executed');
  }
}

// (optional) log connection events - only in debug mode
socket.on('connect', () => {
  debug('[Socket] Connected to server, socket.id:', socket.id);
});
socket.on('disconnect', () => {
  debug('[Socket] Disconnected from server');
});
