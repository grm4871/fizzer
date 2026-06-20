# Browser Roadmap

> Evolving Cascade from an embedded web wrapper into a production-grade browser.

This document is a living plan. Each phase is self-contained and ships independently. The phases are ordered by impact — each one closes a concrete gap between "Electron app with a webview" and "real browser."

---

## Where We Are Today

Cascade already has a solid foundation. Before planning what to build, it's worth being honest about what works and what doesn't.

### What works

| Capability | Implementation | Status |
|---|---|---|
| Native web rendering | `WebContentsView` overlays managed in main process | ✅ Shipped |
| Session persistence | `persist:webview` partition with LevelDB backing | ✅ Shipped |
| User-agent spoofing | Strip Electron/Cascade tokens from UA | ✅ Shipped |
| Ad blocking | `@ghostery/adblocker-electron` on the session | ✅ Shipped |
| Per-site ad-block toggle | `webContentsSites` map + IPC toggle | ✅ Shipped |
| Cookie flush on quit | Explicit `flushStore()` in `will-quit` | ✅ Shipped |
| Tab drag/popout | Deferred destruction + view adoption between windows | ✅ Shipped |
| Anti-adblock defuser | DOM injection on `dom-ready` | ✅ Shipped |
| Session restore | `localStorage` → `PersistedSession` with tab URLs and layout | ✅ Shipped |

### What's missing (the gaps that make it feel like a wrapper)

| Gap | Symptom | Root Cause |
|---|---|---|
| No crash recovery | Tab dies → blank area, no way to recover | No `render-process-gone` handler on views |
| Popups open externally or break | `window.open()` in a `WebContentsView` has no handler | `setWindowOpenHandler` only on the app shell, not on views |
| Blanket permission grants | Any site can use camera/mic/geolocation silently | `setPermissionCheckHandler(() => true)` |
| Single session for all tabs | Can't log into two Google accounts simultaneously | One global `persist:webview` partition |
| No browsing history | Can't search "what site was I on yesterday?" | Navigation events fire but are never persisted |
| No find-in-page | Ctrl+F does nothing inside web tabs | No `webContents.findInPage()` wiring |
| No download management | Downloads are logged to console and forgotten | `will-download` handler doesn't surface progress to UI |
| Links in web tabs open nothing | `target="_blank"` inside a `WebContentsView` is silently swallowed | Views lack `setWindowOpenHandler` |

---

## Phase 1 — Popup Interception & Find-in-Page

**Why first**: These are the most immediately visible "this isn't a real browser" moments. A user clicks a link and nothing happens, or presses Ctrl+F and gets no search bar.

### 1a. Intercept `window.open` / `target="_blank"` on WebContentsViews

**Where**: [main.cjs](../cascade-electron/main.cjs), inside `browser:createView`

Right now, `setWindowOpenHandler` is only configured on `win.webContents` (the app shell) at [line 573](../cascade-electron/main.cjs). The `WebContentsView` instances created for browser tabs have no handler, so popups are silently dropped by Electron's defaults.

```javascript
// Add to browser:createView, after view creation:
view.webContents.setWindowOpenHandler(({ url }) => {
  // Send new-tab event back to the owning renderer
  if (!event.sender.isDestroyed()) {
    event.sender.send('browser:event', {
      tabId,
      type: 'new-tab',
      url,
    });
  }
  return { action: 'deny' };
});
```

**Client side**: `WebView.tsx` already subscribes to `browser:event` — add a `case 'new-tab'` that calls `onNavigate` or a new `onNewTab` prop. `App.tsx` creates a new web tab with the URL.

### 1b. Find-in-Page

**Where**: New IPC channels `browser:findInPage` and `browser:stopFindInPage`

```javascript
ipcMain.handle('browser:findInPage', async (event, tabId, text, options) => {
  const entry = webViews.get(tabId);
  if (!entry) return { success: false };
  entry.view.webContents.findInPage(text, options);
  return { success: true };
});

ipcMain.handle('browser:stopFindInPage', async (event, tabId, action) => {
  const entry = webViews.get(tabId);
  if (!entry) return;
  entry.view.webContents.stopFindInPage(action || 'clearSelection');
});
```

Forward `found-in-page` results back to the renderer via `browser:event`.

**Client side**: A small floating search bar component (Ctrl+F to toggle) that calls these IPC methods and shows match count.

### Verification
- Click a `target="_blank"` link on any site → opens as a new Cascade tab
- Press Ctrl+F in a web tab → find bar appears, highlights matches

---

## Phase 2 — Tab Crash Recovery

