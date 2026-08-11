#!/usr/bin/env bash
# Raise host accept/open-file ceilings for the measured 10,000-connection
# profile. The operation is idempotent and restores every host file/value if
# validation or the gated nginx restart fails.
set -euo pipefail

if [[ "$EUID" -ne 0 ]]; then
  echo "Error: host capacity tuning requires root." >&2
  exit 1
fi

NGINX_CONF="/etc/nginx/nginx.conf"
NGINX_OVERRIDE_DIR="/etc/systemd/system/nginx.service.d"
NGINX_OVERRIDE="$NGINX_OVERRIDE_DIR/cascade-capacity.conf"
SYSCTL_CONF="/etc/sysctl.d/99-cascade-capacity.conf"

if [[ ! -f "$NGINX_CONF" ]] || ! command -v nginx >/dev/null 2>&1; then
  echo "Error: nginx is required for production capacity tuning." >&2
  exit 1
fi

nginx_backup="$(mktemp)"
override_backup="$(mktemp)"
sysctl_backup="$(mktemp)"
desired_nginx="$(mktemp)"
desired_override="$(mktemp)"
desired_sysctl="$(mktemp)"
had_override=0
had_sysctl=0
changes_started=0
capacity_committed=0
old_somaxconn="$(sysctl -n net.core.somaxconn)"

cp "$NGINX_CONF" "$nginx_backup"
if [[ -f "$NGINX_OVERRIDE" ]]; then
  cp "$NGINX_OVERRIDE" "$override_backup"
  had_override=1
fi
if [[ -f "$SYSCTL_CONF" ]]; then
  cp "$SYSCTL_CONF" "$sysctl_backup"
  had_sysctl=1
fi

cleanup_capacity_files() {
  find "$nginx_backup" "$override_backup" "$sysctl_backup" \
    "$desired_nginx" "$desired_override" "$desired_sysctl" \
    -maxdepth 0 -type f -delete 2>/dev/null || true
}

restore_capacity_state() {
  set +e
  echo "==> Restoring prior host capacity configuration" >&2
  install -m 0644 "$nginx_backup" "$NGINX_CONF"
  if [[ "$had_override" == "1" ]]; then
    mkdir -p "$NGINX_OVERRIDE_DIR"
    install -m 0644 "$override_backup" "$NGINX_OVERRIDE"
  else
    find "$NGINX_OVERRIDE" -maxdepth 0 -type f -delete 2>/dev/null || true
  fi
  if [[ "$had_sysctl" == "1" ]]; then
    install -m 0644 "$sysctl_backup" "$SYSCTL_CONF"
  else
    find "$SYSCTL_CONF" -maxdepth 0 -type f -delete 2>/dev/null || true
  fi
  sysctl -w "net.core.somaxconn=$old_somaxconn" >/dev/null
  systemctl daemon-reload
  nginx -t && systemctl restart nginx
  set -e
}

capacity_exit() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$status" != "0" && "$changes_started" == "1" && "$capacity_committed" != "1" ]]; then
    restore_capacity_state
  fi
  cleanup_capacity_files
  exit "$status"
}

trap capacity_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cp "$NGINX_CONF" "$desired_nginx"
worker_connections="$(awk '$1 == "worker_connections" {gsub(/;/, "", $2); print $2; exit}' "$desired_nginx")"
if [[ ! "$worker_connections" =~ ^[0-9]+$ ]]; then
  echo "Error: could not resolve nginx worker_connections." >&2
  exit 1
fi
if (( worker_connections < 65536 )); then
  sed -Ei '0,/^[[:space:]]*worker_connections[[:space:]]+[^;]+;/s//    worker_connections 65536;/' "$desired_nginx"
fi

worker_rlimit="$(awk '$1 == "worker_rlimit_nofile" {gsub(/;/, "", $2); print $2; exit}' "$desired_nginx")"
if [[ -z "$worker_rlimit" ]]; then
  sed -i '1i worker_rlimit_nofile 200000;' "$desired_nginx"
elif [[ "$worker_rlimit" =~ ^[0-9]+$ ]] && (( worker_rlimit < 200000 )); then
  sed -Ei '0,/^[[:space:]]*worker_rlimit_nofile[[:space:]]+[^;]+;/s//worker_rlimit_nofile 200000;/' "$desired_nginx"
elif [[ ! "$worker_rlimit" =~ ^[0-9]+$ ]]; then
  echo "Error: could not parse nginx worker_rlimit_nofile." >&2
  exit 1
