# Remote update cutover seam.
# Inputs are preflight state, candidate identity, and production globals; outputs are committed or safely rolled-back deployment.
# Ordering keeps a healthy bridge/snapshot until identity, health, and authenticated smoke checks pass.

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

start_rolling_container() {
  if container_exists "$ROLLING_CONTAINER"; then
    if container_running "$ROLLING_CONTAINER"; then
      echo "Error: rolling candidate $ROLLING_CONTAINER is already running." >&2
      return 1
    fi
    docker rm "$ROLLING_CONTAINER" >/dev/null
  fi

  echo "==> Starting a warmed rolling candidate"
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" run \
    -d -T --no-deps --name "$ROLLING_CONTAINER" \
    -p "127.0.0.1:$ROLLING_PORT:3000" cascade >/dev/null
  docker update --restart=no "$ROLLING_CONTAINER" >/dev/null
  if [[ "$(docker port "$ROLLING_CONTAINER" 3000/tcp)" != "127.0.0.1:$ROLLING_PORT" ]]; then
    echo "Error: rolling candidate is not bound to the reserved loopback port $ROLLING_PORT." >&2
    return 1
  fi

  verify_container_runtime_shape "$ROLLING_CONTAINER" "warmed rolling candidate"
  wait_for_url "http://127.0.0.1:$ROLLING_PORT/api/health" 60 "warmed rolling candidate"
  check_engine_io "http://127.0.0.1:$ROLLING_PORT"
  verify_live_schema_identity "$ROLLING_CONTAINER"
  verify_authenticated_live_candidate "$ROLLING_CONTAINER" "http://127.0.0.1:$ROLLING_PORT"
}

rollback_rolling_cutover() {
  if [[ "$ROLLING_ROLLBACK_IN_PROGRESS" == "1" ]]; then
    return 1
  fi
  ROLLING_ROLLBACK_IN_PROGRESS=1
  set +e
  echo "==> Rolling candidate failed; restoring the previous image without rewinding live data" >&2

  # The process may have been interrupted after Docker stopped the canonical
  # container but before the next shell assignment. Trust observed container
  # state over the progress flag so that interruption cannot remove the only
  # healthy bridge and strand a stopped primary.
  if [[ "$ROLLING_OLD_STOPPED" != "1" ]] && container_running "$CONTAINER_NAME"; then
    if container_exists "$ROLLING_CONTAINER"; then
      docker rm -f "$ROLLING_CONTAINER" >/dev/null 2>&1
    fi
    set -e
    return 0
  fi
  ROLLING_OLD_STOPPED=1

  # Keep the warmed candidate serving while the canonical port is restored.
  local bridge_ready=0
  if container_exists "$ROLLING_CONTAINER" && ! container_running "$ROLLING_CONTAINER"; then
    docker start "$ROLLING_CONTAINER" >/dev/null
  fi
  if container_running "$ROLLING_CONTAINER"; then
    if wait_for_url "http://127.0.0.1:$ROLLING_PORT/api/health" 60 "rolling rollback bridge"; then
      bridge_ready=1
    fi
  fi

  local canonical_image=""
  canonical_image="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME" 2>/dev/null)"
  if [[ -n "$canonical_image" && "$canonical_image" != "$CURRENT_IMAGE_ID" ]]; then
    if container_running "$CONTAINER_NAME" && [[ "$bridge_ready" != "1" ]]; then
      verify_reopened_production_edge
      echo "CRITICAL: rollback bridge is unavailable; leaving the healthy candidate in service" >&2
      set -e
      return 1
    fi
    docker stop -t 30 "$CONTAINER_NAME" >/dev/null 2>&1
    docker rm "$CONTAINER_NAME" >/dev/null 2>&1
    canonical_image=""
  fi

  if [[ -z "$canonical_image" ]]; then
    CASCADE_IMAGE="$ROLLBACK_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
      up -d --no-build --force-recreate
  elif ! container_running "$CONTAINER_NAME"; then
    docker start "$CONTAINER_NAME" >/dev/null
  fi

  if wait_for_url "$HEALTH_URL" 60 "rolling rollback"; then
    sleep 3
    if [[ "$bridge_ready" == "1" ]] && container_running "$ROLLING_CONTAINER"; then
      docker stop -t 30 "$ROLLING_CONTAINER" >/dev/null 2>&1
    fi
    if verify_reopened_production_edge; then
      docker tag "$CURRENT_IMAGE_ID" cascade:latest
      docker rm "$ROLLING_CONTAINER" >/dev/null 2>&1
      echo "==> Previous image restored with all rolling-window writes preserved" >&2
    fi
  else
    echo "CRITICAL: previous image did not recover; leaving any healthy rolling bridge in service" >&2
  fi
  set -e
}

