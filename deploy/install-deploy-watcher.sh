#!/usr/bin/env bash
#
# install-deploy-watcher.sh — install the systemd units that run deploy-watcher.sh
# whenever the server drops /var/lib/cascade/deploy.request.
#
# Run once on the HOST as root:  sudo ./deploy/install-deploy-watcher.sh fizzer.example.com
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${1:-fizzer.example.com}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Error: run as root (sudo)."
  exit 1
fi

cat > /etc/systemd/system/cascade-deploy.service <<EOF
[Unit]
Description=Run Cascade deploy when a request is queued
After=network-online.target docker.service

[Service]
Type=oneshot
Environment=CASCADE_DEPLOY_DOMAIN=$DOMAIN
WorkingDirectory=$ROOT
ExecStart=$ROOT/deploy/deploy-watcher.sh
EOF

cat > /etc/systemd/system/cascade-deploy.path <<EOF
[Unit]
Description=Watch for Cascade deploy requests

[Path]
PathExists=/var/lib/cascade/deploy.request
Unit=cascade-deploy.service

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now cascade-deploy.path

echo "Installed. Whenever /var/lib/cascade/deploy.request appears, systemd will run:"
echo "  git fetch/reset + $ROOT/deploy/remote-update.sh"
echo "  (CASCADE_DEPLOY_DOMAIN=$DOMAIN is kept for legacy env; bootstrap is deploy/deploy.sh)"
echo ""
echo "Deploy token (configure the client with this, sent as 'Authorization: Bearer <token>'):"
echo "  cat /var/lib/cascade/.cascade/deploy-secret"
