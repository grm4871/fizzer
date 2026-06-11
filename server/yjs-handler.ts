import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { prisma } from './data-utils.js';

// Store active Yjs documents and their awareness instances
const docs = new Map<string, Y.Doc>();
const awarenessMap = new Map<string, Awareness>();

// Track which sockets are in which yjs rooms
const socketDocs = new Map<string, Set<string>>(); // socketId -> Set of netdocIds

/**
 * Get or create a Yjs document for a netdoc
 */
async function getOrCreateDoc(netdocId: string): Promise<{ doc: Y.Doc; awareness: Awareness }> {
  let doc = docs.get(netdocId);
  let awareness = awarenessMap.get(netdocId);

  if (!doc) {
    doc = new Y.Doc();
    awareness = new Awareness(doc);

    // Load existing state from database
    const netdoc = await prisma.netdoc.findUnique({
      where: { id: netdocId },
      select: { yjs_state: true, content: true }
    });

    if (netdoc?.yjs_state) {
      // Apply stored Yjs state
      Y.applyUpdate(doc, new Uint8Array(netdoc.yjs_state));
    } else if (netdoc?.content) {
      // Initialize from plain text content (migration path)
      const ytext = doc.getText('content');
      ytext.insert(0, netdoc.content);
    }

    docs.set(netdocId, doc);
    awarenessMap.set(netdocId, awareness);

    // Set up persistence on document changes (debounced)
    let saveTimeout: NodeJS.Timeout | null = null;
    doc.on('update', () => {
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => {
        persistDoc(netdocId, doc!);
      }, 1000); // Save 1 second after last change
    });
  }

  return { doc, awareness: awareness! };
}

/**
 * Persist Yjs document state to database
 */
async function persistDoc(netdocId: string, doc: Y.Doc) {
  try {
    const state = Y.encodeStateAsUpdate(doc);
    const ytext = doc.getText('content');
    const plainContent = ytext.toString();

    await prisma.netdoc.update({
      where: { id: netdocId },
      data: {
        yjs_state: Buffer.from(state),
        content: plainContent,
        updated_at: new Date()
      }
    });
  } catch (err) {
    console.error(`[Yjs] Error persisting doc ${netdocId}:`, err);
  }
}

/**
 * Clean up document when no more clients are connected
 */
function cleanupDoc(netdocId: string, io: SocketIOServer) {
  const room = io.sockets.adapter.rooms.get(`yjs:${netdocId}`);
  if (!room || room.size === 0) {
    const doc = docs.get(netdocId);
    if (doc) {
      // Final persist before cleanup
      persistDoc(netdocId, doc);
      doc.destroy();
      docs.delete(netdocId);
      awarenessMap.delete(netdocId);
    }
  }
}

/**
 * Initialize Yjs handlers on Socket.IO server
 */
export function initYjsHandler(io: SocketIOServer) {
  io.on('connection', (socket: Socket) => {
    const userId = socket.handshake.auth.userId;
    socketDocs.set(socket.id, new Set());

    /**
     * Join a Yjs collaboration session for a netdoc
     */
    socket.on('yjs:join', async ({ netdocId, user }: {
      netdocId: string;
      user: { id: string; name: string; color: string }
    }) => {
      try {
        const { doc, awareness } = await getOrCreateDoc(netdocId);
        const roomName = `yjs:${netdocId}`;

        socket.join(roomName);
        socketDocs.get(socket.id)?.add(netdocId);

        // Send current document state to new client
        const state = Y.encodeStateAsUpdate(doc);
        socket.emit('yjs:sync', {
          netdocId,
          update: Array.from(state)
        });

        // Send current awareness states to new client (relay existing client states)
        const knownStates = Array.from(awareness.getStates().keys());
        if (knownStates.length > 0) {
          const awarenessUpdate = encodeAwarenessUpdate(awareness, knownStates);
          socket.emit('yjs:awareness-sync', {
            netdocId,
            update: Array.from(awarenessUpdate)
          });
        }

      } catch (err) {
        console.error('[Yjs] Error joining session:', err);
        socket.emit('yjs:error', { message: 'Failed to join collaboration session' });
      }
    });

    /**
     * Leave a Yjs collaboration session
     */
    socket.on('yjs:leave', ({ netdocId }: { netdocId: string }) => {
      const roomName = `yjs:${netdocId}`;
      socket.leave(roomName);
      socketDocs.get(socket.id)?.delete(netdocId);
      cleanupDoc(netdocId, io);
    });

    /**
     * Receive document update from client
     */
    socket.on('yjs:update', ({ netdocId, update }: { netdocId: string; update: number[] }) => {
      const doc = docs.get(netdocId);
      if (doc) {
        const updateArray = new Uint8Array(update);
        Y.applyUpdate(doc, updateArray);

        // Broadcast to other clients in the room
        socket.to(`yjs:${netdocId}`).emit('yjs:update', { netdocId, update });
      }
    });

    /**
     * Receive awareness update from client (cursor position, selection, etc.)
     */
    socket.on('yjs:awareness', ({ netdocId, update }: { netdocId: string; update: number[] }) => {
      const awareness = awarenessMap.get(netdocId);
      if (awareness) {
        applyAwarenessUpdate(awareness, new Uint8Array(update), socket);

        // Broadcast to other clients
        socket.to(`yjs:${netdocId}`).emit('yjs:awareness-update', { netdocId, update });
      }
    });

    /**
     * Handle disconnect - clean up all joined docs
     */
    socket.on('disconnect', () => {
      const docIds = socketDocs.get(socket.id);
      if (docIds) {
        docIds.forEach(netdocId => {
          cleanupDoc(netdocId, io);
        });
        socketDocs.delete(socket.id);
      }
    });
  });
}
