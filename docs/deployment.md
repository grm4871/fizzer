# Deployment and operations

## Production topology

Production serves a Dockerized Node server and built React client behind nginx.
Persistent application data is mounted from `/var/lib/cascade` into `/data` in
the container.

`docker-compose.yml` binds the application to `127.0.0.1:3000`; nginx owns the
public HTTP and TLS boundary.

## Routine release

Pushing `master` triggers `.github/workflows/deploy.yml`. The workflow connects
to the production host over SSH, synchronizes the checkout, and runs:

```bash
bash deploy/remote-update.sh
```

That script:

1. acquires the shared deploy lock;
2. checks disk space and prunes old build cache when necessary;
3. removes only stale, non-running Compose containers;
4. builds the new image;
5. swaps the Compose service;
6. waits for `http://127.0.0.1:3000/api/health`;
7. reports the deployed Git commit.

Always wait for the workflow and verify the expected commit. A successful push
is not proof that production changed.

## Required GitHub Actions secrets

| Secret | Purpose |
| --- | --- |
| `DEPLOY_SSH_KEY` | Private key authorized on the production host |
| `DEPLOY_HOST` | Hostname or IP |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_PORT` | Optional SSH port; defaults to 22 |

Never place secret values in this repository.

## Verification

At minimum, verify:

```bash
curl -fsS https://cscd.online/api/health
```

On the host, also verify the container and checkout:

```bash
docker compose -f /var/www/cascade-browser/docker-compose.yml ps
git -C /var/www/cascade-browser rev-parse --short HEAD
curl -fsS http://127.0.0.1:3000/api/health
```

For a renderer release, load the production client and check for runtime
errors. The repository helper accepts a production URL:

```bash
node scripts/verify-client-runtime.mjs --no-preview https://cscd.online/app.html
```

## Manual fallback

Use a manual deploy only after the Actions run has explicitly failed or Actions
is unavailable. Do not start a fallback while a pushed run is queued or active.
All production paths share a lock, but duplicate deployments still waste time
and create misleading status.

The private local helper and the host-side watcher use the same
`deploy/remote-update.sh` path. `.private/` is machine-local and must never be
committed or documented with secret contents.

## First-time host setup

`deploy/deploy.sh <domain>` bootstraps nginx, certificates, environment, and the
Compose application. It is not the routine update path.

Use `deploy/.env.example` as the minimal environment template and generate a
strong `JWT_SECRET`.

## Client refresh behavior

Do not terminate Electron after a deployment; doing so kills active desktop
agent runs.

- Web clients observe `version.json` and reload automatically.
- Electron source builds use the sidebar **Update desktop app** action to
  fast-forward the checkout and reload renderer windows in place.
- `Ctrl/Cmd+R` reloads only the focused renderer.
- Do not use `Ctrl/Cmd+Shift+R` as a deployment follow-up because it relaunches
  the whole app.

Server-only compatible releases require no desktop refresh. In-flight agent
runs are designed to survive a model-server restart through runner reclaim.
