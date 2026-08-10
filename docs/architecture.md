# Architecture

Cascade is one product with four cooperating runtime surfaces:

```text
React renderer
  |  HTTP + Socket.IO
  v
Express server  <---->  SQLite + vault files
  ^
  |  /runners relay
  |
Electron renderer ---- IPC ---- Electron main ---- local agent CLIs
```

## React renderer

`client/src/App.tsx` composes the workspace, data loading, tabs, panes, chat,
and agent-run lifecycle. Large feature surfaces live under
`client/src/components/`; focused state and parsing helpers live under
`client/src/chat/`, `client/src/layout/`, and adjacent modules.

The client talks to the server through:

- `client/src/api.ts` for authenticated HTTP requests;
- `client/src/socket.ts` for vault, chat, and run events;
- `client/src/desktopRunnerHost.ts` for the desktop runner relay.

The renderer is shared by browser, Electron, and Capacitor Android builds.
Responsive changes must therefore account for touch input, safe areas, and
small viewports.

## Server

`index.ts` is the composition root. It initializes the database, Express,
Socket.IO namespaces, authentication, routes, publishing, chat streaming, and
desktop-runner hooks.

Domain behavior is split across `server/`:

- `vault.ts` — folders, notes, files, graph data, and vault access;
- `chat.ts` — channels, messages, members, agent registrations, and run folding;
- `runner.ts` — run records, events, session lookup, and cancellation;
- `desktop-runner.ts` — authenticated relay to a user's desktop;
- `privacy.ts` — private-block redaction and preservation;
- `scratchpad.ts` — durable agent memory and consolidation;
- `qmd-search.ts` — hybrid semantic and lexical search;
- `publish.ts` — public note publishing;
- `versions.ts` and `noteAssets.ts` — supporting product domains.

Most API routes are declared in `index.ts`. Treat the route handler and its
domain module as the source of truth instead of maintaining a duplicated route
catalog here.

## Persistence

Cascade uses SQLite through `better-sqlite3`. The server creates and migrates
its tables at startup in the relevant domain modules.

Vault notes also have filesystem representations. The database owns product
metadata and realtime chat state; vault files make note content portable and
available to the local workspace.

Cascade's live vault is not a mirror of an agent process's current working
directory. Agents must use the provided helpers to read and mutate live notes
and chats.

## Electron desktop

`cascade-electron/main.cjs` owns windows, IPC handlers, desktop updates, and
local agent process startup. `preload.cjs` exposes a narrow renderer bridge.
`agent-runner.cjs` adapts local providers into the common run-event protocol.

The `/runners` Socket.IO connection intentionally lives in the Chromium
renderer (`client/src/desktopRunnerHost.ts`) while agent processes execute in
Electron main. This avoids Node TLS path differences and keeps provider
credentials on the user's machine.

## Realtime flow

1. A client creates a run through the server.
2. The server records it and delegates it to the registered desktop runner.
3. Electron starts the local provider and emits normalized run events.
4. The desktop renderer relays those events to the server.
5. The server persists events, folds chat output, and broadcasts updates.
6. Clients render the same server-authoritative state.

Run ownership is durable enough to allow a desktop to reclaim in-flight runs
after a model-server restart. See `server/desktop-runner.ts` and
`client/src/desktopRunnerHost.ts`.

## Security boundaries

- User requests use JWT authentication.
- Agent helpers receive restricted, short-lived credentials rather than the
  user's full session token.
- Private note blocks are redacted before search, memory, previews, publishing,
  and model prompts.
- Agent CLIs and their provider credentials remain on the desktop machine.
