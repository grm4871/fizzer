# Deployment and operations

## Production topology

Production serves the certified Dockerized Elixir service and built React client behind nginx.
Persistent application data is mounted from `/var/lib/cascade` into `/data` in
the container.

`docker-compose.yml` binds the application to `127.0.0.1:3000`; nginx owns the
public HTTP and TLS boundary.

## Immutable release artifact

Production never rebuilds a release candidate. Build from a clean, committed
checkout, run the capacity gates against that image ID, then certify and stage
the same artifact before pushing the commit:

```bash
npm run release:image:build

# Run the four load shards and capacity monitor against:
IMAGE="cascade:certified-$(git rev-parse HEAD)"
IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"

npm run release:image:certify -- \
  --image "$IMAGE" \
  --monitor /secure/cascade-capacity/monitor.jsonl \
  --load-result /secure/cascade-capacity/shard-0.json \
  --load-result /secure/cascade-capacity/shard-1.json \
  --load-result /secure/cascade-capacity/shard-2.json \
  --load-result /secure/cascade-capacity/shard-3.json \
  --fault-result /secure/cascade-capacity/runner-restart.json \
  --fault-result /secure/cascade-capacity/sqlite-lock.json \
  --soak-result /secure/cascade-capacity/soak-invariants.json

npm run release:image:stage -- \
  ".cascade-release/$(git rev-parse HEAD).json"
```

The build refuses a dirty checkout. Dockerfile bases are digest-pinned, the
image carries the full Git revision, and certification refuses a different
monitor image ID, a failed/incomplete 10,000-user run, fewer than four bound
load shards, a monitor shorter than 2,250 seconds, a concurrent gate shorter
than 30 minutes, any shard that does not span that gate, or an image whose
embedded cutover gate is closed. The manifest also requires exact-image runner
restart/reclaim and SQLite lock/recovery proofs plus a separate 5,000-user,
two-hour churn/run-event durability soak. The durability soak never replaces
the exact 10,000-user/30-minute capacity gate: both must pass for the same image
ID, full revision, target, fixture identity, and production runtime shape.
Certification reopens the raw capacity and soak journals, fixture file, and
both server-log artifacts without following symlinks; recomputes their semantic
gates from the captured records; and verifies every byte count, line count, and
SHA-256. Fatal/error logs, per-sample container/config drift, probe/DB errors,
non-identical requested/delegated/terminal/persisted run-ID sets, failed SQLite
integrity/count reconciliation, or a probe uninstall failure all fail closed.
The durability artifact also binds the observed 300-310-second ramp, all ten
deterministic churn cohorts, exact live event sequences 2/3/4, one-owner fixture
groups, the single batched runner teardown snapshot/flush, and a fully drained
presence dispatcher with zero unclassified/noop/failure outcomes.
The certified and production runtime envelope is the same exact 2 CPUs pinned
to `0-1`, 3 GiB memory/no additional swap, 100,000 PIDs, and 200,000 open-file
limit. The deploy checks both rendered Compose configuration and container
inspection before reopening traffic, leaving roughly 0.8 GiB host memory
outside the app container.
Staging streams `docker save` over SSH into `docker load`, verifies the remote
image ID, and installs a root-owned checksum manifest below the separate
root-only `/var/lib/cascade-release` trust root. The application-writable
`/var/lib/cascade` volume has no path to replace release attestations. Staging
does not start or replace the production container.

Run `npm run test:elixir:release-safety` before certification. It is already
included once by `npm run test:elixir-release`; the component scripts are
available for focused work:

- `npm run test:elixir:deploy-safety` exercises certification, rollback, and
  the exact nginx edge policy.
- `npm run test:elixir:certified-image`, `npm run test:elixir:rollback`, and
  `npm run test:elixir:edge` expose those three gates individually without
  rerunning them in the aggregate release command.
- `npm run test:elixir:load-harness` exercises the load driver, monitor, edge
  limit proof, and protocol codec.

## Routine release

Pushing the already-staged commit to `master` triggers the authenticated
repository webhook and host-side autodeploy service. The host synchronizes the
checkout and runs:

```bash
bash deploy/remote-update.sh
```

That script:

1. acquires the shared deploy lock;
2. requires the root-owned certification manifest for the exact full commit;
3. verifies the staged tag, immutable image ID, revision label, checksum, and
   embedded cutover approval;
4. checks disk space and removes only stale, non-running Compose containers;
5. runs the isolated database, HTTP, and Socket.IO preflight on that image;
6. captures the current image and a checked database snapshot for rollback;
7. swaps the Compose service with `--no-build` behind the nginx maintenance
   gate;
8. verifies health, Engine.IO, data compatibility, and the running container's
   exact image ID before promoting that ID to `cascade:latest` and reopening
   traffic.

Always watch host autodeploy and verify the expected commit and image ID. A
successful push is not proof that production changed. Automatic GitHub Actions
deployment is disabled; the retained `workflow_dispatch` job is an explicit
manual fallback and is never an artifact transport or build path.

## Infrastructure security boundary

The checked-in nginx policy applies bounded per-address authentication, API,
web, and connection limits before the application allocates request bodies. It protects
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
docker inspect --format '{{.Image}}' cascade
node /var/www/cascade-browser/deploy/certified-image.mjs field \
  --manifest "/var/lib/cascade-release/certified-images/$(git -C /var/www/cascade-browser rev-parse HEAD).json" \
  --name image.id
```

For a renderer release, load the production client and check for runtime
errors. The repository helper accepts a production URL:

```bash
node scripts/verify-client-runtime.mjs --no-preview https://cscd.online/app.html
```

## Manual fallback

Use a manual deploy only after host autodeploy has explicitly failed. Do not
start a fallback while the webhook-triggered deploy is queued or active.
All production paths share a lock, but duplicate deployments still waste time
and create misleading status.

The `.github/workflows/deploy.yml` `workflow_dispatch` action is the remote
manual fallback. It syncs the already-staged revision and calls the same
`deploy/remote-update.sh`; it has no automatic `push` trigger.

The private local helper and the host-side watcher use the same
`deploy/remote-update.sh` path. `.private/` is machine-local and must never be
committed or documented with secret contents.

## First-time host setup

`deploy/deploy.sh <domain>` bootstraps nginx, certificates, environment, and the
Compose application. It requires the exact revision's certified image to have
been staged first, starts it with `--no-build`, and refuses to replace an
existing Cascade container. It is not the routine update path; existing hosts
must use the snapshot-backed `deploy/remote-update.sh` cutover.

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
