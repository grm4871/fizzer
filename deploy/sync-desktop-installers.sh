#!/usr/bin/env bash
# Atomically refresh the public installer files from the verified rolling
# GitHub release. This runs after a successful production cutover, so a failed
# download never replaces a currently downloadable installer.
set -euo pipefail

DOWNLOADS_DIR="${CASCADE_DOWNLOADS_DIR:-/var/lib/cascade/downloads}"
RELEASE_URL="${FIZZER_DESKTOP_RELEASE_URL:-https://github.com/quavertron/fizzer/releases/download/desktop-beta}"
FILES=(
  Fizzer-mac-arm64.dmg
  Fizzer-mac-x64.dmg
  Fizzer-Setup.exe
  Fizzer-linux-x64.deb
  Fizzer-linux-x64.rpm
)

install -d -m 0755 "$DOWNLOADS_DIR"
staging="$(mktemp -d "$DOWNLOADS_DIR/.desktop-sync.XXXXXX")"
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT

fetch() {
  curl --fail --location --silent --show-error --retry 4 --retry-all-errors \
    --connect-timeout 10 --max-time 1800 "$RELEASE_URL/$1" -o "$staging/$1"
}

fetch SHA256SUMS
for file in "${FILES[@]}"; do
  fetch "$file"
  test -s "$staging/$file"
done
(cd "$staging" && sha256sum --check --status SHA256SUMS)

# rename(2) keeps the existing installer available until each verified
# replacement is complete; never copy a partial download into the live route.
for file in "${FILES[@]}" SHA256SUMS; do
  chmod 0644 "$staging/$file"
  mv -f "$staging/$file" "$DOWNLOADS_DIR/$file"
done

echo "==> Refreshed verified desktop installers in $DOWNLOADS_DIR"
