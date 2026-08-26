# Deployment and operations

This runbook covers the maintained production path. Fizzer does not contain a
server-deploy GitHub Actions workflow. The only checked-in workflows are
`.github/workflows/desktop-build.yml` and `.github/workflows/android-beta.yml`;
they publish client artifacts, not a production server deployment.

## Production topology and boundaries

The production Compose service is named `cascade`. It runs the certified image
as UID/GID `1000:1000`, mounts `/var/lib/cascade` at `/data`, and listens only
on `127.0.0.1:3000`. nginx owns the public HTTP/TLS boundary and proxies to the
loopback service. The Compose file pins the production envelope to 2 CPUs on
`0-1`, 3 GiB with no swap, 100,000 PIDs, and a 200,000-file limit.

The application data root contains SQLite, vaults, QMD indexes, and the
persisted deploy secret at `.cascade/deploy-secret`. Keep it writable by UID
1000, but keep release attestations elsewhere:

- `/var/lib/cascade` — application-owned durable data (`0750`, UID/GID 1000).
- `/var/lib/cascade-release` and its `certified-images` child — root-owned,
  mode `0700`; manifests and checksums are root-owned mode `0600`.
- `<checkout>/.env` — root-owned mode `0600`; it contains `JWT_SECRET` and
  production URL configuration and is **not** inside the data backup.

The container cannot replace a root-owned certification manifest through the
application volume. This is a filesystem ownership boundary, not a substitute
for host hardening, firewall rules, encrypted storage, or DDoS protection.

## Host prerequisites

Use a Linux host with systemd, root access, and enough disk for the image,
Compose snapshots, and one rollback copy. Install or provide all of the
following before bootstrap: Git, Docker Engine with the Compose v2 plugin,
nginx, Certbot plus the nginx plugin, `curl`, `openssl`, `dig` (`dnsutils` on
Debian), `ssh`, `scp`, and GNU `coreutils` (`sha256sum`, `stat`, and `df`). On
Debian/Ubuntu, a starting point is:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx curl openssl dnsutils git openssh-client coreutils
sudo systemctl enable --now docker nginx
sudo docker compose version
```

Package names and Docker installation policy vary by distribution. The scripts
do not configure a firewall, SSH policy, unattended upgrades, fail2ban, an
encrypted volume, a provider firewall, or a CDN/WAF. Configure those separately;
permit only the ports and administration paths your deployment requires (normally
SSH, HTTP, and HTTPS). Do not expose port 3000 publicly.

Before bootstrap, point the domain's A/AAAA records at this host and ensure
ports 80 and 443 reach nginx. The bootstrap script must run as root from the
exact clean checkout whose image was staged.

## Build an exact candidate

Build on a release/CI machine, not on the production host. The build helper
requires a clean checkout and archives the exact full Git revision before
calling Docker BuildKit:

```bash
REVISION="$(git rev-parse HEAD)"
IMAGE="cascade:certified-$REVISION"
npm run release:image:build
IMAGE_ID="$(docker image inspect --format '{{if .Descriptor}}{{index .Descriptor.Annotations "config.digest"}}{{else}}{{.Id}}{{end}}' "$IMAGE")"
printf 'revision=%s\nimage=%s\nimage_id=%s\n' "$REVISION" "$IMAGE" "$IMAGE_ID"
```

The image label and immutable ID must be retained with release evidence. A
`FROM` digest pins the selected base-image bytes, but it does **not** make the
`apt-get update && apt-get install` layers fully reproducible: Debian package
indexes and package versions can change. This Dockerfile has no Debian snapshot
repository or complete apt package lock. Treat the image ID, not a rebuild from
the same Dockerfile, as the release artifact.

A shared BuildKit cache is optional and is not the runtime image. For a private
GHCR cache, authenticate first and use a platform-specific reference:

```bash
GITHUB_USERNAME=YOUR_GITHUB_USERNAME
: "${GITHUB_TOKEN:?export GITHUB_TOKEN with package-write permission first}"
export CASCADE_BUILD_CACHE_REF=ghcr.io/grm4871/fizzer:buildcache-amd64
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin
npm run release:image:build
```

Use `buildcache-arm64` only with `CASCADE_TARGET_PLATFORM=linux/arm64`. The
production default is `linux/amd64`; an ARM Mac may use emulation. Keep cache
packages private unless exposing intermediate layers is acceptable.

## Capacity certification (only for capacity-sensitive changes)

Capacity evidence is additive to the normal release checks. Run it when a
change affects concurrency, dispatch, realtime/presence, runner lifecycle,
SQLite contention, runtime limits, or deployment infrastructure. It is not
needed for ordinary UI, documentation, packaging, or route/contract changes.

Do not invoke `certification-runner.mjs` directly and do not pass a shortened
list of certified-image arguments. The outer `release:capacity:run` wrapper
holds the host lock, owns candidate creation/cleanup, isolates generators from
CPUs `0-1`, and invokes the checked-in runner. Prepare a production-derived,
checkpointed fixture and source corpus first. The source database, corpus,
fixture, results, and each phase data root must be canonical, pairwise-disjoint
paths on disk-backed storage; never use `/tmp` for results.

Define every path and secret before invoking the wrapper. The JWT secret must be
the same secret used when generating the authenticated fixture; keep both
secrets private and do not put them in evidence:

```bash
REVISION="$(git rev-parse HEAD)"
IMAGE="cascade:certified-$REVISION"
IMAGE_ID="$(docker image inspect --format '{{if .Descriptor}}{{index .Descriptor.Annotations "config.digest"}}{{else}}{{.Id}}{{end}}' "$IMAGE")"
SOURCE_DB=/secure/cascade-capacity/production-after/docs.db
SOURCE_CORPUS=/secure/cascade-capacity/production-corpus
TEMPLATE_DIR=/secure/cascade-capacity/prepared-production-fixture
FIXTURE=/secure/cascade-capacity/fixtures-10k.jsonl
RESULTS_DIR=/secure/cascade-capacity/results-$REVISION
MAIN_DATA=/secure/cascade-capacity/main10k-$REVISION
FAULT_DATA=/secure/cascade-capacity/faults-$REVISION
SOAK_DATA=/secure/cascade-capacity/soak5k-$REVISION
export CAPACITY_RELEASE_COOKIE="$(openssl rand -hex 32)"
export CAPACITY_JWT_SECRET="$(openssl rand -hex 32)"
mkdir -p "$RESULTS_DIR"
chmod 700 "$RESULTS_DIR"

