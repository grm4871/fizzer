# Elixir cutover compatibility and capacity proof

This directory is deliberately independent of both backends. It drives the
released `socket.io-client` used by Cascade plus the public HTTP API, so the
same command can measure the Node reference server and the Elixir candidate.
It does not modify production data or deployment files.

## The compatibility boundary

The existing web, Electron, and Android clients speak Socket.IO protocol 5 over
Engine.IO protocol 4 at the default `/socket.io/` path. They rely on:

- polling-first connection with WebSocket upgrade and polling-only fallback;
- `/vault`, `/runs`, and `/runners` namespaces on one multiplexed Engine.IO
  connection;
- namespace auth from either `handshake.auth.token` or the HttpOnly session
  cookie;
- rooms (`user:<id>`, `vault:<id>`, `run:<id>`, and chat-presence rooms);
- JSON events, Socket.IO acknowledgements and acknowledgement timeouts;
- 25 s ping interval, 60 s ping timeout, infinite client reconnect, and room
  rejoin after reconnect;
- server-persisted run-event sequence numbers and chat persistence ordering;
- one runner socket per owner, replacement without failing active runs, 20 s
  disconnect grace, and 120 s server-restart reclaim using `activeRunIds` plus
  the stable Electron `runnerInstanceId`.

Phoenix Channels are not wire-compatible with Socket.IO. The safest Elixir edge
is a custom, tested Engine.IO v4 / Socket.IO v5 adapter on Bandit (or Cowboy)
that implements the small protocol subset above. Do not change the released
clients during the backend swap. In particular, the adapter must cover long
polling payload framing and WebSocket probe/upgrade, not only WebSockets.

Keep connection/session processes transport-only. Put room membership in
Registry/PubSub, persist before broadcast, and use a durable database lease for
runner ownership. A runner event is accepted only when the persisted owner
matches. Terminal status and session ID commit in one transaction before the
event is published. Chat ordering should be a server-assigned monotonic
`BIGINT` per channel (or a global database sequence exposed as `message.seq`),
never client wall-clock order.

## Fixture contract

The load driver reads JSON Lines with one real staging account per line:

```json
{"token":"...","vaultId":"...","channelId":"...","ownedChatChannels":1,"runner":true,"runIds":[]}
```

Provision fixtures with the guarded Elixir task against an isolated staging
database. It creates groups of 25 distinct authenticated users sharing a real
vault/channel, refuses `/data` and `/var/lib/cascade`, and records the certified
container vault prefix while writing files only into the isolated host tree:

```bash
mkdir -p /tmp/cascade-capacity/data/.cascade/{vaults,qmd}
: "${CAPACITY_JWT_SECRET:?set the retained private fixture JWT secret}"
cd backend_elixir
CASCADE_ALLOW_LOAD_FIXTURES=1 \
CASCADE_SERVER=false \
CASCADE_QMD_WORKER_ENABLED=false \
DOCS_DB_PATH=/tmp/cascade-capacity/data/docs.db \
CASCADE_DATA_DIR=/tmp/cascade-capacity/data \
CASCADE_VAULTS_BASE_DIR=/tmp/cascade-capacity/data/.cascade/vaults \
CASCADE_QMD_DIR=/tmp/cascade-capacity/data/.cascade/qmd \
JWT_SECRET="$CAPACITY_JWT_SECRET" \
mix cascade.load_fixtures --users 10000 \
  --persisted-vaults-base-dir /data/.cascade/vaults \
  --output /tmp/cascade-capacity/fixtures.jsonl
```

Using distinct accounts matters: reusing one token 10,000 times proves only
connection count, not 10,000-user authentication, authorization, database, or
presence behavior. Never generate these fixtures in production.

## Commands

The harness itself and a small known-good Node reference smoke are runnable now:

```bash
cd /home/jt/Desktop/cascade/loadtest_elixir
npm test
npm run smoke:reference
```

The smoke first runs a raw wire probe: Engine.IO v3 rejection, Engine.IO v4
polling framing, bearer and HttpOnly-cookie namespace auth, exact invalid-auth
errors, multiplexed namespace connect, runner registration, and the
polling-to-WebSocket `probe` upgrade. The codec golden tests cover the event
and acknowledgement frames (`42...` / `43...`) the Elixir adapter must emit and
parse. `wire-contract.json` is the machine-readable subset.

Run the raw probe directly against a provisioned candidate:

```bash
node loadtest_elixir/protocol-probe.mjs \
  --target https://elixir-staging.example \
  --token "$STAGING_USER_TOKEN" \
  --vault-id "$STAGING_VAULT_ID" \
  --channel-id "$STAGING_CHANNEL_ID"
```

One load-generator shard:

