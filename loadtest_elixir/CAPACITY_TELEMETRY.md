# 10,000-user capacity telemetry

This is the server-side half of the capacity proof. Run it only against an
isolated staging database and the immutable image being certified. The client
load result and this monitor result must both pass; neither substitutes for the
other.

## Candidate shape

Use an isolated staging host with enough resources for the candidate and load
generators, but constrain the candidate to the exact production envelope: two
CPUs pinned to `0-1`, 3 GiB memory with no additional swap, 100,000 PIDs, and
200,000 open files. Pin the CPUs as well as applying the quota: a quota alone
can leave all host schedulers online in the BEAM and makes normalized
utilization misleading. Keep generators off CPUs `0-1` (or on separate hosts)
so their resource use is not charged to the candidate or mistaken for server
headroom.

Do not start or clean up a candidate with ad hoc Docker commands. The outer
`capacity-run.sh` boundary holds one host-global lock before any Docker or data
mutation and runs only the checked-in `certification-runner.mjs`. It refuses
foreign capacity containers instead of adopting or deleting them. Cleanup is
allowed only by an immutable container ID plus the wrapper's private owner and
phase labels; a concurrent invocation fails before Docker mutation.

The final proof uses three sequential, pairwise-distinct clones and containers
from one immutable image. Phase A runs the authoritative 10k workload, stops
and checkpoints it, reconciles the database, and freezes its evidence before
phase B exists. Phase B runs only the two fault gates. Phase C runs only the
5k/two-hour soak. Each phase is preflighted while its exact container is still
never-started, then stopped, checkpointed, and frozen. A's root is never reused
or mutated after its reconciliation boundary.

```bash
IMAGE_REF="cascade:certified-$(git rev-parse HEAD)"
IMAGE_ID=$(docker image inspect "$IMAGE_REF" --format '{{.Id}}')
REVISION=$(git rev-parse HEAD)

CAPACITY_RELEASE_COOKIE="$CAPACITY_RELEASE_COOKIE" \
CAPACITY_JWT_SECRET="$CAPACITY_JWT_SECRET" \
npm run release:capacity:run -- \
  --profile final10k \
  --image "$IMAGE_ID" \
  --data-template-dir /secure/cascade-capacity/prepared-production-fixture \
  --data-dir /secure/cascade-capacity/main10k-data \
  --fault-data-dir /secure/cascade-capacity/fault-data \
  --soak-data-dir /secure/cascade-capacity/soak5k-data \
  --host-port 39094 \
  -- \
  --profile final10k \
  --image "$IMAGE_REF" \
  --image-id "$IMAGE_ID" \
  --revision "$REVISION" \
  --source-database /home/jt/cascade-validation-20260811/production-after/docs.db \
  --source-corpus-root /home/jt/cascade-validation-20260811/production-corpus \
  --fixture /secure/cascade-capacity/fixtures-10k.jsonl \
  --results-dir /secure/cascade-capacity/results-final10k \
  --source-ip 192.0.2.10 --source-ip 192.0.2.11 \
  --source-ip 192.0.2.12 --source-ip 192.0.2.13 \
  --soak-source-ip 192.0.2.20 \
  --fixture-prefix capacity
```

Arguments after `--` configure the checked-in controller; they are not an
arbitrary command. The three destination roots and results directory must be
absent and must be on disk-backed storage. Under the locked results root, the
controller creates an owned mode-0700 SQLite snapshot scratch directory,
requires at least 2 GiB free, passes its exact path to every preflight/freeze,
and removes it on completion, error, or signal. Do not place results on `/tmp`.
Before any clone or container creation, the wrapper requires a clean checkout,
an exact full revision, a canonical revision tag resolving to the requested
immutable image ID and OCI revision label, and pairwise-disjoint template,
approved source database/corpus, fixture, results, and phase data paths. No
mutable output may be nested in an immutable provenance tree.
The prepared template must already be a closed, checkpointed,
production-derived fixture tree. The controller starts the monitor before
exactly four group-preserving shards, writes the workload marker only after all
four pass, waits through the post interval, and kills and waits for every child
on failure or signal. It never performs Docker cleanup.

The mandatory 1k diagnostic uses the same lock/ownership path but accepts only
one fresh data root and a 1k fixture. Its four shards keep the aggregate
25-chat/50-read/1-run-per-second workload, reconnect at 30 seconds, and a
320-second monitor with a 60-second gate and post-workload slack. It ends after
its stopped checkpoint/freeze; it cannot run faults, soak, or final image
certification:

```bash
npm run release:capacity:run -- \
  --profile diagnostic1k --image "$IMAGE_ID" \
  --data-template-dir /secure/cascade-capacity/prepared-diagnostic-fixture \
  --data-dir /secure/cascade-capacity/diagnostic1k-data \
  -- \
  --profile diagnostic1k --image-id "$IMAGE_ID" --revision "$REVISION" \
  --source-database /home/jt/cascade-validation-20260811/production-after/docs.db \
  --source-corpus-root /home/jt/cascade-validation-20260811/production-corpus \
  --fixture /secure/cascade-capacity/fixtures-1k.jsonl \
  --results-dir /secure/cascade-capacity/results-diagnostic1k \
  --source-ip 192.0.2.10 --source-ip 192.0.2.11 \
  --source-ip 192.0.2.12 --source-ip 192.0.2.13
```

