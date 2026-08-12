# Agent Instructions

## Ship hard gate (never skip)

Pushing to `master` is **not** shipping. Production only updates after the host
has loaded the staged revision-labelled image and every cutover check passes.

**Automatic deploys do not run on GitHub Actions.** `Deploy Production` has no
`push` trigger; its `workflow_dispatch` entry is retained only as an explicit
fallback after host autodeploy fails. This keeps one automatic production
trigger per push.

**Before every `git push` to master:**

1. Run **`npm run build`** (root `tsc` + CLI wrappers). This is the same compile Docker runs first — a missing `.d.ts` for a new `.mjs` import fails here and will fail deploy.
2. If you changed client UI: also `npm run build:client` and the frontend runtime check below.

**After every push that should go live:**

3. Watch the host deploy: `ssh root@66.135.24.172 journalctl -u cascade-autodeploy -f`.
4. Confirm production really moved — `curl -sf https://cscd.online/api/health` plus
   `ssh root@66.135.24.172 'git -C /var/www/cascade-browser rev-parse --short HEAD'`
   should match your commit.
5. Do **not** claim ship, close the mission, or start unrelated work until that
   commit matches and health is ok.

Ignoring a failed deploy (or skipping local `tsc` and pushing “anyway”) is how multi-commit inbox spam happens. Treat it as a stop-the-line bug.

## How production deploys now

`grm4871/cascade-browser` push → GitHub webhook → the VPS deploys itself. No
Actions minutes, no `DEPLOY_SSH_KEY`, and nothing that breaks when the laptop
sleeps or billing lapses.

| Piece | Where | What it does |
| --- | --- | --- |
| Repo webhook (id 663729978) | GitHub → `https://cscd.online/_gh/deploy` | Fires on every `push`. |
| `cascade-webhook.service` | VPS, `/usr/local/bin/cascade-webhook.py`, loopback :9001 | Verifies `X-Hub-Signature-256` against `/etc/cascade-webhook.secret`, ignores non-`master` refs, then starts the deploy unit. nginx proxies the public route to it. |
| `cascade-autodeploy.service` | VPS, `/usr/local/bin/cascade-autodeploy.sh` | `git fetch` + `reset --hard origin/master` + `deploy/remote-update.sh`, under the same `flock` the old workflow used, so concurrent deploys serialize. Exits immediately when `origin/master` has not moved. |
| `cascade-autodeploy.timer` | VPS, every 10 min | Fallback only, for a webhook GitHub failed to deliver. |

Operating it:

- Watch a deploy: `ssh root@66.135.24.172 journalctl -u cascade-autodeploy -f`
- Force one: `ssh root@66.135.24.172 systemctl start cascade-autodeploy.service`
- Webhook deliveries and redelivery: `gh api repos/grm4871/cascade-browser/hooks/663729978/deliveries`
- The listener rejects an unsigned request with 403, so the public route cannot trigger a deploy without the secret.

## Release matrix

Use [docs/release-matrix.md](docs/release-matrix.md) for changes being shipped.
Frontend, backend, and desktop verification are separate; run only the suites
matching the changed boundaries. Use `npm run test:release` only when a change
actually crosses all three. Report any applicable row that could not be
exercised.

## Frontend / Electron renderer — mandatory runtime check

Do **not** treat TypeScript or `vite build` success as done. Before finishing any frontend or Electron renderer change:

1. **Rebuild** if you changed client code (`npm run build:client` for prod bundles).
2. **Load the app** in a browser (dev server, `vite preview`, or Electron) and confirm the affected screen has **no** `console.error`, uncaught exceptions, or failed module loads.
3. **Prefer automation**: `node scripts/verify-client-runtime.mjs` (headless Playwright against the built client). For chat/send flows, also exercise the changed UI manually or with a targeted script.
4. After **renaming or removing** a function/hook, grep the repo and `client/dist` for stale references before deploy.
5. If runtime verification is not possible, say so explicitly and list the exact checks you ran instead (build output, grep, tests).

## The client bundle is not type-checked — verify the served bundle

`npm run build:client` is plain `vite build` (esbuild transform, **no** typecheck), and the root `tsc` excludes `client/`. Nothing in CI type-checks `client/src`. `npx tsc --noEmit -p client/tsconfig.json` currently reports ~12 pre-existing errors, so it cannot simply be wired into the build yet.

Consequence: a misplaced JSX attribute compiles and deploys silently. A prop written **inside** a callback body instead of beside its siblings becomes an assignment statement, the component renders without the prop, and the feature is invisible in production while working perfectly on the branch (this is exactly how the Superkanban `+` menu item shipped missing).