```bash
node loadtest_elixir/load.mjs \
  --target https://elixir-staging.example \
  --fixtures /secure/cascade-load-fixtures.jsonl \
  --users 2500 \
  --shard-index 0 --shard-count 4 \
  --ramp-seconds 300 --soak-seconds 1860 \
  --chat-rps 6.25 --read-rps 12.5 --run-rps 0.25 \
  --source-ip 192.0.2.10 \
  --polling-percent 5 --reconnect-percent 10 \
  --output /tmp/cascade-load-shard-0.json
```

Run four generators with shard indexes 0-3. The rates above are per shard and
sum to 25 chat writes/s, 50 message-list reads/s, and 1 synthetic desktop run/s.
Sharding assigns whole vault/channel groups, never individual rows, so every
25-member broadcast recipient is measured by the process that created the
message.
Each user multiplexes all applicable namespaces through one Engine.IO manager,
matching the shipped client. Five percent remain on polling to exercise the
fallback path, and ten percent are disconnected together for the reconnect
gate. The driver waits for every scheduled operation, applies bounded
request/drain timeouts, and fails if it schedules, attempts, completes, or
succeeds at less than the configured workload. It separately proves initial
WebSocket upgrades, realtime sender and peer delivery, persisted run terminal
events, and namespace-authenticated reconnects; HTTP reconciliation cannot hide
a broken realtime path.

Production nginx intentionally limits one real source address to 40 concurrent
Socket.IO connections. `--source-ip` sets `X-Forwarded-For` for a directly
trusted staging backend; it does not and must not bypass nginx's
`$binary_remote_addr` limit. An end-to-end production-edge 10,000-connection
test therefore needs at least 250 genuine source addresses, or an isolated
staging-only nginx config with the per-address connection ceiling raised. Do
not enable arbitrary forwarded-address trust or weaken the production limit.

## Required acceptance gates

Run all gates against a production-shaped staging environment and the exact
release image/config:

Build that image once from the clean release commit with
`npm run release:image:build`. Pass its immutable `sha256:...` ID to the monitor
with `--expected-image`; do not rebuild after the run. The release monitor must
run for at least 2,250 seconds, bind the four exact 2,500-user shard artifacts,
and evaluate a 1,800-second window ending at the earliest shard's
`workloadFinishedAt`. Every shard's `soakStartedAt` must precede that window and
every `workloadFinishedAt` must reach its end. The checksummed workload marker must
be created fresh during that monitor and leave at least 30 seconds of
post-workload observation. After all monitor and load-shard outputs pass,
certify them with:

The release proof must run through the single outer `capacity-run.sh` invocation
documented in `CAPACITY_TELEMETRY.md`. The wrapper holds the host-global lock for
the entire qualification and invokes only the checked-in
`certification-runner.mjs`. Never pre-clean by name or by a Docker name filter;
an existing reserved capacity container is foreign state and fails closed.
Phase A alone uses the exact ID exposed while the monitor and shards run.

```bash
node loadtest_elixir/monitor.mjs \
  --container "$CASCADE_CAPACITY_CONTAINER_ID" \
  --output /secure/capacity/monitor.jsonl \
  --duration-seconds 2250 --gate-window-seconds 1800 \
  --expected-image "$IMAGE_ID" \
  --expected-cpus 2 --expected-memory-gib 3 \
  --expected-sessions 10000 --expected-runners 10000 \
  --expected-memberships 50000 \
  --expected-sqlite-pool-size 20 \
  --workload-finished-marker /secure/capacity/workload-finished.json \
  --minimum-workload-seconds 2160 --minimum-post-workload-seconds 30 \
  --expected-load-target "$CASCADE_CAPACITY_TARGET" \
  --expected-shard-count 4 \
  --expected-ramp-seconds 300 --expected-soak-seconds 1860 \
  --expected-polling-percent 5 --expected-reconnect-percent 10 \
  --expected-reconnect-at-seconds 600 \
  --expected-source-ips 192.0.2.10,192.0.2.11,192.0.2.12,192.0.2.13 \
  --expected-chat-rps 6.25 --expected-read-rps 12.5 --expected-run-rps 0.25
```

Start the monitor before the four load generators. Once all four shard files
exist and passed, create the marker on the monitor's evidence filesystem while
the monitor is still running:

```bash
node loadtest_elixir/write-workload-marker.mjs \
  --output /secure/capacity/workload-finished.json \
  --expected-shards 4 \
  --shard /secure/capacity/shard-0.json \
  --shard /secure/capacity/shard-1.json \
  --shard /secure/capacity/shard-2.json \
  --shard /secure/capacity/shard-3.json
```

The marker writer checks every shard result and checksum, creates the file
atomically, and refuses to replace a stale marker. Let the monitor finish its
post-workload interval before certification.

