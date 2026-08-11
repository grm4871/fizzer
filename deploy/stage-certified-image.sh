#!/usr/bin/env bash
# Push one locally certified Docker image to the production host without running it.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MANIFEST="${1:?usage: $0 <certification-manifest.json> [ssh-host]}"
DEPLOY_HOST="${2:-${CASCADE_DEPLOY_SSH_HOST:-root@66.135.24.172}}"
SSH_ARGS=(
  -F /dev/null
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o ServerAliveInterval=20
  -o ServerAliveCountMax=90
  -o TCPKeepAlive=yes
)
node deploy/certified-image.mjs verify --manifest "$MANIFEST" >/dev/null

REVISION="$(node deploy/certified-image.mjs field --manifest "$MANIFEST" --name revision)"
IMAGE_ID="$(node deploy/certified-image.mjs field --manifest "$MANIFEST" --name image.id)"
IMAGE_TAG="$(node deploy/certified-image.mjs field --manifest "$MANIFEST" --name image.tag)"
CHECKSUM="$(awk 'NR == 1 {print $1}' "$MANIFEST.sha256")"
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ || ! "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ || ! "$CHECKSUM" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Error: certification identity is invalid." >&2
  exit 1
fi

echo "==> Loading certified image $IMAGE_ID on $DEPLOY_HOST"
docker image save "$IMAGE_TAG" | gzip -1 | \
  ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" 'gzip -dc | docker image load >/dev/null'

REMOTE_ID="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "docker image inspect --format '{{.Id}}' '$IMAGE_TAG'")"
REMOTE_REVISION="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' '$IMAGE_TAG'")"
if [[ "$REMOTE_ID" != "$IMAGE_ID" || "$REMOTE_REVISION" != "$REVISION" ]]; then
  echo "Error: loaded image identity differs from the certified artifact." >&2
  exit 1
fi

REMOTE_TMP="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "mktemp '/tmp/cascade-certified-$REVISION.XXXXXX.json'")"
if [[ ! "$REMOTE_TMP" =~ ^/tmp/cascade-certified-${REVISION}\.[A-Za-z0-9]+\.json$ ]]; then
  echo "Error: remote host returned an invalid manifest staging path." >&2
  exit 1
fi
cleanup_remote_manifest() {
  ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "rm -f '$REMOTE_TMP'" >/dev/null 2>&1 || true
}
trap cleanup_remote_manifest EXIT
scp "${SSH_ARGS[@]}" "$MANIFEST" "$DEPLOY_HOST:$REMOTE_TMP" >/dev/null
ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "
  set -euo pipefail
  test \"\$(sha256sum '$REMOTE_TMP' | awk '{print \$1}')\" = '$CHECKSUM'
  for release_dir in /var/lib/cascade-release /var/lib/cascade-release/certified-images; do
    test ! -L \"\$release_dir\"
  done
  install -d -m 0700 -o 0 -g 0 /var/lib/cascade-release
  install -d -m 0700 -o 0 -g 0 /var/lib/cascade-release/certified-images
  for release_dir in /var/lib/cascade-release /var/lib/cascade-release/certified-images; do
    test \"\$(stat -c '%u:%g:%a:%F' \"\$release_dir\")\" = '0:0:700:directory'
  done
  install -m 0600 -o 0 -g 0 '$REMOTE_TMP' '/var/lib/cascade-release/certified-images/$REVISION.json.incoming'
  printf '%s  %s.json\\n' '$CHECKSUM' '$REVISION' > '/var/lib/cascade-release/certified-images/$REVISION.json.sha256.incoming'
  chown 0:0 '/var/lib/cascade-release/certified-images/$REVISION.json.sha256.incoming'
  chmod 0600 '/var/lib/cascade-release/certified-images/$REVISION.json.sha256.incoming'
  mv '/var/lib/cascade-release/certified-images/$REVISION.json.incoming' '/var/lib/cascade-release/certified-images/$REVISION.json'
  mv '/var/lib/cascade-release/certified-images/$REVISION.json.sha256.incoming' '/var/lib/cascade-release/certified-images/$REVISION.json.sha256'
  rm -f '$REMOTE_TMP'
"
trap - EXIT

echo "==> Staged $IMAGE_TAG ($IMAGE_ID); no production container was changed"
