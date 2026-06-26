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