After phase A is stopped, checkpointed, reconciled, and frozen, the wrapper
creates a separate production-shaped phase B data clone and never-started
container from the same image. The checked-in controller preflights it, starts
it, and records the certification-bound runner-restart and SQLite write-lock
recovery gates. Both commands refuse the production container/data mount and
refuse to overwrite an earlier result:

```bash
node loadtest_elixir/runner-restart-recovery.mjs \
  --target "$CASCADE_CAPACITY_TARGET" \
  --fixtures /secure/capacity/fixtures.jsonl \
  --container "$CASCADE_CAPACITY_CONTAINER_ID" \
  --output /secure/capacity/runner-restart.json

node loadtest_elixir/sqlite-lock-recovery.mjs \
  --target "$CASCADE_CAPACITY_TARGET" \
  --fixtures /secure/capacity/fixtures.jsonl \
  --container "$CASCADE_CAPACITY_CONTAINER_ID" \
  --db-path "$CASCADE_CAPACITY_DATA_DIR/docs.db" \
  --output /secure/capacity/sqlite-lock.json
```

After phase B is stopped, checkpointed, and frozen, the wrapper creates a third
fresh data clone and never-started phase C container from the same immutable
image. The controller runs the exact 5,000-user/two-hour soak in **Soak
invariants**, stops and freezes C, then invokes the image certifier with all
three preflights/freezes, A's runtime proof/monitor/four shards/reconciliation,
B's two fault results, and C's soak result. It produces
`soak-invariants.json`, its checksummed sample journal, and the final
certification manifest without reusing any phase's container or data root.

This binds the monitor, load, fault, two-hour soak, and raw soak-journal
SHA-256 evidence to the image ID, full Git revision,
pinned-base build, and embedded cutover gate. Stage that manifest/image with
`npm run release:image:stage -- <manifest>` before pushing. Production loads
and promotes the staged ID with `--no-build`; a missing, different, corrupted,
or incomplete certification fails before maintenance.

1. **Golden parity:** every existing server/e2e test passes unchanged against
   Elixir. Record and replay HTTP requests and Socket.IO packets from Node and
   compare status, headers, canonical JSON, event names/payloads, namespace
   errors, acknowledgements, and ordering. Ignore only nondeterministic IDs and
   timestamps. Cookie auth, bearer auth, polling-only, and WebSocket upgrade are
   separate cases.
2. **10,000-user soak:** ramp for 300 seconds, then keep 10,000 authenticated
   users concurrently connected for 1,860 seconds, including a literal
   1,800-second monitor gate; prove 10,000
   Engine.IO connections, 20,000 namespace sockets for web or 30,000 when every
   fixture includes a desktop runner. Connect success >=99.9%; HTTP error rate
   <=0.1%; p99 connect <=5 s; p99 list/write/event delivery <=1 s; no missing
   sender receipt, duplicate create event, or ordering violation.
3. **Headroom:** throughout the bound 30-minute concurrent gate, app CPU <=70%, memory <=70% of its
   limit, scheduler utilization <=80%, run queue not persistently above online
   schedulers, process/mailbox counts stable, SQLite checkout wait p99 <=50 ms,
   query p99 <=100 ms, pool utilization <=80%, and no sustained growth in write
   lock waits, queue, WAL, checkpoint time, or disk latency.
4. **Reconnect storm:** force 10% of clients off simultaneously. >=99% reconnect
   and rejoin rooms within 10 s and 100% within 20 s. No lost persisted messages,
   duplicate broadcasts, presence left online after the final socket, or room
   authorization bypass. The fixed `owner-stratified-v1` selector includes an
   exact proportional sample of presence owners: 10 unique owner IDs per
   2,500-user shard, 40 globally. Selection, presence, workload-marker, monitor,
   and certificate evidence must bind the same IDs; an all-owner, empty, skewed,
   or duplicate-owner cohort is invalid.
5. **Runner recovery:** a disconnect shorter than 20 s fails zero runs. Restart
   the Elixir server with active fake runners; all reported `activeRunIds` are
   reclaimed within the 120 s window, no run is delegated twice, session events
   persist before a steering continuation, and each run has one terminal state.
   A changed `runnerInstanceId` fails exactly the omitted runs; an unchanged ID
   does not.
6. **Dependency failure:** kill the app node, hold a SQLite write lock, delay or
   deny the database volume, fill the checkout pool, and interrupt the edge.
   Requests must shed load with a bounded 503/429 instead of accumulating
   mailboxes. Persisted messages replay after recovery; uncommitted messages are
   explicit failures, never phantom successes.
7. **Soak invariants:** repeat for two hours at 5,000 users with periodic socket
   churn and run events. BEAM process count, ETS, memory, open files, and DB pool
   queues return to baseline after clients leave.

