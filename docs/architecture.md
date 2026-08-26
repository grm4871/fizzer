# Architecture

Fizzer is one product assembled from a browser renderer, Elixir service,
Electron desktop shell, and Capacitor Android wrapper. The checked-in source is
the contract; this page names the ownership boundaries so a change lands in the
right layer.

```text
React renderer (browser / Electron / Capacitor)
  | authenticated HTTP + Socket.IO
  v
Elixir OTP API  <---->  SQLite + vault Markdown/assets + QMD indexes
  ^                                      |
  | /runners relay                        | hybrid search corpus
  |
Chromium runner socket ---- IPC ---- Electron main ---- local agent CLIs
                                      |
                                      +-- Git worktrees / local Orbit scans
Android Local Codex plugin -----------+
```

## Client architecture and state ownership

`client/src/App.tsx` is the workspace composition root. It owns authentication
bootstrap, vault/folder/note lists, active vault, tab registry, pane layout,
focus, note-tab drafts, presence, runner health, and top-level panels. It
persists only session/layout preferences, not note bodies or chat transcripts.
`openTabs` is the global tab registry; the recursive `LayoutNode` tree in
`client/src/layout/tree.ts` arranges those tabs into panes. `noteContents` holds
independent `{note,draft}` entries per note tab.

Chat messages intentionally do not live in App React state. The external store
in `client/src/chat/messageStore.ts` is updated by `client/src/chat/dispatch.ts`
and Socket.IO handlers; `useSyncExternalStore` subscribers in ChatView rerender
only the affected channel. `client/src/chat/session.ts` persists agent-model
preferences and migrates old local chat state, while server data remains the
authority for members, registrations, and transcripts. Chat dispatch folds
streaming text/tool/harness events in `client/src/chat/runBlocks.ts`.

On vault switch, App snapshots the previous vault's tabs/layout/focus and
in-memory drafts in `vaultWorkspacesRef`/`vaultNoteContentsRef`, then restores the
selected vault's workspace and clears vault-scoped lists. Async responses check
`activeVaultIdRef` before painting, preventing a slow old-vault response from
leaking into the new vault.

## Authentication and trust boundary

`client/src/api.ts` sends `credentials: include`, so the primary browser
credential is an HttpOnly `cascade_session` cookie (or the `__Host-` variant in
network mode). `backend_elixir/lib/cascade/auth/session.ex` accepts a legacy
Bearer token only for compatibility. During one-release migration,
`docs_token` is sent with `X-Cascade-Session-Migrate: 1`; `/api/session` sets the
cookie and the client removes that exact legacy value. Login, password change,
and reset responses set the cookie through `CascadeWeb.AuthController` and
`CascadeWeb.AccountRouter`.

`POST /api/auth/agent-token` issues a separate 12-hour `access: agent` token.
The renderer passes it through the narrow Electron preload bridge to the desktop
main process; agent helpers and agent-authorized routes never receive the user's
full browser credential. `backend_elixir/lib/cascade/auth/token.ex` validates
expiry, username, auth version, and access (`user` or `agent`). Password changes
increment auth version and disconnect old sessions.

## Elixir service and domain map

`backend_elixir/lib/cascade/application.ex` starts the database, semantic schema
bootstrap, QMD worker, realtime supervisor, rate limiter, and HTTP listener.
`backend_elixir/lib/cascade_web/` separates route catalogs and routers; auth and
vault mutation gates are in `cascade_web/auth.ex`, `authorization.ex`, and
`account_router.ex`.

