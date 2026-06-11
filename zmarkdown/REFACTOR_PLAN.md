# Major Refactor Plan: Netdoc-Centric Architecture

## Overview
Remove all document/chat handling. Replace with a netdoc-focused UI with horizontal tabs, sidebar subscriptions, and a notifications feed.

## Key Changes

### 1. Remove Documents and Chats Completely
- **Files to modify/delete:**
  - `client/src/DocumentsFeed.tsx` - DELETE
  - `client/src/DocumentViewer.tsx` - DELETE
  - `client/src/Feed.tsx` - DELETE (or rename to something else)
  - `client/src/NewChat.tsx` - DELETE
  - `client/src/NewNetdoc.tsx` - KEEP but may need updates
  - `server/routes/documents.ts` - DELETE
  - `server/routes/posts.ts` - DELETE (if chat-related)
  - All references to `isChannelRoute`, document state, chat state in App.tsx

- **State to remove from App.tsx:**
  - `currentDocument`
  - `currentChat`
  - `documentLoading`
  - `chatLoading`
  - `content` (post/chat content)
  - `isChannelRoute`
  - `isDocumentRoute`
  - Any effects/handlers related to documents/chats

### 2. Horizontal Tabs System
- **New component:** `client/src/components/NetdocTabs.tsx`
  - Displays array of open netdoc tabs
  - Tab structure: `{ id: string; name: string }`
  - Shows tab name with close button (X)
  - Highlights active tab
  - Max 5 tabs visible (scrollable if more)
  - Click tab to make active
  - Click X to close tab (remains loaded if in sidebar)

- **State in App.tsx:**
  - `openTabs: Array<{ id: string; name: string }>` - open netdocs
  - `activeTab: string` - current tab ID
  - `setOpenTabs`, `setActiveTab` - manage tabs

- **Behaviors:**
  - Loading a netdoc opens a tab (if not already open)
  - Closing a tab switches to next available tab
  - Tabs persist only during session (no persistence)
  - If netdoc is in sidebar and tab closed, it remains subscribed
  - If netdoc is NOT in sidebar and tab closed, unsubscribe

### 3. Subscription System (Derived from Sidebar + Tabs)
- **Subscriptions = Sidebar Items + Open Tabs**
  - Always subscribed to all sidebar netdocs
  - Temporarily subscribed to all open tabs not in sidebar
  - When sidebar item added → auto-subscribe
  - When sidebar item removed → unsubscribe (unless in open tab)
  - When tab opened → subscribe (if not already)
  - When tab closed → unsubscribe (if not in sidebar)

- **Implementation:**
  - Create derived set: `subscriptions = new Set([...sidebarNetdocs, ...openTabIds])`
  - Socket manager auto-updates subscriptions when sidebar/tabs change
  - Subscribe/unsubscribe via socket (join/leave rooms)

### 4. Subscribe Button in Header
- **Behavior:**
  - Click "Subscribe" → add current netdoc to sidebar + open tab
  - Click "Unsubscribe" → remove from sidebar (may keep tab open)
  - Button text: "Subscribe" / "Unsubscribe"
  - State: `isSubscribed` = is netdoc in sidebar?

- **API Call:**
  - `POST /api/profile/subscribe` - add to sidebar
  - `POST /api/profile/unsubscribe` - remove from sidebar
  - Body: `{ netdocId: string }`

### 5. Notifications Feed
- **New component:** `client/src/components/NotificationsFeed.tsx`
  - Shows all received netdoc updates (locally cached)
  - Format: Similar to regular netdoc feed but vertically mirrored
  - Most recent at top, scrolled down initially
  - Scroll UP to load older notifications
  - Each notification: source netdoc, update type, timestamp
  - No server caching (local only, cleared on refresh)

- **Notification Structure:**
  ```typescript
  interface Notification {
    id: string;
    netdocId: string;
    netdocName: string;
    updateType: 'comment' | 'edit' | 'created';
    timestamp: Date;
    content?: string;
  }
  ```

- **Button:**
  - "Notifications" button in sidebar
  - Click to open notifications feed (replace main content area)
  - Badge showing count of unread notifications

### 6. Main Content Area Changes
- **Replace main feed with:**
  - User profile netdoc (accessed via profile menu)
  - Profile netdoc displays: user info, their posts/contributions
  - If not viewing profile, show placeholder or empty state

