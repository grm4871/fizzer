# Capacity telemetry and certification operations

This page is the operational contract for `loadtest_elixir/capacity-run.sh` and
`loadtest_elixir/certification-runner.mjs`. It describes the only path that can
produce a release certificate. The monitor, marker writer, fault probes, and
soak probe are useful on their own, but every raw invocation is diagnostic and
non-certifying.

## Evidence boundary

Use the root package script:

```bash
npm run release:capacity:run -- ...
```

`package.json` maps that script to `bash loadtest_elixir/capacity-run.sh`. The
wrapper acquires the host-global lock, validates immutable inputs, creates and
labels candidates, and invokes only the checked-in
`loadtest_elixir/certification-runner.mjs` after the `--` separator. It passes
these protected environment values to the controller:

* `CASCADE_CAPACITY_CONTAINER_ID`, the immutable 64-hex Docker ID;
* `CASCADE_CAPACITY_CONTAINER_NAME`, the reserved exact name;
* `CASCADE_CAPACITY_TARGET`, an isolated loopback URL;
* `CASCADE_CAPACITY_PHASE`, the lifecycle phase;
* `CASCADE_CAPACITY_DATA_DIR`, the phase's data root; and
* phase timestamps, database hash, device, and inode.

The controller refuses direct execution without the wrapper affinity and phase
environment. Do not invoke `certification-runner.mjs` yourself, replace it with
a shell loop, pre-clean by container name, or use an ad-hoc Docker run.

A raw `monitor.mjs`, `write-workload-marker.mjs`, `runner-restart-recovery.mjs`,
`sqlite-lock-recovery.mjs`, or `soak-invariants.mjs` command is diagnostic even
when its own `evaluation.ok` is true. It lacks the wrapper's complete phase
journal, ownership checks, frozen-input identity, isolated phase sequence, and
final certifier replay.

## Host and tool prerequisites

The wrapper is Linux/GNU-only. It needs GNU Bash, `awk`, `cp`, `find`,
`readlink`, and `stat`; `flock`; `taskset`; Docker; Node/npm; Git; `sqlite3`;
and `sha256sum`. Confirm availability before reserving the host:

```bash
for tool in bash awk cp find readlink stat flock taskset docker node npm git sqlite3 sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing $tool" >&2; exit 1; }
done
```

`/proc` must be mounted. The wrapper reads `/proc/self/status`; the controller
reads `/proc/<pid>/status` and validates `Cpus_allowed_list` for every child.
The candidate is pinned to CPUs `0-1` with a 2-CPU quota. The wrapper re-execs
itself with `taskset` so controller, load, monitor, fault, and soak processes
run only on CPUs outside `0-1`. If automatic selection is unsuitable, set
`CASCADE_CAPACITY_GENERATOR_CPUSET` to a valid set (for example `2-5`); it must
not contain `0` or `1`, and those CPUs must be available in the invoking
process's `/proc` affinity.

The Docker candidate shape is fixed by `capacity-run.sh`: `--cpuset-cpus=0-1`,
`--cpus=2`, `--memory=3g`, `--memory-swap=3g`, `--pids-limit=100000`, and
`--ulimit nofile=200000:200000`. The image also receives the fixed Elixir
runtime settings: four HTTP acceptors, 32,768 maximum connections, 65,535
backlog, network mode, one trusted proxy hop, QMD enabled, 5,000 ms realtime
hibernate, 600,000 ms orphan reclaim, SQLite pool 20, and SQLite busy timeout
5,000 ms.

The wrapper requires an owned mode-700 `$XDG_RUNTIME_DIR`, or the owned
`/run/user/<uid>` fallback. It creates a mode-600
`cascade-elixir-capacity.lock` there and takes `flock` before any Docker or data
mutation. Docker must support bind mounts, labels, `--cidfile`, `docker logs`,
and the resource options above. Keep generators on the wrapper-selected CPUs
or separate hosts; do not count generator load as candidate headroom.