Keep `IMAGE_ID` with the results. A mutable tag is not adequate artifact
evidence. The JWT secret must be the same explicit secret used to provision the
fixture; do not rely on a home-directory default. Before starting the candidate,
checkpoint the fixture with `PRAGMA wal_checkpoint(TRUNCATE)`, run
`PRAGMA quick_check` and `PRAGMA foreign_key_check`, verify 10,000 distinct
decoded user IDs/tokens and the expected database membership counts, then hash
both `docs.db` and the JSONL fixture.

## Monitor

Start the monitor immediately before the four load-generator shards. Its 2,250
seconds cover the 300-second ramp, 1,860-second soak, and at least 30 seconds of
post-workload observation. The acceptance window is a literal 1,800 seconds
ending at the earliest shard's workload finish. Each load shard must start
after this monitor and overlap that whole interval. The result paths and marker
must be on the monitor's evidence filesystem; the marker must not already
exist.

```bash
node loadtest_elixir/monitor.mjs \
  --container "$CASCADE_CAPACITY_CONTAINER_ID" \
  --output /secure/cascade-capacity/results/server-monitor.jsonl \
  --expected-image "$IMAGE_ID" \
  --expected-cpus 2 \
  --expected-memory-gib 3 \
  --expected-sessions 10000 \
  --expected-runners 10000 \
  --expected-memberships 50000 \
  --workload-finished-marker /secure/cascade-capacity/results/workload-finished.json \
  --minimum-workload-seconds 2160 \
  --minimum-post-workload-seconds 30 \
  --expected-load-target http://127.0.0.1:39094 \
  --expected-shard-count 4 \
  --expected-ramp-seconds 300 \
  --expected-soak-seconds 1860 \
  --expected-polling-percent 5 \
  --expected-reconnect-percent 10 \
  --expected-reconnect-at-seconds 600 \
  --expected-source-ips 192.0.2.10,192.0.2.11,192.0.2.12,192.0.2.13 \
  --expected-chat-rps 6.25 \
  --expected-read-rps 12.5 \
  --expected-run-rps 0.25 \
  --expected-http-acceptors 4 \
  --expected-http-max-connections 32768 \
  --expected-http-backlog 65535 \
  --expected-network-mode true \
  --expected-trust-proxy-hops 1 \
  --expected-qmd-worker-enabled true \
  --expected-realtime-hibernate-after-ms 5000 \
  --expected-runner-orphan-reclaim-ms 600000 \
  --expected-sqlite-pool-size 20 \
  --expected-sqlite-busy-timeout-ms 5000 \
  --duration-seconds 2250 \
  --gate-window-seconds 1800 \
  --interval-seconds 5
```

The monitor copies `capacity_probe.exs` into the container's writable `/tmp`,
records its SHA-256, loads it with release RPC, and removes its runtime handler
when the run ends. It does not add a product endpoint or alter the application
supervision tree. The JSONL records the immutable image and container limits,
BEAM scheduler/run-queue/process/port/memory state, realtime sessions and room
tables, runner registrations, Bandit connections, Ecto queue/query/write
histograms and errors, DB-pool pressure, mailboxes, ETS, SQLite/WAL sizes,
container CPU/memory/PID/I/O/pressure, BEAM file descriptors, restarts, and OOM
state. The final record contains a fail-closed headroom evaluation.

The process exits nonzero for a wrong image or 2 CPU / 3 GiB shape, missing
telemetry, CPU above 70%, memory above 70%, aggregate scheduler utilization
above 80%, DB-pool utilization above 80% for more than 5% of its 100 ms samples,
DB queue p99 above 50 ms, DB query p99 above 100 ms, any DB/busy/locked error, a run queue persistently above online
schedulers, restart/OOM/sample errors, or insufficient 10,000-session/runner
coverage. The final record also exposes the process, ETS, WAL, mailbox, file
descriptor, membership, runner, and connection start/end values for the manual
stability review.

Do not discard a nonzero monitor exit merely because the client harness passed.
Preserve the complete JSONL plus all shard JSON files, image ID, fixture hashes,
candidate environment, host specification, and start/end timestamps together.

## Production edge proof

The exact nginx template keys its Socket.IO connection limit on
`$binary_remote_addr` and allows 40 connections per source address. An
`X-Forwarded-For` header from the driver does not create a distinct source and
must not be used as evidence. Ten thousand connections through the unmodified
edge require at least 250 genuine source addresses (and enough additional
margin for HTTP traffic).

If that address pool is unavailable, certify the backend with the private
candidate endpoint, separately prove that the unmodified nginx rejects the
41st Socket.IO connection from one address, and measure aggregate edge capacity
with a staging-only, explicitly allowlisted load-generator bypass that is absent
from the production config. Report these as separate proofs; do not claim that
two or four generator IPs exercised the production edge at 10,000 connections,
and do not weaken the production per-IP limit.