npm run release:capacity:run -- \
  --profile final10k \
  --image "$IMAGE_ID" \
  --data-template-dir "$TEMPLATE_DIR" \
  --data-dir "$MAIN_DATA" \
  --fault-data-dir "$FAULT_DATA" \
  --soak-data-dir "$SOAK_DATA" \
  --host-port 39094 \
  -- \
  --profile final10k \
  --image "$IMAGE" \
  --image-id "$IMAGE_ID" \
  --revision "$REVISION" \
  --source-database "$SOURCE_DB" \
  --source-corpus-root "$SOURCE_CORPUS" \
  --fixture "$FIXTURE" \
  --results-dir "$RESULTS_DIR" \
  --source-ip 192.0.2.10 --source-ip 192.0.2.11 \
  --source-ip 192.0.2.12 --source-ip 192.0.2.13 \
  --soak-source-ip 192.0.2.20 \
  --fixture-prefix capacity
```

The example addresses are placeholders: use genuine, distinct generator source
addresses available on the isolated capacity host. The final profile runs the
10,000-user gate, runner-restart and SQLite-lock fault proofs, and the separate
5,000-user two-hour durability soak as sequential, pairwise-distinct candidates.
The monitor is 2,250 seconds (300-second ramp, 1,860-second workload, and
post-workload observation), with four group-preserving shards. A diagnostic
1,000-user run uses `--profile diagnostic1k`, one fresh data root, and a 1,000-
user fixture; it cannot certify an image.

The wrapper writes `monitor.jsonl`, `shard-0.json` through `shard-3.json`,
`reconciliation.json`, phase preflight/freeze files, `runtime-proof.json`,
`runner-restart.json`, `sqlite-lock.json`, and `soak-invariants.json` below
`RESULTS_DIR`. Preserve the complete directory, image ID, fixture/source hashes,
host shape, and timestamps. A nonzero monitor or shard result fails
certification; never turn a client pass into a capacity claim.

The candidate target in this proof is loopback. It does not prove that the
production nginx edge accepts 10,000 connections: the unmodified edge allows
40 Socket.IO connections per source address, so that exercise needs at least
250 genuine source addresses plus margin. If that pool is unavailable, keep
the backend capacity proof separate, prove the 41st same-address connection is
rejected, and report any staging-only allowlisted edge bypass as a separate
proof. Never treat forged `X-Forwarded-For` values as distinct clients.

Create the certification manifest only after the wrapper succeeds. This is the
complete certifier contract (the runner-generated filenames are intentional):

```bash
SCRATCH_DIR=/secure/cascade-capacity/certification-scratch-$REVISION
MANIFEST="$PWD/.cascade-release/$REVISION.json"
mkdir -p "$SCRATCH_DIR" "$(dirname "$MANIFEST")"
chmod 700 "$SCRATCH_DIR"

