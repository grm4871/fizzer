# Elixir compatibility and capacity harness

This directory contains the checked-in client, monitor, fault probes, soak probe,
and certification controller used to qualify the Elixir backend. It is not a
production migration tool and must never be pointed at the production database,
production data directory, or production container.

There are two evidence classes:

* **Diagnostic evidence** is produced by running an individual probe, or by the
  `diagnostic1k` wrapper profile. It is useful for debugging and smoke checks,
  but it is not a release certificate.
* **Certification evidence** is produced only by one `npm run
  release:capacity:run -- ...` invocation using `capacity-run.sh`, which invokes
  the checked-in `certification-runner.mjs`. The wrapper owns the lock, phase
  ordering, container identities, cleanup, and evidence manifest. A passing raw
  monitor, marker, fault probe, or soak probe is never certification evidence.

The commands below are written from the repository root. Replace every
`/absolute/...` value with an absolute path on the test host; do not copy a
machine-specific path from this document.

## 1. Compatibility boundary

The shipped web, Electron, and Android clients use Socket.IO protocol 5 over
Engine.IO protocol 4 at `/socket.io/`. The candidate must preserve:

* polling-first connection, WebSocket probe/upgrade, and polling-only fallback;
* `/vault`, `/runs`, and `/runners` namespaces multiplexed on one Engine.IO
  manager;
* namespace authentication from `handshake.auth.token` or the HttpOnly session
  cookie;
* rooms (`user:<id>`, `vault:<id>`, `run:<id>`, and chat-presence rooms);
* JSON events, acknowledgements, acknowledgement timeouts, and the 25 s / 60 s
  ping interval/timeout;
* reconnect and room rejoin, persisted run-event sequence numbers, and ordered
  chat persistence;
* one runner socket per owner, replacement without failing active runs, 20 s
  disconnect grace, and 120 s restart reclaim using `activeRunIds` and the stable
  Electron `runnerInstanceId`.

Phoenix Channels alone are not wire-compatible. The adapter must implement the
Engine.IO v4 / Socket.IO v5 subset, including long-polling framing and the
polling-to-WebSocket probe. `wire-contract.json`, `protocol-codec.mjs`, and
`protocol-probe.mjs` describe and exercise this boundary.

## 2. Linux/GNU prerequisites and topology

The capacity wrapper is a Linux/GNU harness, not a macOS command. It uses GNU
`bash`, `awk`, `cp`, `find`, `readlink`, and `stat`; `flock`; `taskset`; Docker;
Node/npm; Git; `sqlite3`; and `sha256sum`. The wrapper reads
`/proc/self/status` and the controller/children read `/proc/<pid>/status`, so
`/proc` must be mounted and expose `Cpus_allowed_list`. Docker must support
bind mounts, `--cpuset-cpus`, `--cpus`, `--memory`, `--pids-limit`, `--ulimit`,
`--cidfile`, labels, and `docker logs`.

The candidate container is always exactly two CPUs pinned to `0-1`, 3 GiB
memory with swap disabled, at least 100,000 PIDs, and a 200,000 soft/hard file
descriptor limit. The wrapper re-execs itself with `taskset` so the controller
and all load/monitor children run on CPUs **outside 0-1**. Set
`CASCADE_CAPACITY_GENERATOR_CPUSET` when the automatically selected CPUs are
not suitable; it must be valid `taskset` syntax and must exclude both `0` and
`1`. Keep generators on those CPUs or separate hosts. A CPU quota without
pinning is not equivalent: BEAM scheduler utilization would be ambiguous.

The wrapper requires an owned mode-700 `$XDG_RUNTIME_DIR` (or
`/run/user/<uid>`) and creates `cascade-elixir-capacity.lock` there with mode
600. `flock` is acquired before the first Docker or data mutation. Results and
phase data must be on disk-backed storage. The controller creates a private,
owned mode-700 `sqlite-snapshot-scratch` directory under the results root and
requires at least 2 GiB free; do not put results on tmpfs or `/tmp`.

Reflinks are not required. Phase clones deliberately use GNU
`cp -a --reflink=never` and the wrapper verifies distinct device/inode identities
for each phase database. Reflink-capable storage may be used for an upstream
approved snapshot, but it must not cause phase databases to share an inode.

