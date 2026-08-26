# Self-hosting Fizzer

This is the standalone path for one private Fizzer instance on a host you
control. It uses `docker-compose.selfhost.yml`, not the maintainer's production
bootstrap or deploy-watcher machinery. The container is reachable through a
loopback port only; put a private HTTPS proxy (for example Tailscale Serve) in
front of it.

## Prerequisites and storage

Use a Linux host with Docker Engine and the Compose v2 plugin, Git, OpenSSL,
curl, and a durable absolute data directory. The host directory mounted at
`/data` must be writable by container UID/GID `1000:1000` (the image's `node`
user). Do not make it a symlink, a temporary directory, or a root-only `0700`
directory. The self-host Compose file does not configure host firewall rules,
TLS, backups, or proxy access control; provide those separately.

Choose the data directory and local port once, then use those same values in the
environment file, Compose command, health check, and backup commands. This
example deliberately uses shell variables so changing either value cannot leave
a command silently pointing at `/srv/fizzer/data` or port `3000`:

```bash
git clone https://github.com/grm4871/fizzer.git
cd fizzer
cp .env.selfhost.example .env.selfhost
export FIZZER_DATA_DIR=/srv/fizzer/data
export FIZZER_PORT=3000
export FIZZER_IMAGE=fizzer:selfhost
```

Edit `.env.selfhost` and make these entries exactly match the exported values:

```dotenv
CASCADE_PUBLIC_URL=https://fizzer-host.example.ts.net
CASCADE_ALLOWED_ORIGINS=https://fizzer-host.example.ts.net
JWT_SECRET=<output of openssl rand -hex 32>
FIZZER_DATA_DIR=/srv/fizzer/data
FIZZER_PORT=3000
FIZZER_IMAGE=fizzer:selfhost
```

`CASCADE_PUBLIC_URL` and `CASCADE_ALLOWED_ORIGINS` must be the exact HTTPS
origin clients open, including scheme and port when nonstandard. `JWT_SECRET`
is required in network mode; generate it with `openssl rand -hex 32`, then store
it only in the protected env file. The Compose file passes `FIZZER_DATA_DIR`
and `FIZZER_PORT` to the host bind mount; inside the container the service still
listens on port 3000.

Create and secure the data root before starting:

```bash
openssl rand -hex 32
sudo install -d -m 0750 -o 1000 -g 1000 "$FIZZER_DATA_DIR"
chmod 600 .env.selfhost
```

The `openssl` output above is the value to paste as `JWT_SECRET`; do not leave
the example placeholder. If the directory already contains data, reconcile its
owner and permissions rather than deleting it:

```bash
sudo chown -R 1000:1000 "$FIZZER_DATA_DIR"
sudo chmod 0750 "$FIZZER_DATA_DIR"
```

## Build and start

Build and start with the same env file every time. `--build` is for a deliberate
source rebuild; production-like image pinning is covered below.

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
curl -fsS "http://127.0.0.1:${FIZZER_PORT}/api/health"
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml ps
```

Compose fails before startup if `CASCADE_PUBLIC_URL`,
`CASCADE_ALLOWED_ORIGINS`, `JWT_SECRET`, or `FIZZER_DATA_DIR` is absent. Keep
the published bind on `127.0.0.1`; changing it to `0.0.0.0` bypasses the private
proxy boundary. Check logs without printing `.env`:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml logs --tail=100 fizzer
```

For a reproducible operator-selected image after building, set `FIZZER_IMAGE`
to an immutable local tag or digest and remove `--build`:

```bash
export FIZZER_IMAGE=fizzer:selfhost-2026-08-26
# Set FIZZER_IMAGE to the same value in .env.selfhost first.
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --no-build
```

Before switching an image, record `docker image inspect` output and keep the
previous image. To roll back, set `FIZZER_IMAGE` in `.env.selfhost` back to that
previous tag/digest and run `up -d --no-build`; then perform the health and data
checks below. This is an operator rollback, not the certified production
snapshot/rollback path.

## HTTPS and private proxy

Tailscale Serve requires the host and clients to be on the same tailnet and the
machine's HTTPS name to be enabled. Run it on the host:

```bash
tailscale serve --bg "http://127.0.0.1:${FIZZER_PORT}"
```

Use the HTTPS URL Tailscale reports as both `CASCADE_PUBLIC_URL` and
`CASCADE_ALLOWED_ORIGINS`; verify it from another tailnet device before opening
the desktop. The proxy must preserve the host and intended forwarding headers,
and port `${FIZZER_PORT}` must remain inaccessible from untrusted networks.