Results storage must be a fresh, absolute, canonical directory on disk-backed
storage. The controller creates an owned mode-700 `sqlite-snapshot-scratch`
directory there and requires at least 2 GiB free. `/tmp`, tmpfs, and ramfs are
not valid results/scratch storage. Reflinks are not required: phase cloning uses
GNU `cp -a --reflink=never`, then checks that phase database device/inode pairs
are distinct. A reflink-capable filesystem is acceptable for an upstream source
snapshot only.

## Inputs and private-data handling

The controller requires these absolute paths, all outside mutable phase and
results roots:

* `--source-database`: a closed, canonical regular SQLite file;
* `--source-corpus-root`: a canonical directory containing `vaults/` and `qmd/`;
* `--fixture`: a canonical JSONL regular file; and
* `--results-dir`: a new canonical destination.

Source database and corpus are approved production-derived provenance inputs.
Use the project's approved snapshot process and privacy policy; do not point
these options at a live production mount, copy secrets or personal exports, or
paste their contents into tickets/logs. The certifier compares source logical
rows, schema, FTS integrity, and corpus records, so an approved snapshot must
not be edited after approval. Keep source and fixture files outside the Git
checkout and mode-restricted. The generated fixture contains JWTs and is
private data even though its users are synthetic.

Prepare fixtures with the checked-in
`backend_elixir/lib/mix/tasks/cascade.load_fixtures.ex`, as described in
`loadtest_elixir/README.md`. It requires `CASCADE_ALLOW_LOAD_FIXTURES=1`,
refuses `/data` and `/var/lib/cascade` including aliases, requires
`CASCADE_VAULTS_BASE_DIR`, and accepts only
`--persisted-vaults-base-dir /data/.cascade/vaults`. For a copied non-empty
source database, create `.cascade-load-fixtures-disposable` in the copied data
root with content `cascade-load-fixtures-disposable`. Use a separate fresh
copy/template and fresh output for each profile; never append users to a prior
fixture.

Before passing inputs to the wrapper, close the copied DB and require:

```bash
sqlite3 /absolute/path/to/template/docs.db 'PRAGMA wal_checkpoint(TRUNCATE);'
sqlite3 -readonly /absolute/path/to/template/docs.db 'PRAGMA quick_check;'
sqlite3 -readonly /absolute/path/to/template/docs.db 'PRAGMA foreign_key_check;'
sha256sum /absolute/path/to/template/docs.db /absolute/path/to/fixtures-10k.jsonl
```

The first result must report a non-busy checkpoint, `quick_check` must be `ok`,
foreign-key output must be empty, and no `docs.db-wal` or `docs.db-shm` may
remain. The wrapper/certifier independently repeat integrity, path, byte,
line, and hash checks; these commands do not replace preflight evidence.

## Canonical final invocation

Build the release image once from the clean checkout and retain its immutable
ID. `deploy/build-release-image.sh` checks the tree, archives `git rev-parse
HEAD`, and tags the result `cascade:certified-$REVISION`. Run it before
qualification, then inspect the resulting image without rebuilding:

```bash
cd "$CASCADE_ROOT"
npm run release:image:build
IMAGE_REF="cascade:certified-$(git rev-parse HEAD)"
IMAGE_ID="$(docker image inspect "$IMAGE_REF" --format '{{.Id}}')"
REVISION="$(git rev-parse HEAD)"
```

The final controller requires the canonical revision tag and the matching
`sha256:` ID/revision label. `IMAGE_ID` must not be a mutable tag and must not
change during this run:

