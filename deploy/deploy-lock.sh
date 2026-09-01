#!/usr/bin/env bash

# Host-side defense in depth behind GitHub Actions concurrency. Lock the
# checkout directory itself and keep the descriptor open in the caller for the
# duration of the deploy.
acquire_cascade_deploy_lock() {
  local root="${1:?checkout root is required}"
  local wait_seconds="${CASCADE_DEPLOY_LOCK_WAIT_SECONDS:-900}"

  if [[ "${CASCADE_DEPLOY_LOCK_HELD:-0}" == "1" ]]; then
    return 0
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "Error: flock is required to serialize production deploys." >&2
    return 1
  fi

  exec {CASCADE_DEPLOY_LOCK_FD}<"$root"
  echo "==> Waiting for production deploy lock (up to ${wait_seconds}s)"
  if ! flock -w "$wait_seconds" "$CASCADE_DEPLOY_LOCK_FD"; then
    echo "Error: timed out waiting for another production deploy to finish." >&2
    return 1
  fi

  export CASCADE_DEPLOY_LOCK_HELD=1
  echo "==> Production deploy lock acquired"
}
