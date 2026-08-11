#!/usr/bin/env bash
# Production update with an offline Elixir/data preflight, a mutation-free
# cutover window, and an automatic image+database rollback.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/deploy/deploy-lock.sh"
acquire_cascade_deploy_lock "$ROOT"
cd "$ROOT"

# systemd/root deploys can hit "dubious ownership" on this checkout.
git config --global --add safe.directory "$ROOT" 2>/dev/null || true

COMPOSE_ARGS=(-f docker-compose.yml)
HEALTH_URL="http://127.0.0.1:3000/api/health"
CONTAINER_NAME="cascade"
DATA_DIR="/var/lib/cascade"
LIVE_DB="$DATA_DIR/docs.db"
MAINTENANCE_MARKER="/run/cascade-maintenance"
REVISION="$(git rev-parse HEAD)"
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]] || \
   [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Error: production cutover requires a clean tracked checkout at one full Git revision." >&2
  exit 1
fi
REVISION_SHORT="${REVISION:0:12}"
CERTIFIED_RELEASE_DIR="/var/lib/cascade-release"
CERTIFIED_IMAGE_DIR="$CERTIFIED_RELEASE_DIR/certified-images"
CERTIFIED_MANIFEST="$CERTIFIED_IMAGE_DIR/$REVISION.json"
CERTIFIED_IMAGE_ID=""
CANDIDATE_IMAGE=""
ROLLBACK_IMAGE="cascade:rollback-$REVISION"
PREFLIGHT_DIR=""
PREFLIGHT_CONTAINER="cascade-preflight-$REVISION"
SNAPSHOT_DIR=""
SNAPSHOT_DB=""
CUTOVER_STARTED=0
DEPLOY_COMMITTED=0
ROLLBACK_IN_PROGRESS=0
OLD_BACKEND_STOPPED=0
CANDIDATE_DATA_TOUCHED=0
DEPLOY_DOMAIN=""

close_maintenance_gate() {
  # Replace, rather than follow, any unexpected object at the marker path.
  rm -f -- "$MAINTENANCE_MARKER"
  install -m 0644 -o 0 -g 0 /dev/null "$MAINTENANCE_MARKER"
  if [[ -L "$MAINTENANCE_MARKER" || ! -f "$MAINTENANCE_MARKER" ]] ||
     [[ "$(stat -c '%u:%g:%a' "$MAINTENANCE_MARKER")" != "0:0:644" ]]; then
    echo "Error: could not establish the root-owned maintenance gate." >&2
    return 1
  fi
}

open_maintenance_gate() {
  if ! rm -f -- "$MAINTENANCE_MARKER" || [[ -e "$MAINTENANCE_MARKER" || -L "$MAINTENANCE_MARKER" ]]; then
    echo "CRITICAL: maintenance marker could not be removed; traffic remains gated." >&2
    return 1
  fi
}

load_certified_candidate() {
  echo "==> Verifying staged certification for $REVISION"
  local release_dir
  for release_dir in "$CERTIFIED_RELEASE_DIR" "$CERTIFIED_IMAGE_DIR"; do
    if [[ -L "$release_dir" || ! -d "$release_dir" ]] ||
       [[ "$(stat -c '%u:%g:%a' "$release_dir")" != "0:0:700" ]]; then
      echo "Error: certification directories must be canonical root-owned directories, mode 0700." >&2
      return 1
    fi
  done
  if [[ ! -f "$CERTIFIED_MANIFEST" || ! -f "$CERTIFIED_MANIFEST.sha256" ]]; then
    echo "Error: no staged certification manifest exists for $REVISION." >&2
    echo "       Run npm run release:image:stage before pushing this commit." >&2
    return 1
  fi
  local certificate_file
  for certificate_file in "$CERTIFIED_MANIFEST" "$CERTIFIED_MANIFEST.sha256"; do
    if [[ -L "$certificate_file" || ! -f "$certificate_file" ]] ||
       [[ "$(stat -c '%u:%g:%a' "$certificate_file")" != "0:0:600" ]]; then
      echo "Error: certification manifest and checksum must be regular root-owned files, mode 0600." >&2
      return 1
    fi
  done

  CERTIFIED_IMAGE_ID="$(node deploy/certified-image.mjs verify --manifest "$CERTIFIED_MANIFEST")"
  CANDIDATE_IMAGE="$(node deploy/certified-image.mjs field --manifest "$CERTIFIED_MANIFEST" --name image.tag)"
  if [[ "$CANDIDATE_IMAGE" != "cascade:certified-$REVISION" || ! "$CERTIFIED_IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "Error: staged certification has a non-canonical image identity." >&2
    return 1
  fi

  local embedded_gate
  embedded_gate="$(docker run --rm --network none \
    --entrypoint /app/release/bin/cascade_elixir "$CANDIDATE_IMAGE" eval \
    'if CascadeWeb.RouteCatalog.swap_ready?(), do: IO.puts("swap-ready"), else: System.halt(42)')"
  if [[ "$embedded_gate" != *"swap-ready"* ]]; then
    echo "Error: certified image does not contain an approved cutover gate." >&2
    return 1
  fi
  echo "==> Certified candidate is $CERTIFIED_IMAGE_ID"
}

verify_runtime_shape_json() {
  local label="${1:?runtime-shape label is required}"
  CASCADE_SHAPE_LABEL="$label" node --input-type=module -e '
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const parsed = JSON.parse(input);
    const compose = parsed?.services?.cascade;
    const host = Array.isArray(parsed) ? parsed[0]?.HostConfig : null;
    const nofile = compose
      ? compose.ulimits?.nofile
      : host?.Ulimits?.find((entry) => entry.Name === "nofile");
    const actual = compose ? {
      cpus: Number(compose.cpus),
      cpuset: compose.cpuset,
      memory: Number(compose.mem_limit),
      memorySwap: Number(compose.memswap_limit),
      pids: Number(compose.pids_limit),
      nofileSoft: Number(nofile?.soft),
      nofileHard: Number(nofile?.hard),
    } : {
      cpus: Number(host?.NanoCpus) / 1_000_000_000,
      cpuset: host?.CpusetCpus,
      memory: Number(host?.Memory),
      memorySwap: Number(host?.MemorySwap),
      pids: Number(host?.PidsLimit),
      nofileSoft: Number(nofile?.Soft),
      nofileHard: Number(nofile?.Hard),
    };
    const expected = {
      cpus: 2,
      cpuset: "0-1",
      memory: 3 * 1024 ** 3,
      memorySwap: 3 * 1024 ** 3,
      pids: 100_000,
      nofileSoft: 200_000,
      nofileHard: 200_000,
    };
    const mismatches = Object.keys(expected)
      .filter((key) => actual[key] !== expected[key])
      .map((key) => `${key}=${actual[key] ?? "missing"} expected=${expected[key]}`);
    if (mismatches.length) {
      console.error(`Error: ${process.env.CASCADE_SHAPE_LABEL} differs from the certified runtime envelope: ${mismatches.join(", ")}`);
      process.exit(1);
    }
  '
  echo "==> $label matches the certified 2 CPU / 3 GiB runtime envelope"
}

verify_compose_runtime_shape() {
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" config --format json \
    | verify_runtime_shape_json "Compose candidate configuration"
}

verify_container_runtime_shape() {
  local container="${1:?container is required}"
  local label="${2:?runtime-shape label is required}"
  docker inspect "$container" | verify_runtime_shape_json "$label"
}

secure_production_environment() {
  local environment_file="$ROOT/.env"
  if [[ "$EUID" -ne 0 || -L "$environment_file" || ! -f "$environment_file" ]]; then
    echo "Error: production requires a regular root-managed .env file." >&2
    return 1
  fi
  chown 0:0 "$environment_file"
  chmod 0600 "$environment_file"
  if [[ "$(stat -c '%u:%g:%a' "$environment_file")" != "0:0:600" ]]; then
    echo "Error: production .env must be root-owned and mode 0600." >&2
    return 1
  fi
  echo "==> Production environment file permissions are secure"
}

wait_for_url() {
  local url="${1:?health URL is required}"
  local max_attempts="${2:-90}"
  local label="${3:-app}"

  echo "==> Waiting for $label"
  for i in $(seq 1 "$max_attempts"); do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "$url" 2>/dev/null || true)
    code="${code:-000}"
    if [[ "$code" == "200" ]]; then
      echo "    $label is up."
      return 0
    fi
    if [[ "$i" -eq "$max_attempts" ]]; then
      echo "Error: $label did not become ready (last HTTP status: ${code})." >&2
      return 1
    fi
    sleep 2
  done
}

check_engine_io() {
  local origin="${1:?origin is required}"
  local open_packet legacy_code

  open_packet=$(curl -fsS --connect-timeout 3 --max-time 8 \
    "$origin/socket.io/?EIO=4&transport=polling&t=$RANDOM")
  if [[ "$open_packet" != 0* ]]; then
    echo "Error: Engine.IO v4 did not return an OPEN packet." >&2
    return 1
  fi

  legacy_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 \
    "$origin/socket.io/?EIO=3&transport=polling&t=$RANDOM" || true)
  if [[ "$legacy_code" != "400" ]]; then
    echo "Error: Engine.IO v3 must fail closed with HTTP 400 (got $legacy_code)." >&2
    return 1
  fi
  echo "==> Engine.IO v4 accepted and v3 rejected"
}

verify_maintenance_gate() {
  if [[ -z "$DEPLOY_DOMAIN" ]]; then
    echo "Error: deployment domain is unavailable for maintenance-gate verification." >&2
    return 1
  fi

  # A graceful nginx reload can leave the retiring worker generation alive for
  # a moment. Prove that fresh connections consistently reach the gated
  # generation before stopping the old backend.
  local code="000" consecutive=0
  for _attempt in $(seq 1 20); do
    code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/api/health" || true)
    if [[ "$code" == "503" ]]; then
      consecutive=$((consecutive + 1))
      if [[ "$consecutive" -ge 3 ]]; then
        echo "==> Nginx maintenance gate verified"
        return 0
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  echo "Error: nginx maintenance gate did not stabilize at HTTP 503 (last status: ${code:-000})." >&2
  return 1
}

sync_nginx_security() {
  local domain="${CASCADE_DEPLOY_DOMAIN:-}"
  local site="/etc/nginx/sites-available/cscd"
  if [[ "$EUID" -ne 0 || ! -f "$site" ]]; then
    echo "Error: a root-managed $site is required for a mutation-free cutover." >&2
    return 1
  fi
  if [[ -z "$domain" && -f "$ROOT/.env" ]]; then
    local configured_url
    configured_url="$(sed -nE 's/^[[:space:]]*CASCADE_PUBLIC_URL=//p' "$ROOT/.env" | tail -1)"
    configured_url="${configured_url#\"}"
    configured_url="${configured_url%\"}"
    configured_url="${configured_url#\'}"
    configured_url="${configured_url%\'}"
    domain="${configured_url#*://}"
    domain="${domain%%/*}"
  fi
  if [[ -z "$domain" ]]; then
    domain="$(awk '$1 == "server_name" { for (i=2; i<=NF; i++) { gsub(/;/, "", $i); if ($i !~ /^www\./ && $i != "_") { print $i; exit } } }' "$site")"
  fi
  if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
    echo "Error: invalid CASCADE_DEPLOY_DOMAIN '$domain'" >&2
    return 1
  fi
  DEPLOY_DOMAIN="$domain"

  local rendered backup
  rendered="$(mktemp)"
  backup="$(mktemp)"
  cp "$site" "$backup"
  sed "s/DOMAIN/$domain/g" deploy/nginx.conf.template > "$rendered"
  if ! grep -q "www\.$domain" "$site"; then
    sed -i "s/ www\.$domain//g" "$rendered"
  fi
  install -m 0644 "$rendered" "$site"
  if ! nginx -t; then
    install -m 0644 "$backup" "$site"
    nginx -t
    find "$rendered" "$backup" -maxdepth 0 -type f -delete
    echo "Error: restored previous nginx site after validation failed" >&2
    return 1
  fi
  if ! systemctl reload nginx; then
    install -m 0644 "$backup" "$site"
    nginx -t
    systemctl reload nginx
    find "$rendered" "$backup" -maxdepth 0 -type f -delete
    echo "Error: restored previous nginx site after reload failed" >&2
    return 1
  fi
  if ! nginx -T 2>&1 | grep -F 'if (-f /run/cascade-maintenance)' >/dev/null; then
    install -m 0644 "$backup" "$site"
    nginx -t
    systemctl reload nginx
    find "$rendered" "$backup" -maxdepth 0 -type f -delete
    echo "Error: active nginx configuration does not contain the maintenance gate." >&2
    return 1
  fi
  find "$rendered" "$backup" -maxdepth 0 -type f -delete
  echo "==> Nginx security and cutover gate are active"
}

cleanup_preflight() {
  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null 2>&1 || true
  if [[ -n "$PREFLIGHT_DIR" && "$PREFLIGHT_DIR" == "$DATA_DIR"/.deploy-preflight.* && -d "$PREFLIGHT_DIR" ]]; then
    find "$PREFLIGHT_DIR" -depth -delete 2>/dev/null || true
  fi
}

restore_database_snapshot() {
  if [[ -z "$SNAPSHOT_DB" || ! -f "$SNAPSHOT_DB" ]]; then
    echo "Error: no cutover database snapshot is available for rollback." >&2
    return 1
  fi

  "$ROOT/deploy/restore-sqlite-snapshot.sh" "$SNAPSHOT_DIR" "$LIVE_DB" "$REVISION"
}

rollback_cutover() {
  if [[ "$ROLLBACK_IN_PROGRESS" == "1" ]]; then
    return 1
  fi
  ROLLBACK_IN_PROGRESS=1
  set +e
  echo "==> Candidate failed; restoring the pre-cutover service" >&2
  if ! close_maintenance_gate; then
    echo "CRITICAL: rollback cannot prove traffic is gated; refusing to mutate production data." >&2
    return 1
  fi
  local backend_running
  backend_running="$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)"
  if [[ "$OLD_BACKEND_STOPPED" == "1" || "$backend_running" != "true" ]]; then
    if [[ "$backend_running" == "true" ]]; then
      CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" stop -t 30 cascade || true
    fi
    if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" == "true" ]]; then
      echo "CRITICAL: candidate is still running; refusing an unsafe database restore" >&2
      return 1
    fi
    if [[ "$CANDIDATE_DATA_TOUCHED" == "1" ]]; then
      if ! restore_database_snapshot; then
        echo "CRITICAL: database restore failed; refusing to boot the old image" >&2
        return 1
      fi
    fi
    if ! CASCADE_IMAGE="$ROLLBACK_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
      up -d --no-build --force-recreate; then
      echo "CRITICAL: rollback image failed to start" >&2
      return 1
    fi
  fi
  if wait_for_url "$HEALTH_URL" 60 "rollback" && systemctl is-active --quiet nginx; then
    if open_maintenance_gate; then
      echo "==> Rollback is healthy; external traffic restored" >&2
    fi
  else
    echo "CRITICAL: rollback did not become healthy; maintenance gate remains active" >&2
  fi
  set -e
}

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_preflight
  if [[ "$CUTOVER_STARTED" == "1" && "$DEPLOY_COMMITTED" != "1" ]]; then
    rollback_cutover || true
  fi
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

backup_running_database() {
  local destination="${1:?destination is required}"
  local relative
  relative="${destination#"$DATA_DIR"/}"
  if [[ "$relative" == "$destination" || "$relative" == *".."* ]]; then
    echo "Error: backup destination must be a resolved child of $DATA_DIR" >&2
    return 1
  fi

  docker exec -e CASCADE_BACKUP_PATH="/data/$relative" "$CONTAINER_NAME" \
    node --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/data/docs.db", { fileMustExist: true });
      try { await db.backup(process.env.CASCADE_BACKUP_PATH); } finally { db.close(); }
    '
}

preflight_candidate() {
  echo "==> Running isolated data and protocol preflight"
  PREFLIGHT_DIR="$(mktemp -d "$DATA_DIR/.deploy-preflight.XXXXXX")"
  chown 1000:1000 "$PREFLIGHT_DIR"

  if docker ps --format '{{.Names}}' | grep -Fxq "$CONTAINER_NAME"; then
    backup_running_database "$PREFLIGHT_DIR/before.db"
  else
    cp --reflink=auto --sparse=always "$LIVE_DB" "$PREFLIGHT_DIR/before.db"
    chown 1000:1000 "$PREFLIGHT_DIR/before.db"
  fi
  cp --reflink=auto --sparse=always "$PREFLIGHT_DIR/before.db" "$PREFLIGHT_DIR/after.db"
  mkdir -p "$PREFLIGHT_DIR/before-data" "$PREFLIGHT_DIR/after-data" "$PREFLIGHT_DIR/sqlite-scratch"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/vaults" "$PREFLIGHT_DIR/before-data/vaults"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/qmd" "$PREFLIGHT_DIR/before-data/qmd"
  cp -a --reflink=auto -- "$PREFLIGHT_DIR/before-data/vaults" "$PREFLIGHT_DIR/after-data/vaults"
  cp -a --reflink=auto -- "$PREFLIGHT_DIR/before-data/qmd" "$PREFLIGHT_DIR/after-data/qmd"
  chown -R 1000:1000 "$PREFLIGHT_DIR"

  docker run --rm --network none --env-file "$ROOT/.env" \
    -e CASCADE_SERVER=false \
    -e CASCADE_QMD_WORKER_ENABLED=false \
    -e CASCADE_DATA_DIR=/preflight/after-data \
    -e CASCADE_VAULTS_BASE_DIR=/preflight/after-data/vaults \
    -e CASCADE_QMD_DIR=/preflight/after-data/qmd \
    -e DOCS_DB_PATH=/preflight/after.db \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" eval \
    'case Application.ensure_all_started(:cascade_elixir) do {:ok, _} -> :ok; other -> raise inspect(other) end'

  # `release eval` stops the VM immediately after evaluation. With the source
  # database in WAL mode, the final schema recreation can therefore still be
  # present only in after.db-wal. Checkpoint the now-quiescent clone before the
  # compatibility checker deliberately snapshots the main database file.
  docker run --rm --network none --user 1000:1000 --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight" "$CANDIDATE_IMAGE" --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/preflight/after.db", { fileMustExist: true });
      try {
        const result = db.pragma("wal_checkpoint(TRUNCATE)");
        if (result.some((row) => Number(row.busy) !== 0)) throw new Error(`busy preflight WAL checkpoint: ${JSON.stringify(result)}`);
        if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("preflight SQLite quick_check failed");
      } finally { db.close(); }
    '

  docker run --rm --network none --entrypoint node \
    -e CASCADE_SQLITE_SNAPSHOT_TMPDIR=/sqlite-scratch \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    -v "$PREFLIGHT_DIR/sqlite-scratch:/sqlite-scratch" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --before /preflight/before.db --after /preflight/after.db \
    --before-root /preflight/before-data --after-root /preflight/after-data

  docker run -d --name "$PREFLIGHT_CONTAINER" --env-file "$ROOT/.env" \
    --cpus 2 --cpuset-cpus 0-1 --memory 3g --memory-swap 3g \
    --pids-limit 100000 --ulimit nofile=200000:200000 \
    -e API_PORT=3000 \
    -e CASCADE_BIND_IP=0.0.0.0 \
    -e CASCADE_NETWORK_MODE=false \
    -e CASCADE_QMD_WORKER_ENABLED=false \
    -e CASCADE_DATA_DIR=/preflight/after-data \
    -e CASCADE_VAULTS_BASE_DIR=/preflight/after-data/vaults \
    -e CASCADE_QMD_DIR=/preflight/after-data/qmd \
    -e DOCS_DB_PATH=/preflight/after.db \
    -p 127.0.0.1::3000 \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" >/dev/null
  verify_container_runtime_shape "$PREFLIGHT_CONTAINER" "isolated candidate preflight"

  local mapped_port
  mapped_port="$(docker port "$PREFLIGHT_CONTAINER" 3000/tcp | sed -n 's/.*://p' | head -1)"
  if [[ ! "$mapped_port" =~ ^[0-9]+$ ]]; then
    echo "Error: could not resolve candidate preflight port." >&2
    return 1
  fi
  wait_for_url "http://127.0.0.1:$mapped_port/api/health" 60 "candidate preflight"
  check_engine_io "http://127.0.0.1:$mapped_port"
  docker run --rm --network host --entrypoint node \
    "$CANDIDATE_IMAGE" /app/deploy/preflight-client.mjs "http://127.0.0.1:$mapped_port"
  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null
}

