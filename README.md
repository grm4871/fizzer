# Cascade Browser

Electron + React desktop app for browsing, notes, and agent-assisted editing.

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
npm install --prefix cascade-electron
```

If the API fails to start after a Node upgrade (`NODE_MODULE_VERSION` /
`better-sqlite3` ABI mismatch, often looking like Vite `ECONNREFUSED` on
`/api/*`), rebuild the API's native modules:

```bash
npm run rebuild:native
```

macOS tip if node-gyp fails on a broken Homebrew Python:
`npm_config_python=/usr/bin/python3 npm run rebuild:native`.

## Run In Development

Start the API, Vite client, and Electron shell:

```bash
npm run dev
```

The backend defaults to `http://localhost:3000`, and the Vite client defaults to `http://localhost:5173`.

## Run Without Electron

Start only the API and Vite client:

```bash
npm run dev-headless
```

Then open the Vite URL in a browser.

## Build And Test

```bash
npm run build
npm test
```

## Documentation

The maintained project documentation starts at
[`docs/README.md`](docs/README.md). It covers local setup, architecture, the
agent runtime, development and testing, and production operations.

## Data Locations

Local app data is stored outside the repo:

- SQLite database: `~/.cascade/docs.db`
- Vault markdown files: `~/.cascade/vaults/`

You can override the database path with:

```bash
DOCS_DB_PATH=/path/to/docs.db npm run dev
```

## Useful Scripts

```bash
npm run dev-debug        # debug backend + client + Electron
npm run dev-backend      # API only
npm run dev-client       # Vite client only
npm run package          # package the Electron app
npm run make             # build distributables
```

## Production deploy (CI/CD)

Pushes to `master` reach the authenticated host webhook, whose autodeploy
service fast-forwards the server checkout and runs `deploy/remote-update.sh`.
The GitHub Actions deploy workflow is `workflow_dispatch` fallback only, so a
push has one production trigger. Production loads the already-certified image
without rebuilding it. First-time server setup is still
`deploy/deploy.sh <domain>`.

GitHub Actions secrets (mirror the Simcluster repo values):

| Secret | Purpose |
|--------|---------|
| `DEPLOY_SSH_KEY` | Private key authorized on the host for deploy SSH |
| `DEPLOY_HOST` | Server hostname or IP |
| `DEPLOY_USER` | SSH user (typically `root`) |
| `DEPLOY_PORT` | SSH port (optional; default 22) |
| `DEPLOY_KNOWN_HOSTS` | Pinned SSH host-key line used by the manual fallback |

Desktop Electron installers are built separately by `.github/workflows/desktop-build.yml` on `v*` tags.

## Git Notes

Do not commit generated or local runtime files such as `node_modules/`, `dist/`, `client/dist/`, `*.db`, or logs. They are ignored by `.gitignore`.
