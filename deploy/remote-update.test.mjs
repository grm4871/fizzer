import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(deployDirectory, 'remote-update.sh'), 'utf8');
const compose = fs.readFileSync(path.join(deployDirectory, '../docker-compose.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(deployDirectory, '../Dockerfile'), 'utf8');

function assertOrdered(...lines) {
  let previous = -1;
  for (const line of lines) {
    const index = source.indexOf(`\n${line}\n`, previous + 1);
    assert.notEqual(index, -1, `missing cutover gate: ${line}`);
    assert.ok(index > previous, `cutover gate is out of order: ${line}`);
    previous = index;
  }
}

test('cutover stays gated from rollback capture through candidate verification', () => {
  assertOrdered(
    'load_certified_candidate',
    'verify_compose_runtime_shape',
    'ensure_cutover_disk_capacity',
    'secure_production_environment',
    'preflight_candidate',
    'sync_nginx_security',
    'docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"',
    'CUTOVER_STARTED=1',
    'close_maintenance_gate',
    'verify_maintenance_gate',
    'docker compose "${COMPOSE_ARGS[@]}" stop -t 120 cascade',
    'OLD_BACKEND_STOPPED=1',
    'checkpoint_and_snapshot',
    'CANDIDATE_DATA_TOUCHED=1',
    'verify_container_runtime_shape "$CONTAINER_NAME" "running production candidate"',
    'wait_for_url "$HEALTH_URL" 90 "Elixir candidate"',
    'check_engine_io "http://127.0.0.1:3000"',
    'verify_live_database',
    'verify_authenticated_live_candidate',
    'docker tag "$CERTIFIED_IMAGE_ID" cascade:latest',
    'DEPLOY_COMMITTED=1',
    'open_maintenance_gate',
    'verify_reopened_production_edge',
  );
});

test('production promotes the staged certified image and never rebuilds a candidate', () => {
  assert.match(source, /CERTIFIED_RELEASE_DIR="\/var\/lib\/cascade-release"/);
  assert.match(source, /CERTIFIED_MANIFEST="\$CERTIFIED_IMAGE_DIR\/\$REVISION\.json"/);
  assert.match(source, /certification directories must be canonical root-owned directories, mode 0700/);
  assert.match(source, /OPERATOR_WAIVER_DIR="\$CERTIFIED_RELEASE_DIR\/operator-waivers"/);
  assert.match(source, /no staged certification or explicit operator capacity waiver exists/);
  assert.match(source, /for authorization_part in "\$authorization_file" "\$authorization_file\.sha256"/);
  assert.match(source, /release authorization and checksum must be regular root-owned files, mode 0600/);
  assert.match(source, /git status --porcelain --untracked-files=no/);
  assert.match(source, /-L "\$authorization_part"/);
  assert.match(source, /certified-image\.mjs verify --manifest "\$authorization_file"/);
  assert.match(source, /CANDIDATE_IMAGE="\$\(node deploy\/certified-image\.mjs field/);
  assert.match(source, /operator-capacity-waiver\.mjs verify/);
  assert.match(source, /explicit 1,000-certified \/ 10,000-demonstrated operator capacity waiver/);
  assert.match(source, /OPERATOR_WAIVER_USED=1/);
  assert.match(source, /mv "\$OPERATOR_WAIVER" "\$OPERATOR_WAIVER\.used"/);
  assert.match(source, /loaded_image_id="\$\(docker image inspect/);
  assert.match(source, /docker run --rm --network none[\s\S]*RouteCatalog\.swap_ready\?\(\)/);
  assert.match(source, /RUNNING_IMAGE_ID="\$\(docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(source, /RUNNING_IMAGE_ID" != "\$CERTIFIED_IMAGE_ID/);
  assert.doesNotMatch(source, /^\s*docker (?:compose )?build(?:\s|$)/mu);
  assert.doesNotMatch(source, /BUILD_ARGS/);
});

test('preflight, Compose, and the running candidate share the certified resource envelope', () => {
  assert.match(source, /cpus: 2,[\s\S]*cpuset: "0-1"[\s\S]*memory: 3 \* 1024 \*\* 3/);
  assert.match(source, /memorySwap: 3 \* 1024 \*\* 3,[\s\S]*pids: 100_000/);
  assert.match(source, /CASCADE_IMAGE="\$CANDIDATE_IMAGE" docker compose[\s\S]*config --format json/);
  assert.match(source, /--cpus 2 --cpuset-cpus 0-1 --memory 3g --memory-swap 3g/);
  assert.match(source, /--pids-limit 100000 --ulimit nofile=200000:200000/);
  assert.match(source, /verify_container_runtime_shape "\$PREFLIGHT_CONTAINER" "isolated candidate preflight"/);
  assert.match(source, /verify_container_runtime_shape "\$CONTAINER_NAME" "running production candidate"/);
});

test('authenticated production smoke stays behind the reversible maintenance gate', () => {
  assert.match(source, /Running authenticated production read\/realtime smoke behind the maintenance gate/);
  assert.match(source, /Cascade\.Auth\.Token\.sign_user\(user\)/);
  assert.match(source, /authenticated-live-smoke\.mjs "http:\/\/127\.0\.0\.1:3000"/);
  assert.doesNotMatch(source, /runner:register/);
  assert.match(dockerfile, /COPY --chown=node:node deploy\/authenticated-live-smoke\.mjs \.\/deploy\/authenticated-live-smoke\.mjs/);
  assertOrdered(
    'close_maintenance_gate',
    'verify_authenticated_live_candidate',
    'DEPLOY_COMMITTED=1',
    'open_maintenance_gate',
  );
});

test('the reopened TLS edge serves health, client assets, and Engine.IO', () => {
  assert.match(source, /--resolve "\$DEPLOY_DOMAIN:443:127\.0\.0\.1" "https:\/\/\$DEPLOY_DOMAIN\/api\/health"/);
  assert.match(source, /root_html[\s\S]*<div id="root"><\/div>/);
  assert.match(source, /socket\.io\/\?EIO=4&transport=polling/);
  assertOrdered(
    'open_maintenance_gate',
    'verify_reopened_production_edge',
    '  mv "$OPERATOR_WAIVER" "$OPERATOR_WAIVER.used"',
    'docker compose "${COMPOSE_ARGS[@]}" ps',
  );
});

test('failure handling restores only a verified snapshot after the candidate is stopped', () => {
  assert.match(source, /if \[\[ "\$CUTOVER_STARTED" == "1" && "\$DEPLOY_COMMITTED" != "1" \]\]; then\s+rollback_cutover/);
  assertOrdered(
    '  if ! close_maintenance_gate; then',
    '      CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" stop -t 30 cascade || true',
    '      if ! restore_database_snapshot; then',
    '    if ! CASCADE_IMAGE="$ROLLBACK_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \\',
    '    if open_maintenance_gate; then',
  );
  assert.match(source, /candidate is still running; refusing an unsafe database restore/);
  assert.match(source, /rollback cannot prove traffic is gated; refusing to mutate production data/);
  assert.match(source, /if \[\[ "\$OLD_BACKEND_STOPPED" == "1" \|\| "\$backend_running" != "true" \]\]/);
  assert.match(source, /rollback did not become healthy; maintenance gate remains active/);
});

test('snapshot creation fails closed on a busy checkpoint and records integrity evidence', () => {
  assert.match(source, /Match the production database owner[\s\S]*--user 1000:1000 --entrypoint node/);
  assert.match(source, /wal_checkpoint\(TRUNCATE\)/);
  assert.match(source, /busy WAL checkpoint/);
  assert.match(source, /SQLite quick_check failed/);
  assert.match(source, /SQL query-only while allowing those disposable files/);
  assert.match(source, /-v "\$SNAPSHOT_DIR:\/snapshot"/);
  assert.match(source, /db\.pragma\("query_only = ON"\)/);
  assert.match(source, /rm -f -- "\$snapshot_tmp-wal" "\$snapshot_tmp-shm"/);
  assert.match(source, /snapshot foreign_key_check failed/);
  assert.match(source, /sha256sum docs\.db > docs\.db\.sha256/);
  assert.match(source, /git rev-parse HEAD > "\$SNAPSHOT_DIR\/revision\.txt"/);
});

test('isolated preflight checkpoints the migrated WAL before main-file compatibility inspection', () => {
  assert.match(source, /busy preflight WAL checkpoint/);
  assert.match(source, /preflight SQLite quick_check failed/);
  assertOrdered(
    "    'case Application.ensure_all_started(:cascade_elixir) do {:ok, _} -> :ok; other -> raise inspect(other) end'",
    '  docker run --rm --network none --user 1000:1000 --entrypoint node \\',
    '  docker run --rm --network none --entrypoint node \\',
  );
});

test('preflight and live cutover bind the complete vault and QMD corpus without exemptions', () => {
  assert.match(source, /before-data\/vaults/);
  assert.match(source, /before-data\/qmd/);
  assert.match(source, /--before-root \/preflight\/before-data --after-root \/preflight\/after-data/);
  assert.match(source, /"\$SNAPSHOT_DIR\/corpus\/vaults"/);
  assert.match(source, /"\$SNAPSHOT_DIR\/corpus\/qmd"/);
  assert.match(source, /--before-root \/snapshot\/corpus --after-root \/live-corpus/);
  assert.match(source, /"\$DATA_DIR\/\.cascade\/vaults:\/live-corpus\/vaults:ro"/);
  assert.match(source, /"\$DATA_DIR\/\.cascade\/qmd:\/live-corpus\/qmd:ro"/);
  assert.doesNotMatch(source, /"\$DATA_DIR\/\.cascade:\/live-corpus:ro"/);
  assert.match(source, /CASCADE_SQLITE_SNAPSHOT_TMPDIR=\/sqlite-scratch/);
  assert.match(source, /sqlite-scratch:\/sqlite-scratch/);
  assert.doesNotMatch(source, /allow-derived|ignore.*index\.sqlite/iu);
});

test('production gives runners ten minutes to reclaim after gated candidate startup', () => {
  const configured = compose.match(/CASCADE_RUNNER_ORPHAN_RECLAIM_MS:\s*"(\d+)"/);
  assert.ok(configured, 'production runner reclaim override is missing');
  assert.equal(Number(configured[1]), 600_000);

  const healthAttempts = source.match(/wait_for_url "\$HEALTH_URL" (\d+) "Elixir candidate"/);
  assert.ok(healthAttempts, 'candidate health wait is missing');
  assert.ok(Number(configured[1]) > Number(healthAttempts[1]) * 2_000);
  assertOrdered(
    'CANDIDATE_DATA_TOUCHED=1',
    'wait_for_url "$HEALTH_URL" 90 "Elixir candidate"',
    'verify_live_database',
    'DEPLOY_COMMITTED=1',
  );
  assert.match(source, /DEPLOY_COMMITTED=1\s+open_maintenance_gate/);
});

test('maintenance and cleanup operations fail closed and stay project scoped', () => {
  assert.match(source, /install -m 0644 -o 0 -g 0 \/dev\/null "\$MAINTENANCE_MARKER"/);
  assert.match(source, /if ! rm -f -- "\$MAINTENANCE_MARKER" \|\| \[\[ -e "\$MAINTENANCE_MARKER" \|\| -L "\$MAINTENANCE_MARKER" \]\]/);
  assert.match(source, /consecutive=\$\(\(consecutive \+ 1\)\)/);
  assert.match(source, /"\$consecutive" -ge 3/);
  assert.match(source, /maintenance gate did not stabilize at HTTP 503/);
  assert.match(source, /docker compose "\$\{COMPOSE_ARGS\[@\]\}" ps -aq[\s\S]*--status created --status exited --status dead cascade/);
  assert.doesNotMatch(source, /--filter "label=com\.docker\.compose\.service=cascade"/);
});

test('production secrets are regular root-owned mode 0600 before candidate startup', () => {
  assert.match(source, /-L "\$environment_file" \|\| ! -f "\$environment_file"/);
  assert.match(source, /chown 0:0 "\$environment_file"/);
  assert.match(source, /chmod 0600 "\$environment_file"/);
  assert.match(source, /"0:0:600"/);
  assertOrdered(
    'secure_production_environment',
    'preflight_candidate',
    'CANDIDATE_DATA_TOUCHED=1',
  );
});