checkpoint_and_snapshot() {
  echo "==> Checkpointing and snapshotting the quiescent production database"
  docker run --rm --network none --user 0:0 --entrypoint node \
    -v "$DATA_DIR:/data" "$CANDIDATE_IMAGE" --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/data/docs.db", { fileMustExist: true });
      try {
        const result = db.pragma("wal_checkpoint(TRUNCATE)");
        if (result.some((row) => Number(row.busy) !== 0)) throw new Error(`busy WAL checkpoint: ${JSON.stringify(result)}`);
        if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("SQLite quick_check failed");
      } finally { db.close(); }
    '

  SNAPSHOT_DIR="/var/backups/cascade/cutover-$REVISION-$(date -u +%Y%m%dT%H%M%SZ)"
  install -d -m 0700 "$SNAPSHOT_DIR"
  local snapshot_tmp="$SNAPSHOT_DIR/.docs.db.incomplete"
  cp --reflink=auto --sparse=always --preserve=mode,ownership,timestamps "$LIVE_DB" "$snapshot_tmp"
  docker run --rm --network none --user 0:0 --entrypoint node \
    -v "$SNAPSHOT_DIR:/snapshot:ro" "$CANDIDATE_IMAGE" --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/snapshot/.docs.db.incomplete", { readonly: true, fileMustExist: true });
      try {
        if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("snapshot quick_check failed");
        if (db.pragma("foreign_key_check").length) throw new Error("snapshot foreign_key_check failed");
      } finally { db.close(); }
    '
  mv "$snapshot_tmp" "$SNAPSHOT_DIR/docs.db"
  install -d -m 0700 "$SNAPSHOT_DIR/corpus"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/vaults" "$SNAPSHOT_DIR/corpus/vaults"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/qmd" "$SNAPSHOT_DIR/corpus/qmd"
  (cd "$SNAPSHOT_DIR" && sha256sum docs.db > docs.db.sha256)
  SNAPSHOT_DB="$SNAPSHOT_DIR/docs.db"
  git rev-parse HEAD > "$SNAPSHOT_DIR/revision.txt"
}

