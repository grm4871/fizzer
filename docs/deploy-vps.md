# Deploy Cascade On A VPS

This is the small-instance deployment path for multi-user testing. It runs one Node process that serves both the API and the built React client. Put nginx, Caddy, or another TLS reverse proxy in front of it.

## Build

```bash
npm install
npm run build:vps
```

## Environment

Use a production `.env` or systemd environment with at least:

```bash
NODE_ENV=production
CASCADE_NETWORK_MODE=true
API_HOST=127.0.0.1
API_PORT=3000
CASCADE_ALLOWED_ORIGINS=https://cascade.example.com
DOCS_DB_PATH=/var/lib/cascade/docs.db
CASCADE_ENABLE_WIDGET_SHELL=false
```

Set `JWT_SECRET` to a long random value if you want to manage it yourself. If omitted, Cascade persists a generated secret at `~/.cascade/secret` so existing sessions survive process restarts. Do not set `JWT_SECRET=cascade-dev-secret` in network mode.

Keep `CASCADE_ENABLE_WIDGET_SHELL=false` for multi-user testing unless every user is trusted. That endpoint runs shell commands in the vault root.

## Run

```bash
npm run start:vps
```

The server serves `client/dist` automatically when it exists. For a same-origin deployment, build the client without `VITE_API_URL` so browser requests go to the same host as the app.

## Reverse Proxy Notes

Forward HTTP and WebSocket traffic to `127.0.0.1:3000`. Example nginx locations:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
}
```

If the app sits behind more than one proxy hop, set `CASCADE_TRUST_PROXY_HOPS` accordingly so auth rate limiting keys on the real client IP.
