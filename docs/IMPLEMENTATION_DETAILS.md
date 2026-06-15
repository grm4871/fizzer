# Implementation Details

This document explains how the current implementation works in moderate depth, with emphasis on control flow, storage, and important code paths.

## Backend Implementation

Source: [index.ts](../index.ts)

## Boot Sequence

- Resolves runtime config from env:
  - `API_PORT` (default 3000)
  - Signing key env variable (default dev value)
  - `DOCS_DB_PATH` (default workspace [docs.db](../docs.db))
- Opens SQLite via better-sqlite3.
- Enables WAL journal mode.
- Creates required tables if missing.

## Schema

The API database defines three tables:

- `users`: credentials and creation metadata.
- `docs`: document rows, creator ownership, timestamps.
- `sidebar_items`: per-user ordering of documents.

## Account Pipeline

1. Login/register routes return a session value containing account identity.
2. Client sends that value in request headers.
3. Request guard middleware validates the value.
4. Middleware injects account identity into request context.

## Write-Access Rules

- Read routes require an active account session.
- Edit/delete require that `doc.creator_id === req.user.id`.
- Writes by non-owners return HTTP 403.

## Sidebar Ordering

- Reorder endpoint accepts a full ordered list of doc IDs.
- Uses a transaction to update `position` atomically.
- UI optimistically reorders local state then persists.

## Frontend Implementation

Source: [client/src/App.tsx](../client/src/App.tsx)

## State Model

Primary state variables:

- Identity/session: current user object plus account-form inputs and related error state
- Collection and selection: `docs`, `activeId`, `activeDoc`
- Editing: `draftTitle`, `draftContent`, `canEdit`, `status`

`dirty` is derived from comparing draft values to active document values.

## Networking Layer

The `api()` helper centralizes:

- JSON content headers.
- Session value attachment from localStorage.
- 401 handling by clearing the local session value.

This keeps call sites concise while enforcing consistent session semantics.

## Load and Refresh Strategy

- On mount, attempts session restore via `/api/me`.
- On successful session restore, loads docs and auto-selects first document.
- Selection changes trigger doc fetch with permission metadata.
- Save operations refresh both active doc and list.

## UI Composition

The app is intentionally monolithic in one file and uses:

- Inline `<Style />` component for scoped static CSS.
- Two major modes:
  - Account form when `user` is null.
  - Split-pane document UI when signed in.

## Vite Configuration Details

Source: [client/vite.config.js](../client/vite.config.js)

Custom Vite plugins currently provide:

- Bot/CLI netdoc proxy behavior before SPA fallback.
- Build-time `version.json` generation in `dist`.
- HTML fallback rewrite to `app.html` for navigation requests.

Proxy rules route `/api` and `/socket.io` requests to backend.

## Electron Implementation

Sources:

- [cascade-electron/main.cjs](../cascade-electron/main.cjs)
- [cascade-electron/preload.cjs](../cascade-electron/preload.cjs)
- [cascade-electron/database.cjs](../cascade-electron/database.cjs)

## Main Process Lifecycle

- On ready: initialize local DB module and clear cookies.
- Delays window creation slightly to allow local services to come up.
- Loads localhost in development and netar.is when packaged.

## Process Boundary Settings

- Disables Node integration in renderer.
- Enables context isolation.
- Exposes explicit IPC API surface through preload.
- Blocks navigation/window opens to non-allowlisted hosts.

## Local Netdoc Storage

`database.cjs` persists app config and netdoc data in user config directory:

- Config path: `~/.config/cascade/config.json` (Linux/macOS), `%APPDATA%/cascade` (Windows)
- Default DB path from config: `cascade.db`

Schema includes:

- `netdoc`
- `netdoc_comment`
- `netdoc_version`
- `app_metadata`
- `user_settings`

## Known Mismatch to Be Aware Of

In `database.cjs`, SQL defines `text` column in `netdoc`, while several methods reference `content` in queries. This is an inconsistency inherited from previous code and should be corrected before relying heavily on netdoc write paths.

## Operational Commands

From [package.json](../package.json):

- `npm run dev` for full local stack.
- `npm run dev-headless` for API + frontend only.
- `npm run dev-backend` and `npm run dev-client` for isolated runs.

If backend startup reports port in use, free port 3000 or set `API_PORT`.