Before starting, use an isolated host/namespace and verify the candidate
endpoint is loopback-only for the wrapper (for example, the wrapper's default
`http://127.0.0.1:<host-port>` target). Never weaken the production nginx
per-source-address limit or enable arbitrary forwarded-address trust.

## 3. Production-derived fixture and source preparation

Certification needs four immutable inputs:

1. an approved, closed SQLite source snapshot (`docs.db`),
2. an approved corpus root containing `vaults/` and `qmd/`,
3. a fixture JSONL file containing synthetic authenticated users, and
4. a clean checkout and immutable image.

The source database/corpus are provenance inputs, not output destinations. Use
an approved production-derived snapshot process with the privacy policy already
applied. Do not copy private credentials, tokens, personal exports, logs, or
unapproved files into the source tree. The certifier compares approved logical
rows, schema, FTS integrity, and corpus records, so do not hand-edit or redact
an approved snapshot after it is approved; create a new approved snapshot
instead. Keep the source database, corpus, and fixture outside the results and
phase roots, readable only by the operator/service account. Do not print their
contents or commit them.

The checked-in Elixir task is `backend_elixir/lib/mix/tasks/cascade.load_fixtures.ex`.
It generates one JSON object per user and creates 25-user vault/channel groups.
It refuses to run without `CASCADE_ALLOW_LOAD_FIXTURES=1`, refuses `/data` and
`/var/lib/cascade` (including aliases), requires
`CASCADE_VAULTS_BASE_DIR`, and requires the exact runtime persisted path
`/data/.cascade/vaults`. A non-empty copied database also requires a regular
`.cascade-load-fixtures-disposable` file containing exactly
`cascade-load-fixtures-disposable` (the task trims a final newline).

Prepare a fresh template for each profile. The following is a procedure, not a
new script; all invoked tools and options are current repository interfaces:

```bash
export CASCADE_ROOT=/absolute/path/to/cascade-browser
export CAPACITY_PREP=/absolute/path/to/private/capacity-prep
export CAPACITY_SOURCE_DB=/absolute/path/to/approved/docs.db
export CAPACITY_SOURCE_CORPUS=/absolute/path/to/approved/corpus
export CAPACITY_JWT_SECRET='use-the-retained-private-fixture-secret'

install -d -m 700 "$CAPACITY_PREP/final-template/.cascade/vaults" \
  "$CAPACITY_PREP/final-template/.cascade/qmd"
cp --reflink=never -- "$CAPACITY_SOURCE_DB" \
  "$CAPACITY_PREP/final-template/docs.db"
cp -a --reflink=never "$CAPACITY_SOURCE_CORPUS/vaults/." \
  "$CAPACITY_PREP/final-template/.cascade/vaults/"
cp -a --reflink=never "$CAPACITY_SOURCE_CORPUS/qmd/." \
  "$CAPACITY_PREP/final-template/.cascade/qmd/"
printf '%s\n' cascade-load-fixtures-disposable > \
  "$CAPACITY_PREP/final-template/.cascade-load-fixtures-disposable"

cd "$CASCADE_ROOT/backend_elixir"
CASCADE_ALLOW_LOAD_FIXTURES=1 \
CASCADE_SERVER=false \
CASCADE_QMD_WORKER_ENABLED=false \
DOCS_DB_PATH="$CAPACITY_PREP/final-template/docs.db" \
CASCADE_DATA_DIR="$CAPACITY_PREP/final-template" \
CASCADE_VAULTS_BASE_DIR="$CAPACITY_PREP/final-template/.cascade/vaults" \
CASCADE_QMD_DIR="$CAPACITY_PREP/final-template/.cascade/qmd" \
JWT_SECRET="$CAPACITY_JWT_SECRET" \
mix cascade.load_fixtures --users 10000 --prefix capacity \
  --persisted-vaults-base-dir /data/.cascade/vaults \
  --output "$CAPACITY_PREP/fixtures-10k.jsonl"
```

