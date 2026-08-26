# Remote update preflight seam.
# Inputs are candidate/container/network globals; outputs are runtime, maintenance, and nginx assertions.
# Ordering verifies local runtime shape and edge gating before any backend stop.

close_maintenance_gate() {
  # Replace, rather than follow, any unexpected object at the marker path.
  rm -f -- "$MAINTENANCE_MARKER"
  install -m 0644 -o 0 -g 0 /dev/null "$MAINTENANCE_MARKER"
  if [[ -L "$MAINTENANCE_MARKER" || ! -f "$MAINTENANCE_MARKER" ]] ||
     [[ "$(stat -c '%u:%g:%a' "$MAINTENANCE_MARKER")" != "0:0:644" ]]; then
    echo "Error: could not establish the root-owned maintenance gate." >&2
    return 1
  fi
}

open_maintenance_gate() {
  if ! rm -f -- "$MAINTENANCE_MARKER" || [[ -e "$MAINTENANCE_MARKER" || -L "$MAINTENANCE_MARKER" ]]; then
    echo "CRITICAL: maintenance marker could not be removed; traffic remains gated." >&2
    return 1
  fi
}

wait_for_url() {
  local url="${1:?health URL is required}"
  local max_attempts="${2:-90}"
  local label="${3:-app}"

  echo "==> Waiting for $label"
  for i in $(seq 1 "$max_attempts"); do
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 2 "$url" 2>/dev/null || true)
    code="${code:-000}"
    if [[ "$code" == "200" ]]; then
      echo "    $label is up."
      return 0
    fi
    if [[ "$i" -eq "$max_attempts" ]]; then
      echo "Error: $label did not become ready (last HTTP status: ${code})." >&2
      return 1
    fi
    sleep 2
  done
}

container_exists() {
  docker inspect "$1" >/dev/null 2>&1
}

container_running() {
  [[ "$(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null)" == "true" ]]
}

check_engine_io() {
  local origin="${1:?origin is required}"
  local open_packet legacy_code

  open_packet=$(curl -fsS --connect-timeout 3 --max-time 8 \
    "$origin/socket.io/?EIO=4&transport=polling&t=$RANDOM")
  if [[ "$open_packet" != 0* ]]; then
    echo "Error: Engine.IO v4 did not return an OPEN packet." >&2
    return 1
  fi

  legacy_code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 8 \
    "$origin/socket.io/?EIO=3&transport=polling&t=$RANDOM" || true)
  if [[ "$legacy_code" != "400" ]]; then
    echo "Error: Engine.IO v3 must fail closed with HTTP 400 (got $legacy_code)." >&2
    return 1
  fi
  echo "==> Engine.IO v4 accepted and v3 rejected"
}

verify_maintenance_gate() {
  if [[ -z "$DEPLOY_DOMAIN" ]]; then
    echo "Error: deployment domain is unavailable for maintenance-gate verification." >&2
    return 1
  fi

  # A graceful nginx reload can leave the retiring worker generation alive for
  # a moment. Prove that fresh connections consistently reach the gated
  # generation before stopping the old backend.
  local code="000" consecutive=0
  for _attempt in $(seq 1 20); do
    code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/api/health" || true)
    if [[ "$code" == "503" ]]; then
      consecutive=$((consecutive + 1))
      if [[ "$consecutive" -ge 3 ]]; then
        echo "==> Nginx maintenance gate verified"
        return 0
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  echo "Error: nginx maintenance gate did not stabilize at HTTP 503 (last status: ${code:-000})." >&2
  return 1
}

