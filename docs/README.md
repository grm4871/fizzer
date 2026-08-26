# Fizzer documentation

This directory is the maintained documentation for Fizzer. It lives inside the
application repository so docs changes can be reviewed with the code they
describe. Use the page that matches your job:

## Choose a guide

- [Getting started](getting-started.md) — prerequisites, installs, local data,
  run modes, and first verification.
- [User guide](user-guide.md) — use vaults, notes, channels, agents, missions,
  work items, public communities, direct messages, and the Fizzer Guide.
- [Architecture](architecture.md) — understand client state, content and
  search ownership, Elixir domains, realtime wire behavior, Electron, Android,
  and security boundaries.
- [Development and testing](development.md) — choose a focused development
  command, test boundary, release gate, or UI verification path.
- [Agent runtime](agent-runtime.md) — local provider execution, sessions,
  streaming, helpers, and runner security boundaries.
- [Self-hosting](self-hosting.md) — run a loopback-only private instance and
  connect a pinned desktop identity.
- [Deployment and operations](deployment.md) — production bootstrap, updates,
  rollback, and operator checks.
- [Product language](CONTEXT.md) — canonical terminology for Fizzer Guide
  conversations, Product feedback, Trust-and-safety reports, and the Fizzer
  tracker.

## Repository map

| Path | Responsibility |
| --- | --- |
| `client/src/` | React renderer, workspace state, chat/note UI, layout, sockets, and tests |
| `backend_elixir/lib/cascade/content/` | Vaults, folders, notes, files, graph data, and access |
| `backend_elixir/lib/cascade/accounts/` | Accounts, membership, discovery, DMs, moderation, feedback, and activity |
| `backend_elixir/lib/cascade/chat/` | Channels, messages, agent registrations, and chat projections |
| `backend_elixir/lib/cascade/missions/` | Durable missions, task state, scheduling, and dispatch outbox |
| `backend_elixir/lib/cascade/runs/` | Runs, events, sessions, ownership, and cancellation |
| `backend_elixir/lib/cascade/realtime/` | Socket.IO-compatible namespaces, rooms, presence, and runner relay |
| `backend_elixir/lib/cascade/search/` | QMD-backed hybrid lexical/semantic search |
| `backend_elixir/lib/cascade_web/` | HTTP routers, controllers, auth, and authorization gates |
| `cascade-electron/` | Electron main process, preload bridge, local runner, worktrees, and Orbit |
| `cli-agents/` | Provider adapters and scoped `cascade-*` helper commands |
| `android/` | Capacitor Android wrapper and bundled Local Codex plugin |
| `.github/workflows/` | Checked-in desktop and Android beta build/publish workflows |

## Documentation rules

1. Document current behavior, not intended behavior.
2. Link to the source file that owns a behavior instead of duplicating large
   implementation details.
3. Keep secrets, private host details, user tokens, and `.private/` contents out
   of documentation.
4. Update the relevant page in the same change when a public command,
   architecture boundary, deployment path, or operator workflow changes.
5. Prefer short runnable examples. Commands should work from the repository
   root unless a page says otherwise.
6. Keep product-facing language aligned with `docs/CONTEXT.md`: a Fizzer Guide
   issue always targets the Fizzer tracker, while Product feedback and
   Trust-and-safety reports remain separate paths.

The code and checked-in configuration remain authoritative. In particular,
`package.json`, `.github/workflows/android-beta.yml`,
`.github/workflows/desktop-build.yml`, `docker-compose.yml`, and
the relevant `deploy/` scripts should be checked before operational work.
