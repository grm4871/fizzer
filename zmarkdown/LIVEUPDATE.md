# Netaris Real-Time Collaboration Implementation Plan

## Overview
Implement CRDT-based real-time collaborative editing for NetDocs using pg_crdt extension and Yjs on the client side. Uses hybrid approach: normal text storage with CRDT state only during active collaboration sessions.

## Phase 1: Database Setup

### 1.1 Installing pg_crdt Extension

Here's the process we're following:

1. Install dependencies in the running Podman container (in progress)
    - git, make, gcc, postgresql-server-dev-all
2. Clone and build pg_crdt
podman exec -it netaris-postgres bash -c "cd /tmp && git clone
https://github.com/supabase/pg_crdt.git && cd pg_crdt && make &&
make install"
3. Enable the extension in your database
podman exec -it netaris-postgres psql -U netaris -d netaris -c
"CREATE EXTENSION pg_crdt;"

### 1.2 Update Schema
Add collaboration tables to existing schema:
```sql
-- Active collaboration sessions (new)
CREATE TABLE IF NOT EXISTS netdoc_session (
    netdoc_id BIGINT PRIMARY KEY REFERENCES netdoc(id) ON DELETE CASCADE,
    collaborative_state crdt_map, -- CRDT state while editing
    participant_count INTEGER DEFAULT 0,
    last_activity TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Track active participants in sessions (new)
CREATE TABLE IF NOT EXISTS netdoc_session_participant (
    netdoc_id BIGINT REFERENCES netdoc_session(netdoc_id) ON DELETE CASCADE,
    user_id UUID REFERENCES profile(id) ON DELETE CASCADE,
    cursor_position INTEGER,
    selection_range JSONB, -- {start: int, end: int}
    last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (netdoc_id, user_id)
);

-- Indexes for session performance
CREATE INDEX IF NOT EXISTS idx_netdoc_session_activity ON netdoc_session(last_activity);
CREATE INDEX IF NOT EXISTS idx_netdoc_session_participant_user ON netdoc_session_participant(user_id);
CREATE INDEX IF NOT EXISTS idx_netdoc_session_participant_netdoc ON netdoc_session_participant(netdoc_id);

-- Session cleanup function
CREATE OR REPLACE FUNCTION cleanup_inactive_sessions()
RETURNS void AS $$
BEGIN
    DELETE FROM netdoc_session 
    WHERE last_activity < NOW() - INTERVAL '30 minutes';
END;
$$ LANGUAGE plpgsql;

-- Trigger to update netdoc.updated_at when session closes
CREATE OR REPLACE FUNCTION sync_netdoc_from_session()
RETURNS TRIGGER AS $$
BEGIN
    -- When session is deleted, update the parent netdoc's updated_at
    UPDATE netdoc 
    SET updated_at = NOW() 
    WHERE id = OLD.netdoc_id;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_session_cleanup
    AFTER DELETE ON netdoc_session
    FOR EACH ROW
    EXECUTE FUNCTION sync_netdoc_from_session();
```

## Phase 2: Backend API

### 2.1 WebSocket Server Setup
- Set up WebSocket server for real-time communication
- Handle client connections/disconnections
- Broadcast updates to all participants in a session

