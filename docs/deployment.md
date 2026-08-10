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
7. when invoked by the root watcher, validates and reloads the repository's
   bounded nginx request/connection limits with automatic rollback;
8. reports the deployed Git commit.

Always wait for the workflow and verify the expected commit. A successful push
is not proof that production changed.

## Required GitHub Actions secrets

| Secret | Purpose |
| --- | --- |
| `DEPLOY_SSH_KEY` | Private key authorized on the production host |
| `DEPLOY_HOST` | Hostname or IP |
| `DEPLOY_USER` | SSH user |
| `DEPLOY_PORT` | Optional SSH port; defaults to 22 |
| `DEPLOY_KNOWN_HOSTS` | Pinned host-key line(s) authenticated out of band |

Never place secret values in this repository.

Authenticate the server's Ed25519 fingerprint through the VPS console (for
example, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), compare it with a
separately collected public-key line, and store that line in
`DEPLOY_KNOWN_HOSTS`. Workflows fail closed when the pin is absent or does not
name `DEPLOY_HOST`; they never learn a key from the connection they are about
to trust.

## Infrastructure security boundary

The checked-in nginx policy applies bounded per-address authentication, API,
web, and connection limits before Node allocates request bodies. It protects
the application process from ordinary abuse; it cannot absorb traffic that
saturates the VPS link. Volumetric DDoS protection requires a provider or
CDN/WAF in front of the host and therefore a DNS/account change outside a code
deployment.

`/var/lib/cascade` contains SQLite, Markdown, and note assets. Back it with an
encrypted provider volume or an OS-managed encrypted filesystem. Migrating the
live directory is deliberately not automated by a release: it requires an
authenticated infrastructure console, a verified backup, a maintenance window,
and post-copy ownership/data reconciliation. Application-level encryption with
a key stored beside the data would not protect a stolen volume.

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
