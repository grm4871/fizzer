import { useEffect, useRef, useState, useCallback } from 'react';
import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { socket } from '../services/socket';

export interface RemoteUser {
  id: string;
  name: string;
  color: string;
  clientId: number;
  cursor?: { index: number; length: number };
}

interface UseYjsOptions {
  netdocId: string;
  user: { id: string; name: string; color: string };
  enabled?: boolean;
}

export function useYjs({ netdocId, user, enabled = true }: UseYjsOptions) {
  const docRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const ytextRef = useRef<Y.Text | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [remoteUsers, setRemoteUsers] = useState<RemoteUser[]>([]);
  const [text, setText] = useState('');

  // Initialize Yjs document
  useEffect(() => {
    if (!enabled || !netdocId || !user.id) return;

    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    const ytext = doc.getText('content');

    docRef.current = doc;
    awarenessRef.current = awareness;
    ytextRef.current = ytext;

    // Set local user info so other clients can see us
    awareness.setLocalStateField('user', {
      id: user.id,
      name: user.name,
      color: user.color
    });

    // Resolve relative cursor positions to absolute indices for remote users
    const resolveRemoteUsers = () => {
      const states = awareness.getStates();
      const users: RemoteUser[] = [];
      states.forEach((state, clientId) => {
        if (clientId !== awareness.clientID && state.user) {
          let cursor: { index: number; length: number } | undefined;
          if (state.cursor) {
            const { anchor, head } = state.cursor;
            if (anchor && head) {
              const anchorPos = Y.createAbsolutePositionFromRelativePosition(
                Y.createRelativePositionFromJSON(anchor), doc
              );
              const headPos = Y.createAbsolutePositionFromRelativePosition(
                Y.createRelativePositionFromJSON(head), doc
              );
              if (anchorPos && headPos) {
                const start = Math.min(anchorPos.index, headPos.index);
                const end = Math.max(anchorPos.index, headPos.index);
                cursor = { index: start, length: end - start };
              }
            }
          }
          users.push({
            ...state.user,
            clientId,
            cursor
          });
        }
      });
      setRemoteUsers(users);
    };

    // Listen for local text changes
    const textObserver = () => {
      setText(ytext.toString());
      // Re-resolve cursor positions when text changes (positions shift)
      resolveRemoteUsers();
    };
    ytext.observe(textObserver);

    // Listen for awareness changes (remote cursors)
    awareness.on('change', resolveRemoteUsers);

    // Socket event handlers
    const handleSync = ({ netdocId: id, update }: { netdocId: string; update: number[] }) => {
      if (id === netdocId) {
        Y.applyUpdate(doc, new Uint8Array(update));
        setText(ytext.toString());
        setIsConnected(true);
      }
    };

    const handleUpdate = ({ netdocId: id, update }: { netdocId: string; update: number[] }) => {
      if (id === netdocId) {
        Y.applyUpdate(doc, new Uint8Array(update));
      }
    };

    const handleAwarenessSync = ({ netdocId: id, update }: { netdocId: string; update: number[] }) => {
      if (id === netdocId) {
        applyAwarenessUpdate(awareness, new Uint8Array(update), null);
      }
    };

    const handleAwarenessUpdate = ({ netdocId: id, update }: { netdocId: string; update: number[] }) => {
      if (id === netdocId) {
        applyAwarenessUpdate(awareness, new Uint8Array(update), null);
      }
    };

    // Subscribe to socket events
    socket.on('yjs:sync', handleSync);
    socket.on('yjs:update', handleUpdate);
    socket.on('yjs:awareness-sync', handleAwarenessSync);
    socket.on('yjs:awareness-update', handleAwarenessUpdate);

    // Join the collaboration session
    socket.emit('yjs:join', { netdocId, user });

    // Send local updates to server
    doc.on('update', (update: Uint8Array, origin: any) => {
      if (origin !== 'remote') {
        socket.emit('yjs:update', {
          netdocId,
          update: Array.from(update)
        });
      }
    });

    return () => {
      // Cleanup
      socket.emit('yjs:leave', { netdocId });
      socket.off('yjs:sync', handleSync);
      socket.off('yjs:update', handleUpdate);
      socket.off('yjs:awareness-sync', handleAwarenessSync);
      socket.off('yjs:awareness-update', handleAwarenessUpdate);
      ytext.unobserve(textObserver);
      awareness.off('change', resolveRemoteUsers);
      awareness.destroy();
      doc.destroy();
      docRef.current = null;
      awarenessRef.current = null;
      ytextRef.current = null;
      setIsConnected(false);
    };
  }, [netdocId, user.id, user.name, user.color, enabled]);

  // Update text content (for textarea binding)
  const updateText = useCallback((newText: string, cursorPosition?: number) => {
    const ytext = ytextRef.current;
    if (!ytext) return;

    const currentText = ytext.toString();

    // Calculate diff and apply changes
    // Find common prefix
    let prefixLen = 0;
    while (prefixLen < currentText.length && prefixLen < newText.length && currentText[prefixLen] === newText[prefixLen]) {
      prefixLen++;
    }

    // Find common suffix (from the end)
    let suffixLen = 0;
    while (
      suffixLen < currentText.length - prefixLen &&
      suffixLen < newText.length - prefixLen &&
      currentText[currentText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
    ) {
      suffixLen++;
    }

    const deleteCount = currentText.length - prefixLen - suffixLen;
    const insertText = newText.slice(prefixLen, newText.length - suffixLen);

    if (deleteCount > 0 || insertText.length > 0) {
      docRef.current?.transact(() => {
        if (deleteCount > 0) {
          ytext.delete(prefixLen, deleteCount);
        }
        if (insertText.length > 0) {
          ytext.insert(prefixLen, insertText);
        }
      });
    }
  }, []);

  // Update cursor position in awareness using Yjs relative positions
  const updateCursor = useCallback((index: number, length: number = 0) => {
    const awareness = awarenessRef.current;
    const ytext = ytextRef.current;
    if (!awareness || !ytext) return;

    const anchor = Y.createRelativePositionFromTypeIndex(ytext, index);
    const head = Y.createRelativePositionFromTypeIndex(ytext, index + length);

    awareness.setLocalStateField('cursor', {
      anchor: Y.relativePositionToJSON(anchor),
      head: Y.relativePositionToJSON(head)
    });

    // Send awareness update to server
    const update = encodeAwarenessUpdate(awareness, [awareness.clientID]);
    socket.emit('yjs:awareness', {
      netdocId,
      update: Array.from(update)
    });
  }, [netdocId]);

  return {
    text,
    updateText,
    updateCursor,
    isConnected,
    remoteUsers,
    ytext: ytextRef.current
  };
}
