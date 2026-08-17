#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/deploy/deploy-lock.sh"
acquire_cascade_deploy_lock "$ROOT"

if [[ "$EUID" -ne 0 ]]; then
  echo "Error: first-time host setup must run as root." >&2
  exit 1
fi

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <your-domain.com>"
  echo ""
  echo "Example:"
  echo "  $0 fizzer.example.com"
  exit 1
fi

# Strip protocol / trailing slash if pasted from a browser bar.
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%%/*}"

if [[ ! "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
  echo "Error: '$DOMAIN' does not look like a valid domain."
  exit 1
fi

SERVER_IP="$(curl -4 -s --max-time 5 ifconfig.me || curl -4 -s --max-time 5 icanhazip.com || hostname -I | awk '{print $1}')"
NGINX_SITE="/etc/nginx/sites-available/cscd"
NGINX_ENABLED="/etc/nginx/sites-enabled/cscd"
DATA_DIR="/var/lib/cascade"

echo "==> cascade deploy"
echo "    domain:     $DOMAIN"
echo "    server ip:  $SERVER_IP"
echo ""
echo "Point your domain's DNS A record to $SERVER_IP before continuing."
echo "  $DOMAIN      A  ->  $SERVER_IP"
echo "  www.$DOMAIN  A  ->  $SERVER_IP   (optional)"
echo ""

if ! command -v docker >/dev/null 2>&1; then
  echo "Error: docker is not installed."
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "Error: docker compose plugin is not available."
  exit 1
fi

if docker inspect cascade >/dev/null 2>&1; then
  echo "Error: deploy.sh is bootstrap-only and refuses to replace an existing Cascade container." >&2
  echo "       Use deploy/remote-update.sh for a snapshot-backed production cutover." >&2
  exit 1
fi

# The application owns its data root. Release attestations deliberately live
# outside this tree so the container user cannot replace root-owned metadata by
# renaming a child of an application-owned directory.
install -d -m 0750 -o 1000 -g 1000 "$DATA_DIR"

if [[ ! -f .env ]]; then
  umask 077
  SECRET="$(openssl rand -hex 32)"
  cat > .env <<EOF
JWT_SECRET=$SECRET
CASCADE_ALLOWED_ORIGINS=https://$DOMAIN
EOF
  echo "==> Created .env with a generated JWT_SECRET"
else
  if ! grep -q '^CASCADE_ALLOWED_ORIGINS=' .env; then
    echo "CASCADE_ALLOWED_ORIGINS=https://$DOMAIN" >> .env
  else
    sed -i "s|^CASCADE_ALLOWED_ORIGINS=.*|CASCADE_ALLOWED_ORIGINS=https://$DOMAIN|" .env
  fi
  if ! grep -q '^JWT_SECRET=' .env; then
    SECRET="$(openssl rand -hex 32)"
    echo "JWT_SECRET=$SECRET" >> .env
    echo "==> Added JWT_SECRET to existing .env"
  fi
fi
chmod 0600 .env

REVISION="$(git rev-parse HEAD)"
CERTIFIED_RELEASE_DIR="/var/lib/cascade-release"
CERTIFIED_IMAGE_DIR="$CERTIFIED_RELEASE_DIR/certified-images"
for RELEASE_DIR in "$CERTIFIED_RELEASE_DIR" "$CERTIFIED_IMAGE_DIR"; do
  if [[ -L "$RELEASE_DIR" || ! -d "$RELEASE_DIR" ]] ||
     [[ "$(stat -c '%u:%g:%a' "$RELEASE_DIR")" != "0:0:700" ]]; then
    echo "Error: certification directories must be canonical root-owned directories, mode 0700." >&2
    exit 1
  fi
done
CERTIFIED_MANIFEST="$CERTIFIED_IMAGE_DIR/$REVISION.json"
if [[ ! -f "$CERTIFIED_MANIFEST" || ! -f "$CERTIFIED_MANIFEST.sha256" ]]; then
  echo "Error: stage the certified image manifest for $REVISION before first-time setup." >&2
  exit 1
fi
for CERTIFICATE_FILE in "$CERTIFIED_MANIFEST" "$CERTIFIED_MANIFEST.sha256"; do
  if [[ -L "$CERTIFICATE_FILE" || ! -f "$CERTIFICATE_FILE" ]] ||
     [[ "$(stat -c '%u:%g:%a' "$CERTIFICATE_FILE")" != "0:0:600" ]]; then
    echo "Error: certification manifest and checksum must be regular root-owned files, mode 0600." >&2
    exit 1
  fi
done
CERTIFIED_IMAGE_ID="$(node deploy/certified-image.mjs verify --manifest "$CERTIFIED_MANIFEST")"
CASCADE_IMAGE="$(node deploy/certified-image.mjs field --manifest "$CERTIFIED_MANIFEST" --name image.tag)"

echo "==> Starting the preloaded certified app image"
CASCADE_IMAGE="$CASCADE_IMAGE" docker compose up -d --no-build
RUNNING_IMAGE_ID="$(docker inspect --format '{{.Image}}' cascade)"
if [[ "$RUNNING_IMAGE_ID" != "$CERTIFIED_IMAGE_ID" ]]; then
  echo "Error: running image $RUNNING_IMAGE_ID differs from certified image $CERTIFIED_IMAGE_ID." >&2
  exit 1
fi
RUNNING_SHAPE="$(docker inspect --format '{{.HostConfig.NanoCpus}} {{.HostConfig.CpusetCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.PidsLimit}} {{(index .HostConfig.Ulimits 0).Name}} {{(index .HostConfig.Ulimits 0).Soft}} {{(index .HostConfig.Ulimits 0).Hard}}' cascade)"
EXPECTED_SHAPE="2000000000 0-1 3221225472 3221225472 100000 nofile 200000 200000"
if [[ "$RUNNING_SHAPE" != "$EXPECTED_SHAPE" ]]; then
  echo "Error: first-time container differs from the certified runtime envelope: $RUNNING_SHAPE" >&2
  exit 1
fi

echo "==> Waiting for the app health check on localhost:3000"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    echo "Error: app did not become ready. Check logs with: docker compose logs -f"
    exit 1
  fi
  sleep 2
done
echo "    App is up."

echo "==> Installing nginx site (HTTP-only, for certbot)"
sed "s/DOMAIN/$DOMAIN/g" deploy/nginx-http-only.conf.template > /tmp/cscd-nginx.conf
cp /tmp/cscd-nginx.conf "$NGINX_SITE"
ln -sf "$NGINX_SITE" "$NGINX_ENABLED"
nginx -t
systemctl reload nginx

RESOLVED="$(dig +short "$DOMAIN" A @8.8.8.8 | head -1)"
if [[ "$RESOLVED" != "$SERVER_IP" ]]; then
  echo ""
  echo "DNS for $DOMAIN points to '${RESOLVED:-nothing}' — expected $SERVER_IP."
  echo "Update your registrar DNS:"
  echo "  @   A    $SERVER_IP"
  echo "  www A    $SERVER_IP"
  echo ""
  echo "The app container is running. After DNS updates, finish HTTPS with:"
  echo "  ./deploy/finish-https.sh $DOMAIN"
  exit 1
fi

CERT_DOMAINS=(-d "$DOMAIN")
WWW_RESOLVED="$(dig +short "www.$DOMAIN" A @8.8.8.8 | head -1)"
if [[ "$WWW_RESOLVED" == "$SERVER_IP" ]]; then
  CERT_DOMAINS+=(-d "www.$DOMAIN")
fi

echo "==> Requesting TLS certificate from Let's Encrypt"
if certbot certonly --nginx "${CERT_DOMAINS[@]}" --non-interactive --agree-tos --register-unsafely-without-email; then
  :
else
  echo ""
  echo "Certbot failed. The app is running — retry with:"
  echo "  ./deploy/finish-https.sh $DOMAIN"
  exit 1
fi

echo "==> Enabling HTTPS nginx config"
sed \
  -e "s/DOMAIN/$DOMAIN/g" \
  -e 's/CASCADE_PRIMARY_PORT/3000/g' \
  -e 's|CASCADE_BACKUP_SERVER|server 127.0.0.1:39001 backup max_fails=1 fail_timeout=2s;|g' \
  deploy/nginx.conf.template > /tmp/cscd-nginx.conf
cp /tmp/cscd-nginx.conf "$NGINX_SITE"
nginx -t
systemctl reload nginx

echo ""
echo "Done! Cascade is live at:"
echo "  https://$DOMAIN"
echo ""
echo "Useful commands:"
echo "  docker compose logs -f          # app logs"
echo "  docker compose restart          # restart the currently certified image"
