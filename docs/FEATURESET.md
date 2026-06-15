# Feature Set

This file describes the currently active features that are implemented and launchable in the present repository state.

## Core Product Features

## 1) Account Access and Session Handling

Implemented in [index.ts](../index.ts) and consumed by [client/src/App.tsx](../client/src/App.tsx).

- Register account with username/password validation.
- Login with password verification.
- Session value with 30-day expiry.
- Session restore on app load via `/api/me`.
- Logout by removing local session value.

## 2) Document Workspace

Implemented across [index.ts](../index.ts) and [client/src/App.tsx](../client/src/App.tsx).

- Create document with default title/content.
- List documents in sidebar.
- Open and view individual document.
- Edit title and body.
- Save changes.
- Delete document.

Behavioral rule:

- Only the document creator may edit or delete.
- Non-creators can still view and browse.

## 3) Sidebar Ordering

Implemented by `/api/sidebar/reorder` in [index.ts](../index.ts) with UI controls in [client/src/App.tsx](../client/src/App.tsx).

- Move documents up/down in sidebar.
- Persist order per user in SQLite table `sidebar_items`.

## 4) Desktop Runtime Wrapper

Implemented in [cascade-electron/main.cjs](../cascade-electron/main.cjs).

- Runs the app in an Electron BrowserWindow.
- Supports desktop shortcuts for reload/relaunch/zoom.
- Restricts navigation to trusted hosts.
- Clears cookies on app startup.

## 5) Local Netdoc Storage APIs (Electron IPC)

Implemented in [cascade-electron/preload.cjs](../cascade-electron/preload.cjs) and [cascade-electron/database.cjs](../cascade-electron/database.cjs).

- Read/update local DB config path.
- Create/update/delete netdocs.
- Query netdoc existence and latest content.
- Persist and query version history.

Important implementation note:

- IPC endpoints are available through `window.electronAPI` but are not currently consumed by the minimal React app in [client/src/App.tsx](../client/src/App.tsx).

## Developer and Runtime Features

## 1) Local Development Orchestration

Defined in [package.json](../package.json).

- `npm run dev` launches backend + frontend + Electron concurrently.
- `npm run dev-headless` launches backend + frontend only.
- Staging variants support env-specific startup.

## 2) Vite Runtime Middleware Features

Defined in [client/vite.config.js](../client/vite.config.js).

- API and socket proxy to backend port.
- Bot/CLI request proxy for `/netdoc/:id` paths.
- Dev HTML fallback rewriting to `app.html`.
- Build-time generation of `version.json`.

## 3) Persistent Data Strategy

- API server persists editor data in workspace SQLite file [docs.db](../docs.db).
- Electron process persists netdoc data in user config path under `~/.config/cascade`.

## Feature Boundaries

Given the current minimal tree, features from the historical repo that depended on removed modules are intentionally not included.
Only features backed by the launch-path files listed in this document are considered active.