verify_live_database() {
  backup_running_database "$PREFLIGHT_DIR/live-after.db"
  docker run --rm --network none --user 0:0 --entrypoint node \
    -e CASCADE_SQLITE_SNAPSHOT_TMPDIR=/sqlite-scratch \
    -v "$SNAPSHOT_DIR:/snapshot:ro" \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    -v "$PREFLIGHT_DIR/sqlite-scratch:/sqlite-scratch" \
    -v "$DATA_DIR/.cascade:/live-corpus:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --before /snapshot/docs.db --after /preflight/live-after.db \
    --before-root /snapshot/corpus --after-root /live-corpus
}

verify_authenticated_live_candidate() {
  echo "==> Running authenticated production read/realtime smoke behind the maintenance gate"
  local probe_token
  probe_token="$(docker exec "$CONTAINER_NAME" /app/release/bin/cascade_elixir eval '
    case Cascade.Accounts.SQL.one("""
      SELECT DISTINCT u.id FROM users u
      JOIN vaults v ON v.created_by=u.id
      JOIN notes n ON n.vault_id=v.id
      WHERE n.is_archived=0
        AND (n.content LIKE 'cascade://chat-channel%' OR n.content_preview LIKE 'cascade://chat-channel%')
      ORDER BY u.id ASC LIMIT 1
    """) do
      [id] ->
        {:ok, user} = Cascade.Auth.Accounts.fetch_by_id(id)
        IO.write(Cascade.Auth.Token.sign_user(user))
      _ ->
        raise "production has no owner account with an accessible chat channel"
    end
  ')"
  if [[ -z "$probe_token" ]]; then
    echo "Error: could not mint the ephemeral authenticated smoke token." >&2
    return 1
  fi
  printf '%s' "$probe_token" | docker run --rm -i --network host --entrypoint node \
    "$CANDIDATE_IMAGE" /app/deploy/authenticated-live-smoke.mjs "http://127.0.0.1:3000"
  unset probe_token
}