**Why second**: Without this, a single bad page can leave a dead pane with no recovery option.

### Implementation

**Where**: [main.cjs](../cascade-electron/main.cjs), inside `browser:createView`

```javascript
view.webContents.on('render-process-gone', (evt, details) => {
  console.error(`[WebContentsView] Tab ${tabId} crashed:`, details.reason, details.exitCode);
  if (!event.sender.isDestroyed()) {
    event.sender.send('browser:event', {
      tabId,
      type: 'crashed',
      reason: details.reason,
    });
  }
});
```

**Client side**: `WebView.tsx` adds a `crashed` state. When received, it hides the placeholder div and shows a crash overlay with the site favicon, the URL, and a "Reload" button. Clicking "Reload" calls `destroyView` + `createView` + `loadURL` to spin up a fresh renderer process.

### Verification
- Navigate to `chrome://crash` → crash screen appears with reload button
- Reload → page comes back with navigation history intact

---

## Phase 3 — Permission Request Prompts

**Why third**: The current blanket-grant model is a real security problem. Any site can silently activate the microphone.

### Implementation

**Where**: [main.cjs](../cascade-electron/main.cjs), replace the current `setPermissionRequestHandler` in `configureWebviewSession()`

The current code:
```javascript
// CURRENT — grants everything silently
webviewSession.setPermissionRequestHandler((_wc, _perm, callback) => {
  callback(true);
});
```

Replace with a pending-request queue:
```javascript
const pendingPermissions = new Map(); // requestId → callback

webviewSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
  // Auto-grant safe permissions
  const autoGrant = ['clipboard-read', 'clipboard-sanitized-write', 'pointerLock'];
  if (autoGrant.includes(permission)) return callback(true);

  // Check stored grants in cascade.db
  const site = normalizeSite(details.requestingUrl);
  const stored = db.getSetting(`perm:${site}:${permission}`);
  if (stored === 'granted') return callback(true);
  if (stored === 'denied') return callback(false);

  // Ask the user via IPC
  const requestId = `${Date.now()}-${Math.random()}`;
  pendingPermissions.set(requestId, callback);

  // Find which window owns this webContents
  for (const [, entry] of webViews) {
    if (entry.view.webContents === webContents && entry.win && !entry.win.isDestroyed()) {
      entry.win.webContents.send('browser:event', {
        type: 'permission-request',
        requestId,
        permission,
        site,
        requestingUrl: details.requestingUrl,
      });
      break;
    }
  }
});

ipcMain.handle('browser:resolvePermission', async (event, requestId, granted, remember) => {
  const callback = pendingPermissions.get(requestId);
  if (!callback) return;
  pendingPermissions.delete(requestId);
  callback(granted);

  // Optionally persist the decision
  if (remember) {
    // Extract site from the original request (stored alongside requestId)
    db.setSetting(`perm:${site}:${permission}`, granted ? 'granted' : 'denied');
  }
});
```

**Client side**: A `<PermissionPrompt>` component that renders as a small banner below the URL bar: *"discord.com wants to use your microphone — [Allow] [Block] ☐ Remember"*

### Verification
- Visit a site that requests geolocation → prompt appears
- Click "Allow" with "Remember" checked → no prompt on next visit
- Click "Block" → site receives denial, no silent access

---

## Phase 4 — Session Profiles & Incognito

**Why fourth**: Once the security model is in place, multi-profile is the next highest-value feature for a productivity browser.

### Design

Introduce a `Profile` concept managed in `cascade.db`:

```sql
CREATE TABLE IF NOT EXISTS browser_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  partition TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The default profile maps to `persist:webview` (preserving existing data). New profiles get `persist:profile-<uuid>`. Each tab tracks its `profileId`.

**Incognito**: A built-in profile with a non-persistent partition (`temp:private-<uuid>`). When the last tab using it closes, the session data is gone — Chromium handles this natively when the partition string doesn't start with `persist:`.

### Changes

| File | Change |
|---|---|
| `database.cjs` | Add `browser_profiles` table and CRUD |
| `preload.cjs` | Expose `listProfiles`, `createProfile`, `deleteProfile` |
| `main.cjs` `browser:createView` | Accept `profileId` param, look up the partition, configure the session with the same UA/permissions/adblock setup |
| `WebView.tsx` | Accept `profileId` prop |
| `App.tsx` | Profile selector in tab context menu or URL bar |

### Verification
- Create a "Work" profile → log into Google as work account
- Default profile still has personal Google login
- Open incognito tab → no cookies, no history, close tab → session gone

---

## Phase 5 — Browsing History & Session Recovery

**Why fifth**: This is the feature that makes the browser feel *persistent* and *trustworthy*. But it depends on the profile system from Phase 4 to scope history per-profile.

### Schema

```sql
CREATE TABLE IF NOT EXISTS browser_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL DEFAULT 'default',
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  visited_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (profile_id) REFERENCES browser_profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_history_visited ON browser_history(visited_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_url ON browser_history(url);
```

### Implementation

**Write path** (main process): On every `did-navigate` event in `browser:createView`, insert a row. Debounce rapid SPA navigations (ignore `did-navigate-in-page` for history, or deduplicate within a 2-second window).

**Read path** (IPC): `browser:searchHistory(query, limit)` and `browser:getRecentHistory(limit)`. Exposed through preload.

**Crash recovery**: The current `PersistedSession` in localStorage already saves tab URLs and layout. Enhance it to also track whether the shutdown was clean (write a `clean_exit` flag to `user_settings` in `will-quit`, clear it on startup). If the flag is missing on boot → show a "Restore previous session?" prompt.

### Verification
- Browse 5 sites → all appear in history
- Search history for "github" → matching entries returned
- Kill the process with `kill -9` → on restart, "Restore session?" prompt appears

---

## Phase 6 — Download Management

**Why sixth**: The `will-download` handler in `configureWebviewSession()` currently just logs to console. Files download to the default location with no UI feedback.

### Implementation

**Where**: [main.cjs](../cascade-electron/main.cjs), replace the existing `will-download` handler

```javascript
webviewSession.on('will-download', (event, item) => {
  const id = `dl-${Date.now()}`;

  // Forward download metadata to all browser windows
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('browser:event', {
        type: 'download-started',
        downloadId: id,
        filename: item.getFilename(),
        totalBytes: item.getTotalBytes(),
        url: item.getURL(),
      });
    }
  }

  item.on('updated', (evt, state) => {
    // Send progress updates
  });

  item.once('done', (evt, state) => {
    // Send completion/failure notification
  });
});
```

**Client side**: A downloads panel (slide-out from the toolbar or a dedicated tab) showing filename, progress bar, speed, and open/reveal-in-folder actions.

### Verification
- Download a file → progress bar appears in UI
- Download completes → "Open" and "Show in folder" buttons work
- Download fails → error state shown

---

## Phase 7 — Custom Protocol & Extension Foundation

**Why last**: This is the most complex phase and has the least user-facing urgency. It unlocks future extensibility but isn't blocking any current workflow.

### 7a. Custom `cascade://` Protocol

Register a privileged scheme for internal pages:

```javascript
// Before app.whenReady(), at module scope:
const { protocol } = require('electron');
protocol.registerSchemesAsPrivileged([{
  scheme: 'cascade',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
  }
}]);

// Inside app.whenReady():
protocol.handle('cascade', (request) => {
  const url = new URL(request.url);
  // cascade://settings → serve settings page
  // cascade://history  → serve history search page
  // cascade://newtab   → serve new tab page
});
```

This gives internal pages a proper origin, CSP isolation, and the ability to use `fetch()` against the cascade scheme.

### 7b. Chrome Extension Loading

Electron supports `session.loadExtension(path)` for unpacked extensions. The practical scope:

| Works out of the box | Requires custom UI |
|---|---|
| Content scripts | Extension popup (browserAction) |
| Background service workers | Extension options page |
| `chrome.storage` API | Toolbar button/badge |
| `declarativeNetRequest` | Context menu entries |

Start with content-script-only extensions (e.g., uBlock Origin's cosmetic filters, Vimium keybindings). Build the toolbar popup UI as a React overlay later.

### Verification
- `cascade://newtab` renders a custom new tab page
- Load an unpacked extension → content scripts execute on matching pages

---

## Implementation Order Summary

| Phase | Effort | Key Risk |
|---|---|---|
| 1. Popup interception & find-in-page | Small (1–2 days) | None — straightforward API wiring |
| 2. Crash recovery | Small (1 day) | None — well-documented Electron API |
| 3. Permission prompts | Medium (2–3 days) | Async callback lifecycle requires careful cleanup |
| 4. Session profiles | Medium (3–4 days) | Must replicate adblock/UA/permissions setup per session |
| 5. History & session recovery | Medium (2–3 days) | Debouncing SPA navigations, clean-exit detection |
| 6. Download management | Medium (2–3 days) | Progress update throttling, multi-window broadcast |
| 7. Custom protocols & extensions | Large (1–2 weeks) | Extension UI bridge is significant custom work |

All phases use APIs that already exist in Electron 39.x. No forks, patches, or native modules required.
