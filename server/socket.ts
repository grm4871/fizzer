import { Server } from 'socket.io';

/**
 * Socket.IO server instance exported for use in other modules.
 * This is a placeholder that will be set by app-routing.ts
 */
let _io: Server | undefined;

/**
 * Set the Socket.IO server instance
 */
export function setIO(ioInstance: Server) {
  _io = ioInstance;
}

/**
 * Get the Socket.IO server instance
 */
export function getIO(): Server | undefined {
  return _io;
}

/**
 * Alias for backward compatibility
 */
export const io = { get _instance() { return _io; } };
