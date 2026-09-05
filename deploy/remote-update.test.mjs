import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const deployDirectory = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(deployDirectory, 'remote-update.sh'), 'utf8');
const hostDeploy = fs.readFileSync(path.join(deployDirectory, 'github-actions-host.sh'), 'utf8');
const workflow = fs.readFileSync(
  path.join(deployDirectory, '../.github/workflows/deploy-production.yml'),
  'utf8',
);
const desktopWorkflow = fs.readFileSync(
  path.join(deployDirectory, '../.github/workflows/desktop-build.yml'),
  'utf8',
);
const compose = fs.readFileSync(path.join(deployDirectory, '../docker-compose.yml'), 'utf8');
const dockerfile = fs.readFileSync(path.join(deployDirectory, '../Dockerfile'), 'utf8');
const nginxTemplate = fs.readFileSync(path.join(deployDirectory, 'nginx.conf.template'), 'utf8');

function assertOrdered(...lines) {
  let previous = -1;
  for (const line of lines) {
    const index = source.indexOf(`\n${line}\n`, previous + 1);
    assert.notEqual(index, -1, `missing cutover gate: ${line}`);
    assert.ok(index > previous, `cutover gate is out of order: ${line}`);
    previous = index;
  }
}

function functionBody(name) {
  const start = source.indexOf(`\n${name}() {\n`);
  assert.notEqual(start, -1, `missing function: ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `unterminated function: ${name}`);
  return source.slice(start, end + 3);
}

function assertOrderedWithin(haystack, ...lines) {
  let previous = -1;
  for (const line of lines) {
    const index = haystack.indexOf(`\n${line}\n`, previous + 1);
    assert.notEqual(index, -1, `missing ordered line: ${line}`);
    assert.ok(index > previous, `line is out of order: ${line}`);
    previous = index;
  }
}

test('state-identical releases use a warmed backup and never close the maintenance gate', () => {
  const rolling = functionBody('rolling_cutover');
  assertOrderedWithin(
    rolling,
    '  start_rolling_container',
    '  verify_reopened_production_edge',
    '  docker stop -t 120 "$CONTAINER_NAME" >/dev/null',
    '  ROLLING_OLD_STOPPED=1',
    '  verify_reopened_production_edge',
    '  docker rm "$CONTAINER_NAME" >/dev/null',
    '  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \\',
    '  verify_container_runtime_shape "$CONTAINER_NAME" "canonical rolling candidate"',
    '  sleep 3',
    '  verify_reopened_production_edge',
    '  docker stop -t 120 "$ROLLING_CONTAINER" >/dev/null',
    '  verify_reopened_production_edge',
    '  DEPLOY_COMMITTED=1',
  );
  assert.doesNotMatch(rolling, /close_maintenance_gate|verify_maintenance_gate|restore_database_snapshot/);
  assert.match(source, /if \[\[ "\$ROLLING_SAFE" == "1" \]\]; then\s+rolling_cutover\s+else\s+maintenance_cutover/);
  assert.match(source, /sync_nginx_security 3000 "\$ROLLING_PORT"/);
  assertOrdered(
    'sync_nginx_security 3000 "$ROLLING_PORT"',
    'settle_reloaded_nginx',
    '  rolling_cutover',
  );
});

test('state-changing releases retain the gated snapshot rollback path', () => {
  const maintenance = functionBody('maintenance_cutover');
  assertOrderedWithin(
    maintenance,
    '  CUTOVER_STARTED=1',
    '  close_maintenance_gate',
    '  verify_maintenance_gate',
    '  docker compose "${COMPOSE_ARGS[@]}" stop -t 120 cascade',
    '  OLD_BACKEND_STOPPED=1',
    '  checkpoint_and_snapshot',
    '  CANDIDATE_DATA_TOUCHED=1',
    '  verify_live_database',
    '  verify_authenticated_live_candidate "$CONTAINER_NAME" "http://127.0.0.1:3000"',
    '  DEPLOY_COMMITTED=1',
    '  open_maintenance_gate',
    '  verify_reopened_production_edge',
  );
});

test('production promotes an exact staged image without requiring capacity certification', () => {
  assert.match(source, /CERTIFIED_RELEASE_DIR="\/var\/lib\/cascade-release"/);
  assert.match(source, /CERTIFIED_MANIFEST="\$CERTIFIED_IMAGE_DIR\/\$REVISION\.json"/);
  assert.match(source, /CANDIDATE_IMAGE="cascade:certified-\$REVISION"/);
  assert.match(source, /CERTIFIED_IMAGE_ID="\$\(docker image inspect/);
  assert.match(source, /loaded_revision="\$\(docker image inspect/);
  assert.match(source, /staged release image has an invalid identity or revision label/);
  assert.match(source, /Capacity evidence is optional for routine releases/);
  assert.match(source, /certification directories must be canonical root-owned directories, mode 0700/);
  assert.match(source, /for certification_part in "\$CERTIFIED_MANIFEST" "\$CERTIFIED_MANIFEST\.sha256"/);
  assert.match(source, /certification and checksum must be regular root-owned files, mode 0600/);
  assert.match(source, /git status --porcelain --untracked-files=no/);
  assert.match(source, /-L "\$certification_part"/);
  assert.match(source, /certified-image\.mjs verify --manifest "\$CERTIFIED_MANIFEST"/);
  assert.match(source, /staged capacity certification differs from the release image/);
  assert.doesNotMatch(source, /operator-capacity-waiver/);
  assert.match(source, /docker run --rm --network none[\s\S]*RouteCatalog\.swap_ready\?\(\)/);
  assert.match(source, /running_image_id="\$\(docker inspect --format '\{\{\.Image\}\}'/);
  assert.match(source, /running_image_id" != "\$CERTIFIED_IMAGE_ID/);
  assert.doesNotMatch(source, /^\s*docker (?:compose )?build(?:\s|$)/mu);
  assert.doesNotMatch(source, /BUILD_ARGS/);
});

test('GitHub Actions is the only exact-revision production deploy entrypoint', () => {
  assert.match(workflow, /name: Deploy Production/);
  assert.match(workflow, /push:\s+branches: \[master\]/);
  assert.match(workflow, /group: deploy-production\s+cancel-in-progress: false/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /REVISION: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /"deploy \$REVISION"/);
  assert.match(workflow, /"verify \$REVISION"/);
  assert.match(workflow, /https:\/\/cscd\.online\/api\/health/);

  assert.match(hostDeploy, /REMOTE=https:\/\/github\.com\/grm4871\/fizzer\.git/);
  assert.match(hostDeploy, /git fetch --force --no-tags origin refs\/heads\/master/);
  assert.match(hostDeploy, /git merge-base --is-ancestor "\$revision" "\$master_revision"/);
  assert.match(hostDeploy, /git reset --hard "\$revision"/);
  assert.match(hostDeploy, /image="cascade:certified-\$revision"/);
  assert.match(hostDeploy, /bash deploy\/build-release-image\.sh/);
  assert.match(hostDeploy, /CASCADE_DEPLOY_DOMAIN="\$DOMAIN" bash deploy\/remote-update\.sh/);
  assert.match(hostDeploy, /running_revision" == "\$revision"/);
  assert.match(hostDeploy, /running_image" == "\$certified_image"/);
  assert.match(hostDeploy, /http:\/\/127\.0\.0\.1:3000\/api\/health/);
  assert.ok(
    hostDeploy.indexOf('git reset --hard "$revision"')
      < hostDeploy.indexOf('bash deploy/build-release-image.sh'),
    'the host must resolve the exact triggering commit before building it',
  );
  assert.equal(fs.existsSync(path.join(deployDirectory, 'deploy-watcher.sh')), false);
  assert.equal(fs.existsSync(path.join(deployDirectory, 'install-deploy-watcher.sh')), false);
});

test('the post-cutover installer sync verifies a release manifest before replacing routes', () => {
  const sync = fs.readFileSync(path.join(deployDirectory, 'sync-desktop-installers.sh'), 'utf8');
  assert.match(source, /bash "\$ROOT\/deploy\/sync-desktop-installers\.sh"/);
  assert.match(desktopWorkflow, /Refresh production download routes/);
  assert.match(desktopWorkflow, /gh workflow run deploy-production\.yml --ref "\$\{GITHUB_SHA\}"/);
  assert.match(sync, /Fizzer-mac-arm64\.dmg/);
  assert.match(sync, /Fizzer-mac-x64\.dmg/);
  assert.match(sync, /Fizzer-Setup\.exe/);
  assert.match(sync, /Fizzer-linux-x64\.deb/);
  assert.match(sync, /Fizzer-linux-x64\.rpm/);
  assert.match(sync, /sha256sum --check --status SHA256SUMS/);
  assert.match(sync, /mv -f "\$staging\/\$file" "\$DOWNLOADS_DIR\/\$file"/);
});

test('the host build reads an image identity supported by older Docker engines', () => {
  const build = fs.readFileSync(path.join(deployDirectory, 'build-release-image.sh'), 'utf8');
  assert.match(build, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.doesNotMatch(build, /\.Descriptor/);
});

test('preflight, rolling bridge, Compose, and the canonical candidate share the resource envelope', () => {
  assert.match(source, /cpus: 2,[\s\S]*cpuset: "0-1"[\s\S]*memory: 3 \* 1024 \*\* 3/);
  assert.match(source, /memorySwap: 3 \* 1024 \*\* 3,[\s\S]*pids: 100_000/);
  assert.match(source, /CASCADE_IMAGE="\$CANDIDATE_IMAGE" docker compose[\s\S]*config --format json/);
  assert.match(source, /--cpus 2 --cpuset-cpus 0-1 --memory 3g --memory-swap 3g/);
  assert.match(source, /--pids-limit 100000 --ulimit nofile=200000:200000/);
  assert.match(source, /verify_container_runtime_shape "\$PREFLIGHT_CONTAINER" "isolated candidate preflight"/);
  assert.match(source, /verify_container_runtime_shape "\$ROLLING_CONTAINER" "warmed rolling candidate"/);
  assert.match(source, /verify_container_runtime_shape "\$CONTAINER_NAME" "running production candidate"/);
  assert.match(source, /verify_container_runtime_shape "\$CONTAINER_NAME" "canonical rolling candidate"/);
});

test('authenticated production smoke runs directly against both rolling candidate instances', () => {
  assert.match(source, /Running authenticated production read\/realtime smoke against \$container/);
  assert.match(source, /release eval` starts a separate VM, not an RPC session/);
  assert.match(source, /new Database\("\/data\/docs\.db", \{ readonly: true, fileMustExist: true \}\)/);
  assert.match(source, /createHmac\("sha256", process\.env\.JWT_SECRET\)/);
  assert.match(source, /authenticated-live-smoke\.mjs "\$origin"/);
  assert.doesNotMatch(source, /runner:register/);
  assert.match(dockerfile, /COPY --chown=node:node deploy\/authenticated-live-smoke\.mjs \.\/deploy\/authenticated-live-smoke\.mjs/);
  const rolling = functionBody('rolling_cutover');
  assert.match(rolling, /verify_authenticated_live_candidate "\$CONTAINER_NAME" "http:\/\/127\.0\.0\.1:3000"/);
  const starter = functionBody('start_rolling_container');
  assert.match(starter, /verify_authenticated_live_candidate "\$ROLLING_CONTAINER" "http:\/\/127\.0\.0\.1:\$ROLLING_PORT"/);
});

