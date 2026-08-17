# Self-hosting Fizzer

This path runs one private Fizzer instance on a host you control. It keeps the
service bound to loopback; use a private-network HTTPS proxy such as Tailscale
Serve to reach it. It does not use Fizzer's maintainer deployment machinery.

## Build and start

Prerequisites: Git, Docker with Compose, an HTTPS hostname that reaches the
host, and a durable absolute directory for application data.

```bash
git clone https://github.com/grm4871/fizzer.git
cd fizzer
cp .env.selfhost.example .env.selfhost
openssl rand -hex 32
```

Edit `.env.selfhost`: set `CASCADE_PUBLIC_URL` and
`CASCADE_ALLOWED_ORIGINS` to the exact HTTPS origin users will open, paste the
generated value into `JWT_SECRET`, and set `FIZZER_DATA_DIR` to an absolute
host directory. Then:

```bash
mkdir -p /srv/fizzer/data
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml up -d --build
curl -fsS http://127.0.0.1:3000/api/health
```

Compose fails before startup when any required value is absent. The published
port remains on `127.0.0.1`; do not change it to `0.0.0.0` merely to make a
private-network hostname work. Terminate HTTPS on a local reverse proxy.

For Tailscale Serve, connect the host and clients to the same tailnet, enable
HTTPS for the machine name, and proxy its HTTPS origin to
`http://127.0.0.1:3000`. For example, with a current Tailscale CLI:

```bash
tailscale serve --bg http://127.0.0.1:3000
```

Use the HTTPS URL reported by Tailscale as both Fizzer origin settings. Verify
the URL from another connected tailnet device before configuring the desktop.

## Connect the desktop

The released desktop defaults to the hosted beta. Select this instance only
through a trusted local launch environment or command line:

```bash
CASCADE_APP_URL=https://fizzer-host.example.ts.net \
CASCADE_USER_DATA_DIR="$HOME/.config/Fizzer-selfhost" \
CASCADE_AGENT_STATE_DIR="$HOME/.local/state/Fizzer-selfhost-agents" \
fizzer-desktop
```

Alternatively pass `--instance-url=https://fizzer-host.example.ts.net`.
HTTPS is required except for `http://localhost`, `127.0.0.1`, or `[::1]`
development origins. The selected origin is pinned in Electron main: renderer
navigation and local runner/helper traffic cannot retarget it.

Use distinct `CASCADE_USER_DATA_DIR` and `CASCADE_AGENT_STATE_DIR` values when
the hosted and self-hosted identities must not share cookies or runner state.
Provider credentials remain in the local agent CLIs and are not copied to the
server.

## Back up and restore

The directory named by `FIZZER_DATA_DIR` is the complete durable boundary,
including SQLite and vault files. Stop the service so the database and files
form one consistent snapshot:

```bash
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml stop
sudo tar --xattrs --acls -C /srv/fizzer -czf "fizzer-backup-$(date +%F).tar.gz" data
docker compose --env-file .env.selfhost -f docker-compose.selfhost.yml start
```

To restore, stop Fizzer, move the current data directory aside, extract a
trusted backup into the same parent directory, preserve its ownership and
permissions, start Fizzer, and verify `/api/health` plus a representative vault.
Keep the displaced directory until that verification passes.

## Mobile access

Mobile browsers can use the same HTTPS URL while connected to the tailnet. The
stock Android beta remains tied to its build-time server. To build a custom APK:

```bash
CASCADE_ANDROID_LIVE_URL=https://fizzer-host.example.ts.net/app.html npm run android:apk
```

This produces `client/public/cascade-android.apk`. A runtime server picker is
outside the current self-hosting scope.