- **New Tab Button:**
  - "Load Netdoc" button or "+" button
  - Click opens modal/inline input to enter netdoc ID
  - Fetch netdoc by ID and open in new tab
  - Error handling if netdoc not found or not readable

### 7. Navigation State
- **Routes to keep:**
  - `/channel/:id` - channel view (netdoc in sidebar)
  - `/netdoc/:id` - specific netdoc tab view
  - `/profile` - user profile view

- **Routes to remove:**
  - `/document/:id`
  - `/chat/:id`
  - Any document/chat related routes

- **App routing logic:**
  - If no active tab: show profile netdoc
  - If active tab: show that netdoc
  - If notifications button clicked: show notifications feed

## Implementation Order

1. **Phase 1: Remove dead code**
   - Delete document/chat components
   - Remove related state from App.tsx
   - Remove related routes from server

2. **Phase 2: Implement tab system**
   - Create NetdocTabs component
   - Add open tabs state management
   - Implement tab switching/closing

3. **Phase 3: Subscription refactor**
   - Create derived subscription set
   - Update socket handlers
   - Update subscribe button logic

4. **Phase 4: Notifications system**
   - Create NotificationsFeed component
   - Add notification caching
   - Implement notification badge

5. **Phase 5: Profile and load system**
   - Implement profile netdoc view
   - Implement load netdoc modal
   - Update main content routing

6. **Phase 6: Integration and polish**
   - Test all flows
   - Handle edge cases
   - Clean up remaining dead code

## Files to Create
- `client/src/components/NetdocTabs.tsx`
- `client/src/components/NotificationsFeed.tsx`
- `client/src/components/LoadNetdocModal.tsx` (optional, could be inline)

## Files to Delete
- `client/src/DocumentsFeed.tsx`
- `client/src/DocumentViewer.tsx`
- `client/src/Feed.tsx`
- `client/src/NewChat.tsx`
- `server/routes/documents.ts`
- `server/routes/posts.ts` (if chat-specific)

## Files to Modify
- `client/src/App.tsx` - major cleanup
- `client/src/components/NetdocHeader.tsx` - update subscribe logic
- `client/src/index.ts` - socket handlers
- `client/src/Sidebar.tsx` - subscribe/unsubscribe handlers
- `server/routes/netdocs.ts` - add subscribe/unsubscribe endpoints
- `server/data-utils.ts` - add subscription functions
- `server/routes.ts` - add subscription routes

## State Management Pattern

### App.tsx state (new):
```typescript
// Tabs
const [openTabs, setOpenTabs] = useState<Array<{ id: string; name: string }>>([]);
const [activeTab, setActiveTab] = useState<string | null>(null);

// Sidebar (existing, unchanged)
const [sidebarItems, setSidebarItems] = useState([]);

// Current netdoc being viewed
const [currentNetdoc, setCurrentNetdoc] = useState(null);

// Notifications (new)
const [notifications, setNotifications] = useState<Notification[]>([]);
const [showNotifications, setShowNotifications] = useState(false);

// Profile (new)
const [userProfileNetdoc, setUserProfileNetdoc] = useState(null);
```

### Derived state:
```typescript
// All netdoc IDs we're subscribed to
const subscriptions = useMemo(() => {
  const sidebarIds = sidebarItems
    .filter(item => item.type === 'netdoc')
    .map(item => item.netdocId);
  const tabIds = openTabs.map(tab => tab.id);
  return new Set([...sidebarIds, ...tabIds]);
}, [sidebarItems, openTabs]);
```

## Socket Events

### Subscribe/Unsubscribe
```typescript
socket.emit('subscribe', netdocId); // join room netdoc:${id}
socket.emit('unsubscribe', netdocId); // leave room
```

### Notifications
```typescript
socket.on('netdoc:updated', (data) => {
  // Add to local notifications cache
  setNotifications(prev => [data, ...prev]);
});
```

## Notes
- Notifications are local-only, cleared on page refresh
- Sidebar subscriptions persisted on server
- Tab subscriptions ephemeral (session-only)
- No infinite scroll on tabs (max 5 visible)
- Notifications feed uses infinite scroll UP (like email)
