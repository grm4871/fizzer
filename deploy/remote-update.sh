#!/usr/bin/env bash
# Production update with an offline Elixir/data preflight, a zero-503 rolling
# handoff for state-identical releases, and a gated snapshot rollback fallback
# for releases that intentionally migrate persistent state.
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
ROLLING_CONTAINER="cascade-rolling-$REVISION_SHORT"
CERTIFIED_RELEASE_DIR="/var/lib/cascade-release"
CERTIFIED_IMAGE_DIR="$CERTIFIED_RELEASE_DIR/certified-images"
CERTIFIED_MANIFEST="$CERTIFIED_IMAGE_DIR/$REVISION.json"
CERTIFIED_IMAGE_ID=""
CANDIDATE_IMAGE=""
ROLLBACK_IMAGE="cascade:rollback-$REVISION"
PREFLIGHT_DIR=""
PREFLIGHT_CONTAINER="cascade-preflight-$REVISION"
PREFLIGHT_PORT=""
SNAPSHOT_DIR=""
SNAPSHOT_DB=""
CUTOVER_STARTED=0
DEPLOY_COMMITTED=0
ROLLBACK_IN_PROGRESS=0
OLD_BACKEND_STOPPED=0
CANDIDATE_DATA_TOUCHED=0
DEPLOY_DOMAIN=""
ROLLING_SAFE=0
ROLLING_STARTED=0
ROLLING_OLD_STOPPED=0
ROLLING_OLD_REMOVED=0
ROLLING_FINAL_STARTED=0
ROLLING_ROLLBACK_IN_PROGRESS=0
ROLLING_PORT=39001
NGINX_CONFIG_CHANGED=0



# Source phase libraries in dependency order; they intentionally share this script's globals.
source "$ROOT/deploy/lib/remote-update-identity.sh"
source "$ROOT/deploy/lib/remote-update-preflight.sh"
source "$ROOT/deploy/lib/remote-update-snapshot.sh"
source "$ROOT/deploy/lib/remote-update-auth-smoke.sh"
source "$ROOT/deploy/lib/remote-update-cutover.sh"

on_exit() {
  local status=$?
  trap - EXIT INT TERM
  cleanup_preflight
  if [[ "$ROLLING_STARTED" == "1" && "$DEPLOY_COMMITTED" != "1" ]]; then
    rollback_rolling_cutover || true
  elif [[ "$CUTOVER_STARTED" == "1" && "$DEPLOY_COMMITTED" != "1" ]]; then
    rollback_cutover || true
  fi
  exit "$status"
}

trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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

load_release_candidate
verify_compose_runtime_shape
ensure_cutover_disk_capacity
secure_production_environment
preflight_candidate
sync_nginx_security 3000 "$ROLLING_PORT"
settle_reloaded_nginx

CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
if [[ -z "$CURRENT_IMAGE_ID" ]]; then
  echo "Error: no running production image is available for rollback." >&2
  exit 1
fi
docker tag "$CURRENT_IMAGE_ID" "$ROLLBACK_IMAGE"

if [[ "${CASCADE_TUNE_HOST_CAPACITY:-1}" == "1" ]]; then
  "$ROOT/deploy/tune-host-capacity.sh"
fi

if [[ "$ROLLING_SAFE" == "1" ]]; then
  rolling_cutover
else
  maintenance_cutover
fi

docker compose "${COMPOSE_ARGS[@]}" ps
if [[ -n "$SNAPSHOT_DIR" ]]; then
  echo "==> Deployed $REVISION_SHORT ($CERTIFIED_IMAGE_ID); rollback snapshot: $SNAPSHOT_DIR"
else
  echo "==> Deployed $REVISION_SHORT ($CERTIFIED_IMAGE_ID); rolling rollback preserved live state"
fi

echo "==> Pruning dangling images and old build cache"
docker image prune -f >/dev/null || true
docker builder prune -af --filter "until=72h" >/dev/null || true
df -h / | awk 'NR==2 {printf "    Disk: %s used, %s free (%s)\n", $3, $4, $5}'
