# Cascade documentation

This directory is the maintained technical documentation for Cascade Browser.
It lives inside the application repository so documentation changes can be
reviewed with the code they describe.

## Start here

- [Getting started](getting-started.md) — install dependencies and run Cascade
  locally.
- [Architecture](architecture.md) — understand the client, server, desktop
  shell, persistence, and realtime boundaries.
- [Agent runtime](agent-runtime.md) — understand local agent execution,
  sessions, streaming, helpers, and security boundaries.
- [Development and testing](development.md) — make and verify changes.
- [Deployment and operations](deployment.md) — build, deploy, verify, and
  refresh production safely.

## Repository map

| Path | Responsibility |
| --- | --- |
| `client/src/` | React renderer, chat and note UI, layout, sockets, and tests |
| `server/` | Vault, chat, runner, search, privacy, publishing, and memory modules |
| `index.ts` | Express/Socket.IO composition root and HTTP routes |
| `cascade-electron/` | Electron main process, preload bridge, and local runner |
| `cli-agents/` | Agent adapters and the `cascade-*` helper commands |
| `android/` | Capacitor Android wrapper |
| `deploy/` | Production bootstrap, update, locking, and nginx configuration |
| `scripts/` | Verification, development instances, and integration utilities |

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

The code and checked-in configuration remain authoritative. In particular,
`package.json`, `.github/workflows/`, `docker-compose.yml`, and
`deploy/remote-update.sh` should be checked before performing operational work.
