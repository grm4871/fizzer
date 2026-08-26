# Capacity runtime seam: owned container lifecycle, identity checks, and database freeze boundaries.
# Evidence invariant: cleanup only removes containers whose ID, owner, phase, and name still match.
inspect_owned_container() {
  local id="$1"
  docker container inspect --format \
    '{{.Id}}|{{index .Config.Labels "io.cascade.capacity-run-owner"}}|{{index .Config.Labels "io.cascade.capacity-run-phase"}}|{{.Name}}|{{.State.Running}}|{{.State.StartedAt}}|{{.RestartCount}}|{{.State.OOMKilled}}' \
    "$id" 2>/dev/null
}

owned_identity_matches() {
  local phase="$1"
  local observed="$2"
  local observed_id observed_owner observed_phase observed_name
  local _running _started_at _restart_count _oom_killed
  IFS='|' read -r observed_id observed_owner observed_phase observed_name \
    _running _started_at _restart_count _oom_killed <<<"$observed"
  [[ "$observed_id" == "${phase_ids[$phase]:-}" \
      && "$observed_owner" == "${phase_owners[$phase]:-}" \
      && "$observed_phase" == "$phase" \
      && "$observed_name" == "/${phase_names[$phase]}" ]]
}

cleanup_owned_containers() {
  local prior_status=$?
  local cleanup_status=0
  local phase id observed cid_file
  trap - EXIT INT TERM

  for ((index = ${#owned_phases[@]} - 1; index >= 0; index -= 1)); do
    phase="${owned_phases[$index]}"
    cid_file="${phase_cid_files[$phase]}"
    id="${phase_ids[$phase]:-}"
    if [[ -z "$id" && -f "$cid_file" ]]; then
      IFS= read -r id <"$cid_file" || true
      phase_ids[$phase]="$id"
    fi
    [[ -n "$id" ]] || continue
    if [[ ! "$id" =~ ^[a-f0-9]{64}$ ]]; then
      echo "Error: refusing $phase cleanup because its recorded container ID is invalid." >&2
      cleanup_status=1
    elif observed="$(inspect_owned_container "$id")"; then
      if ! owned_identity_matches "$phase" "$observed"; then
        echo "Error: refusing $phase cleanup because container ownership no longer matches." >&2
        cleanup_status=1
      elif ! docker container rm -f "$id" >/dev/null; then
        echo "Error: failed to remove owned $phase capacity container $id." >&2
        cleanup_status=1
      fi
    else
      echo "Error: could not inspect owned $phase capacity container $id during cleanup." >&2
      cleanup_status=1
    fi
  done

  rm -f -- "$ownership_dir"/*.id
  rmdir -- "$ownership_dir" 2>/dev/null || true
  if (( prior_status != 0 )); then
    exit "$prior_status"
  fi
  exit "$cleanup_status"
}
trap cleanup_owned_containers EXIT INT TERM

export_phase_environment() {
  local phase="$1"
  local lifecycle="$2"
  export CASCADE_CAPACITY_CONTAINER_ID="${phase_ids[$phase]}"
  export CASCADE_CAPACITY_CONTAINER_NAME="${phase_names[$phase]}"
  export CASCADE_CAPACITY_DATA_DIR="${phase_roots[$phase]}"
  export CASCADE_CAPACITY_TARGET="http://127.0.0.1:${host_port}"
  export CASCADE_CAPACITY_PHASE="$lifecycle"
  export CASCADE_CAPACITY_PHASE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  export CASCADE_CAPACITY_CONTAINER_CREATED_AT="${phase_created_at[$phase]:-}"
  export CASCADE_CAPACITY_CONTAINER_STARTED_AT="${phase_started_at[$phase]:-}"
  export CASCADE_CAPACITY_CONTAINER_STOPPED_AT="${phase_stopped_at[$phase]:-}"
  export CASCADE_CAPACITY_10K_DATA_DIR="$data_dir"
  export CASCADE_CAPACITY_FAULT_DATA_DIR="$fault_data_dir"
  export CASCADE_CAPACITY_SOAK_DATA_DIR="$soak_data_dir"
  export CASCADE_CAPACITY_DATABASE_SHA256="${phase_database_sha256[$phase]:-}"
  export CASCADE_CAPACITY_DATABASE_DEVICE_INODE="${phase_database_device_inode[$phase]:-}"
  export CASCADE_CAPACITY_DATABASE_FROZEN_AT="${phase_database_frozen_at[$phase]:-}"
  case "$phase" in
    main10k) export CASCADE_CAPACITY_10K_CONTAINER_ID="${phase_ids[$phase]}" ;;
    faults) export CASCADE_CAPACITY_FAULT_CONTAINER_ID="${phase_ids[$phase]}" ;;
    soak5k) export CASCADE_CAPACITY_SOAK_CONTAINER_ID="${phase_ids[$phase]}" ;;
    diagnostic) export CASCADE_CAPACITY_DIAGNOSTIC_CONTAINER_ID="${phase_ids[$phase]}" ;;
  esac
}

invoke_controller() {
  local phase="$1"
  local lifecycle="$2"
  shift 2
  export_phase_environment "$phase" "$lifecycle"
  "$@"
}

create_candidate() {
  local phase="$1"
  local name="${phase_names[$phase]}"
  local root="${phase_roots[$phase]}"
  local phase_owner="${run_owner}-${phase}"
  local cid_file="$ownership_dir/${phase}.id"
  local id observed running started_at restart_count oom_killed
  phase_owners[$phase]="$phase_owner"
  phase_cid_files[$phase]="$cid_file"
  owned_phases+=("$phase")

  docker create \
    --cidfile "$cid_file" \
    --name "$name" \
    --label "io.cascade.capacity-run-owner=$phase_owner" \
    --label "io.cascade.capacity-run-phase=$phase" \
    --init \
    --cpuset-cpus=0-1 --cpus=2 \
    --memory=3g --memory-swap=3g \
    --pids-limit=100000 --ulimit nofile=200000:200000 \
    -p "127.0.0.1:${host_port}:3000" \
    -e 'ERL_AFLAGS=+S 2:2 +sbwt none +sbwtdcpu none +sbwtdio none' \
    -e RELEASE_DISTRIBUTION=name \
    -e RELEASE_NODE=cascade_capacity@127.0.0.1 \
    -e "RELEASE_COOKIE=$CAPACITY_RELEASE_COOKIE" \
    -e "JWT_SECRET=$CAPACITY_JWT_SECRET" \
    -e CASCADE_NETWORK_MODE=true \
    -e CASCADE_BIND_IP=0.0.0.0 \
    -e API_PORT=3000 \
    -e DOCS_DB_PATH=/data/docs.db \
    -e CASCADE_DATA_DIR=/data \
    -e CASCADE_VAULTS_BASE_DIR=/data/.cascade/vaults \
    -e CASCADE_QMD_DIR=/data/.cascade/qmd \
    -e CASCADE_QMD_WORKER_ENABLED=true \
    -e CASCADE_HTTP_MAX_CONNECTIONS=32768 \
    -e CASCADE_HTTP_ACCEPTORS=4 \
    -e CASCADE_HTTP_BACKLOG=65535 \
    -e CASCADE_REALTIME_HIBERNATE_AFTER_MS=5000 \
    -e CASCADE_RUNNER_ORPHAN_RECLAIM_MS=600000 \
    -e CASCADE_TRUST_PROXY_HOPS=1 \
    -e CASCADE_SQLITE_POOL_SIZE=20 \
    -e CASCADE_SQLITE_BUSY_TIMEOUT_MS=5000 \
    -v "$root:/data" \
    "$image" >/dev/null

  if [[ -f "$cid_file" ]]; then
    # Docker writes --cidfile as 64 hex bytes without a trailing newline.
    # `read` still populates the value but returns nonzero at EOF, which would
    # otherwise trip `set -e` before ownership validation can run.
    IFS= read -r id <"$cid_file" || true
  fi
  [[ "$id" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Error: Docker did not record an exact $phase container ID." >&2
    exit 70
  }
  phase_ids[$phase]="$id"
  observed="$(inspect_owned_container "$id" || true)"
  owned_identity_matches "$phase" "$observed" || {
    echo "Error: created $phase container does not match its ownership record." >&2
    exit 70
  }
  IFS='|' read -r _id _owner _phase _name running started_at restart_count oom_killed <<<"$observed"
  [[ "$running" == 'false' && "$started_at" == '0001-01-01T00:00:00Z' \
      && "$restart_count" == '0' && "$oom_killed" == 'false' ]] || {
    echo "Error: $phase preflight requires a never-started healthy owned container." >&2
    exit 70
  }
  phase_created_at[$phase]="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

verify_never_started() {
  local phase="$1"
  local observed running started_at restart_count oom_killed
  observed="$(inspect_owned_container "${phase_ids[$phase]}" || true)"
  owned_identity_matches "$phase" "$observed" || return 1
  IFS='|' read -r _id _owner _phase _name running started_at restart_count oom_killed <<<"$observed"
  [[ "$running" == 'false' && "$started_at" == '0001-01-01T00:00:00Z' \
      && "$restart_count" == '0' && "$oom_killed" == 'false' ]]
}

start_candidate() {
  local phase="$1"
  local id="${phase_ids[$phase]}"
  local observed running started_at
  verify_never_started "$phase" || {
    echo "Error: $phase preflight started, replaced, or damaged its container." >&2
    exit 70
  }
  docker container start "$id" >/dev/null
  observed="$(inspect_owned_container "$id" || true)"
  owned_identity_matches "$phase" "$observed" || {
    echo "Error: $phase ownership changed while starting." >&2
    exit 70
  }
  IFS='|' read -r _id _owner _phase _name running started_at _restart _oom <<<"$observed"
  [[ "$running" == 'true' && "$started_at" != '0001-01-01T00:00:00Z' && -n "$started_at" ]] || {
    echo "Error: exact owned $phase container did not start." >&2
    exit 70
  }
  phase_started_at[$phase]="$started_at"
}

stop_candidate() {
  local phase="$1"
  local id="${phase_ids[$phase]}"
  local observed running started_at
  observed="$(inspect_owned_container "$id" || true)"
  owned_identity_matches "$phase" "$observed" || {
    echo "Error: $phase ownership changed before stop." >&2
    exit 70
  }
  IFS='|' read -r _id _owner _phase _name running started_at _restart _oom <<<"$observed"
  [[ "$running" == 'true' ]] || {
    echo "Error: $phase candidate stopped before its evidence phase completed." >&2
    exit 70
  }
  docker container stop --time 30 "$id" >/dev/null
  observed="$(inspect_owned_container "$id" || true)"
  owned_identity_matches "$phase" "$observed" || {
    echo "Error: $phase ownership changed while stopping." >&2
    exit 70
  }
  IFS='|' read -r _id _owner _phase _name running started_at _restart _oom <<<"$observed"
  [[ "$running" == 'false' && "$started_at" != '0001-01-01T00:00:00Z' ]] || {
    echo "Error: exact owned $phase container did not stop." >&2
    exit 70
  }
  phase_stopped_at[$phase]="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

freeze_phase_database() {
  local phase="$1"
  local database="${phase_roots[$phase]}/docs.db"
  local checkpoint checkpoint_busy checkpoint_frames checkpointed_frames
  local quick_check foreign_keys
  quick_check="$(sqlite3 -readonly "$database" 'PRAGMA quick_check;')"
  foreign_keys="$(sqlite3 -readonly "$database" 'PRAGMA foreign_key_check;')"
  checkpoint="$(sqlite3 "$database" 'PRAGMA wal_checkpoint(TRUNCATE);')"
  IFS='|' read -r checkpoint_busy checkpoint_frames checkpointed_frames <<<"$checkpoint"
  [[ "$checkpoint_busy" == '0' && "$checkpoint_frames" == "$checkpointed_frames" \
      && "$quick_check" == 'ok' && -z "$foreign_keys" \
      && ! -s "$database-wal" ]] || {
    echo "Error: $phase database did not checkpoint and validate cleanly." >&2
    exit 70
  }
  rm -f -- "$database-wal" "$database-shm"
  [[ ! -e "$database-wal" && ! -e "$database-shm" ]] || {
    echo "Error: $phase database sidecars did not close cleanly." >&2
    exit 70
  }
  phase_database_sha256[$phase]="$(sha256sum -- "$database" | awk '{print $1}')"
  phase_database_device_inode[$phase]="$(stat -Lc '%d:%i' -- "$database")"
  phase_database_frozen_at[$phase]="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

assert_phase_database_frozen() {
  local phase="$1"
  local database="${phase_roots[$phase]}/docs.db"
  [[ "$(sha256sum -- "$database" | awk '{print $1}')" == "${phase_database_sha256[$phase]}" \
      && "$(stat -Lc '%d:%i' -- "$database")" == "${phase_database_device_inode[$phase]}" \
      && ! -e "$database-wal" && ! -e "$database-shm" ]] || {
    echo "Error: $phase database changed after its freeze boundary." >&2
    exit 70
  }
}

