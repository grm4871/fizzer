# Backend parity harness

## Launcher inventory and environment contract

Before `scripts/lib/test-backend.mjs`, the six release-relevant e2es each
spawned `node dist/index.js` themselves. `test-chat-forward-e2e.mjs` and
`test-desktop-runner-e2e.mjs` also defaulted to fixed ports (3098 and 3097),
cleanup varied between one DB file and DB/WAL/SHM files, and none isolated the
vault, QMD, or download roots. Readiness polling and termination were duplicated.

The shared launcher now selects the process with:

```sh
CASCADE_TEST_BACKEND=node node scripts/test-account-e2e.mjs
CASCADE_TEST_BACKEND=elixir node scripts/test-account-e2e.mjs
```

It launches the backend directly (never through a proxy), chooses an ephemeral
port unless `TEST_API_PORT` is explicit, waits for a successful JSON
`GET /api/health` response, fails if the process exits before readiness, and
terminates the whole process group with TERM followed by a bounded KILL fallback.
Every owned run root is created by `mkdtemp` and contains:

| Purpose | Environment | Isolated value |
| --- | --- | --- |
| SQLite | `DOCS_DB_PATH` | `<temp>/data/docs.db` |
| General data | `CASCADE_DATA_DIR` | `<temp>/data` |
| Vault files | `CASCADE_VAULTS_BASE_DIR` | `<temp>/vaults` |
| QMD | `CASCADE_QMD_DIR` | `<temp>/qmd` |
| Downloads | `CASCADE_DOWNLOADS_DIR` | `<temp>/downloads` |

The exact launch compatibility is:

| Concern | Node backend | Elixir backend | Launcher behavior |
| --- | --- | --- | --- |
| Port | `API_PORT` | `API_PORT` | Sets the same ephemeral port contract. |
| Bind host | `API_HOST` | `CASCADE_BIND_IP` | Sets both to `127.0.0.1`; each backend consumes its native name. |
| Database | `DOCS_DB_PATH` | `DOCS_DB_PATH` | Uses a fixture copy beneath the run root. |
| JWT signing | `JWT_SECRET` | `JWT_SECRET` | Caller supplies one explicit test secret. |
| Registration gate | `CASCADE_REQUIRE_INVITE_REGISTRATION` | currently derived from `CASCADE_NETWORK_MODE` | An explicit Node gate is translated to Elixir network mode unless the caller explicitly sets network mode. |
| Open registration helper | `CASCADE_ALLOW_OPEN_REGISTRATION` is not read by current source | not read by current source | Preserved for existing scripts; non-network test mode is open on both. |
| Repository/static root | process cwd | `CASCADE_REPO_ROOT` / `CASCADE_CLIENT_DIST_DIR` | Launches from the native cwd and points Elixir at the repository. |
| Writable file roots | several independent variables | same independent variables | Forces every supported root beneath the owned temporary directory. |

`scripts/test-account-e2e.mjs`, `test-chat-delete-e2e.mjs`,
`test-chat-forward-e2e.mjs`, `test-chat-mission-e2e.mjs`,
`test-desktop-runner-e2e.mjs`, and `test-agent-multivault-e2e.mjs` use this
launcher without changing their assertions.

## Differential release transcript

Run the fail-closed comparison directly:

```sh
node scripts/test-backend-differential.mjs
```

The runner boots Node once to initialize the canonical empty schema, stops it,
and copies that exact DB and vault tree into independent Node and Elixir run
roots. It then performs the same ordered auth, account, vault, folder/note,
chat, publish, search, desktop-runner, run, and Socket.IO operations against
each process. It compares:

- HTTP status, JSON/text value and shape, and selected cache/security/cookie headers;
- ordered `/vault` and `/runners` Socket.IO application events;
- SQLite quick check, foreign keys, table columns, row counts, and normalized rows;
- the complete vault file tree and normalized text or binary digest.

The only ignored SQLite object is the documented Elixir-owned
`cascade_elixir_schema_migrations` table. SQLite-owned FTS shadow segment/index
tables are excluded while the logical FTS virtual-table rows remain compared.
Both sequential backend runs use the same absolute temporary root, so stored
vault paths require no path normalization. The only value normalization is
printed at startup and exported as `NORMALIZATION_RULES`: generated numeric or
UUID identities, timestamps, opaque tokens/slugs/cookie values/password hashes,
and the two ephemeral loopback origins. All other values, ordering, statuses,
headers, schema, rows, and files remain exact. A mismatch prints JSON paths for
actionable diffs and exits nonzero. Set `CASCADE_KEEP_TEST_ARTIFACTS=1` to retain
the exact temporary DBs and file roots after a failure.
The same variable retains launcher-owned artifacts for any adapted e2e.
Every completed two-backend comparison also writes the full normalized diff and
fail-closed root-cause clusters to
`scripts/artifacts/backend-differential-latest.json`. Set
`CASCADE_DIFFERENTIAL_REPORT` to a repository-relative or absolute path to
retain a named release artifact; clustering labels differences but never
suppresses them.

Focused unit coverage:

```sh
node --test scripts/lib/test-backend.test.mjs scripts/lib/backend-differential.test.mjs
```