Fizzer defaults `CASCADE_TRUST_PROXY_HOPS` to `0`. Leave it at zero when clients
can connect directly or the proxy does not provide a trusted, known X-Forwarded-
For chain. Set `CASCADE_TRUST_PROXY_HOPS=1` in `.env.selfhost` only when exactly
one trusted proxy (such as the configured Tailscale Serve path) is guaranteed to
be the only ingress and its forwarding behavior has been verified. A nonzero
value does not authenticate arbitrary forwarded headers.

Other reverse proxies are supported only when they provide equivalent HTTPS,
origin, and access controls. The self-host Compose file does not install nginx
or obtain/renew a certificate.

## Connect the desktop

The released desktop defaults to the hosted beta. Select this instance through a
trusted local launch environment or the command line:

```bash
export FIZZER_ORIGIN=https://fizzer-host.example.ts.net
CASCADE_APP_URL="$FIZZER_ORIGIN" \
CASCADE_USER_DATA_DIR="$HOME/.config/Fizzer-selfhost" \
CASCADE_AGENT_STATE_DIR="$HOME/.local/state/Fizzer-selfhost-agents" \
fizzer-desktop
```

Alternatively pass `--instance-url="$FIZZER_ORIGIN"`. HTTPS is required except
for localhost development origins. Use distinct user-data and agent-state
directories when hosted and self-hosted identities must not share cookies or
runner state. Provider credentials stay in local agent CLIs; they are not copied
to the server.

## Backup and restore

`FIZZER_DATA_DIR` is the complete application-owned durable boundary for this
Compose deployment: SQLite, vault files, QMD indexes, and any persisted
`.cascade` files. `.env.selfhost` is outside that boundary and contains the JWT
secret and public-origin configuration; back it up separately in an encrypted
secret store. Losing the env file can invalidate sessions or prevent startup.

Stop the service and archive the exact directory selected above. The `-C` and
relative member name are computed from `FIZZER_DATA_DIR`, so arbitrary data roots
remain consistent:

```bash
BACKUP_DIR=/srv/fizzer/backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DATA_PARENT="$(dirname -- "$FIZZER_DATA_DIR")"
DATA_NAME="$(basename -- "$FIZZER_DATA_DIR")"
sudo install -d -m 0700 -o root -g root "$BACKUP_DIR"
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml stop
sudo tar --xattrs --acls -C "$DATA_PARENT" -czf "$BACKUP_DIR/data-$STAMP.tar.gz" "$DATA_NAME"
sudo tar --xattrs --acls -C "$PWD" -czf "$BACKUP_DIR/env-$STAMP.tar.gz" .env.selfhost
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml start
sudo sha256sum "$BACKUP_DIR/data-$STAMP.tar.gz" "$BACKUP_DIR/env-$STAMP.tar.gz" | sudo tee "$BACKUP_DIR/SHA256SUMS-$STAMP" >/dev/null
```

To restore, verify the archive checksum, stop Fizzer, move the current data
root aside, extract the trusted data archive into the same parent, restore the
env file separately, and reconcile ownership:

```bash
BACKUP_DIR=/srv/fizzer/backups
DATA_BACKUP="$BACKUP_DIR/data-YYYYMMDDTHHMMSSZ.tar.gz"
ENV_BACKUP="$BACKUP_DIR/env-YYYYMMDDTHHMMSSZ.tar.gz"
DATA_PARENT="$(dirname -- "$FIZZER_DATA_DIR")"
test -f "$DATA_BACKUP"
test -f "$ENV_BACKUP"
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml stop
sudo mv "$FIZZER_DATA_DIR" "${FIZZER_DATA_DIR}.before-restore-$(date -u +%Y%m%dT%H%M%SZ)"
sudo tar --xattrs --acls -C "$DATA_PARENT" -xzf "$DATA_BACKUP"
sudo tar --xattrs --acls -C "$PWD" -xzf "$ENV_BACKUP"
sudo chown -R 1000:1000 "$FIZZER_DATA_DIR"
sudo chmod 0750 "$FIZZER_DATA_DIR"
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml start
curl -fsS "http://127.0.0.1:${FIZZER_PORT}/api/health"
```

Restore `.env.selfhost` from its separately protected backup before `start` if
it was lost. Keep the displaced directory until health and a representative
vault/file check pass; do not delete it as part of an automated restore.

## Mobile access

A mobile browser can use the same HTTPS origin while connected to the tailnet.
The stock Android beta is tied to its build-time server. To build a custom APK,
set the live URL to the app path:

```bash
export FIZZER_ORIGIN=https://fizzer-host.example.ts.net
CASCADE_ANDROID_LIVE_URL="$FIZZER_ORIGIN/app.html" npm run android:apk
```

This produces `client/public/cascade-android.apk`. The current Android workflow
is a beta build/publish workflow and may skip its APK build when signing secrets
are not configured; it is not a runtime server picker or self-host deployment.