verify_reopened_production_edge() {
  echo "==> Verifying the reopened production edge"
  local health_code root_html engine_open
  health_code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
    --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/api/health")"
  if [[ "$health_code" != "200" ]]; then
    echo "Error: reopened production health returned HTTP ${health_code:-000}." >&2
    return 1
  fi
  root_html="$(curl --noproxy '*' -fsS --connect-timeout 3 --max-time 10 \
    --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/")"
  if [[ "$root_html" != *'<div id="root"></div>'* ]]; then
    echo "Error: reopened production edge did not serve the client entrypoint." >&2
    return 1
  fi
  engine_open="$(curl --noproxy '*' -fsS --connect-timeout 3 --max-time 10 \
    --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" \
    "https://$DEPLOY_DOMAIN/socket.io/?EIO=4&transport=polling&t=$RANDOM")"
  if [[ "$engine_open" != 0* ]]; then
    echo "Error: reopened production edge did not return an Engine.IO v4 OPEN packet." >&2
    return 1
  fi
  echo "==> Reopened production health, client, TLS edge, and Engine.IO are verified"
}

ensure_cutover_disk_capacity() {
  if [[ ! -f "$LIVE_DB" ]]; then
    echo "Error: production database $LIVE_DB does not exist." >&2
    return 1
  fi

  local database_kb available_kb required_kb
  database_kb="$(( ($(stat -c '%s' "$LIVE_DB") + 1023) / 1024 ))"
  available_kb="$(df -Pk "$DATA_DIR" | awk 'NR==2 {print $4}')"
  # Peak cutover storage includes isolated before/after copies, the immutable
  # rollback snapshot, and the post-start verification backup. Keep 1 GiB free
  # beyond those four logical database copies so a reflink-capable filesystem
  # is an optimization, never an assumption.
  required_kb="$(( database_kb * 4 + 1048576 ))"
  if (( available_kb < required_kb )); then
    echo "Error: cutover needs ${required_kb} KiB free for verified snapshots; only ${available_kb} KiB is available." >&2
    return 1
  fi
  echo "==> Cutover snapshot capacity available (${available_kb} KiB free; ${required_kb} KiB required)"
}

