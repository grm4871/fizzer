#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 <your-domain.com>"
  echo ""
  echo "Example:"
  echo "  $0 cscd.online"
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

mkdir -p "$DATA_DIR"
chown -R 1000:1000 "$DATA_DIR"

if [[ ! -f .env ]]; then
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

echo "==> Building and starting the app container"
# BuildKit enables the cache mounts in the Dockerfile (apt + npm caches persist
# across builds). Skip --pull by default so we don't re-fetch the base image
# every deploy; run with REFRESH_BASE=1 to pull the latest base image.
export DOCKER_BUILDKIT=1
export COMPOSE_DOCKER_CLI_BUILD=1
if [[ "${REFRESH_BASE:-0}" == "1" ]]; then
  docker compose build --pull
else
  docker compose build
fi
docker compose up -d

echo "==> Waiting for the app to respond on localhost:3000"
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/ >/dev/null 2>&1; then
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
sed "s/DOMAIN/$DOMAIN/g" deploy/nginx.conf.template > /tmp/cscd-nginx.conf
cp /tmp/cscd-nginx.conf "$NGINX_SITE"
nginx -t
systemctl reload nginx

echo ""
echo "Done! Cascade is live at:"
echo "  https://$DOMAIN"
echo ""
echo "Useful commands:"
echo "  docker compose logs -f          # app logs"
echo "  docker compose restart          # restart after code changes + rebuild"
echo "  $0 $DOMAIN                      # re-run full deploy"