| Domain | Owner | Responsibility |
| --- | --- | --- |
| Account/auth | `cascade/accounts/`, `cascade/auth/` | Registration, password/profile, sessions, reset, invites, roles, and agent-token issuance |
| Social/community | `cascade/accounts/community_activity.ex`, `vault_members.ex` | Membership, invitations, presence-facing activity, unread/read watermarks, and three roles |
| Public vaults | `cascade/accounts/public_vaults.ex` | Owner-curated discovery, sanitized home-note preview, Open/Request/Invite policy, viewer-only joins |
| Direct messages | `cascade/accounts/direct_messages.ex` | One-to-one linked channels, private per-user DM vaults, anti-enumeration, blocks, DM settings |
| Moderation | `cascade/accounts/moderation.ex` | Vault bans and bounded reports for vault/note/message/member targets; owner/global review |
| Product feedback | `cascade/accounts/product_feedback.ex` | Private authenticated feedback queue, separate from moderation and tracker issues |
| Content | `cascade/content/` | Vaults, folders, Markdown notes, assets, tags, links, versions, graph, and access |
| Chat/agents | `cascade/chat/` | Channels, canonical messages, linked-channel projections, registrations, replies, and memberships |
| Runs | `cascade/runs/` | Durable run records/events, sessions, ownership, cancellation, and runner lifecycle |
| Missions | `cascade/missions/` | Mission/task state machine, dependency scheduling, dispatch outbox, and chat projection |
| Work items | `cascade/work_items.ex` | Server-backed task lifecycle, leases, Git state, handoffs, reviews, and PR metadata |
| Evolution | `cascade/evolution.ex` | Chat backlinks, chat-to-note distillation, agent-memory folders, and consolidation |
| Managed agents | `cascade/managed_agents.ex` | Credential-free entitlement, model allow-list, budget reservation, claims, heartbeats, settlement, and audit |
| Search | `cascade/search/` | User/agent corpus variants, lexical fallback, QMD ranking, and result shaping |
| Publishing | `cascade/publishing.ex`, `publishing/` | Scrubbed public snapshots, safe Markdown, public pages, and oEmbed |
| Realtime | `cascade/realtime/` | Socket.IO protocol, namespace/room authorization, presence, ordered events, and runner relay |

The route catalogs in `cascade_web/account_routes.ex`, `chat_routes.ex`,
`content_routes.ex`, `extended_content_routes.ex`, `mission_routes.ex`, and
`orchestration_routes.ex` are the concise HTTP integration map.

## Persistence, paths, and invariants

The backend SQLite database defaults to `docs.db` in the repository root,
resolved by `backend_elixir/config/config.exs` and `runtime.exs`; `DOCS_DB_PATH`
overrides it. `Cascade.Content.Store.vaults_base_dir/0` defaults vault files to
`~/.cascade/vaults` and accepts `CASCADE_VAULTS_BASE_DIR`. Vault metadata and
chat state are in SQLite; note Markdown and assets are filesystem
representations of the same content boundary, not an agent working-directory
mirror.

Every vault gets a unique managed root. `resolve_under_vault/2` rejects path
escape; folder and filename segments are sanitized. Note assets live below
`.cascade-assets/<note-id>/`, are written with restrictive permissions, and are
validated before storage. Deleting a vault removes its managed root only after
checking it remains below the configured base.

QMD uses `Cascade.Search.QMD.root_dir/0`, default `~/.cascade/qmd`, override
`CASCADE_QMD_DIR`. Each vault and access variant has `notes/`, `chats/`, and an
`index.sqlite`. `sync_corpus/3` derives documents from non-archived SQLite notes
and chat messages, writes stable paths, deletes stale files, and computes a
fingerprint. `qmd_worker.mjs` owns the Node QMD index; Elixir owns corpus
selection, redaction, timeout/backpressure, lexical fallback, and
reciprocal-rank fusion.

A normal member search may include private blocks when the member is authorized.
Agent-authenticated content/search uses `Cascade.Content.Privacy` to redact
those blocks before search, memory, previews, publishing, or prompts. This is
the member-search versus agent-redaction distinction; it is not a client-side
filter.

## HTTP and realtime wire behavior

Mutating HTTP routes authenticate first and then pass either
`:not_vault_scoped` or `VaultMembers.mutation_gate/2`; viewers are blocked except
for explicitly allowed self-leave/report cases. Domain controllers return the
canonical JSON projection.

`client/src/socket.ts` creates two cookie-authenticated Socket.IO clients:

- `/vault` joins one accessible `vault:<id>` room and visible
  `chat:<source-channel>` presence rooms. It carries note create/change/delete,
  chat message create/update/delete, agent-member/profile, presence, and
  community-change events.
- `/runs` joins authorized `run:<id>` rooms for streamed run events.

`Cascade.Realtime.DomainAdapter` authorizes namespaces and room joins: vault
membership gates vault rooms, channel access gates presence rooms, and run
ownership gates run rooms. Events are persisted before broadcast by the domain
callbacks. A room does not replay events missed while disconnected.