npm run release:image:certify -- \
  --image "$IMAGE" \
  --source-database "$SOURCE_DB" \
  --source-corpus-root "$SOURCE_CORPUS" \
  --fixture "$FIXTURE" \
  --load-driver loadtest_elixir/load.mjs \
  --reconciliation-driver loadtest_elixir/reconcile-capacity.mjs \
  --monitor "$RESULTS_DIR/monitor.jsonl" \
  --fixture-preflight "$RESULTS_DIR/fixture-preflight-main10k.json" \
  --fault-preflight "$RESULTS_DIR/fixture-preflight-faults.json" \
  --soak-preflight "$RESULTS_DIR/fixture-preflight-soak5k.json" \
  --runtime-proof "$RESULTS_DIR/runtime-proof.json" \
  --reconciliation "$RESULTS_DIR/reconciliation.json" \
  --main-freeze "$RESULTS_DIR/freeze-main10k.json" \
  --fault-freeze "$RESULTS_DIR/freeze-faults.json" \
  --soak-freeze "$RESULTS_DIR/freeze-soak5k.json" \
  --load-result "$RESULTS_DIR/shard-0.json" \
  --load-result "$RESULTS_DIR/shard-1.json" \
  --load-result "$RESULTS_DIR/shard-2.json" \
  --load-result "$RESULTS_DIR/shard-3.json" \
  --fault-result "$RESULTS_DIR/runner-restart.json" \
  --fault-result "$RESULTS_DIR/sqlite-lock.json" \
  --soak-result "$RESULTS_DIR/soak-invariants.json" \
  --scratch-directory "$SCRATCH_DIR" \
  --output "$MANIFEST"

npm run release:image:verify -- --manifest "$MANIFEST"
```

The certifier emits `$MANIFEST.sha256`. The manifest and checksum bind the
exact image ID, full revision, source/fixture identity, runtime envelope,
preflights, freezes, load shards, faults, soak, and all evidence digests. The
scratch directory must be private, owned by the certifier user, disk-backed,
and have at least 2 GiB free. Do not edit, regenerate, or rename evidence
files after certification.

## Stage: routine versus certified

Staging loads an image on the host and leaves the running production container
untouched. These commands are deliberately different:

- **Routine exact-image release (no capacity manifest):**
  `npm run release:image:stage -- <ssh-host>`
- **Capacity-certified release:**
  `npm run release:image:stage-certified -- <manifest> <ssh-host>`

For example:

```bash
DEPLOY_HOST=prod.example.net
MANIFEST="$PWD/.cascade-release/$(git rev-parse HEAD).json"
npm run release:image:stage -- "$DEPLOY_HOST"
# or, after certification:
npm run release:image:stage-certified -- "$MANIFEST" "$DEPLOY_HOST"
```

Routine staging verifies the local and remote immutable image ID and revision
label. Certified staging additionally verifies the manifest/checksum, loads the
same image, and installs the manifest under root-owned
`/var/lib/cascade-release/certified-images/<revision>.json` with its checksum.
The remote staging host needs strict, pre-established SSH host keys; staging
uses `BatchMode` and strict host-key checking and streams `docker save` through
SSH into `docker load`.

A capacity manifest is optional for a routine exact-image release. When a
manifest is present on a host, `remote-update.sh` validates its checksum, image
ID, image tag, and revision; a mismatched or partial manifest fails closed. A
new host's `deploy/deploy.sh` is stricter: bootstrap requires the certified
manifest for the checkout revision. Existing hosts use `remote-update.sh`.

## Bootstrap a production host

After staging the image, prepare the environment **before** starting the
container, then run the bootstrap from the exact checkout as root:

```bash
sudo -i
cd /path/to/fizzer
cp deploy/.env.example .env
vi .env
export DOMAIN=fizzer.example.com
./deploy/deploy.sh "$DOMAIN"
```

Set `CASCADE_PUBLIC_URL=https://$DOMAIN`, the matching
`CASCADE_ALLOWED_ORIGINS`, and a generated `JWT_SECRET` in `.env` before
running `deploy.sh`; do not leave example values in the file. The script fills
`CASCADE_ALLOWED_ORIGINS` and `JWT_SECRET` only when absent or updating the
allowed origin. It does not set a custom `CASCADE_PUBLIC_URL`.