test('the reopened TLS edge serves health, client assets, and Engine.IO', () => {
  assert.match(source, /--resolve "\$DEPLOY_DOMAIN:443:127\.0\.0\.1" "https:\/\/\$DEPLOY_DOMAIN\/api\/health"/);
  assert.match(source, /--resolve "\$DEPLOY_DOMAIN:443:127\.0\.0\.1" "https:\/\/\$DEPLOY_DOMAIN\/app\.html"/);
  assert.match(source, /root_html[\s\S]*<div id="root"/);
  assert.match(source, /root_html[\s\S]*assets\/main-/);
  assert.match(source, /socket\.io\/\?EIO=4&transport=polling/);
  assert.match(source, /Require three complete,[\s\S]*fresh edge probes/);
  assert.match(source, /health_code" == "200"[\s\S]*root_html[\s\S]*engine_open/);
  assert.match(source, /"\$consecutive" -ge 3/);
  assert.match(source, /reopened production edge did not stabilize/);
  assertOrderedWithin(
    functionBody('maintenance_cutover'),
    '  open_maintenance_gate',
    '  verify_reopened_production_edge',
  );
  assert.match(source, /docker compose "\$\{COMPOSE_ARGS\[@\]\}" ps/);
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

test('rolling failure keeps a verified bridge online and never rewinds user writes', () => {
  const rollback = functionBody('rollback_rolling_cutover');
  assert.match(source, /if \[\[ "\$ROLLING_STARTED" == "1" && "\$DEPLOY_COMMITTED" != "1" \]\]; then\s+rollback_rolling_cutover/);
  assert.match(rollback, /restoring the previous image without rewinding live data/);
  assert.match(rollback, /rolling rollback bridge/);
  assert.match(rollback, /CASCADE_IMAGE="\$ROLLBACK_IMAGE" docker compose/);
  assert.match(rollback, /Previous image restored with all rolling-window writes preserved/);
  assert.doesNotMatch(rollback, /restore_database_snapshot|SNAPSHOT_DB/);
  assert.match(rollback, /leaving the healthy candidate in service/);
  assert.match(rollback, /ROLLING_OLD_STOPPED" != "1" \]\] && container_running "\$CONTAINER_NAME"/);
  assert.match(rollback, /ROLLING_OLD_STOPPED=1/);
});

test('nginx uses a primary/backup upstream with bounded pre-send failover', () => {
  assert.match(nginxTemplate, /upstream cascade_app \{/);
  assert.match(nginxTemplate, /server 127\.0\.0\.1:CASCADE_PRIMARY_PORT/);
  assert.match(nginxTemplate, /CASCADE_BACKUP_SERVER/);
  assert.match(nginxTemplate, /proxy_next_upstream error timeout http_502 http_503 http_504/);
  assert.match(nginxTemplate, /proxy_next_upstream_tries 2/);
  assert.doesNotMatch(nginxTemplate, /proxy_next_upstream[^;]*non_idempotent/);
  assert.equal((nginxTemplate.match(/proxy_pass http:\/\/cascade_app;/g) || []).length, 4);
});

test('the one-time upstream bootstrap drains old HTTP keepalive workers before cutover', () => {
  const configure = functionBody('configure_nginx_upstreams');
  const settle = functionBody('settle_reloaded_nginx');
  assert.match(configure, /NGINX_CONFIG_CHANGED=1/);
  assert.match(settle, /seq 1 80/);
  assert.match(settle, /production health changed while nginx workers drained/);
  assert.match(settle, /https:\/\/\$DEPLOY_DOMAIN\/api\/health/);
  assert.doesNotMatch(settle, /close_maintenance_gate/);
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

test('isolated preflight classifies startup state before its mutating protocol probe', () => {
  assert.match(source, /busy preflight WAL checkpoint/);
  assert.match(source, /preflight SQLite quick_check failed/);
  assert.match(source, /Classify only startup DDL/);
  assertOrderedWithin(
    functionBody('preflight_candidate'),
    '  dump_live_schema "$PREFLIGHT_DIR/before-schema.json"',
    '    --materialize-schema /preflight/before-schema.json \\',
    '  boot_preflight_database',
    '    --dump-schema /preflight/after.db > "$PREFLIGHT_DIR/after-schema.json"',
    '    --schema-only --before-schema /preflight/before-schema.json --after-schema /preflight/after-schema.json 2>&1)"',
    '  start_preflight_server',
    '  docker run --rm --network host --entrypoint node \\',
    '  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null',
  );
  assert.match(functionBody('start_preflight_server'), /verify_container_runtime_shape "\$PREFLIGHT_CONTAINER" "isolated candidate preflight"/);
  assert.match(functionBody('verify_migration_clone'), /--before \/preflight\/before\.db --after \/preflight\/after\.db/);
});

test('preflight and live cutover bind the complete vault and QMD corpus without exemptions', () => {
  assert.match(functionBody('verify_migration_clone'), /before-data\/vaults/);
  assert.match(functionBody('verify_migration_clone'), /before-data\/qmd/);
  assert.match(functionBody('verify_migration_clone'), /--before-root \/preflight\/before-data --after-root \/preflight\/after-data/);
  assert.match(source, /"\$SNAPSHOT_DIR\/corpus\/vaults"/);
  assert.match(source, /"\$SNAPSHOT_DIR\/corpus\/qmd"/);
  assert.match(source, /--before-root \/snapshot\/corpus --after-root \/live-corpus/);
  assert.match(source, /"\$DATA_DIR\/\.cascade\/vaults:\/live-corpus\/vaults:ro"/);
  assert.match(source, /"\$DATA_DIR\/\.cascade\/qmd:\/live-corpus\/qmd:ro"/);
  assert.doesNotMatch(source, /"\$DATA_DIR\/\.cascade:\/live-corpus:ro"/);
  assert.match(source, /CASCADE_SQLITE_SNAPSHOT_TMPDIR=\/sqlite-scratch/);
  assert.match(source, /sqlite-scratch:\/sqlite-scratch/);
  assert.doesNotMatch(source, /allow-derived|ignore.*index\.sqlite/iu);
  assert.match(source, /Candidate boot is schema-identical; rolling cutover is eligible/);
  assert.match(source, /--schema-only/);
  assert.match(source, /verify_live_schema_identity "\$ROLLING_CONTAINER"/);
  assert.doesNotMatch(source, /verify_live_schema_identity "\$CONTAINER_NAME"/);
  assert.doesNotMatch(functionBody('preflight_candidate'), /--require-identical/);
  assert.doesNotMatch(functionBody('verify_live_schema_identity'), /backup_running_database/);
});

test('production gives runners ten minutes to reclaim after gated candidate startup', () => {
  const configured = compose.match(/CASCADE_RUNNER_ORPHAN_RECLAIM_MS:\s*"(\d+)"/);
  assert.ok(configured, 'production runner reclaim override is missing');
  assert.equal(Number(configured[1]), 600_000);

  const healthAttempts = source.match(/wait_for_url "\$HEALTH_URL" (\d+) "Elixir candidate"/);
  assert.ok(healthAttempts, 'candidate health wait is missing');
  assert.ok(Number(configured[1]) > Number(healthAttempts[1]) * 2_000);
  assertOrderedWithin(
    functionBody('maintenance_cutover'),
    '  CANDIDATE_DATA_TOUCHED=1',
    '  wait_for_url "$HEALTH_URL" 90 "Elixir candidate"',
    '  verify_live_database',
    '  DEPLOY_COMMITTED=1',
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
  );
  assert.match(functionBody('maintenance_cutover'), /CANDIDATE_DATA_TOUCHED=1/);
  assert.match(functionBody('rolling_cutover'), /start_rolling_container/);
});
