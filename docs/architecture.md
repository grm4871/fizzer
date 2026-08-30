# Architecture

Fizzer is one product with four cooperating runtime surfaces:

```text
React renderer
  |  HTTP + Socket.IO
  v
Elixir backend  <---->  SQLite + vault files
  ^
  |  /runners relay
  |
Electron renderer ---- IPC ---- Electron main ---- local agent CLIs
                                 |
                                 +---- packaged local backend (desktop default)
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

The production and local API is the Elixir OTP application in
`backend_elixir/`. `Cascade.Application` starts SQLite, domain schema
bootstrap, Socket.IO-compatible namespaces (`/runs`, `/vault`, `/runners`),
and the Bandit HTTP listener.

Domain behavior lives under `backend_elixir/lib/cascade/`:

- `content/` — vaults, folders, notes, files, graph data, and access;
- `chat/` — channels, messages, members, agent registrations, and run folding;
- `runs/` — run records, events, session lookup, and cancellation;
- `missions/` — durable chat missions and task projection;
- `realtime/` — Socket.IO compatibility, presence, and runner relay;
- `privacy.ex` — private-block redaction and preservation;
- `scratchpad.ex` — durable agent memory and consolidation;
- `search/` — hybrid semantic and lexical search via the QMD worker;
- `publishing/` — public note publishing.

HTTP routes are declared under `backend_elixir/lib/cascade_web/`. Treat the
router catalog and its domain module as the source of truth.

A Node QMD worker (`backend_elixir/priv/qmd_worker.mjs`) remains a supervised
specialization for semantic search. It is not an HTTP backend.

## Persistence

Cascade uses SQLite. The Elixir service creates and migrates tables at startup
through domain schema modules and a checksummed raw-SQL ledger.

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

Packaged desktop builds also carry a platform-native OTP release and the built
React client. Electron starts that service on a random `127.0.0.1` port, keeps
SQLite and vault files below its user-data directory, and stops the service
with the app. An explicit `CASCADE_APP_URL`, `APP_URL`, or `--instance-url=`
selects a remote instance instead. Source development keeps using Vite unless
`FIZZER_EMBEDDED_BACKEND=1` is set.

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
after a model-server restart. See `backend_elixir/lib/cascade/runs/` and
`client/src/desktopRunnerHost.ts`.

## Security boundaries

- User requests use JWT authentication.
- Agent helpers receive restricted, short-lived credentials rather than the
  user's full session token.
- Private note blocks are redacted before search, memory, previews, publishing,
  and model prompts.
- Agent CLIs and their provider credentials remain on the desktop machine.
