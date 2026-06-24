#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DOMAIN="${1:-cscd.online}"
SERVER_IP="$(curl -4 -s --max-time 5 ifconfig.me || curl -4 -s --max-time 5 icanhazip.com)"
NGINX_SITE="/etc/nginx/sites-available/cscd"
NGINX_ENABLED="/etc/nginx/sites-enabled/cscd"

echo "==> Waiting for $DOMAIN to resolve to $SERVER_IP"
for i in $(seq 1 120); do
  RESOLVED="$(dig +short "$DOMAIN" A @8.8.8.8 | head -1)"
  if [[ "$RESOLVED" == "$SERVER_IP" ]]; then
    echo "    DNS is correct ($RESOLVED)"
    break
  fi
  if [[ "$i" -eq 120 ]]; then
    echo "Timed out. $DOMAIN still resolves to '${RESOLVED:-nothing}' (expected $SERVER_IP)."
    echo "Update your DNS, then re-run: $0 $DOMAIN"
    exit 1
  fi
  echo "    [$i/120] $DOMAIN -> ${RESOLVED:-unresolved} (waiting...)"
  sleep 30
done

WWW_RESOLVED="$(dig +short "www.$DOMAIN" A @8.8.8.8 | head -1)"
CERT_DOMAINS=(-d "$DOMAIN")
if [[ "$WWW_RESOLVED" == "$SERVER_IP" ]]; then
  CERT_DOMAINS+=(-d "www.$DOMAIN")
  echo "    www.$DOMAIN also points here — including in certificate"
else
  echo "    www.$DOMAIN not on this server yet — cert will cover apex only for now"
fi

echo "==> Requesting TLS certificate"
certbot certonly --nginx "${CERT_DOMAINS[@]}" --non-interactive --agree-tos --register-unsafely-without-email

echo "==> Enabling HTTPS nginx config"
sed "s/DOMAIN/$DOMAIN/g" deploy/nginx.conf.template > /tmp/cscd-nginx.conf
if [[ ${#CERT_DOMAINS[@]} -eq 1 ]]; then
  sed -i "s/ www\.$DOMAIN//g" /tmp/cscd-nginx.conf
fi
cp /tmp/cscd-nginx.conf "$NGINX_SITE"
ln -sf "$NGINX_SITE" "$NGINX_ENABLED"
nginx -t
systemctl reload nginx

echo ""
echo "HTTPS is live at https://$DOMAIN"