So when a UI feature is "missing in prod but works locally", do not stop at "stale client":

- Fetch what the site actually serves and grep it: `curl -s https://cscd.online/app | grep -o 'assets/main-[A-Za-z0-9_-]*\.js'`, then `curl -s https://cscd.online/assets/main-XXXX.js` and grep for the feature string **and its call site** (prop names survive minification — `grep -o '.\{120\}onOpenSuperkanban.\{160\}'`).
- Compare the deployed JSX call site against `git show origin/master:<file>`. A prop present in the working tree but absent (or misplaced) on `origin/master` means an uncommitted local fix, not a caching problem.

## GitHub CLI

`gh` is installed and authenticated (account `grm4871`; scopes `repo`, `workflow`, `gist`, `read:org`). Use it instead of guessing at deploy state:

- `gh run list --limit 5` — recent runs, including any manually dispatched fallback deploy.
- `gh run view <id> --log-failed` — the failing step's log.
- `gh run watch <id>` — block until a run finishes. Not the deploy path any more; use `journalctl -u cascade-autodeploy -f` on the host.

## Deploying changes

Production deploys use the authenticated repository webhook and host-side
autodeploy described above.

1. **Commit, build, and stage** the exact full-SHA image before pushing (`npm run release:image:build && npm run release:image:stage`). Capacity certification is separate and is required only for changes whose risk is production capacity; use `release:image:certify` and `release:image:stage-certified` for those changes. Then push to `master`; the webhook starts the host service, which fetches/reset to `origin/master` and runs `deploy/remote-update.sh` with `--no-build`.
2. **Wait for the host deploy** (do not assume push means live) — `journalctl -u cascade-autodeploy -f`, or: `docker compose -f /var/www/cascade-browser/docker-compose.yml ps` and `curl -sf http://127.0.0.1:3000/api/health`. Confirm the expected commit (`git -C /var/www/cascade-browser rev-parse --short HEAD`) before claiming ship. A verified cutover still does not prove a changed UI behaves correctly; also inspect and exercise the served bundle for client changes.
3. First-time host bootstrap (nginx, certbot, `.env`) remains `deploy/deploy.sh <domain>` — not used for routine releases. If host autodeploy explicitly fails, manually dispatch `.github/workflows/deploy.yml`; never dispatch it concurrently with the webhook path.

Routine releases whose isolated boot is logically state-identical use nginx's
fixed `127.0.0.1:3000` primary and `127.0.0.1:39001` rolling backup; they must
not create `/run/cascade-maintenance`. Releases that intentionally migrate
persistent state retain the snapshot-backed maintenance cutover. For any change
to this machinery, continuously probe the public health endpoint throughout the
deploy and treat even one 5xx response as a failed cutover.

### When a deployment fails

- Read `journalctl -u cascade-autodeploy` first. For a manually dispatched fallback, read its failing step with `gh run view <id> --log-failed` **before** changing anything.
- Classify from that log:
  - **`tsc` / `npm run build` in the server image** → fix types/imports locally with `npm run build` (not client-only).
  - **client `vite build`** → `npm run build:client` on the exact commit.
  - **before SSH** → repository secrets/connectivity.
  - **after SSH / remote-update** → host preflight, snapshot, Compose, or health-check output is truth.
- Fix, validate the same command that failed, push, and **watch the host deploy complete successfully** before claiming ship.

### After deploy lands — refresh in place (never kill the app)

**Do not** quit, `pkill`, `app.relaunch`, or otherwise terminate the Electron process. That kills every agent run hosted by the desktop. Full app restart is never the deploy follow-up path.

- **Web clients** auto-reload when `version.json` changes (`client/public/version-check.js`). No action needed unless something still looks stale.
- **Electron desktop** already has an **in-place hot reload**:
  - Sidebar footer **Update desktop app** button (RefreshCw icon) → `electronAPI.updateAndRestart` → IPC `app:updateAndRestart`.
  - That **git pull --ff-only**s the checkout (source-desktop builds) and calls `refreshDesktopWindows()` (renderer `reloadIgnoringCache` only). Main process stays up; local agent processes are not canceled by this path.
  - Keyboard: **Ctrl/Cmd+R** reloads the focused renderer only. (**Ctrl/Cmd+Shift+R** relaunches the whole app — do **not** use that after deploy.)
- After a deploy that changes hosted UI or desktop source the user should pick up, **use/tell them the sidebar reload button** (or Ctrl/Cmd+R for renderer-only). Prefer that over asking them to quit Cascade.
- Server-only deploys that keep the runner protocol compatible need no desktop action; mid-flight runs are designed to survive **model-server** restart via reclaim (`activeRunIds` + deferred orphan settle).