### 2.2 Create New Router: `routes/netdoc-session.ts`
```typescript
import express, { Request, Response } from 'express';
import { prisma } from '../data-utils.js';
import { getIO } from '../socket.js';

const router = express.Router();

/**
 * Get active session info for a netdoc
 * 
 * Endpoint: GET /api/netdoc/:id/session
 * Query params: ?userId=
 * Responses:
 *  - 200: session object with participants
 *  - 404: no active session
 *  - 500: server error
 */
router.get('/:id/session', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;
    
    // Parse netdoc id
    let netdocId: bigint;
    try {
      if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid netdoc ID format' });
      }
      netdocId = BigInt(id);
    } catch {
      return res.status(400).json({ error: 'Invalid netdoc ID' });
    }
    
    // Find active session
    const session = await prisma.netdoc_session.findUnique({
      where: { netdoc_id: netdocId },
      include: {
        participants: {
          include: {
            profile: {
              select: {
                id: true,
                username: true,
                displayName: true,
                color: true
              }
            }
          }
        }
      }
    });
    
    if (!session) {
      return res.status(404).json({ error: 'No active session' });
    }
    
    res.json({
      netdocId: session.netdoc_id.toString(),
      participantCount: session.participant_count,
      lastActivity: session.last_activity,
      participants: session.participants.map(p => ({
        userId: p.user_id,
        username: p.profile.username,
        displayName: p.profile.displayName,
        color: p.profile.color,
        cursorPosition: p.cursor_position,
        selectionRange: p.selection_range,
        lastSeen: p.last_seen
      }))
    });
  } catch (err) {
    console.error('Get session error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Start or join a collaboration session
 * 
 * Endpoint: POST /api/netdoc/:id/session/join
 * Body: { userId: string }
 * Responses:
 *  - 200: joined session with current state
 *  - 201: created new session
 *  - 403: no permission
 *  - 500: server error
 */
router.post('/:id/session/join', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Parse netdoc id
    let netdocId: bigint;
    try {
      if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid netdoc ID format' });
      }
      netdocId = BigInt(id);
    } catch {
      return res.status(400).json({ error: 'Invalid netdoc ID' });
    }
    
    // Check edit permission
    const hasEditAccess = await checkNetdocPermission(netdocId, userId, 'edit');
    if (!hasEditAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Find or create session
    let session = await prisma.netdoc_session.findUnique({
      where: { netdoc_id: netdocId }
    });
    
    const isNewSession = !session;
    
    if (!session) {
      // Get current netdoc content to initialize CRDT state
      const netdoc = await prisma.netdoc.findUnique({
        where: { id: netdocId },
        select: { content: true }
      });
      
      if (!netdoc) {
        return res.status(404).json({ error: 'Netdoc not found' });
      }
      
      // Create new session (CRDT state initialization will need raw SQL)
      // This is placeholder - actual CRDT initialization needs pg_crdt functions
      await prisma.$executeRaw`
        INSERT INTO netdoc_session (netdoc_id, collaborative_state, participant_count)
        VALUES (${netdocId}, crdt_map_new(), 0)
      `;
      
      session = await prisma.netdoc_session.findUnique({
        where: { netdoc_id: netdocId }
      });
    }
    
    // Check if user already in session
    const existingParticipant = await prisma.netdoc_session_participant.findUnique({
      where: {
        netdoc_id_user_id: {
          netdoc_id: netdocId,
          user_id: userId
        }
      }
    });
    
    if (!existingParticipant) {
      // Add participant
      await prisma.netdoc_session_participant.create({
        data: {
          netdoc_id: netdocId,
          user_id: userId
        }
      });
      
      // Increment participant count
      await prisma.netdoc_session.update({
        where: { netdoc_id: netdocId },
        data: {
          participant_count: { increment: 1 },
          last_activity: new Date()
        }
      });
    } else {
      // Update last_seen
      await prisma.netdoc_session_participant.update({
        where: {
          netdoc_id_user_id: {
            netdoc_id: netdocId,
            user_id: userId
          }
        },
        data: { last_seen: new Date() }
      });
    }
    
    // Get user info to broadcast
    const userProfile = await prisma.profile.findUnique({
      where: { id: userId },
      select: {
        username: true,
        displayName: true,
        color: true
      }
    });
    
    // Broadcast join event to other participants
    const io = getIO();
    if (io) {
      io.to(`collab:${netdocId.toString()}`).emit('collab:user-joined', {
        userId,
        username: userProfile?.username,
        displayName: userProfile?.displayName,
        color: userProfile?.color
      });
    }
    
    res.status(isNewSession ? 201 : 200).json({
      netdocId: netdocId.toString(),
      sessionCreated: isNewSession,
      message: isNewSession ? 'Session created' : 'Joined session'
    });
  } catch (err) {
    console.error('Join session error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Leave a collaboration session
 * 
 * Endpoint: POST /api/netdoc/:id/session/leave
 * Body: { userId: string }
 * Responses:
 *  - 200: left session
 *  - 404: session not found
 *  - 500: server error
 */
router.post('/:id/session/leave', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Parse netdoc id
    let netdocId: bigint;
    try {
      if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid netdoc ID format' });
      }
      netdocId = BigInt(id);
    } catch {
      return res.status(400).json({ error: 'Invalid netdoc ID' });
    }
    
    // Remove participant
    await prisma.netdoc_session_participant.delete({
      where: {
        netdoc_id_user_id: {
          netdoc_id: netdocId,
          user_id: userId
        }
      }
    });
    
    // Decrement participant count
    const session = await prisma.netdoc_session.update({
      where: { netdoc_id: netdocId },
      data: {
        participant_count: { decrement: 1 },
        last_activity: new Date()
      }
    });
    
    // Broadcast leave event
    const io = getIO();
    if (io) {
      io.to(`collab:${netdocId.toString()}`).emit('collab:user-left', {
        userId
      });
    }
    
    // If no participants left, save and close session
    if (session.participant_count <= 0) {
      // Get CRDT state and convert to text (needs raw SQL with pg_crdt functions)
      const result = await prisma.$queryRaw<Array>`
        SELECT crdt_map_to_text(collaborative_state) as content
        FROM netdoc_session
        WHERE netdoc_id = ${netdocId}
      `;
      
      const finalContent = result[0]?.content || '';
      
      // Get current netdoc for version history
      const currentNetdoc = await prisma.netdoc.findUnique({
        where: { id: netdocId },
        select: { content: true }
      });
      
      // Create version if content changed
      if (currentNetdoc && currentNetdoc.content !== finalContent) {
        await prisma.netdoc_version.create({
          data: {
            netdoc_id: netdocId,
            content: currentNetdoc.content
          }
        });
      }
      
      // Update netdoc content
      await prisma.netdoc.update({
        where: { id: netdocId },
        data: {
          content: finalContent,
          updated_at: new Date()
        }
      });
      
      // Delete session (trigger will update netdoc.updated_at)
      await prisma.netdoc_session.delete({
        where: { netdoc_id: netdocId }
      });
      
      // Emit session closed event
      if (io) {
        io.to(`netdoc:${netdocId.toString()}`).emit('netdoc:updated', {
          netdocId: netdocId.toString(),
          updateType: 'session-closed',
          timestamp: new Date()
        });
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Leave session error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Update cursor/selection position
 * 
 * Endpoint: POST /api/netdoc/:id/session/cursor
 * Body: { userId: string, cursorPosition?: number, selectionRange?: {start: number, end: number} }
 * Responses:
 *  - 200: cursor updated
 *  - 500: server error
 */
router.post('/:id/session/cursor', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId, cursorPosition, selectionRange } = req.body;
    
    // Parse netdoc id
    let netdocId: bigint;
    try {
      if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid netdoc ID format' });
      }
      netdocId = BigInt(id);
    } catch {
      return res.status(400).json({ error: 'Invalid netdoc ID' });
    }
    
    // Update participant cursor/selection
    await prisma.netdoc_session_participant.update({
      where: {
        netdoc_id_user_id: {
          netdoc_id: netdocId,
          user_id: userId
        }
      },
      data: {
        cursor_position: cursorPosition,
        selection_range: selectionRange,
        last_seen: new Date()
      }
    });
    
    // Update session activity
    await prisma.netdoc_session.update({
      where: { netdoc_id: netdocId },
      data: { last_activity: new Date() }
    });
    
    // Broadcast via WebSocket (handled by socket.io event)
    
    res.json({ success: true });
  } catch (err) {
    console.error('Update cursor error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Manual save while session is active
 * 
 * Endpoint: POST /api/netdoc/:id/session/save
 * Body: { userId: string }
 * Responses:
 *  - 200: saved successfully
 *  - 403: no permission
 *  - 500: server error
 */
router.post('/:id/session/save', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    // Parse netdoc id
    let netdocId: bigint;
    try {
      if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid netdoc ID format' });
      }
      netdocId = BigInt(id);
    } catch {
      return res.status(400).json({ error: 'Invalid netdoc ID' });
    }
    
    // Check edit permission
    const hasEditAccess = await checkNetdocPermission(netdocId, userId, 'edit');
    if (!hasEditAccess) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    // Get CRDT state and convert to text
    const result = await prisma.$queryRaw<Array>`
      SELECT crdt_map_to_text(collaborative_state) as content
      FROM netdoc_session
      WHERE netdoc_id = ${netdocId}
    `;
    
    const finalContent = result[0]?.content || '';
    
    // Get current netdoc for version history
    const currentNetdoc = await prisma.netdoc.findUnique({
      where: { id: netdocId },
      select: { content: true }
    });
    
    // Create version if content changed
    if (currentNetdoc && currentNetdoc.content !== finalContent) {
      await prisma.netdoc_version.create({
        data: {
          netdoc_id: netdocId,
          content: currentNetdoc.content
        }
      });
    }
    
    // Update netdoc content
    await prisma.netdoc.update({
      where: { id: netdocId },
      data: {
        content: finalContent,
        updated_at: new Date()
      }
    });
    
    // Emit save event
    const io = getIO();
    if (io) {
      io.to(`collab:${netdocId.toString()}`).emit('collab:saved', {
        netdocId: netdocId.toString(),
        timestamp: new Date()
      });
    }
    
    res.json({ success: true });
  } catch (err) {
    console.error('Save session error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * Heartbeat to keep session alive
 * 
 * Endpoint: POST /api/netdoc/:id/session/heartbeat
 * Body: { userId: string }
 * Responses:
 *  - 200: heartbeat acknowledged with participant list
 *  - 500: server error
 */
router.post('/:id/session/heartbeat', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { userId } = req.body;
    
    // Parse netdoc id
    let netdocId: bigint;
    try {
      if (!id || !/^\d+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid netdoc ID format' });
      }
      netdocId = BigInt(id);
    } catch {
      return res.status(400).json({ error: 'Invalid netdoc ID' });
    }
    
    // Update participant last_seen
    await prisma.netdoc_session_participant.update({
      where: {
        netdoc_id_user_id: {
          netdoc_id: netdocId,
          user_id: userId
        }
      },
      data: { last_seen: new Date() }
    });
    
    // Update session activity
    await prisma.netdoc_session.update({
      where: { netdoc_id: netdocId },
      data: { last_activity: new Date() }
    });
    
    // Get current participants
    const participants = await prisma.netdoc_session_participant.findMany({
      where: { netdoc_id: netdocId },
      include: {
        profile: {
          select: {
            username: true,
            displayName: true,
            color: true
          }
        }
      }
    });
    
    res.json({
      participants: participants.map(p => ({
        userId: p.user_id,
        username: p.profile.username,
        displayName: p.profile.displayName,
        color: p.profile.color,
        lastSeen: p.last_seen
      }))
    });
  } catch (err) {
    console.error('Heartbeat error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

export default router;
```

