# Backend test harness

## Launcher inventory and environment contract

`scripts/lib/test-backend.mjs` starts the Elixir API for e2e and verify
scripts. The Node/Express backend has been removed.

```sh
node scripts/test-account-e2e.mjs
```

It launches `mix run --no-halt` from `backend_elixir/`, chooses an ephemeral
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

`CASCADE_TEST_BACKEND` must be `elixir` or unset. `node` is rejected.

The static HTTP/socket/SQL contract is generated from Elixir sources:

```sh
node scripts/check-backend-contract.mjs --check
node scripts/check-elixir-route-parity.mjs
```
