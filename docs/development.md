# Development and testing

This page is for contributors changing Fizzer. Start with
[Getting started](getting-started.md), then select the narrowest command that
proves the boundary you changed. The source file that owns a behavior is listed
in the ownership table below.

## Development commands

Run from the repository root:

```bash
npm run dev                 # backend + Vite + Electron watcher
npm run dev-headless        # backend + Vite, no Electron
npm run dev-debug           # same backend command as dev, plus Electron/client
npm run dev-headless-debug  # same debug-named backend command, no Electron
npm run dev-instance -- --name my-change
```

`dev-debug` currently runs `npm run dev-backend-debug`, whose command is the same
as `dev-backend`: `dotenv -- sh -c 'export API_PORT=${API_PORT:-3000}; cd
backend_elixir && mix run --no-halt'`. The debug name does not currently add a
different backend mode.

The backend defaults to `docs.db` at the repository root. Use
`DOCS_DB_PATH=/tmp/fizzer-test.db` for an isolated database. Vault files default
to `~/.cascade/vaults` (`CASCADE_VAULTS_BASE_DIR` overrides); QMD corpora/indexes
default to `~/.cascade/qmd` (`CASCADE_QMD_DIR` overrides). These are separate
from one another. `backend_elixir/config/runtime.exs`,
`Cascade.Content.Store.vaults_base_dir/0`, and
`Cascade.Search.QMD.root_dir/0` own these defaults.

## Focused command matrix

| Changed boundary | Focused proof | What it covers |
| --- | --- | --- |
| TypeScript CLI wrappers/adapters | `npm run build` | Root `tsc` build and `scripts/copy-cli-agent-wrappers.cjs` |
| CLI agent behavior | `npm run test:cli-agents` | `tsx --test cli-agents/*.test.ts` (TypeScript glob) |
| React state/helpers/components | `npm test` | Client workspace unit tests under `client/src/tests/` |
| Renderer production output | `npm run typecheck:client && npm run build:client` | Client TypeScript and Vite bundle |
| Built renderer runtime | `node scripts/verify-client-runtime.mjs` | Headless Chromium uncaught exceptions, module failures, fatal console errors |
| Client performance budget | `npm run verify:client-performance` | Built renderer performance checks |
| Electron main/preload/runner | `npm run test:electron` | `node --test cascade-electron/*.test.cjs` |
| Desktop runner lifecycle | `npm run test:desktop-runner` | Cross-boundary desktop runner exercise |
| Elixir backend compile/domain | `npm run test:elixir:mix-check` | `cd backend_elixir && mix check` |
| Backend route contract | `npm run test:elixir:contract-parity && npm run test:elixir:route-parity` | HTTP contract and route catalogs |
| Backend data compatibility | `npm run test:elixir:data-parity && npm run test:elixir:unit-parity` | Data compatibility and focused parity tests |
| Account/chat/missions | `npm run test:e2e` | Account, chat delete/forward/mission, and run ownership flows |
| Agent multi-vault | `npm run test:agent-multivault` | Agent access across vault boundaries |
| Android renderer/APK | `npm run build:client:android` or `npm run android:apk` | Capacitor bundle; APK additionally prepares bundled Codex and runs Gradle |

Do not use a broad command as a substitute for a changed-boundary proof. A
renderer build cannot prove interaction behavior; a backend compile cannot prove
socket access or UI state.

## Change workflow

1. Read `AGENTS.md`, `docs/CONTEXT.md`, and the source that owns the behavior.
2. Preserve unrelated work in a dirty checkout.
3. Make the smallest coherent source/test/documentation change.
4. Run the focused command(s) from the matrix while iterating.
5. Exercise the changed runtime or UI, including error and empty states.
6. Run the release gate appropriate to the affected surface before shipping.

## Frontend verification

For a renderer change, run:

```bash
npm test
npm run typecheck:client
npm run build:client
node scripts/verify-client-runtime.mjs
```

Then exercise the actual screen in a development server, Vite preview, or
Electron. Check:

- no `console.error`, page exceptions, or failed module loads;
- loading, empty, error, and populated states;
- keyboard, pointer, and touch behavior;
- narrow viewports, safe-area insets, scroll, and overflow;
- the changed interaction, not only the initial render.

`client/src/App.tsx` owns workspace state and vault switching. Chat transcript
updates belong in `client/src/chat/messageStore.ts` and `dispatch.ts` so a
streaming token does not rerender the whole shell. `client/src/index.css` owns
global styles and responsive breakpoints; component markup and class names live
with their components. Check both desktop and mobile when changing either.

## Backend and realtime verification

The Elixir application starts its schema/bootstrap, QMD worker, realtime
supervisor, and HTTP edge from `backend_elixir/lib/cascade/application.ex`.
Domain routes are cataloged by the `*_routes.ex` modules under
`backend_elixir/lib/cascade_web/`. The backend's mutation authorization is
fail-closed: routes pass a vault-aware gate or explicitly mark themselves
`:not_vault_scoped`.

For content/search changes, use an isolated `DOCS_DB_PATH`; verify both a normal
member request and an agent-authorized request. Member search can include
private blocks when authorized, while agent search uses the redacted corpus.
Check path safety through `Cascade.Content.Store.resolve_under_vault/2` and QMD
sync/fallback behavior through `Cascade.Search.QMD`.