Use a separate fresh copy, output file, and prefix such as `diagnostic` for a
1,000-user diagnostic. Do not append diagnostic users to the final template.
Every final fixture must have exactly 10,000 lines, 10,000 distinct JWT user
IDs/tokens/usernames, 400 distinct vault/channel groups, 25 users per group,
one owner per group, and `runner: true` for every line. The diagnostic shape is
1,000 users and 40 groups. `load.mjs` and `deploy/certified-image.mjs` perform
these checks; the final wrapper does not accept a partial fixture.

After provisioning, close/check the copied database before handing it to the
wrapper. Run `PRAGMA wal_checkpoint(TRUNCATE);`, `PRAGMA quick_check;`, and
`PRAGMA foreign_key_check;` with `sqlite3`; require `ok`, no foreign-key rows,
and no `docs.db-wal` or `docs.db-shm`. Record `sha256sum` for `docs.db` and the
fixture JSONL. Never put the JWT secret in a command-line argument or artifact;
`capacity-run.sh` requires `CAPACITY_JWT_SECRET` and
`CAPACITY_RELEASE_COOKIE` in the environment.

## 4. Diagnostics (never a certificate)

Run the harmless reference smoke from the repository root with the actual
subpackage scripts:

```bash
npm --prefix loadtest_elixir run smoke:reference
npm --prefix loadtest_elixir test
```

The smoke covers Engine.IO v3 rejection, Engine.IO v4 polling framing,
bearer/cookie authentication, invalid-auth errors, namespace multiplexing,
runner registration, and WebSocket probing. The test command covers the
checked-in unit tests. These commands do not certify an image.

A raw protocol probe is also diagnostic:

```bash
node loadtest_elixir/protocol-probe.mjs \
  --target https://candidate.example \
  --token "$STAGING_USER_TOKEN" \
  --vault-id "$STAGING_VAULT_ID" \
  --channel-id "$STAGING_CHANNEL_ID"
```

For a disposable running candidate, `load.mjs` can be run directly. Use four
whole-group shards and unique genuine source addresses. Its output is a shard
JSON file; direct output is not bound to the certification journal or image
manifest:

```bash
node loadtest_elixir/load.mjs \
  --target http://127.0.0.1:39094 \
  --fixtures /absolute/path/fixtures-10k.jsonl \
  --users 2500 --shard-index 0 --shard-count 4 \
  --ramp-seconds 300 --soak-seconds 1860 \
  --chat-rps 6.25 --read-rps 12.5 --run-rps 0.25 \
  --source-ip 192.0.2.10 --polling-percent 5 --reconnect-percent 10 \
  --reconnect-at-seconds 600 --output /absolute/path/diagnostic-shard-0.json
```

Direct `monitor.mjs` and `write-workload-marker.mjs` invocations are likewise
diagnostic only. The monitor must be started before shards, and the marker must
be fresh, written only after all shard results pass, and written while the
monitor is still running. `monitor.mjs` captures the container log when given
`--server-log-output`; it evaluates the configured headroom window but cannot
supply the wrapper's phase identity, journal, or final image certificate.

Direct `runner-restart-recovery.mjs`, `sqlite-lock-recovery.mjs`, and
`soak-invariants.mjs` invocations are fault/soak diagnostics only. They require
an isolated running candidate and fresh output files. The soak command is
available as the root `release:soak:invariants` script; profile overrides are
rejected by the script:

```bash
node loadtest_elixir/runner-restart-recovery.mjs \
  --target http://127.0.0.1:39094 --fixtures /absolute/path/fixtures-10k.jsonl \
  --container "$ISOLATED_CONTAINER" \
  --output /absolute/path/runner-restart-diagnostic.json

node loadtest_elixir/sqlite-lock-recovery.mjs \
  --target http://127.0.0.1:39094 --fixtures /absolute/path/fixtures-10k.jsonl \
  --container "$ISOLATED_CONTAINER" --db-path /absolute/path/docs.db \
  --output /absolute/path/sqlite-lock-diagnostic.json

npm run release:soak:invariants -- \
  --target http://127.0.0.1:39094 --fixtures /absolute/path/fixtures-10k.jsonl \
  --container "$ISOLATED_CONTAINER" --expected-image "$IMAGE_ID" \
  --expected-revision "$REVISION" --source-ip 192.0.2.20 \
  --output /absolute/path/soak-diagnostic.json
```