```bash
CAPACITY_RELEASE_COOKIE="$CAPACITY_RELEASE_COOKIE" \
CAPACITY_JWT_SECRET="$CAPACITY_JWT_SECRET" \
npm run release:capacity:run -- \
  --profile final10k \
  --image "$IMAGE_ID" \
  --data-template-dir /absolute/path/to/prepared-final-template \
  --data-dir /absolute/path/to/final-main10k-data \
  --fault-data-dir /absolute/path/to/final-fault-data \
  --soak-data-dir /absolute/path/to/final-soak-data \
  --host-port 39094 \
  -- \
  --profile final10k \
  --image "$IMAGE_REF" \
  --image-id "$IMAGE_ID" \
  --revision "$REVISION" \
  --source-database /absolute/path/to/approved/docs.db \
  --source-corpus-root /absolute/path/to/approved/corpus \
  --fixture /absolute/path/to/fixtures-10k.jsonl \
  --results-dir /absolute/path/to/results-final10k \
  --source-ip 192.0.2.10 \
  --source-ip 192.0.2.11 \
  --source-ip 192.0.2.12 \
  --source-ip 192.0.2.13 \
  --soak-source-ip 192.0.2.20 \
  --fixture-prefix capacity
```

The options before `--` are wrapper options. The options after `--` are the
checked-in controller's finite option set, not an arbitrary command. All three
phase data destinations and the results directory must be absent before the
wrapper starts, pairwise disjoint, and separate from the template, source
inputs, corpus, and checkout. `CAPACITY_RELEASE_COOKIE` and
`CAPACITY_JWT_SECRET` are required environment variables; never put either in
an option or artifact.

The wrapper rejects a dirty checkout, a revision mismatch, a missing immutable
image label, an existing reserved container, a stale output, a symlink/alias,
or a source path inside `/data` or `/var/lib/cascade`. It clones the template
with `--reflink=never`, verifies regular `docs.db` files and distinct device /
inode pairs, then creates every candidate with owner and phase labels.

## Diagnostic wrapper profile

For a small end-to-end rehearsal, use a fresh 1,000-user template and fixture.
This uses the same lock, affinity, ownership, preflight, stop, checkpoint, and
freeze machinery but is explicitly diagnostic and cannot enter final
certification. It creates only one candidate and one data root:

```bash
CAPACITY_RELEASE_COOKIE="$CAPACITY_RELEASE_COOKIE" \
CAPACITY_JWT_SECRET="$CAPACITY_JWT_SECRET" \
npm run release:capacity:run -- \
  --profile diagnostic1k \
  --image "$IMAGE_ID" \
  --data-template-dir /absolute/path/to/prepared-diagnostic-template \
  --data-dir /absolute/path/to/diagnostic1k-data \
  --host-port 39094 \
  -- \
  --profile diagnostic1k \
  --image-id "$IMAGE_ID" \
  --revision "$REVISION" \
  --source-database /absolute/path/to/approved/docs.db \
  --source-corpus-root /absolute/path/to/approved/corpus \
  --fixture /absolute/path/to/fixtures-1k.jsonl \
  --results-dir /absolute/path/to/results-diagnostic1k \
  --source-ip 192.0.2.10 \
  --source-ip 192.0.2.11 \
  --source-ip 192.0.2.12 \
  --source-ip 192.0.2.13 \
  --fixture-prefix diagnostic
```

The fixed `diagnostic1k` profile is 1,000 users, 60-second ramp, 120-second
soak, 320-second monitor, 60-second gate, reconnect at 30 seconds, four equal
250-user shards, 5% polling, 10% reconnect, and the same aggregate chat/read/run
rates as final. Its manifest is a diagnostic record, not a release artifact.

## Lifecycle, journaling, resume, and cleanup

`final10k` is strictly sequential. The wrapper and controller enforce this
order; a phase cannot be skipped, repeated, or reordered:

1. **A / `main10k`:** create a never-started candidate; run
   `preflight-main10k`; verify it remains never-started; start it; run
   `run-main10k`; stop it; checkpoint and hash its DB; run
   `reconcile-main10k`; freeze it.
2. **B / `faults`:** only after A is reconciled/frozen, create and preflight a
   distinct never-started candidate; run `run-faults` (runner restart followed
   by SQLite lock recovery); stop, checkpoint, and `freeze-faults`.
3. **C / `soak5k`:** only after B is frozen, create/preflight a third candidate;
   run `run-soak5k`; stop, checkpoint, and `freeze-soak5k`.