### 2.3 Register Router in Main App
```typescript
// In your main app file (e.g., index.ts or app.ts)
import netdocSessionRouter from './routes/netdoc-session.js';

app.use('/api/netdoc', netdocSessionRouter);
```

## Phase 3: Frontend Integration

### 3.1 Install Yjs
- Add Yjs library to frontend dependencies
- Add y-websocket for WebSocket provider

### 3.2 Collaborative Editor Component

**On document open:**
- Check if netdoc has active session (GET `/api/netdoc/:id/session`)
- If session exists, join it
- If no session and this is first viewer, single-user mode (no session)
- When second user opens, start session and both users join
- Initialize Yjs document with current netdoc.content

**Real-time sync:**
- Bind Yjs to text editor (e.g., ProseMirror, CodeMirror, or custom)
- Send Yjs operations to server via WebSocket
- Apply incoming operations from other users
- Display other users' cursors and selections
- Start heartbeat interval

**On document close:**
- Stop heartbeat
- Leave session (POST `/api/netdoc/:id/session/leave`)
- If last participant, triggers automatic save and session cleanup

### 3.3 Presence Indicators
- Show active participants list (from netdoc_session_participant)
- Display colored cursors for each user (use profile.color)
- Show selections/highlights from other users
- Show user avatars/display_name from profile table
- Indicate when users are typing vs idle (based on cursor updates)

## Phase 4: Conflict Resolution & Edge Cases

### 4.1 Network Issues
- Queue operations locally if WebSocket disconnected
- Show "disconnected" indicator in UI
- Replay queued operations when reconnected
- Handle out-of-order operation arrival (CRDTs handle this naturally)
- If disconnected for >5 minutes, force leave session and save local draft

### 4.2 Session Timeout
- Run periodic cleanup job (cron every 5 minutes)
- Warn users 5 minutes before auto-save on timeout
- Auto-save and close session after 30 minutes of no activity
- Restore session if user returns within grace period

### 4.3 Permissions Integration
- Check netdoc_permission before allowing session join
- User needs 'write' or 'edit' permission to join session
- If permissions change during session, kick affected users
- Broadcast permission changes via WebSocket

### 4.4 Version History Integration
- Create netdoc_version entry on manual saves
- Create netdoc_version entry when session closes
- Store version with timestamp for rollback capability
- Version content is plain text (converted from CRDT state)

### 4.5 Read-Only Viewers
- Allow users with 'read' permission to see live edits
- Don't increment participant_count for read-only viewers
- Show viewer count separately from editor count
- Viewers see cursors but can't edit