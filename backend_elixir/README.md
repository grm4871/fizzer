# Cascade Elixir backend

This directory contains Fizzer's production HTTP and Socket.IO backend. It
preserves the existing SQLite, bcrypt, JWT, cookie, security-header,
health-response, Vite-cache, and SPA-fallback contracts. The native
implementation includes the checked-in HTTP route inventory and Socket.IO 4.x
`/runs`, `/vault`, and `/runners` namespaces; unsupported `/api/*` requests
return `501`, not placeholder success.

The backend is an application, not a deployment controller. It does not build
images, stage artifacts, configure nginx, obtain certificates, or perform a
production promotion. Those operations are in `deploy/`. There is no server
GitHub Actions workflow in this repository: the current workflows are only
`desktop-build.yml` and `android-beta.yml`.

## Development

Use a copy of production data until shadow-read and migration work is complete.
The raw-SQL migration runner has its own checksum ledger and does not use Ecto
schemas, preserving compatibility with the existing database.

```sh
mix deps.get
mix check
API_PORT=3000 DOCS_DB_PATH=/path/to/copy.db mix run --no-halt
```

In network mode set a non-default `JWT_SECRET`, `CASCADE_ALLOWED_ORIGINS`, and
`CASCADE_PUBLIC_URL`. If `JWT_SECRET` is omitted outside network mode, the
backend can create/read its persisted secret under `$HOME/.cascade/secret`; do
not rely on that behavior for a production backup. The production image sets
`HOME=/data`, so the equivalent persisted path is inside the mounted data root.

## Runtime configuration

The production Compose file supplies the values that keep the Elixir process
and its Node/QMD worker on the same data tree:

- `DOCS_DB_PATH=/data/docs.db` and `CASCADE_DATA_DIR=/data`.
- `CASCADE_VAULTS_BASE_DIR=/data/.cascade/vaults` and
  `CASCADE_QMD_DIR=/data/.cascade/qmd`.
- `CASCADE_BIND_IP=0.0.0.0` inside the container, while Docker publishes only
  loopback `127.0.0.1:3000` on the host.
- `CASCADE_PUBLIC_URL`, `CASCADE_ALLOWED_ORIGINS`, and `JWT_SECRET` from the
  root-owned production `.env`.
- `CASCADE_TRUST_PROXY_HOPS=1` only for the one nginx proxy expected by the
  production template. The default is `0`; a nonzero value is unsafe when
  untrusted clients can reach the service or inject forwarded headers.

The container runs as UID/GID 1000. Its host data directory must therefore be
writable by `1000:1000`; release manifests are intentionally stored outside it
under root-owned `/var/lib/cascade-release`.

## Capacity controls

The HTTP listener uses BEAM processes and bounded knobs rather than an unlimited
queue:

- `CASCADE_HTTP_ACCEPTORS` (default scheduler count, minimum 4)
- `CASCADE_HTTP_MAX_CONNECTIONS` (default 16,384)
- `CASCADE_SQLITE_POOL_SIZE` (default 20; SQLite writes still serialize)
- `CASCADE_SQLITE_BUSY_TIMEOUT_MS` (default 5,000)
- `CASCADE_REALTIME_HIBERNATE_AFTER_MS` (default 5,000)
- `CASCADE_RUNNER_ORPHAN_RECLAIM_MS` (default 120,000; production Compose uses
  600,000 to preserve the cutover reclaim window)

The target 10,000-user capacity claim is valid only when the exact immutable
release image passes the production-shaped 10,000-user gate, fault proofs, and
separate 5,000-user/two-hour durability soak. Use the one outer command:

```sh
npm run release:capacity:run -- \
  --profile final10k --image sha256:<immutable-image-id> \
  --data-template-dir /secure/capacity/prepared-production-fixture \
  --data-dir /secure/capacity/main10k \
  --fault-data-dir /secure/capacity/faults \
  --soak-data-dir /secure/capacity/soak5k \
  -- --profile final10k --image cascade:certified-<full-git-sha> \
  --image-id sha256:<immutable-image-id> --revision <full-git-sha> \
  --source-database /secure/capacity/production-after/docs.db \
  --source-corpus-root /secure/capacity/production-corpus \
  --fixture /secure/capacity/fixtures-10k.jsonl \
  --results-dir /secure/capacity/results-final10k \
  --source-ip 192.0.2.10 --source-ip 192.0.2.11 \
  --source-ip 192.0.2.12 --source-ip 192.0.2.13 \
  --soak-source-ip 192.0.2.20 --fixture-prefix capacity
```

Set `CAPACITY_RELEASE_COOKIE` and `CAPACITY_JWT_SECRET` in the invoking
process; the latter must be the secret used to create the fixture. Arguments
after the wrapper's `--` configure only the checked-in
`loadtest_elixir/certification-runner.mjs`; do not invoke that runner directly.
The wrapper owns the lock, candidate IDs, data roots, and cleanup. Keep result
paths canonical, private, pairwise-disjoint, and disk-backed; never put results
on `/tmp`. See `loadtest_elixir/CAPACITY_TELEMETRY.md` and the deployment
runbook for artifact names and the complete `release:image:certify` command.

## Release and deployment boundary

Build from a clean exact revision with `npm run release:image:build`. A routine
exact-image release stages with:

```sh
npm run release:image:stage -- <ssh-host>
```

A capacity-sensitive release first runs the outer capacity command and the
complete certifier, then stages its manifest and matching image with:

```sh
npm run release:image:stage-certified -- <manifest> <ssh-host>
```

The capacity manifest is optional for an existing host's routine
`deploy/remote-update.sh` cutover. If a manifest is present, the updater checks
its checksum, revision, tag, and image ID against the staged candidate; a
mismatch fails closed. First-time `deploy/deploy.sh` bootstrap intentionally
requires the certified manifest for its revision.

`remote-update.sh` never builds. It validates the staged image and rendered
Compose/runtime shape, performs isolated data/protocol preflight, and chooses a
rolling state-identical cutover or a maintenance-gated snapshot cutover. It
tags `cascade:latest` only after health, Engine.IO, authenticated live checks,
edge checks, and exact image identity pass. Failures before commit roll back to
the previous image; a state-changing rollback restores the checked SQLite
snapshot before reopening traffic. The app-writable `deploy.result` status file
is not release evidence; trust root-owned manifests and host-side Docker/nginx
checks instead.

The image's Dockerfile pins `FROM` digests, but its `apt-get update` layers use
moving Debian package indexes and are not fully reproducible. The current
`desktop-build` workflow publishes unsigned technical-beta installers (with
checksums); the `android-beta` workflow may skip building when signing secrets
are absent. Neither workflow certifies or deploys this backend.

## Domain authentication boundary

Authenticated controllers use `CascadeWeb.Auth.require/2` (or that module as a
Plug). It assigns `:current_user`, `:auth_access`, `:auth_source`, and
`:auth_token`; restricts agent tokens to the existing capability route list;
recursively redacts private blocks from agent JSON; and fails mutations closed
unless a controller supplies a vault-aware `mutation_gate` or the explicit
`:not_vault_scoped` marker.

Run `mix cascade.parity` to verify the implementation inventory embedded in the
image. This checks route/implementation parity only; it does not certify
capacity, image provenance, TLS, host hardening, backups, or a production
promotion.