4. **Certificate:** run `certify` against all A/B/C preflights, freezes, load
   shards, monitor, reconciliation, fault results, soak result, and frozen
   source inputs. Then write the command manifest.

The controller creates `.certification-runner-state.json` and appends a
hash-chained `command-journal.jsonl` in the results root. Each child start and
finish records phase, label, PID, affinity, command argv (without secret-bearing
environment), status, signal, timestamps, and a digest chained to the prior
record. State records completed phases, input/tool hashes, affinity, scratch
identity, and container identities. Every subsequent phase rechecks those
values and refuses changed options or inputs.

This is controlled phase continuation, not an invitation to edit state or
resume a stale run. On a child error or signal, the controller terminates its
process groups, removes scratch files, and the wrapper's exit trap removes only
containers whose immutable ID, owner label, phase label, and exact name still
match. A rerun must use fresh absent phase roots and a fresh results directory;
the wrapper refuses existing reserved containers and destinations. Preserve the
failed results directory for investigation, then select new roots for a new
attempt. Never delete by name or with a broad Docker filter.

At successful completion, scratch is empty and removed, owned phase containers
are removed, the results directory and phase data roots remain available for
review, and no production path has been touched. If cleanup identity checks
fail, treat cleanup as a failed run and investigate the recorded immutable IDs;
do not force-remove an unrelated container.

## Phase A workload and monitor

The controller starts `monitor.mjs` and waits for a valid `start` JSONL record
before starting exactly four `load.mjs` children. Each shard receives 2,500
users, one of the four source IPs, `--shard-count 4`, a 300-second ramp,
1,860-second soak, 6.25 chat writes/s, 12.5 reads/s, 0.25 runs/s, 5% polling,
10% reconnect, and reconnect at 600 seconds. The controller adds the fixed
client thresholds and writes `monitor.jsonl`, `monitor.jsonl.container.log`,
`shard-0.json` through `shard-3.json`, and `workload-finished.json` under the
results root.

The marker writer is invoked only after all four shard processes exit zero and
the controller validates each shard's profile, source IP, fixture hash, driver
hash, owner-stratified reconnect plan, successful message IDs, and requested run
IDs. It creates the marker atomically and refuses stale/replacement artifacts.
The monitor then completes its 2,250-second observation, evaluates the literal
1,800-second window ending at the earliest shard's `workloadFinishedAt`, and must
pass. It captures server logs over the candidate lifetime and fails on fatal or
error patterns, restarts, OOM, missing telemetry, wrong identity, resource
headroom failure, DB errors, or incomplete 10k coverage.

The final gate requires connect success >=99.9%, HTTP error rate <=0.1%, p99
connect <=5 s, p99 read/write/event <=1 s, CPU <=70%, memory <=70% of 3 GiB,
scheduler utilization <=80%, pool utilization <=80%, checkout p99 <=50 ms,
query p99 <=100 ms, no sustained queue/WAL/lock/disk growth, and stable BEAM,
mailbox, ETS, process, port, and file-descriptor state. Reconnect recovery must
be >=99% within 10 s and 100% within 20 s. Sender receipts, peer delivery,
presence, ordering, and persisted run IDs must reconcile. Run events must be
exactly `2:status:running`, `3:text`, and `4:status:completed` once and in order.

`capacity_probe.exs` is copied by `monitor.mjs` into the candidate's writable
`/tmp`, loaded through release RPC, hashed in the monitor evidence, and removed
at the end. It is a runtime probe, not a product endpoint or supervision-tree
change. The controller also verifies the embedded `/app/loadtest_elixir/load.mjs`
and `/app/loadtest_elixir/reconcile-capacity.mjs` hashes match the frozen
checkout files.

## Phase B faults and Phase C soak