App therefore reconciles after each vault-socket connect by fetching visible
transcripts and agent members, and performs a debounced soft vault reload for
note bursts. Note bodies refresh only when their open draft is clean; deletion
closes its tab. `messageStore` merges a fetched snapshot with live rows using a
baseline so a reconnect cannot erase a message or hydrated harness/media data
that arrived during the request. Pending dispatches are retried on reconnect
and periodically for visible channels.

## Agent runner and orchestration

The `/runners` socket intentionally lives in Chromium
(`client/src/desktopRunnerHost.ts`) so its network/TLS behavior matches the
renderer. Electron main (`cascade-electron/main.cjs`) owns the local process and
preload (`preload.cjs`) exposes narrow IPC. `agent-runner.cjs` adapts provider
output to normalized status/text/tool/harness/session events. Main-process runs
survive renderer reload; bridge cursors and terminal replay support reclaiming
in-flight work.

A channel message is persisted by `cascade/chat/messages.ex`, dispatch intent is
recorded in the mission outbox when applicable, and a registered runner claims
the work. The runner starts a local CLI with the configured cwd/sandbox/model,
returns events, and the server folds terminal status into runs, mission tasks,
work items, and chat projections. `Cascade.Missions.Scheduler` materializes only
ready dependency tasks; `Cascade.Missions.Store` records every transition and
wakes the coordinator for review/attention. The browser never becomes the
source of truth for mission progress.

Mission status is `active`, `reviewing`, `attention`, `blocked`, `completed`, or
`canceled`. Task status is independently `pending`, `running`, `completed`,
`failed`, `blocked`, or `canceled`. A completed mission cannot have pending or
running workers; a task retry returns a terminal task to pending only after its
run is inactive.

## Android and Orbit

The renderer is shared with Capacitor. `client/src/androidLocalCodex.ts` and
`android/app/src/main/java/com/cascade/browser/LocalCodexPlugin.java` expose the
foreground-only bundled Local Codex runtime. It keeps Codex home/config and a
private workspace inside Android app storage, supports device auth, emits run
output, and keeps the screen awake while login/runs are active. It is not a
portable desktop runner and does not execute arbitrary provider CLIs.

Orbit (`client/src/components/OrbitGraph.tsx`) is a desktop-local visualization,
not a backend-wide monitor. `cascade-electron/local-agents.cjs` scans recently
active Claude Code JSONL sessions and Codex state/rollout files, including only
live turns and open parent/child edges. It polls at about 750 ms. The backend
`POST /api/local-agents` route returns an empty graph because a hosted backend
cannot read the desktop filesystem. Optional captions are local Ollama work in
`cascade-electron/agent-captions.cjs`; other providers, remote sessions, and
completed turns are outside Orbit's scope.

## Responsive and style ownership

`client/src/main.tsx` imports the single global stylesheet `client/src/index.css`.
Components own semantic markup, interaction state, and class names; the
stylesheet owns palette/tokens, global layout, pane/sidebar geometry, modal
surfaces, typography, and responsive rules. `@media (max-width: 900px)` changes
the shell to mobile behavior (drawer sidebar, stacked panes, touch-safe controls);
smaller breakpoints adapt dialogs, Kanban, chat, and discovery/DM surfaces.
Safe-area insets are included for mobile fixed controls. A UI change should
update the owning component and its `index.css` rules together and be checked
at desktop, narrow viewport, touch, keyboard, loading, empty, and error states.

## Key implementation paths

- Workspace composition/state: `client/src/App.tsx`
- Session/layout migration: `client/src/chat/session.ts`, `client/src/layout/tree.ts`
- Chat store/dispatch/folding: `client/src/chat/messageStore.ts`, `dispatch.ts`, `runBlocks.ts`
- HTTP client and domain types: `client/src/api.ts`
- Socket factories: `client/src/socket.ts`
- Runner relay: `client/src/desktopRunnerHost.ts`
- Server bootstrap/routes: `backend_elixir/lib/cascade/application.ex`, `backend_elixir/lib/cascade_web/`
- Content/path/privacy/search: `cascade/content/store.ex`, `assets.ex`, `privacy.ex`, `search/qmd.ex`
- Mission state: `cascade/missions/store.ex`, `scheduler.ex`, `dispatches.ex`
- Desktop IPC/runner/worktrees: `cascade-electron/main.cjs`, `preload.cjs`, `agent-runner.cjs`, `worktrees.cjs`