For socket changes, verify `/vault` room membership, `/runs` run ownership, and
reconnect behavior. `client/src/socket.ts` uses cookie credentials and polling
with WebSocket fallback; `client/src/App.tsx` refetches visible transcripts and
agent members after reconnect because rooms do not replay missed events.

For mission/orchestration changes, verify the separate status sets: mission
`active/reviewing/attention/blocked/completed/canceled`; task
`pending/running/completed/failed/blocked/canceled`. Exercise dependencies,
retry after a terminal task, cancellation, coordinator review, and work-item
synchronization. The authoritative implementation is
`backend_elixir/lib/cascade/missions/store.ex`; scheduling/outbox behavior is in
`scheduler.ex` and `dispatches.ex`.

## Test locations and useful scripts

- `client/src/tests/` — renderer feature and regression tests;
- `client/src/layout/*.test.ts` — layout behavior;
- `backend_elixir/test/` — Elixir backend tests;
- `cascade-electron/*.test.cjs` — Electron runner, IPC, worktree, and usage tests;
- `cli-agents/*.test.ts` — TypeScript helper tests run by `tsx`;
- `scripts/test-*.mjs` — integration and cross-boundary checks;
- `scripts/verify-*-ui.mjs` — focused UI smoke checks.

Focused UI scripts include:

```bash
npm run verify:notes-ui
npm run verify:tab-menus
npm run verify:vault-workspaces-ui
npm run verify:chat-collaboration-ui
npm run verify:chat-mission-ui
npm run verify:account-ui
npm run verify:discovery-dms-ui
npm run verify:updates-ui
npm run verify:workspaces-ui
```

Use the matching script from `package.json`; these checks are intentionally
separate because not every change needs every UI flow.

## Release matrix

The complete release commands are explicit in `package.json`:

```bash
npm run test:release:backend
npm run test:release:frontend
npm run test:release:desktop
npm run test:release
```

`test:release:backend` builds, runs `test:elixir-release`, and runs the CLI
TypeScript tests. `test:release:frontend` typechecks, builds, verifies
performance/runtime, and runs client tests. Add
`npm run test:release:frontend:ui` when release-sensitive UI surfaces changed;
`test:release:frontend:full` includes both. `test:release:desktop` runs the
Electron glob. `test:release` combines backend, frontend, and desktop gates.

The Elixir release sequence (`npm run test:elixir-release`) includes mix check,
swap readiness, contract/route/data/unit parity, end-to-end flows, deployment
safety, and load harness checks. Deployment safety is represented by the
checked-in scripts under `deploy/` and the commands
`test:elixir:certified-image`, `test:elixir:rollback`, and
`test:elixir:edge`—there is no `.github/workflows/deploy.yml` in this repository.
The checked-in CI entry points are `.github/workflows/desktop-build.yml` and
`.github/workflows/android-beta.yml`.

## Data safety and review hygiene

Use an isolated database for tests or experiments that write application state;
do not point them at the normal repository-root `docs.db` or another user's
copy. Do not commit:

- `.env` files, passwords, provider credentials, or tokens;
- SQLite databases or generated QMD data;
- `node_modules/`, `dist/`, or `client/dist/`;
- local logs, screenshots, or `.private/` contents.

Before renaming or deleting a function, hook, component, or class, search source
and `client/dist` after rebuilding for stale references. Review public docs and
`docs/CONTEXT.md` whenever a user-visible name or reporting boundary changes.

## Code ownership guide

| Change | Start with |
| --- | --- |
| Workspace shell, vault switching, global state | `client/src/App.tsx` |
| Chat UI and message interactions | `client/src/components/ChatView.tsx` and `ChatGroupRow.tsx` |
| Note editor/media/Kanban | `client/src/components/NoteEditor.tsx`, `KanbanView.tsx` |
| Agent catalog and prompt policy | `client/src/chat/agents.ts` |
| Message store/stream folding | `client/src/chat/messageStore.ts`, `runBlocks.ts`, `dispatch.ts` |
| HTTP route and authorization | `backend_elixir/lib/cascade_web/` and matching `cascade` domain |
| Content paths, privacy, search | `backend_elixir/lib/cascade/content/`, `search/qmd.ex` |
| Mission scheduling/state | `backend_elixir/lib/cascade/missions/` |
| Work items and Git lifecycle | `backend_elixir/lib/cascade/work_items.ex`, `client/src/chat/workItems.ts`, `workspaces.ts` |
| Electron IPC or desktop lifecycle | `cascade-electron/main.cjs`, `preload.cjs` |
| Desktop agent execution | `cascade-electron/agent-runner.cjs` |
| Orbit local discovery | `cascade-electron/local-agents.cjs`, `client/src/components/OrbitGraph.tsx` |
| Android Local Codex | `android/app/src/main/java/com/cascade/browser/LocalCodexPlugin.java`, `client/src/androidLocalCodex.ts` |
| Production desktop/Android CI | `.github/workflows/desktop-build.yml`, `.github/workflows/android-beta.yml` |
