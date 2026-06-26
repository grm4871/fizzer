#!/usr/bin/env bash
#
# deploy-watcher.sh — host-side half of the agent-driven deploy pipeline.
#
# The Cascade server runs inside the container and cannot run docker/nginx/certbot
# itself, so POST /api/deploy only drops a request file into the shared data volume
# (/var/lib/cascade/deploy.request). This script — run on the HOST, as root, by the
# cascade-deploy.path systemd unit — picks that request up, fast-forwards the repo
# to the latest remote commit, and runs deploy/deploy.sh.
#
# It can also be run by hand to process a pending request.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DOMAIN="${CASCADE_DEPLOY_DOMAIN:-cscd.online}"
DATA_DIR="${CASCADE_DATA_DIR:-/var/lib/cascade}"
REQUEST_FILE="$DATA_DIR/deploy.request"
RESULT_FILE="$DATA_DIR/deploy.result"

[[ -f "$REQUEST_FILE" ]] || { echo "No deploy request pending."; exit 0; }

# Optional "ref" from the request body (branch, tag, or sha). Empty => current branch's remote.
REF="$(node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); if (p.ref) process.stdout.write(String(p.ref));" "$REQUEST_FILE" 2>/dev/null || true)"

# Consume the request up front so a failing deploy doesn't loop forever on the path unit.
rm -f "$REQUEST_FILE"

write_result() {
  local status="$1" message="$2"
  local finished_at commit
  finished_at="$(date -u +%FT%TZ)"
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  node -e "
const fs = require('fs');
const [file, status, finishedAt, ref, commit, message] = process.argv.slice(1);
fs.writeFileSync(file, JSON.stringify({ status, finishedAt, ref, commit, message }) + '\n');
" \
    "$RESULT_FILE" "$status" "$finished_at" "${REF:-}" "$commit" "$message"
  # The container (uid 1000) reads this back via GET /api/deploy/status.
  chown 1000:1000 "$RESULT_FILE" 2>/dev/null || true
}

echo "==> Deploy requested (ref=${REF:-<current branch>}); fetching latest"
if ! git fetch --all --prune; then
  write_result error "git fetch failed"
  exit 1
fi

if [[ -n "$REF" ]]; then
  TARGET="$REF"
else
  TARGET="origin/$(git rev-parse --abbrev-ref HEAD)"
fi

echo "==> Resetting working tree to $TARGET"
if ! git reset --hard "$TARGET"; then
  write_result error "git reset to $TARGET failed"
  exit 1
fi

echo "==> Running deploy.sh $DOMAIN"
if ./deploy/deploy.sh "$DOMAIN"; then
  write_result ok "deployed"
  echo "==> Deploy complete: $(git rev-parse --short HEAD)"
else
  write_result error "deploy.sh failed"
  exit 1
fi