AVAIL_KB="$(df -k / | awk 'NR==2 {print $4}')"
if [[ "$AVAIL_KB" -lt 2097152 ]]; then
  echo "==> Low disk space — pruning unused Docker build cache"
  docker builder prune -af --filter "until=24h" >/dev/null || true
  AVAIL_KB="$(df -k / | awk 'NR==2 {print $4}')"
  if [[ "$AVAIL_KB" -lt 1048576 ]]; then
    echo "Error: less than 1 GiB free on disk; refusing a snapshot-backed deploy." >&2
    df -h /
    exit 1
  fi
fi

# Remove only stopped Compose leftovers. Never stop the live app as cleanup.
mapfile -t STALE_CONTAINERS < <(
  docker compose "${COMPOSE_ARGS[@]}" ps -aq \
    --status created --status exited --status dead cascade | sort -u
)
if [[ "${#STALE_CONTAINERS[@]}" -gt 0 ]]; then
  echo "==> Removing stale Cascade recreate containers"
  docker rm "${STALE_CONTAINERS[@]}" >/dev/null
fi

load_certified_candidate
verify_compose_runtime_shape
ensure_cutover_disk_capacity
secure_production_environment
preflight_candidate
sync_nginx_security

CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
if [[ -z "$CURRENT_IMAGE_ID" ]]; then
  echo "Error: no running production image is available for rollback." >&2
  exit 1
