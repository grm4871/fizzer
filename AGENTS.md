# Agent Instructions

## Frontend / Electron renderer — mandatory runtime check

Do **not** treat TypeScript or `vite build` success as done. Before finishing any frontend or Electron renderer change:

1. **Rebuild** if you changed client code (`npm run build:client` for prod bundles).
2. **Load the app** in a browser (dev server, `vite preview`, or Electron) and confirm the affected screen has **no** `console.error`, uncaught exceptions, or failed module loads.
3. **Prefer automation**: `node scripts/verify-client-runtime.mjs` (headless Playwright against the built client). For chat/send flows, also exercise the changed UI manually or with a targeted script.
4. After **renaming or removing** a function/hook, grep the repo and `client/dist` for stale references before deploy.
5. If runtime verification is not possible, say so explicitly and list the exact checks you ran instead (build output, grep, tests).

## Deploying changes

Production deploys use the same GitHub Actions → SSH pattern as Simcluster.

1. **Commit and push** to `master`. That triggers `.github/workflows/deploy.yml`, which SSHs to the host, `git fetch`/`reset --hard origin/master`, and runs `deploy/remote-update.sh` (docker compose build + up + health check).
2. **Wait for the Actions run** (do not assume push means live). Prefer the Actions UI, or on the host: `docker compose -f /var/www/cascade-browser/docker-compose.yml ps` and `curl -sf http://127.0.0.1:3000/api/health`. Confirm the expected commit (`git -C /var/www/cascade-browser rev-parse --short HEAD`) before claiming ship.
3. First-time host bootstrap (nginx, certbot, `.env`) remains `deploy/deploy.sh <domain>` — not used for routine releases. Required Actions secrets (same names as Simcluster): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_PORT`.

### When a deployment fails

- First verify the client bundle from the exact commit: run `npm run build:client`. A GitHub Actions failure during the host's `docker compose build` can be a client syntax/build error, not an SSH or secret problem. Fix and validate that build before retrying the workflow.
- Use the Actions log to classify failures: before SSH means repository secrets/connectivity; after SSH means the remote update/build output is the source of truth.

### After deploy lands — refresh in place (never kill the app)

**Do not** quit, `pkill`, `app.relaunch`, or otherwise terminate the Electron process. That kills every agent run hosted by the desktop. Full app restart is never the deploy follow-up path.

- **Web clients** auto-reload when `version.json` changes (`client/public/version-check.js`). No action needed unless something still looks stale.
- **Electron desktop** already has an **in-place hot reload**:
  - Sidebar footer **Update desktop app** button (RefreshCw icon) → `electronAPI.updateAndRestart` → IPC `app:updateAndRestart`.
  - That **git pull --ff-only**s the checkout (source-desktop builds) and calls `refreshDesktopWindows()` (renderer `reloadIgnoringCache` only). Main process stays up; local agent processes are not canceled by this path.
  - Keyboard: **Ctrl/Cmd+R** reloads the focused renderer only. (**Ctrl/Cmd+Shift+R** relaunches the whole app — do **not** use that after deploy.)
- After a deploy that changes hosted UI or desktop source the user should pick up, **use/tell them the sidebar reload button** (or Ctrl/Cmd+R for renderer-only). Prefer that over asking them to quit Cascade.
- Server-only deploys that keep the runner protocol compatible need no desktop action; mid-flight runs are designed to survive **model-server** restart via reclaim (`activeRunIds` + deferred orphan settle).