`deploy.sh` is bootstrap-only and refuses to replace an existing `cascade`
container. It creates `/var/lib/cascade` as UID/GID 1000, checks the root-owned
certification directories and manifest, starts Compose with `--no-build`, and
checks the image ID and runtime envelope before installing nginx. It obtains a
Let's Encrypt certificate, installs the HTTPS site, and reloads nginx only
after `nginx -t` succeeds.

Protect the environment file:

```bash
sudo chown root:root .env
sudo chmod 600 .env
```

## Promote and roll back

On an existing host, run the same checked-out revision's update script as root:

```bash
sudo -i
cd /path/to/fizzer
export CASCADE_DEPLOY_DOMAIN=fizzer.example.com
./deploy/remote-update.sh
```

The script never builds. It acquires the deploy lock; validates the clean full
revision, staged image, optional capacity manifest, `.env` ownership, rendered
Compose configuration, and container envelope; runs isolated database/HTTP/
Socket.IO preflight; checks disk; and records the currently running image as a
rollback tag.

For a state-identical release, it starts the candidate on loopback `39001`,
checks health, Engine.IO v4 (and v3 rejection), authenticated reads/realtime,
and the public edge, then stops the old primary so nginx fails over to the
warmed bridge. It starts the canonical `cascade` service on port 3000, repeats
runtime and authenticated checks, waits for nginx's failure timer, drains the
bridge, and only then tags the image `cascade:latest`. This is failover, not
load balancing.

If schema/data preflight says persistent state changes, the script instead
creates the root-owned `/run/cascade-maintenance` gate, verifies nginx returns
503, stops the old service, checkpoints and validates a SQLite snapshot, starts
the candidate with `--no-build`, checks live data and health, then commits and
reopens traffic. It retains the snapshot path printed by the script.

Failures before commit trigger the appropriate rollback automatically. A
rolling rollback starts the previous image while preserving live state. A
maintenance rollback keeps traffic gated, restores the checked SQLite snapshot
when the candidate touched data, boots the previous image, and reopens traffic
only after health and nginx checks pass. If rollback cannot be proven healthy,
the maintenance gate remains active; investigate logs and the printed snapshot
rather than manually pointing Compose at `latest`. Keep the old image and
snapshot until the post-deploy verification is complete.

## Backups and recovery boundary

A production backup must include both durable application data and the separate
`.env` file. `/var/lib/cascade` includes SQLite, vault/QMD trees, and the
persisted deploy secret, but **does not include** `<checkout>/.env` (JWT secret,
public URL, and allowed origins). Losing `.env` invalidates sessions and may
prevent recovery even when the data archive is intact. Encrypt backups and
store them outside the host.

Stop the service for a filesystem-consistent archive:

```bash
BACKUP_DIR=/var/backups/fizzer
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
sudo install -d -m 700 -o root -g root "$BACKUP_DIR"
sudo docker compose -f /path/to/fizzer/docker-compose.yml stop cascade
sudo tar --xattrs --acls -C /var/lib -czf "$BACKUP_DIR/cascade-data-$STAMP.tar.gz" cascade
sudo tar --xattrs --acls -C /path/to/fizzer -czf "$BACKUP_DIR/cascade-env-$STAMP.tar.gz" .env
sudo docker compose -f /path/to/fizzer/docker-compose.yml start cascade
sudo sha256sum "$BACKUP_DIR/cascade-data-$STAMP.tar.gz" \
  "$BACKUP_DIR/cascade-env-$STAMP.tar.gz" \
  | sudo tee "$BACKUP_DIR/SHA256SUMS-$STAMP" >/dev/null
```

Restore only from a trusted, verified archive: stop Fizzer, move the current
`/var/lib/cascade` aside, extract the data archive under `/var/lib`, restore
`.env` with root ownership and mode 0600, check `/var/lib/cascade` ownership
(UID/GID 1000), start Compose with `--no-build`, and verify health plus a
representative vault. Keep the displaced data until that verification passes.

## nginx, certificates, and edge assumptions

The checked-in nginx policy applies per-address request/connection limits and
forwards `X-Forwarded-*` headers. It is not volumetric DDoS protection. The
production Compose service sets `CASCADE_TRUST_PROXY_HOPS=1` because exactly one
nginx proxy is expected. Do not set a nonzero value when clients can reach the
application directly or when the proxy chain is different: forwarded headers
are then attacker-controlled or interpreted with the wrong hop count.

`deploy.sh` and `finish-https.sh` request certificates, but renewal is an
operator responsibility. Install a deploy hook that tests and reloads nginx
only after a successful renewal:

```bash
sudo sh -c 'printf "%s\n" "#!/bin/sh" "set -eu" "nginx -t" "systemctl reload nginx" "systemctl is-active --quiet nginx" > /etc/letsencrypt/renewal-hooks/deploy/20-cascade-nginx'
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/20-cascade-nginx
sudo certbot renew --dry-run
sudo nginx -t
sudo systemctl is-active --quiet nginx
```

After a real renewal, verify the timer/log and the served certificate and
application through the configured name:

```bash
DOMAIN=fizzer.example.com
sudo systemctl list-timers --all | grep -i certbot
sudo journalctl -u certbot.service --since "24 hours ago" --no-pager
curl --noproxy '*' --resolve "$DOMAIN:443:127.0.0.1" -fsS "https://$DOMAIN/api/health"
```

For Tailscale or another private proxy, the proxy must be the only path to the
loopback service and must preserve the intended host/origin and forwarding
headers. Tailscale Serve is appropriate for a self-hosted private instance,
not an excuse to bind port 3000 publicly. Confirm the proxy's hop count and
TLS certificate from a real client before enabling forwarded-address trust.

## Deploy watcher

The optional watcher is host-side automation, not a GitHub workflow. Install it
once as root after bootstrap:

```bash
sudo /path/to/fizzer/deploy/install-deploy-watcher.sh fizzer.example.com
sudo systemctl status cascade-deploy.path
```

The app's authenticated `POST /api/deploy` writes
`/var/lib/cascade/deploy.request`; systemd starts the root watcher, which
fetches/resets the checkout and runs `remote-update.sh`. On first backend start,
when `CASCADE_DEPLOY_TOKEN` is absent, the backend generates
`/data/.cascade/deploy-secret` (the host path is
`/var/lib/cascade/.cascade/deploy-secret`) as a mode-0600 file. Start the app
and wait for health before reading the token:

```bash
curl -fsS http://127.0.0.1:3000/api/health
sudo cat /var/lib/cascade/.cascade/deploy-secret
```

If `CASCADE_DEPLOY_TOKEN` is explicitly set in `.env`, that value overrides the
persisted token and must be backed up as part of `.env`. Send the token as
`Authorization: Bearer <token>`; the status endpoint is separately
authenticated. The watcher installer prints the token path but does not create
a token itself.

`deploy.result` is written under the application data root and chowned to UID
1000 so the app can report it. Treat that result as an untrusted status hint,
not an attestation: an application-writable path is not a secure audit log.
For release truth, inspect root-owned manifests, `docker inspect`, the checked
out revision, nginx, and the watcher/service logs. The watcher does not itself
provide signature verification or general host hardening.

## Verification

Define the public origin and checkout before running checks; do not rely on
undeclared shell variables:

```bash
FIZZER_DOMAIN=fizzer.example.com
FIZZER_CHECKOUT=/path/to/fizzer
curl -fsS "https://$FIZZER_DOMAIN/api/health"
sudo docker compose -f "$FIZZER_CHECKOUT/docker-compose.yml" ps
sudo git -C "$FIZZER_CHECKOUT" rev-parse --short HEAD
curl -fsS http://127.0.0.1:3000/api/health
sudo docker inspect --format '{{.Image}}' cascade
```

For a certified release, verify the staged manifest against that revision:

```bash
REVISION="$(sudo git -C "$FIZZER_CHECKOUT" rev-parse HEAD)"
sudo node "$FIZZER_CHECKOUT/deploy/certified-image.mjs" field \
  --manifest "/var/lib/cascade-release/certified-images/$REVISION.json" \
  --name image.id
node "$FIZZER_CHECKOUT/scripts/verify-client-runtime.mjs" --no-preview \
  "https://$FIZZER_DOMAIN/app.html"
```

The manifest command applies only when a certified manifest was staged. For a
routine release without one, compare the inspected image ID with the recorded
release evidence instead. Always inspect the configured public origin, because a
successful image push is not proof that this host changed.

## Client refresh

Do not terminate Electron after a deployment; doing so kills active desktop
agent runs. Web clients observe `version.json` and reload automatically.
Electron source builds use **Update desktop app** to fast-forward and reload
renderer windows in place; `Ctrl/Cmd+R` reloads only the focused renderer, while
`Ctrl/Cmd+Shift+R` relaunches the whole app. Server-only compatible releases do
not require a desktop refresh. The current desktop workflow publishes unsigned
technical-beta installers; a GitHub checksum is integrity evidence, not code
signing or publisher identity.
