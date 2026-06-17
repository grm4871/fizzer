# Cascade Browser

Electron + React desktop app for browsing, notes, and agent-assisted editing.

## Requirements

- Node.js 20+
- npm

## Install

```bash
npm install
```

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

## Git Notes

Do not commit generated or local runtime files such as `node_modules/`, `dist/`, `client/dist/`, `*.db`, or logs. They are ignored by `.gitignore`.