fi

runtime_limit="$(systemctl show nginx --property=LimitNOFILE --value)"
configured_limit=200000
if [[ -f "$NGINX_OVERRIDE" ]]; then
  existing_limit="$(sed -nE 's/^[[:space:]]*LimitNOFILE=([^[:space:]#]+).*$/\1/p' "$NGINX_OVERRIDE" | tail -1)"
  if [[ "$existing_limit" == "infinity" || "$existing_limit" == "unlimited" ]]; then
    configured_limit="infinity"
  elif [[ "$existing_limit" =~ ^[0-9]+$ ]] && (( existing_limit > configured_limit )); then
    configured_limit="$existing_limit"
  fi
fi
if [[ "$runtime_limit" == "infinity" || "$runtime_limit" == "unlimited" ]]; then
  configured_limit="infinity"
elif [[ "$runtime_limit" =~ ^[0-9]+$ && "$configured_limit" != "infinity" ]] &&
     (( runtime_limit > configured_limit )); then
  configured_limit="$runtime_limit"
fi
printf '%s\n' '[Service]' "LimitNOFILE=$configured_limit" > "$desired_override"

configured_somaxconn=65535
if [[ "$old_somaxconn" =~ ^[0-9]+$ ]] && (( old_somaxconn > configured_somaxconn )); then
  configured_somaxconn="$old_somaxconn"
fi
printf '%s\n' "net.core.somaxconn=$configured_somaxconn" > "$desired_sysctl"

main_pid="$(systemctl show nginx --property=MainPID --value)"
process_limit=0
if [[ "$main_pid" =~ ^[1-9][0-9]*$ && -r "/proc/$main_pid/limits" ]]; then
  process_limit="$(awk '$1 == "Max" && $2 == "open" && $3 == "files" {print $4; exit}' "/proc/$main_pid/limits")"
fi

limit_is_sufficient() {
  local value="${1:-}"
  [[ "$value" == "infinity" || "$value" == "unlimited" ]] ||
    [[ "$value" =~ ^[0-9]+$ && "$value" -ge 200000 ]]
}

files_match=1
cmp -s "$desired_nginx" "$NGINX_CONF" || files_match=0
cmp -s "$desired_override" "$NGINX_OVERRIDE" 2>/dev/null || files_match=0
cmp -s "$desired_sysctl" "$SYSCTL_CONF" 2>/dev/null || files_match=0
if [[ "$files_match" == "1" && "$old_somaxconn" =~ ^[0-9]+$ ]] &&
   limit_is_sufficient "$runtime_limit" && limit_is_sufficient "$process_limit" &&
   (( old_somaxconn >= 65535 )); then
  capacity_committed=1
  echo "==> Host edge capacity already active: nofile=$process_limit, worker_connections=$worker_connections, somaxconn=$old_somaxconn"
  exit 0
fi

changes_started=1
install -m 0644 "$desired_nginx" "$NGINX_CONF"
mkdir -p "$NGINX_OVERRIDE_DIR"
install -m 0644 "$desired_override" "$NGINX_OVERRIDE"
install -m 0644 "$desired_sysctl" "$SYSCTL_CONF"

nginx -t
systemctl daemon-reload
systemctl restart nginx
sysctl -w "net.core.somaxconn=$configured_somaxconn" >/dev/null

runtime_limit="$(systemctl show nginx --property=LimitNOFILE --value)"
main_pid="$(systemctl show nginx --property=MainPID --value)"
process_limit="$(awk '$1 == "Max" && $2 == "open" && $3 == "files" {print $4; exit}' "/proc/$main_pid/limits")"
worker_connections="$(awk '$1 == "worker_connections" {gsub(/;/, "", $2); print $2; exit}' "$NGINX_CONF")"
live_somaxconn="$(sysctl -n net.core.somaxconn)"

if ! limit_is_sufficient "$runtime_limit" || ! limit_is_sufficient "$process_limit" ||
   [[ ! "$worker_connections" =~ ^[0-9]+$ || ! "$live_somaxconn" =~ ^[0-9]+$ ]] ||
   (( worker_connections < 65536 || live_somaxconn < 65535 )); then
  echo "Error: host capacity limits did not take effect." >&2
  exit 1
fi

capacity_committed=1
echo "==> Host edge capacity active: nofile=$process_limit, worker_connections=$worker_connections, somaxconn=$live_somaxconn"