The checked-in controller runs the soak-invariant proof in isolated phase C
after phase A is reconciled/frozen and phase B's recovery gates pass. The
command refuses reused identities, non-runner fixtures, a container outside the
2-CPU/3-GiB release envelope, and an image ID other than the requested immutable
`sha256:...` ID:

```bash
npm run release:soak:invariants -- \
  --target "$CASCADE_CAPACITY_TARGET" \
  --fixtures /secure/cascade-load-fixtures.jsonl \
  --container "$CASCADE_CAPACITY_CONTAINER_ID" \
  --expected-image "$IMAGE_ID" \
  --expected-revision "$(git rev-parse HEAD)" \
  --source-ip 192.0.2.20 \
  --output /secure/capacity/soak-invariants.json
```

The release profile is fixed, not tunable: exactly 5,000 authenticated users,
a 300-second ramp, 7,200-second soak, five-second samples, 10% churn every 300
seconds, one real delegated run per second, and three consecutive recovery
samples. Profile overrides are rejected before the run starts. The candidate
must have the same exact 2-CPU/3-GiB host envelope and effective application
configuration used by the 10,000-user gate. Wall-clock ramp timestamps must
prove completion in 300-310 seconds; a slow serial connection loop cannot hide
behind the configured ramp value. Fixtures must form exactly 200 complete
25-user groups with exactly one presence owner per group. The 23 churn cycles
walk ten deterministic, identity-digested 500-user cohorts, proving all 5,000
users churn twice and the first three cohorts churn a third time.

A run counts only when the requested, delegated, live-complete, terminal, and
post-run HTTP/SQLite run-ID sets are identical; persisted event sequences must
be contiguous and contain queued, running, text, and completed exactly once.
The live socket proof separately binds every run to exact sequence 2 running,
3 text, and 4 completed, so a gap cannot be hidden by a valid persisted replay.
Every sample
rechecks immutable container/image/start/revision identity, zero restarts/OOMs,
the production resource/config shape, headroom, DB queue/query/write-lock
latency and errors, busy/locked errors, mailboxes, and WAL size/growth. After
all clients leave, three consecutive samples must return sessions, runners,
memberships, pool state, BEAM processes, ETS, memory, and files to the bound
pre-load envelope. User/vault/membership counts must remain unchanged, run and
event deltas must reconcile, delegated runs must return to baseline, SQLite
foreign keys and `quick_check` must pass, the capacity probe must uninstall,
and the server-log interval from immutable container start through soak finish
must contain zero fatal/error lines. Simultaneous teardown must produce exactly
one disconnect flush covering 99-100% of owners and exactly one delegated-run
snapshot, zero per-owner reads, and a drained dispatcher with no noop/start/task
failures. A post-uninstall snapshot must explicitly report that the probe is no
longer installed.

The command creates three mode-0600 artifacts:
`soak-invariants.json`, `soak-invariants.json.samples.jsonl`, and
`soak-invariants.json.container.log`. Certification reopens those files plus
the fixture JSONL without following symlinks, binds their SHA-256/byte/line
identities, parses the raw journal, and independently recomputes its aggregates
and gates. This mandatory durability proof is additional to—and can never
replace—the exact 10,000-user/30-minute capacity certificate.

The default driver thresholds are the user-facing gates above. Infrastructure
headroom and recovery invariants must be collected from OpenTelemetry/BEAM,
SQLite/WAL telemetry, nginx/load balancer, and the fixture verifier; a
client-only number is not a capacity proof.

## Production path and cutover

The release envelope is exact: 2 CPUs pinned to `0-1`, 3 GiB memory with no
additional swap, 100,000 PIDs, and a 200,000-file descriptor limit. This leaves
roughly 0.8 GiB of the current 3.8 GiB host outside the app container. Compose,
the isolated deploy preflight, and the running candidate are all inspected
against that same shape before traffic opens. Any resource change requires a
fresh certification; do not treat a larger unmeasured container as equivalent.
Preserve SQLite and the existing file schema for the first candidate rather
than introducing a distributed database during the parity cutover. Use
`worker_rlimit_nofile`/systemd limits >=200,000 and at least 65,536 nginx worker
connections, then verify actual process limits and ports.

For a lossless data swap, first shadow reads and compare Node/Elixir results.
Then stop accepting new mutations and runs, let active runs settle, checkpoint
SQLite WAL, take a recoverable snapshot, validate row counts plus per-table
checksums and foreign keys, and atomically switch the upstream while retaining
the exact existing database and file layout. Keep the old server image and the
pre-cutover snapshot for rollback. Do not dual-write application tables in two
independently implemented backends: partial success makes rollback ambiguous.

The Elixir server must start and accept runner reclaim comfortably inside 120 s.
Only lift the mutation drain after the new health, parity smoke, data checks,
Socket.IO namespace smoke, and fresh chat/run round trip all pass. Roll back the
upstream—not the database—if any gate fails before new writes are enabled.
