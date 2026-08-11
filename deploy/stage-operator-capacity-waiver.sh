#!/usr/bin/env bash
# Stage one exact image under the operator's explicit capacity-risk waiver.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WAIVER="${1:?usage: $0 <operator-waiver.json> [ssh-host]}"
DEPLOY_HOST="${2:-${CASCADE_DEPLOY_SSH_HOST:-root@66.135.24.172}}"
SSH_ARGS=(
  -F /dev/null
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o ServerAliveInterval=20
  -o ServerAliveCountMax=90
  -o TCPKeepAlive=yes
)

REVISION="$(node deploy/operator-capacity-waiver.mjs field --waiver "$WAIVER" --name revision)"
IMAGE_ID="$(node deploy/operator-capacity-waiver.mjs verify --waiver "$WAIVER" --expected-revision "$REVISION")"
IMAGE_TAG="cascade:certified-$REVISION"
CHECKSUM="$(awk 'NR == 1 {print $1}' "$WAIVER.sha256")"
LOCAL_IMAGE_ID="$(docker image inspect --format '{{if .Descriptor}}{{index .Descriptor.Annotations "config.digest"}}{{else}}{{.Id}}{{end}}' "$IMAGE_TAG")"
LOCAL_REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_TAG")"
if [[ "$LOCAL_IMAGE_ID" != "$IMAGE_ID" || "$LOCAL_REVISION" != "$REVISION" ]]; then
  echo "Error: local image does not match the operator capacity waiver." >&2
  exit 1
fi

echo "==> Loading operator-approved image $IMAGE_ID on $DEPLOY_HOST"
docker image save "$IMAGE_TAG" | gzip -1 | \
  ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" 'gzip -dc | docker image load >/dev/null'

REMOTE_ID="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "docker image inspect --format '{{.Id}}' '$IMAGE_TAG'")"
REMOTE_REVISION="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "docker image inspect --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}' '$IMAGE_TAG'")"
if [[ "$REMOTE_ID" != "$IMAGE_ID" || "$REMOTE_REVISION" != "$REVISION" ]]; then
  echo "Error: loaded image identity differs from the operator capacity waiver." >&2
  exit 1
fi

REMOTE_TMP="$(ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "mktemp '/tmp/cascade-waiver-$REVISION.XXXXXX.json'")"
if [[ ! "$REMOTE_TMP" =~ ^/tmp/cascade-waiver-${REVISION}\.[A-Za-z0-9]+\.json$ ]]; then
  echo "Error: remote host returned an invalid waiver staging path." >&2
  exit 1
fi
cleanup_remote_waiver() {
  ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "rm -f '$REMOTE_TMP'" >/dev/null 2>&1 || true
}
trap cleanup_remote_waiver EXIT
scp "${SSH_ARGS[@]}" "$WAIVER" "$DEPLOY_HOST:$REMOTE_TMP" >/dev/null
ssh "${SSH_ARGS[@]}" "$DEPLOY_HOST" "
  set -euo pipefail
  test \"\$(sha256sum '$REMOTE_TMP' | awk '{print \$1}')\" = '$CHECKSUM'
  for release_dir in /var/lib/cascade-release /var/lib/cascade-release/operator-waivers; do
    test ! -L \"\$release_dir\"
  done
  install -d -m 0700 -o 0 -g 0 /var/lib/cascade-release
  install -d -m 0700 -o 0 -g 0 /var/lib/cascade-release/operator-waivers
  install -d -m 0700 -o 0 -g 0 /var/lib/cascade-release/certified-images
  install -m 0600 -o 0 -g 0 '$REMOTE_TMP' '/var/lib/cascade-release/operator-waivers/$REVISION.json.incoming'
  printf '%s  %s.json\n' '$CHECKSUM' '$REVISION' > '/var/lib/cascade-release/operator-waivers/$REVISION.json.sha256.incoming'
  chown 0:0 '/var/lib/cascade-release/operator-waivers/$REVISION.json.sha256.incoming'
  chmod 0600 '/var/lib/cascade-release/operator-waivers/$REVISION.json.sha256.incoming'
  mv '/var/lib/cascade-release/operator-waivers/$REVISION.json.incoming' '/var/lib/cascade-release/operator-waivers/$REVISION.json'
  mv '/var/lib/cascade-release/operator-waivers/$REVISION.json.sha256.incoming' '/var/lib/cascade-release/operator-waivers/$REVISION.json.sha256'
  rm -f '$REMOTE_TMP'
"
trap - EXIT

echo "==> Staged $IMAGE_TAG ($IMAGE_ID) under the explicit operator capacity waiver; production unchanged"