rolling_cutover() {
  echo "==> Starting zero-503 rolling cutover"
  ROLLING_STARTED=1
  start_rolling_container

  # Every nginx worker generation uses the stable 3000/39001 primary/backup
  # pair. The candidate receives traffic only after port 3000 stops accepting
  # a connection, never concurrently by load-balancing policy.
  verify_reopened_production_edge

  echo "==> Draining the previous backend into the warmed candidate"
  docker stop -t 120 "$CONTAINER_NAME" >/dev/null
  ROLLING_OLD_STOPPED=1
  verify_reopened_production_edge

  docker rm "$CONTAINER_NAME" >/dev/null
  ROLLING_OLD_REMOVED=1

  # Restore the canonical Compose service and port while the warmed candidate
  # continues to serve. This keeps established operational checks unchanged.
  echo "==> Starting the canonical candidate behind the rolling bridge"
  CASCADE_IMAGE="$CANDIDATE_IMAGE" docker compose "${COMPOSE_ARGS[@]}" \
    up -d --no-build --force-recreate
  ROLLING_FINAL_STARTED=1
  verify_container_runtime_shape "$CONTAINER_NAME" "canonical rolling candidate"
  wait_for_url "$HEALTH_URL" 90 "canonical rolling candidate"
  check_engine_io "http://127.0.0.1:3000"
  verify_authenticated_live_candidate "$CONTAINER_NAME" "http://127.0.0.1:3000"

  local running_image_id
  running_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
  if [[ "$running_image_id" != "$CERTIFIED_IMAGE_ID" ]]; then
    echo "Error: canonical candidate is $running_image_id, expected certified image $CERTIFIED_IMAGE_ID." >&2
    return 1
  fi

  # Let every worker's primary failure timer expire before removing the
  # bridge. A failed bridge connection can still retry the now-healthy primary.
  sleep 3
  verify_reopened_production_edge
  echo "==> Draining the rolling bridge into the canonical candidate"
  docker stop -t 120 "$ROLLING_CONTAINER" >/dev/null
  verify_reopened_production_edge

  docker tag "$CERTIFIED_IMAGE_ID" cascade:latest
  DEPLOY_COMMITTED=1
  docker rm "$ROLLING_CONTAINER" >/dev/null 2>&1 || true
  echo "==> Zero-503 rolling cutover committed"
}

maintenance_cutover() {
  echo "==> Persistent-state migration requires the snapshot-backed maintenance cutover"
  CUTOVER_STARTED=1
  close_maintenance_gate
  verify_maintenance_gate

  # Stopping first closes pre-existing WebSockets; the nginx marker prevents
  # reconnects and mutations until the migration candidate is verified.
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
  verify_authenticated_live_candidate "$CONTAINER_NAME" "http://127.0.0.1:3000"
  local running_image_id
  running_image_id="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
  if [[ "$running_image_id" != "$CERTIFIED_IMAGE_ID" ]]; then
    echo "Error: running candidate is $running_image_id, expected certified image $CERTIFIED_IMAGE_ID." >&2
    return 1
  fi

  docker tag "$CERTIFIED_IMAGE_ID" cascade:latest
  # Once the gate opens, external mutations can reach the candidate and an
  # automatic database rollback would lose them. Commit first, then open it.
  DEPLOY_COMMITTED=1
  open_maintenance_gate
  verify_reopened_production_edge
}
