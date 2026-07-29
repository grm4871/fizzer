#!/usr/bin/env bash
# Remote update run on the server (e.g. from GitHub Actions over SSH).
# Builds and swaps the Cascade container without re-running first-time
# nginx/certbot setup (see deploy/deploy.sh for bootstrap).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# systemd/root deploys can hit "dubious ownership" on this checkout.
git config --global --add safe.directory "$ROOT" 2>/dev/null || true

COMPOSE_ARGS=(-f docker-compose.yml)
HEALTH_URL="http://127.0.0.1:3000/api/health"
CONTAINER_NAME="cascade"

wait_for_app() {
  local max_attempts="${1:-90}"

  echo "==> Waiting for app"
  for i in $(seq 1 "$max_attempts"); do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "$HEALTH_URL" 2>/dev/null || true)
    code="${code:-000}"
    if [[ "$code" == "200" ]]; then
      echo "    App is up."
      return 0
    fi
    if [[ "$i" -eq "$max_attempts" ]]; then
      echo "Error: app did not become ready (last HTTP status: ${code})."
      docker compose "${COMPOSE_ARGS[@]}" logs --tail 50
      return 1
    fi
    echo "    Not ready yet (HTTP ${code}), retrying..."
    sleep 2
  done
}

AVAIL_KB="$(df -k / | awk 'NR==2 {print $4}')"
if [[ "$AVAIL_KB" -lt 2097152 ]]; then
  echo "==> Low disk space — pruning unused Docker build cache"
  docker builder prune -af --filter "until=24h" >/dev/null || true
  AVAIL_KB="$(df -k / | awk 'NR==2 {print $4}')"
  if [[ "$AVAIL_KB" -lt 524288 ]]; then
    echo "Error: less than 512 MB free on disk; aborting deploy." >&2
    df -h /
    exit 1
  fi
fi

export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1

echo "==> Building new image"
if [[ "${REFRESH_BASE:-0}" == "1" ]]; then
  docker compose "${COMPOSE_ARGS[@]}" build --pull
else
  docker compose "${COMPOSE_ARGS[@]}" build
fi

echo "==> Swapping to new container"
docker compose "${COMPOSE_ARGS[@]}" up -d

wait_for_app 90
docker compose "${COMPOSE_ARGS[@]}" ps
echo "==> Deployed $(git rev-parse --short HEAD 2>/dev/null || echo unknown) (${CONTAINER_NAME})"
