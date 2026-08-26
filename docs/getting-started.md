# Getting started

This page is for a developer running Fizzer from a checkout. For product use,
start with the [user guide](user-guide.md). Commands below run from the
repository root unless noted.

## Prerequisites

- Node.js 24 or newer (the `engines` entry in `package.json` is `>=24`);
- npm and Git;
- Elixir 1.17+ and Erlang/OTP for the local API;
- an Electron-capable desktop session for the full desktop app;
- a supported, locally installed and authenticated agent CLI if you want local
  agent execution (Codex, Claude Code, Grok, Copilot, Hermes, Antigravity,
  Akron, OMP, or Pi).

The browser/headless mode is enough for ordinary notes and chat. Agent execution
needs the Electron shell or another compatible runner. Provider login happens in
the provider's own CLI; Fizzer does not replace it.

## Install

```bash
npm install
npm install --prefix cascade-electron
```

The root package is an npm workspace that includes `client/`. The Electron shell
is a separate package and needs its own install.

### Native modules (`better-sqlite3`)

Helper scripts and the QMD worker use `better-sqlite3` against the current Node
ABI. After a Node upgrade, if a tool reports `NODE_MODULE_VERSION`, rebuild:

```bash
npm run rebuild:native
```

The root `postinstall` runs the rebuild only when it detects a load-time ABI
mismatch. On macOS, if node-gyp fails because Homebrew Python is broken (for
example, `pyexpat`), the rebuild script prefers `/usr/bin/python3`; force it
with:

```bash
npm_config_python=/usr/bin/python3 npm run rebuild:native
```

Set `CASCADE_SKIP_NATIVE_REBUILD=1` to skip automatic native work.

## Run Fizzer

### Full desktop stack

```bash
cp .env.example .env
npm run dev
```

`npm run dev` runs the backend (`npm run dev-backend`), Vite client, and
Electron watcher. The API listens at `http://localhost:3000`; Vite listens at
`http://localhost:5173`.

### Browser-only stack

```bash
npm run dev-headless
```

This runs the same API and Vite client without Electron. It supports notes,
chat, and server-backed features; local provider execution and desktop Git
worktrees are unavailable.

### Debug mode

```bash
npm run dev-debug
```

`dev-debug` currently invokes the same backend command as `dev`: its
`dev-backend-debug` script is the same `dotenv ... cd backend_elixir && mix run
--no-halt` command as `dev-backend`. The name is retained for compatibility; do
not infer extra backend instrumentation from it. `npm run dev-headless-debug`
likewise runs the debug-named backend script with the headless client.

### Isolated development instance

```bash
npm run dev-instance -- --name my-change
```

See `node scripts/dev-instance.cjs --help` for instance options. Use an
isolated database when running multiple instances or scripts that write state.

## Local data and overrides

The default locations are deliberately independent:

| Data | Default | Override |
| --- | --- | --- |
| Backend SQLite | `docs.db` in the repository root | `DOCS_DB_PATH=/tmp/fizzer.db` |
| Vault Markdown and assets | `~/.cascade/vaults/` | `CASCADE_VAULTS_BASE_DIR=/path/to/vaults` |
| QMD corpora and indexes | `~/.cascade/qmd/` | `CASCADE_QMD_DIR=/path/to/qmd` |

The database default is defined by `backend_elixir/config/config.exs` and
`backend_elixir/config/runtime.exs`; the vault directory is selected by
`Cascade.Content.Store.vaults_base_dir/0`; QMD uses `Cascade.Search.QMD.root_dir/0`.
Changing `DOCS_DB_PATH` does not move vault files or QMD indexes.

For an isolated database:

```bash
DOCS_DB_PATH=/tmp/fizzer-my-change.db npm run dev
```

Vault creation makes a unique directory below the managed vault base. Content
writes must resolve below that vault root (`Cascade.Content.Store.resolve_under_vault/2`);
assets are kept below its `.cascade-assets/<note-id>/` directory and are not a
second database. Do not inspect or edit SQLite directly for ordinary product
work; use the application API and the `cascade-note`, `cascade-chat`, and
`cascade-scratchpad` helpers where applicable.

## First verification

Choose the focused checks for the boundary you changed:

```bash
npm run build                 # TypeScript CLI/helper build
npm test                      # client unit tests
npm run build:client          # production renderer bundle
node scripts/verify-client-runtime.mjs
npm run test:cli-agents       # tsx --test cli-agents/*.test.ts
npm run test:electron         # node --test cascade-electron/*.test.cjs
```

The runtime verifier loads the built renderer in headless Chromium and reports
uncaught exceptions, failed module loads, and fatal console errors. The full
matrix is in [Development and testing](development.md).

## Account and local-agent setup

1. Start Fizzer and register or log in.
2. Create a vault; it starts with a `General` channel note.
3. Install and authenticate a provider CLI on the computer that will execute
   the run.
4. In a channel, choose **Add agent**, configure its model and working folder,
   then save it.
5. Mention the agent in that channel.

Browser authentication is an HttpOnly session cookie. A legacy `docs_token`
bearer credential can be migrated once by the session endpoint and then removed
from local storage. Agent helpers use a separate short-lived agent token, not
the user's browser session.

## Android preview

The Capacitor Android build includes the bundled **Local Codex** plugin. On a
supported APK, Account settings can authenticate it with device auth, enable it,
and run Codex in Fizzer's private foreground workspace. It is separate from the
desktop runner and does not make arbitrary provider CLIs available on Android.

## Configuration and hygiene

The repository root `.env.example` documents local server, runner, and session
settings. `deploy/.env.example` is the minimal production environment template.
Never commit `.env`, tokens, provider credentials, database files, generated
QMD data, `node_modules/`, `dist/`, or files under `.private/`.
