# Remote update snapshot seam.
# Inputs are production/candidate mounts and database globals; outputs are immutable snapshots and schema evidence.
# Ordering checkpoints/quiesces data, snapshots bytes, then compares live candidate state.

cleanup_preflight() {
  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null 2>&1 || true
  if [[ -n "$PREFLIGHT_DIR" && "$PREFLIGHT_DIR" == "$DATA_DIR"/.deploy-preflight.* && -d "$PREFLIGHT_DIR" ]]; then
    find "$PREFLIGHT_DIR" -depth -delete 2>/dev/null || true
  fi
}
backup_running_database() {
  local destination="${1:?destination is required}"
  local container="${2:-$CONTAINER_NAME}"
  local relative
  relative="${destination#"$DATA_DIR"/}"
  if [[ "$relative" == "$destination" || "$relative" == *".."* ]]; then
    echo "Error: backup destination must be a resolved child of $DATA_DIR" >&2
    return 1
  fi

  docker exec -e CASCADE_BACKUP_PATH="/data/$relative" "$container" \
    node --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/data/docs.db", { fileMustExist: true });
      try { await db.backup(process.env.CASCADE_BACKUP_PATH); } finally { db.close(); }
    '
}

checkpoint_preflight_clone() {
  # A short-lived release VM may leave its final writes in WAL. The identity
  # checker deliberately reads an immutable main-file copy, so checkpoint each
  # complete boot mode after it has stopped.
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
}

start_preflight_server() {
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

  PREFLIGHT_PORT="$(docker port "$PREFLIGHT_CONTAINER" 3000/tcp | sed -n 's/.*://p' | head -1)"
  if [[ ! "$PREFLIGHT_PORT" =~ ^[0-9]+$ ]]; then
    echo "Error: could not resolve candidate preflight port." >&2
    return 1
  fi
  wait_for_url "http://127.0.0.1:$PREFLIGHT_PORT/api/health" 60 "candidate preflight"
}

dump_sqlite_schema() {
  local source="${1:?schema source database is required}"
  local destination="${2:?schema dump path is required}"
  docker run --rm --network none --entrypoint node \
    -v "$(dirname "$source"):/schema-source:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --dump-schema "/schema-source/$(basename "$source")" \
    > "$destination"
}

dump_live_schema() {
  local destination="${1:?schema dump path is required}"
  # The running production image may predate this checker. Read the live
  # database with the candidate image while sharing the WAL directory.
  if container_running "$CONTAINER_NAME"; then
    docker run --rm --network none --volumes-from "$CONTAINER_NAME" --entrypoint node \
      "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
      --dump-schema /data/docs.db > "$destination"
    return
  fi
  dump_sqlite_schema "$LIVE_DB" "$destination"
}

boot_preflight_database() {
  mkdir -p "$PREFLIGHT_DIR/after-data/vaults" "$PREFLIGHT_DIR/after-data/qmd"
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
  checkpoint_preflight_clone
}

verify_migration_clone() {
  echo "==> Candidate boot mutates schema; verifying maintenance-cutover compatibility"
  mkdir -p "$PREFLIGHT_DIR/before-data" "$PREFLIGHT_DIR/after-data" "$PREFLIGHT_DIR/sqlite-scratch"
  if container_running "$CONTAINER_NAME"; then
    backup_running_database "$PREFLIGHT_DIR/before.db"
  else
    cp --reflink=auto --sparse=always "$LIVE_DB" "$PREFLIGHT_DIR/before.db"
    chown 1000:1000 "$PREFLIGHT_DIR/before.db"
  fi
  cp --reflink=auto --sparse=always "$PREFLIGHT_DIR/before.db" "$PREFLIGHT_DIR/after.db"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/vaults" "$PREFLIGHT_DIR/before-data/vaults"
  cp -a --reflink=auto -- "$DATA_DIR/.cascade/qmd" "$PREFLIGHT_DIR/before-data/qmd"
  rm -rf "$PREFLIGHT_DIR/after-data/vaults" "$PREFLIGHT_DIR/after-data/qmd"
  cp -a --reflink=auto -- "$PREFLIGHT_DIR/before-data/vaults" "$PREFLIGHT_DIR/after-data/vaults"
  cp -a --reflink=auto -- "$PREFLIGHT_DIR/before-data/qmd" "$PREFLIGHT_DIR/after-data/qmd"
  boot_preflight_database
  docker run --rm --network none --entrypoint node \
    -e CASCADE_SQLITE_SNAPSHOT_TMPDIR=/sqlite-scratch \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    -v "$PREFLIGHT_DIR/sqlite-scratch:/sqlite-scratch" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --before /preflight/before.db --after /preflight/after.db \
    --before-root /preflight/before-data --after-root /preflight/after-data
}

