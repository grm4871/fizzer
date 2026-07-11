# Agent Instructions

## Frontend / Electron renderer — mandatory runtime check

Do **not** treat TypeScript or `vite build` success as done. Before finishing any frontend or Electron renderer change:

1. **Rebuild** if you changed client code (`npm run build:client` for prod bundles).
2. **Load the app** in a browser (dev server, `vite preview`, or Electron) and confirm the affected screen has **no** `console.error`, uncaught exceptions, or failed module loads.
3. **Prefer automation**: `node scripts/verify-client-runtime.mjs` (headless Playwright against the built client). For chat/send flows, also exercise the changed UI manually or with a targeted script.
4. After **renaming or removing** a function/hook, grep the repo and `client/dist` for stale references before deploy.
5. If runtime verification is not possible, say so explicitly and list the exact checks you ran instead (build output, grep, tests).

## Deploying changes

When asked to deploy changes, always:

1. **Commit and push** your working tree.
2. **Run the private deploy script**: `./.private/deploy-cscd-online.sh` (untracked, in `.private/`). It POSTs to the server's `/api/deploy` endpoint with the deploy token; the host watcher then fast-forwards to the pushed commit and runs `deploy/deploy.sh`. (`deploy/deploy.sh` itself needs root and is not run directly.)
3. **Wait for the deploy to land** (do not assume "queued" means done). Prefer:
   - `./.private/deploy-cscd-online.sh --wait` (queues then polls until `last` updates or timeout), or
   - `./.private/deploy-cscd-status.sh` / `GET /api/deploy/status` with the deploy token.
   Poll every few seconds for up to ~3–5 minutes. Confirm `pending: false` and `last.status` is `ok` (or report `error` + message). Note `last.commit` in your final reply.
4. Deploy is fragile: the queue can succeed while the host watcher fails, or the agent process can die mid-deploy when the container restarts. Always verify status (or that live `/api/health` + expected commit behavior returned) before claiming ship.

### After deploy lands — refresh in place (never kill the app)

**Do not** quit, `pkill`, `app.relaunch`, or otherwise terminate the Electron process. That kills every agent run hosted by the desktop. Full app restart is never the deploy follow-up path.

- **Web clients** auto-reload when `version.json` changes (`client/public/version-check.js`). No action needed unless something still looks stale.
- **Electron desktop** already has an **in-place hot reload**:
  - Sidebar footer **Update desktop app** button (RefreshCw icon) → `electronAPI.updateAndRestart` → IPC `app:updateAndRestart`.
  - That **git pull --ff-only**s the checkout (source-desktop builds) and calls `refreshDesktopWindows()` (renderer `reloadIgnoringCache` only). Main process stays up; local agent processes are not canceled by this path.
  - Keyboard: **Ctrl/Cmd+R** reloads the focused renderer only. (**Ctrl/Cmd+Shift+R** relaunches the whole app — do **not** use that after deploy.)
- After a deploy that changes hosted UI or desktop source the user should pick up, **use/tell them the sidebar reload button** (or Ctrl/Cmd+R for renderer-only). Prefer that over asking them to quit Cascade.
- Server-only deploys that keep the runner protocol compatible need no desktop action; mid-flight runs are designed to survive **model-server** restart via reclaim (`activeRunIds` + deferred orphan settle).