`edge-limit-proof.mjs` can prove the configured 40-connection per-source
Socket.IO limit against an isolated edge, and `edge-nginx-main.conf` documents
the production template. It is separate diagnostic/manual edge evidence, not a
substitute for the backend certificate.

## 5. Canonical certification

The only release evidence path is the wrapper invocation documented in
`CAPACITY_TELEMETRY.md`. Run one `npm run release:capacity:run -- ...` command
from a clean checkout. It invokes only the checked-in
`loadtest_elixir/certification-runner.mjs` after `--`; do not replace it with a
shell loop or ad-hoc Docker commands. The wrapper refuses existing reserved
containers, stale destinations, mutable image tags, dirty checkouts, unsafe
runtime directories, and production paths.

The final profile runs sequentially and uses pairwise-distinct phase clones and
containers:

1. **A / `main10k`:** preflight the never-started candidate, run four 2,500-user
   shards, monitor 2,250 seconds, write the marker, stop/checkpoint, reconcile,
   and freeze.
2. **B / `faults`:** create/preflight a new candidate from the same image and
   template, run runner-restart and SQLite-write-lock recovery, stop/checkpoint,
   and freeze.
3. **C / `soak5k`:** create/preflight a third candidate, run the fixed 5,000-user
   two-hour soak, stop/checkpoint, and freeze.
4. **Certification:** `deploy/certified-image.mjs certify` independently reopens
   all bound inputs and phase evidence, then writes `certification.json` and its
   checksum. The command manifest is written only after every phase completes.

Raw probe output cannot be copied into these names to bypass a phase. The
controller checks tool hashes, input hashes, container IDs, image ID, full Git
revision, runtime shape, phase ordering, workload identity, database inode and
hash, corpus evidence, and the hash-chained command journal.

## 6. Gates and manual review

The fixed final workload is 10,000 authenticated users: 300-second ramp,
1,860-second soak, 5% polling-only, 10% owner-stratified forced reconnect at
600 seconds, 25 chat writes/s, 50 list reads/s, and 1 delegated run/s in total.
It proves 10,000 Engine.IO connections, 20,000 namespace sockets (30,000 when
all fixtures have runners), four complete 25-user groups per shard partition,
and exact sender/peer, ordering, run-event, and reconnect identity evidence.

The monitor's bound 1,800-second window must meet connect success >=99.9%, HTTP
errors <=0.1%, p99 connect <=5 s, p99 read/write/event <=1 s, CPU <=70%, memory
<=70% of 3 GiB, scheduler utilization <=80%, pool utilization <=80%, checkout
p99 <=50 ms, query p99 <=100 ms, no DB/busy/locked errors, no restart/OOM, and
stable process/mailbox/ETS/WAL/file-descriptor state. Reconnects must be >=99%
within 10 s and 100% within 20 s. Run and persisted event IDs must reconcile;
`2:status:running`, `3:text`, `4:status:completed` must occur once and in order.

Fault recovery must bound failure to 429/503 rather than phantom success or
mailbox growth, recover writes after the SQLite lock, reclaim active runs within
120 s after restart, delegate each run once, and leave one terminal state. The
soak must hold its exact 5,000-user/300-second-ramp/7,200-second profile with
10% churn every 300 s, return BEAM/ETS/memory/open-file/pool state to baseline
for three samples, and produce its raw sample journal and container log.

OpenTelemetry, BEAM dashboards, SQLite/WAL dashboards, nginx, and load-balancer
exports are **manual review** unless a current checked-in command explicitly
binds and hashes them into certification evidence. Client numbers or a pasted
external dashboard cannot upgrade a diagnostic run into a certificate. The
production edge allows 40 Socket.IO connections per `$binary_remote_addr`; an
`X-Forwarded-For` header does not create a source address. Ten thousand
unmodified-edge connections require at least 250 genuine source addresses plus
margin, or must be reported as a separate staging/manual proof.

Only after `certification.json` verifies successfully should the immutable
manifest/image be staged with `npm run release:image:stage-certified -- \
  /absolute/path/to/results-final10k/certification.json "$CASCADE_DEPLOY_SSH_HOST"`.
The staging helper requires a configured SSH host. Production must load the
staged immutable ID with `--no-build`; never rebuild or retag after
certification.