`runner-restart-recovery.mjs` runs against the isolated phase-B candidate and
checks same container/image, restart within 120 seconds, `activeRunIds` reclaim,
one delegation, one completed terminal event, and final `completed` status.
`sqlite-lock-recovery.mjs` opens the phase-B `docs.db`, holds `BEGIN IMMEDIATE`,
checks that the API returns bounded 429/503 without persisting the blocked ID,
releases the lock, and checks a recovery write returns 201 and is persisted.
Both output artifacts must be fresh and `evaluation.ok` must be true.

`soak-invariants.mjs` runs the fixed phase-C profile: 5,000 users, 300-second
ramp, 7,200-second soak, 10% churn every 300 seconds, one run/s, five-second
samples, 180-second recovery timeout, and three consecutive return-to-baseline
samples. It rejects profile overrides. It writes `soak-invariants.json`,
`soak-invariants.json.samples.jsonl`, and
`soak-invariants.json.container.log`. The result must show stable process/ETS/
memory/open-file/DB-pool state and clean return after clients leave, with no
fatal/error server-log lines.

## Artifact index and identity

All paths below are relative to `$RESULTS_DIR`, the `--results-dir` supplied to
the wrapper. The wrapper and controller create them with mode 0600 unless they
are directories (mode 0700):

| Phase | Artifacts |
| --- | --- |
| Controller | `.certification-runner-state.json`, `command-journal.jsonl`, `command-manifest.json` (after completion), `sqlite-snapshot-scratch/` (temporary) |
| A preflight/runtime | `fixture-preflight-main10k.json`, `runtime-proof.json` |
| A workload | `monitor.jsonl`, `monitor.jsonl.container.log`, `shard-0.json` … `shard-3.json`, `workload-finished.json`, `reconciliation.json`, `freeze-main10k.json` |
| B | `fixture-preflight-faults.json`, `runner-restart.json`, `sqlite-lock.json`, `freeze-faults.json` |
| C | `fixture-preflight-soak5k.json`, `soak-invariants.json`, `soak-invariants.json.samples.jsonl`, `soak-invariants.json.container.log`, `freeze-soak5k.json` |
| Final cert | `certification.json`, `certification.json.sha256` |
| Diagnostic wrapper | `fixture-preflight-diagnostic.json`, `diagnostic-monitor.jsonl`, `diagnostic-monitor.jsonl.container.log`, `diagnostic-shard-0.json` … `diagnostic-shard-3.json`, `diagnostic-workload-finished.json`, `freeze-diagnostic.json`, plus state/journal/manifest |

`command-manifest.json` records the final image ID, full revision, affinity,
container/data identities, frozen input evidence, command journal digest/tail,
and SHA-256/byte/device/inode evidence for every result artifact. The certifier
also binds the fixture, source DB, source corpus tree, controller, certifier,
load/reconciliation/monitor/fault/soak tools, configuration, runtime proof,
monitor, marker, shards, freezes, reconciliation, faults, soak journal, and
final certificate. `certification.json.sha256` is the checksum to carry with
the certificate; verify it before staging.

A successful certificate is therefore an immutable tuple of image ID, full Git
revision, pinned-base build metadata, configuration digest, fixture/source
hashes, phase container IDs, frozen DB hashes and inodes, workload/monitor/fault/
soak evidence, and journal chain. Do not rename, rewrite, normalize, or replace
an artifact after completion. If any hash, byte count, line count, path identity,
container identity, or phase timestamp changes, the evidence is invalid.

## Raw diagnostic commands

For an isolated running candidate, direct commands are allowed for diagnosis but
must use distinct output names and must not be copied into certification names.
A raw monitor is started before raw load shards; a raw marker is written only
after all shard JSON passes and while the monitor is running. Include
`--server-log-output` when using the monitor so its server log is retained.
Direct fault and soak output is similarly diagnostic. These commands do not
acquire the wrapper lock, create phase labels, or produce a certification
manifest.

The exact interfaces are:

```bash
node loadtest_elixir/monitor.mjs --container "$CANDIDATE_CONTAINER" \
  --output /absolute/path/diagnostic-monitor.jsonl \
  --server-log-output /absolute/path/diagnostic-monitor.jsonl.container.log \
  --expected-image "$IMAGE_ID" --expected-cpus 2 --expected-memory-gib 3 \
  --expected-sessions 1000 --expected-runners 1000 --expected-memberships 5000 \
  --workload-finished-marker /absolute/path/diagnostic-workload-finished.json \
  --minimum-workload-seconds 180 --minimum-post-workload-seconds 30 \
  --expected-load-target http://127.0.0.1:39094 \
  --expected-shard-count 4 --expected-ramp-seconds 60 \
  --expected-soak-seconds 120 --expected-polling-percent 5 \
  --expected-reconnect-percent 10 --expected-reconnect-at-seconds 30 \
  --expected-source-ips 192.0.2.10,192.0.2.11,192.0.2.12,192.0.2.13 \
  --expected-chat-rps 6.25 --expected-read-rps 12.5 --expected-run-rps 0.25 \
  --duration-seconds 320 --gate-window-seconds 60

node loadtest_elixir/write-workload-marker.mjs \
  --output /absolute/path/diagnostic-workload-finished.json \
  --expected-shards 4 \
  --shard /absolute/path/diagnostic-shard-0.json \
  --shard /absolute/path/diagnostic-shard-1.json \
  --shard /absolute/path/diagnostic-shard-2.json \
  --shard /absolute/path/diagnostic-shard-3.json

node loadtest_elixir/runner-restart-recovery.mjs --target http://127.0.0.1:39094 \
  --fixtures /absolute/path/fixtures-1k.jsonl --container "$CANDIDATE_CONTAINER" \
  --output /absolute/path/runner-restart-diagnostic.json

node loadtest_elixir/sqlite-lock-recovery.mjs --target http://127.0.0.1:39094 \
  --fixtures /absolute/path/fixtures-1k.jsonl --container "$CANDIDATE_CONTAINER" \
  --db-path /absolute/path/diagnostic-data/docs.db \
  --output /absolute/path/sqlite-lock-diagnostic.json

npm run release:soak:invariants -- --target http://127.0.0.1:39094 \
  --fixtures /absolute/path/fixtures-10k.jsonl --container "$CANDIDATE_CONTAINER" \
  --expected-image "$IMAGE_ID" --expected-revision "$REVISION" \
  --source-ip 192.0.2.20 --output /absolute/path/soak-diagnostic.json
```

`edge-limit-proof.mjs` and `edge-nginx-main.conf` are separate edge diagnostics.
The checked-in edge probe proves the configured 40-connection limit and
replacement behavior for one source; it does not prove 10,000 connections
through production nginx.

## External edge and telemetry review

The monitor's bound evidence comes from Docker state, release RPC, BEAM/Ecto,
SQLite/WAL, and the captured container log. OpenTelemetry exports, external
BEAM dashboards, SQLite dashboards, nginx logs, and load-balancer metrics are
manual review unless a current checked-in command explicitly includes their
bytes and hash in the certificate. A client-only metric or pasted dashboard
cannot satisfy a missing monitor gate.

The production nginx template keys its Socket.IO connection limit on
`$binary_remote_addr` and allows 40 connections per source. `X-Forwarded-For`
from a load generator does not create a distinct source and must not be treated
as evidence. Ten thousand unmodified-edge connections require at least 250
genuine source addresses plus margin. If that address pool is unavailable,
report private-backend capacity and edge-limit behavior as separate proofs; do
not weaken production configuration or claim that two/four generator addresses
exercised the production edge.

After and only after `certification.json` and its checksum verify, stage the
manifest with the current root command:

```bash
npm run release:image:stage-certified -- \
  /absolute/path/to/results-final10k/certification.json "$CASCADE_DEPLOY_SSH_HOST"
```

The staging helper verifies the manifest, loads the exact image, and requires
an SSH host; it does not start a production container. Production must load the
staged immutable ID with `--no-build`; a missing, changed, corrupted, or
incomplete manifest fails closed.