preflight_candidate() {
  echo "==> Running isolated schema and protocol preflight"
  PREFLIGHT_DIR="$(mktemp -d "$DATA_DIR/.deploy-preflight.XXXXXX")"
  chown 1000:1000 "$PREFLIGHT_DIR"
  mkdir -p "$PREFLIGHT_DIR/after-data" "$PREFLIGHT_DIR/sqlite-scratch"

  dump_live_schema "$PREFLIGHT_DIR/before-schema.json"
  docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --materialize-schema /preflight/before-schema.json \
    --materialize-dest /preflight/after.db
  chown 1000:1000 "$PREFLIGHT_DIR/after.db"

  # Classify only startup DDL. The protocol probe creates disposable rows, so
  # it must not participate in the rolling-safe decision.
  boot_preflight_database
  docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --dump-schema /preflight/after.db > "$PREFLIGHT_DIR/after-schema.json"
  local schema_output=""
  local schema_status=0
  set +e
  schema_output="$(docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --schema-only --before-schema /preflight/before-schema.json --after-schema /preflight/after-schema.json 2>&1)"
  schema_status=$?
  set -e
  printf '%s\n' "$schema_output"
  if [[ "$schema_status" -eq 0 ]]; then
    ROLLING_SAFE=1
    echo "==> Candidate boot is schema-identical; rolling cutover is eligible"
  elif [[ "$schema_output" == *"database schema changed"* || "$schema_output" == *"migration ledger changed"* ]]; then
    verify_migration_clone
    ROLLING_SAFE=0
  else
    echo "Error: schema preflight failed before a rolling-safe decision could be made." >&2
    return 1
  fi

  start_preflight_server
  check_engine_io "http://127.0.0.1:$PREFLIGHT_PORT"
  docker run --rm --network host --entrypoint node \
    "$CANDIDATE_IMAGE" /app/deploy/preflight-client.mjs "http://127.0.0.1:$PREFLIGHT_PORT"
  docker rm -f "$PREFLIGHT_CONTAINER" >/dev/null
}

checkpoint_and_snapshot() {
  echo "==> Checkpointing and snapshotting the quiescent production database"
  # Match the production database owner. SQLite may need to recreate WAL/SHM
  # sidecars after the old container was force-stopped at its drain deadline.
  docker run --rm --network none --user 1000:1000 --entrypoint node \
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
  # A WAL-mode database opened from a read-only mount can fail before
  # `quick_check` because SQLite still needs transient SHM/WAL sidecars. Keep
  # SQL query-only while allowing those disposable files in the private,
  # root-owned snapshot directory.
  docker run --rm --network none --user 0:0 --entrypoint node \
    -v "$SNAPSHOT_DIR:/snapshot" "$CANDIDATE_IMAGE" --input-type=module -e '
      import Database from "better-sqlite3";
      const db = new Database("/snapshot/.docs.db.incomplete", { fileMustExist: true });
      try {
        db.pragma("query_only = ON");
        if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("snapshot quick_check failed");
        if (db.pragma("foreign_key_check").length) throw new Error("snapshot foreign_key_check failed");
      } finally { db.close(); }
    '
  rm -f -- "$snapshot_tmp-wal" "$snapshot_tmp-shm"
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
  mkdir -p "$PREFLIGHT_DIR/live-corpus"
  docker run --rm --network none --user 0:0 --entrypoint node \
    -e CASCADE_SQLITE_SNAPSHOT_TMPDIR=/sqlite-scratch \
    -v "$SNAPSHOT_DIR:/snapshot:ro" \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    -v "$PREFLIGHT_DIR/sqlite-scratch:/sqlite-scratch" \
    -v "$PREFLIGHT_DIR/live-corpus:/live-corpus" \
    -v "$DATA_DIR/.cascade/vaults:/live-corpus/vaults:ro" \
    -v "$DATA_DIR/.cascade/qmd:/live-corpus/qmd:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --before /snapshot/docs.db --after /preflight/live-after.db \
    --before-root /snapshot/corpus --after-root /live-corpus
}

verify_live_schema_identity() {
  local container="${1:?container is required}"
  docker exec "$container" node /app/scripts/check-elixir-data-compat.mjs \
    --dump-schema /data/docs.db > "$PREFLIGHT_DIR/live-schema-$container.json"
  docker run --rm --network none --entrypoint node \
    -v "$PREFLIGHT_DIR:/preflight:ro" \
    "$CANDIDATE_IMAGE" /app/scripts/check-elixir-data-compat.mjs \
    --schema-only \
    --before-schema /preflight/before-schema.json \
    --after-schema "/preflight/live-schema-$container.json"
}
