#!/usr/bin/env bash
# Build the current checkout's frontend and atomically publish it at /beta/.
# This never changes the production image, checkout, or database.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEPLOY_HOST="${1:-${CASCADE_DEPLOY_SSH_HOST:-}}"
if [[ -z "$DEPLOY_HOST" ]]; then
  echo "usage: $0 <ssh-host> (or set CASCADE_DEPLOY_SSH_HOST)" >&2
  exit 2
fi

SSH_ARGS=(-F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes)
REVISION="$(git rev-parse --short=12 HEAD)"
BUILD_ID="${REVISION}-$(date -u +%Y%m%dT%H%M%SZ)"
if [[ ! "$BUILD_ID" =~ ^[0-9a-f]{12}-[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "Error: invalid beta build id." >&2
  exit 1
fi

echo "==> Building beta frontend from $REVISION"
CASCADE_CLIENT_BASE=/beta/ npm --workspace=client run build

if ! grep -qE '(src|href)="/beta/' client/dist/app.html; then
  echo "Error: beta build does not use the /beta/ asset base." >&2
  exit 1
fi

printf '{"build":"%s","revision":"%s"}\n' "$BUILD_ID" "$(git rev-parse HEAD)" > client/dist/beta-build.json

echo "==> Publishing $BUILD_ID on $DEPLOY_HOST"
tar -C client/dist -czf - . | ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "
  set -euo pipefail
  install -d -m 0755 /var/lib/cascade-beta/releases
  target='/var/lib/cascade-beta/releases/$BUILD_ID'
  test ! -e \"\$target\"
  install -d -m 0755 \"\$target\"
  tar -xzf - -C \"\$target\"
  find \"\$target\" -type d -exec chmod 0755 {} +
  find \"\$target\" -type f -exec chmod 0644 {} +
  ln -sfn \"releases/$BUILD_ID\" /var/lib/cascade-beta/current.next
  mv -Tf /var/lib/cascade-beta/current.next /var/lib/cascade-beta/current
"

echo "==> Published https://cscd.online/beta/ ($BUILD_ID)"
