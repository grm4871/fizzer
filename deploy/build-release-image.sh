#!/usr/bin/env bash
# Build the immutable image that staging will certify and production will load.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REVISION="$(git rev-parse HEAD)"
if [[ ! "$REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Error: release revision is not a full Git SHA." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  echo "Error: release images must be built from a clean checkout." >&2
  git status --short >&2
  exit 1
fi

IMAGE="cascade:certified-$REVISION"
TARGET_PLATFORM="${CASCADE_TARGET_PLATFORM:-linux/amd64}"
echo "==> Building immutable release candidate $IMAGE"
# The local BuildKit cache is persistent on one builder only. When a shared
# registry ref is supplied, import and export the complete multi-stage cache so
# other Linux builders can reuse dependency and compilation work too. Keep
# refs must match TARGET_PLATFORM; native NIFs and the bundled OTP runtime are
# not interchangeable between ARM64 and AMD64.
BUILD_ARGS=(
  --platform "$TARGET_PLATFORM"
  --provenance=false
  --build-arg "CASCADE_REVISION=$REVISION"
)
if [[ -n "${CASCADE_BUILD_CACHE_REF:-}" ]]; then
  BUILD_ARGS+=(
    --cache-from "type=registry,ref=${CASCADE_BUILD_CACHE_REF}"
    --cache-to "type=registry,ref=${CASCADE_BUILD_CACHE_REF},mode=max,compression=zstd"
  )
  echo "==> Using shared BuildKit cache ${CASCADE_BUILD_CACHE_REF}"
else
  echo "==> Using the local BuildKit cache (set CASCADE_BUILD_CACHE_REF to share it)"
fi
echo "==> Target platform: $TARGET_PLATFORM"
# Build from the committed Git object, not the mutable working directory. The
# clean-tree check above is an operator guard; this archive is the actual TOCTOU
# boundary that prevents a concurrent edit from entering a revision-labelled
# image after that check has passed.
git archive --format=tar "$REVISION" | DOCKER_BUILDKIT=1 docker build --pull \
  "${BUILD_ARGS[@]}" \
  --tag "$IMAGE" -

IMAGE_ID="$(docker image inspect --format '{{if .Descriptor}}{{index .Descriptor.Annotations "config.digest"}}{{else}}{{.Id}}{{end}}' "$IMAGE")"
LABEL_REVISION="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE")"
if [[ ! "$IMAGE_ID" =~ ^sha256:[0-9a-f]{64}$ || "$LABEL_REVISION" != "$REVISION" ]]; then
  echo "Error: built image identity or revision label is invalid." >&2
  exit 1
fi

printf '%s\n' "$IMAGE_ID"
echo "==> Built $IMAGE at $IMAGE_ID"
