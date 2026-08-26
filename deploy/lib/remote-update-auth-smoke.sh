# Remote update authenticated smoke seam.
# Inputs are running container/image and public-domain globals; outputs are protocol/auth/edge assertions.
# Ordering probes authenticated reads before reopening external traffic.

verify_authenticated_live_candidate() {
  local container="${1:-$CONTAINER_NAME}"
  local origin="${2:-$HEALTH_URL}"
  origin="${origin%/api/health}"
  echo "==> Running authenticated production read/realtime smoke against $container"
  local probe_token
  # `release eval` starts a separate VM, not an RPC session in the running
  # release, so its Repo is intentionally absent. Mint the ephemeral parity
  # token from the image's pinned SQLite library and Node's HMAC; the live
  # Elixir edge still performs every authorization check below.
  probe_token="$(docker exec "$container" node --input-type=module -e '
    import crypto from "node:crypto";
    import Database from "better-sqlite3";
    const db = new Database("/data/docs.db", { readonly: true, fileMustExist: true });
    try {
      const user = db.prepare(`
        SELECT DISTINCT u.id,u.username,u.auth_version AS authVersion FROM users u
        JOIN vaults v ON v.created_by=u.id
        JOIN notes n ON n.vault_id=v.id
        WHERE n.is_archived=0
          AND (n.content LIKE ? OR n.content_preview LIKE ?)
        ORDER BY u.id ASC LIMIT 1
      `).get("cascade://chat-channel%", "cascade://chat-channel%");
      if (!user) throw new Error("production has no owner account with an accessible chat channel");
      const now = Math.floor(Date.now() / 1000);
      const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ ...user, access: "user", iat: now, exp: now + 7 * 24 * 60 * 60 })}`;
      process.stdout.write(`${body}.${crypto.createHmac("sha256", process.env.JWT_SECRET).update(body).digest("base64url")}`);
    } finally { db.close(); }
  ')"
  if [[ -z "$probe_token" ]]; then
    echo "Error: could not mint the ephemeral authenticated smoke token." >&2
    return 1
  fi
  printf '%s' "$probe_token" | docker run --rm -i --network host --entrypoint node \
    "$CANDIDATE_IMAGE" /app/deploy/authenticated-live-smoke.mjs "$origin"
  unset probe_token
}

verify_reopened_production_edge() {
  echo "==> Verifying the reopened production edge"
  local health_code="000" root_html="" engine_open="" consecutive=0
  # As with gate closure, nginx's graceful reload can briefly leave a retiring
  # worker generation serving the old marker state. Require three complete,
  # fresh edge probes before declaring the public cutover finished.
  for _attempt in $(seq 1 20); do
    health_code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/api/health" || true)"
    root_html="$(curl --noproxy '*' -fsS --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" "https://$DEPLOY_DOMAIN/app.html" || true)"
    engine_open="$(curl --noproxy '*' -fsS --connect-timeout 3 --max-time 10 \
      --resolve "$DEPLOY_DOMAIN:443:127.0.0.1" \
      "https://$DEPLOY_DOMAIN/socket.io/?EIO=4&transport=polling&t=$RANDOM" || true)"
    if [[ "$health_code" == "200" && "$root_html" == *'<div id="root"'* && "$root_html" == *'assets/main-'* && "$engine_open" == 0* ]]; then
      consecutive=$((consecutive + 1))
      if [[ "$consecutive" -ge 3 ]]; then
        echo "==> Reopened production health, client, TLS edge, and Engine.IO are verified"
        return 0
      fi
    else
      consecutive=0
    fi
    sleep 1
  done
  echo "Error: reopened production edge did not stabilize (health HTTP ${health_code:-000}, client=$([[ "$root_html" == *'<div id="root"'* && "$root_html" == *'assets/main-'* ]] && echo ok || echo failed), Engine.IO=$([[ "$engine_open" == 0* ]] && echo ok || echo failed))." >&2
  return 1
}