configure_nginx_upstreams() {
  local primary_port="${1:?primary upstream port is required}"
  local backup_port="${2:-}"
  local domain="${CASCADE_DEPLOY_DOMAIN:-}"
  local site="/etc/nginx/sites-available/cscd"
  if [[ "$EUID" -ne 0 || ! -f "$site" ]]; then
    echo "Error: a root-managed $site is required for a verified cutover." >&2
    return 1
  fi
  if [[ ! "$primary_port" =~ ^[0-9]+$ ]] || (( primary_port < 1 || primary_port > 65535 )); then
    echo "Error: invalid primary nginx upstream port '$primary_port'." >&2
    return 1
  fi
  if [[ -n "$backup_port" ]] && {
    [[ ! "$backup_port" =~ ^[0-9]+$ ]] ||
      (( backup_port < 1 || backup_port > 65535 )) ||
      [[ "$backup_port" == "$primary_port" ]];
  }; then
    echo "Error: invalid backup nginx upstream port '$backup_port'." >&2
    return 1
  fi
  if [[ -z "$domain" && -f "$ROOT/.env" ]]; then
    local configured_url
    configured_url="$(sed -nE 's/^[[:space:]]*CASCADE_PUBLIC_URL=//p' "$ROOT/.env" | tail -1)"
    configured_url="${configured_url#\"}"
    configured_url="${configured_url%\"}"
    configured_url="${configured_url#\'}"
    configured_url="${configured_url%\'}"
    domain="${configured_url#*://}"
    domain="${domain%%/*}"
  fi
  if [[ -z "$domain" ]]; then
    domain="$(awk '$1 == "server_name" { for (i=2; i<=NF; i++) { gsub(/;/, "", $i); if ($i !~ /^www\./ && $i != "_") { print $i; exit } } }' "$site")"
  fi
  if [[ ! "$domain" =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$ ]]; then
    echo "Error: invalid CASCADE_DEPLOY_DOMAIN '$domain'" >&2
    return 1
  fi
  DEPLOY_DOMAIN="$domain"

  local rendered backup backup_server=""
  rendered="$(mktemp)"
  backup="$(mktemp)"
  cp "$site" "$backup"
  if [[ -n "$backup_port" ]]; then
    backup_server="server 127.0.0.1:$backup_port backup max_fails=1 fail_timeout=2s;"
  fi
  sed \
    -e "s/DOMAIN/$domain/g" \
    -e "s/CASCADE_PRIMARY_PORT/$primary_port/g" \
    -e "s|CASCADE_BACKUP_SERVER|$backup_server|g" \
    deploy/nginx.conf.template > "$rendered"
  if ! grep -q "www\.$domain" "$site"; then
    sed -i "s/ www\.$domain//g" "$rendered"
  fi
  local site_changed=0
  if ! cmp -s "$rendered" "$site"; then
    site_changed=1
    install -m 0644 "$rendered" "$site"
    if ! nginx -t; then
      install -m 0644 "$backup" "$site"
      nginx -t
      find "$rendered" "$backup" -maxdepth 0 -type f -delete
      echo "Error: restored previous nginx site after validation failed" >&2
      return 1
    fi
    if ! systemctl reload nginx; then
      install -m 0644 "$backup" "$site"
      nginx -t
      systemctl reload nginx
      find "$rendered" "$backup" -maxdepth 0 -type f -delete
      echo "Error: restored previous nginx site after reload failed" >&2
      return 1
    fi
  fi
  local active_config
  active_config="$(nginx -T 2>&1)"
  if [[ "$active_config" != *'if (-f /run/cascade-maintenance)'* ||
        "$active_config" != *'upstream cascade_app {'* ||
        "$active_config" != *"server 127.0.0.1:$primary_port"* ||
        ( -n "$backup_port" && "$active_config" != *"server 127.0.0.1:$backup_port backup"* ) ]]; then
    if [[ "$site_changed" == "1" ]]; then
      install -m 0644 "$backup" "$site"
      nginx -t
      systemctl reload nginx
    fi
    find "$rendered" "$backup" -maxdepth 0 -type f -delete
    echo "Error: active nginx configuration does not contain the requested cutover upstreams." >&2
    return 1
  fi
  if [[ "$site_changed" == "1" ]]; then
    NGINX_CONFIG_CHANGED=1
  fi
  find "$rendered" "$backup" -maxdepth 0 -type f -delete
  echo "==> Nginx upstream active on $primary_port${backup_port:+ with failover to $backup_port}"
}

sync_nginx_security() {
  configure_nginx_upstreams \
    "${1:?active upstream port is required}" "${2:-}"
  echo "==> Nginx security and cutover controls are active"
}

settle_reloaded_nginx() {
  if [[ "$NGINX_CONFIG_CHANGED" != "1" ]]; then
    return 0
  fi
  if [[ -z "$DEPLOY_DOMAIN" ]]; then
    echo "Error: deployment domain is unavailable for nginx generation settling." >&2
    return 1
  fi

  # The first release that installs the stable primary/backup upstream leaves
  # a graceful worker generation carrying the previous single-upstream config.
  # Keep the old backend alive beyond nginx's default 75-second HTTP keepalive
  # window so those connections drain before either backend is stopped. Future
  # releases do not rewrite this fixed upstream pair and skip this wait.
  echo "==> Nginx configuration changed; draining the previous HTTP worker generation"
  local code="000"
  for _attempt in $(seq 1 80); do
    code=$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' \
      --connect-timeout 3 --max-time 10 --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" \
      "https://$DEPLOY_DOMAIN/api/health" || true)
    if [[ "$code" != "200" ]]; then
      echo "Error: production health changed while nginx workers drained (HTTP ${code:-000})." >&2
      return 1
    fi
    sleep 1
  done
  echo "==> Previous nginx HTTP worker generation drained"
}
