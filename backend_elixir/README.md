# Cascade Elixir backend

This is Cascade's production HTTP and Socket.IO backend. It opens the SQLite
database and preserves the existing table, bcrypt, JWT, cookie, security-header,
health-response, Vite cache, and SPA fallback contracts.

The 167-route HTTP inventory and Socket.IO 4.x namespaces (`/runs`, `/vault`,
and `/runners`) have native implementations. Unsupported `/api/*` requests
still return `501`; they never return placeholder success. Production cutover
remains fail-closed until the production-shaped capacity manifest is certified,
staged, and verified against the exact release image.

## Development

```sh
mix deps.get
mix check
API_PORT=3000 DOCS_DB_PATH=/path/to/copy.db mix run --no-halt
```

Use a copy of production data until the full shadow-read and migration suite is
green. The raw-SQL migration runner has its own checksum ledger and does not use
Ecto schemas, preserving compatibility with the existing database.

## Capacity controls

The HTTP listener uses BEAM processes and exposes bounded knobs rather than an
unlimited queue:

- `CASCADE_HTTP_ACCEPTORS` (default: scheduler count, minimum 4)
- `CASCADE_HTTP_MAX_CONNECTIONS` (default: 16,384)
- `CASCADE_SQLITE_POOL_SIZE` (default: 20; SQLite writes still serialize)
- `CASCADE_SQLITE_BUSY_TIMEOUT_MS` (default: 5,000)
- `CASCADE_REALTIME_HIBERNATE_AFTER_MS` (default: 5,000; bounds idle session
  memory while retaining namespace and room state)
- `CASCADE_RUNNER_ORPHAN_RECLAIM_MS` (default: 120,000; production uses
  600,000 so gated cutover verification does not consume the reclaim window)

The target is 10,000 connected users. No capacity claim or production swap is
valid until the exact release image passes the representative 10,000-user soak
and latency/error-budget gate against production-shaped data.

## Domain authentication boundary

All authenticated controllers use `CascadeWeb.Auth.require/2` (or that module
as a Plug). It assigns `:current_user`, `:auth_access`, `:auth_source`, and
`:auth_token`; restricts agent tokens to the existing capability route list;
recursively redacts private blocks from agent JSON; and fails every mutation
closed unless the controller supplies a vault-aware `mutation_gate` function
or the explicit `:not_vault_scoped` marker.

Run `mix cascade.parity` to verify the implementation inventory embedded in the
image. That command deliberately does not claim capacity: certification binds
the real 10,000-user evidence to the image ID, and deployment refuses to point
production at the service without the matching staged manifest.