fi
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"

echo "==> Entering the mutation-free cutover window"
CUTOVER_STARTED=1
close_maintenance_gate
verify_maintenance_gate

if [[ "${CASCADE_TUNE_HOST_CAPACITY:-1}" == "1" ]]; then
  "$ROOT/deploy/tune-host-capacity.sh"
fi

# Stopping first closes pre-existing WebSockets; the nginx marker prevents all
# reconnects and HTTP keep-alive mutations until verification is complete.
docker compose "${COMPOSE_ARGS[@]}" stop -t 120 cascade
OLD_BACKEND_STOPPED=1
checkpoint_and_snapshot

echo "==> Starting the Elixir candidate"
CANDIDATE_DATA_TOUCHED=1
CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
  up -d --no-build --force-recreate

verify_container_runtime_shape "$CONTAINER_NAME" "running production candidate"
wait_for_url "$HEALTH_URL" 90 "Elixir candidate"
check_engine_io "http://127.0.0.1:3000"
verify_live_database
verify_authenticated_live_candidate
RUNNING_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
if [[ "$RUNNING_IMAGE_ID" != "$CERTIFIED_IMAGE_ID" ]]; then
  echo "Error: running candidate is $RUNNING_IMAGE_ID, expected certified image $CERTIFIED_IMAGE_ID." >&2
  exit 1
fi

docker tag "$CERTIFIED_IMAGE_ID" cascade:latest
# Once the gate opens, external mutations can reach the candidate and an
# automatic database rollback would lose them. Commit first, then open traffic;
# a marker-removal failure therefore leaves the verified candidate fail-closed.
DEPLOY_COMMITTED=1
open_maintenance_gate
verify_reopened_production_edge

docker compose "${COMPOSE_ARGS[@]}" ps
echo "==> Deployed $REVISION_SHORT ($CERTIFIED_IMAGE_ID); rollback snapshot: $SNAPSHOT_DIR"

echo "==> Pruning dangling images and old build cache"
docker image prune -f >/dev/null || true
docker builder prune -af --filter "until=72h" >/dev/null || true
df -h / | awk 'NR==2 {printf "    Disk: %s used, %s free (%s)\n", $3, $4, $5}'
