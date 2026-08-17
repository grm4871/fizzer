#!/usr/bin/env bash
# Load one exact revision-labelled release image on the production host without running it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DEPLOY_HOST="${1:-${CASCADE_DEPLOY_SSH_HOST:-root@66.135.24.172}}"
SSH_ARGS=(
  -F /dev/null
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o ServerAliveInterval=20
  -o ServerAliveCountMax=90
  -o TCPKeepAlive=yes
)

REVISION="$(git rev-parse HEAD)"
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]] || \
   [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Error: release staging requires a clean checkout at one full Git revision." >&2
  exit 1
fi

IMAGE_TAG="cascade:certified-$REVISION"
IMAGE_ID="$(docker image inspect --format '{{if .Descriptor}}{{index .Descriptor.Annotations "config.digest"}}{{else}}{{.Id}}{{end}}' "$IMAGE_TAG")"
LABEL_REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_TAG")"
if [[ ! "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ || "$LABEL_REVISION" != "$REVISION" ]]; then
  echo "Error: local release image identity or revision label is invalid." >&2
  exit 1
fi

echo "==> Loading release image $IMAGE_ID on $DEPLOY_HOST"
docker image save "$IMAGE_TAG" | gzip -1 | \
  ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" 'gzip -dc | docker image load >/dev/null'

REMOTE_ID="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "docker image inspect --format '{{.Id}}' '$IMAGE_TAG'")"
REMOTE_REVISION="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' '$IMAGE_TAG'")"
if [[ "$REMOTE_ID" != "$IMAGE_ID" || "$REMOTE_REVISION" != "$REVISION" ]]; then
  echo "Error: loaded release image differs from the local artifact." >&2
  exit 1
fi

echo "==> Staged $IMAGE_TAG ($IMAGE_ID); production unchanged"
