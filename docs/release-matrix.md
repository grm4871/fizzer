# Fizzer release matrix

Use this matrix to choose checks from the boundaries touched by a change. Record
pass, fail, or not applicable against the exact commit. A build passing is not
evidence that the served user-visible flow works.

## Release paths

There are two image paths; do not mix their commands:

| Path | When | Required sequence |
| --- | --- | --- |
| Routine exact-image | UI, docs, packaging, and ordinary route/contract changes | `npm run release:image:build`, then `npm run release:image:stage -- <ssh-host>`, then host-side `deploy/remote-update.sh` |
| Capacity-certified | Concurrency, dispatch, realtime/presence, runner lifecycle, SQLite contention, runtime limits, or deployment-infrastructure changes | Build; run the outer `npm run release:capacity:run -- ... -- ...` wrapper; run the complete `release:image:certify` contract over its generated evidence; then `npm run release:image:stage-certified -- <manifest> <ssh-host>`; then `remote-update.sh` |

The capacity manifest is optional for an existing host's routine exact-image
release. If a manifest is staged, `remote-update.sh` validates its checksum,
full revision, image tag, and immutable image ID against the candidate; a partial
or mismatched manifest fails closed. First-time `deploy/deploy.sh` bootstrap
requires the certified manifest for its checkout revision.

Capacity certification must use the outer `release:capacity:run` command. That
wrapper holds the lock, isolates generators from candidate CPUs `0-1`, invokes
only the checked-in `loadtest_elixir/certification-runner.mjs`, and owns exact
candidate IDs, phase roots, and cleanup. Do not call the runner directly or use
an incomplete direct `certified-image` invocation. The final profile covers the
10,000-user gate, two fault proofs, and separate 5,000-user/two-hour soak. Keep
source DB/corpus, fixture, results, and phase roots canonical, private,
pairwise-disjoint, and disk-backed; never use `/tmp` for results. The certifier
then consumes the runner's monitor, four shard, preflight, freeze, runtime,
reconciliation, fault, and soak artifacts and emits a manifest plus checksum.
The full executable command is in `docs/deployment.md` and
`loadtest_elixir/CAPACITY_TELEMETRY.md`.

## Baseline checks

Run the scoped suite from the exact commit being shipped:

- Hosted/client UI: `npm run test:release:frontend`.
- API, Elixir, or agent server: `npm run test:release:backend`.
- Electron main process or packaging: `npm run test:release:desktop`.
- A change crossing all three boundaries: `npm run test:release`.

`npm run test:release:frontend:full` is the exhaustive UI sweep for periodic or
cross-cutting work, not the routine frontend gate. `npm run build:vps` does not
type-check the renderer; frontend coverage starts with `npm run typecheck:client`.
Backend coverage is `mix check` plus the Elixir contract, route, data, e2e, and
deploy/rollback/edge suites, not `npm test` alone.

For every release:

- [ ] Review `git status` and the committed diff; release image builds require a clean checkout.
- [ ] Run each applicable scoped suite; a failure in a touched boundary blocks release.
- [ ] Confirm the exact image ID, full Git revision, and target platform in release evidence.
- [ ] Confirm `.env` has the exact `CASCADE_PUBLIC_URL`, matching allowed origin, and a protected JWT secret.
- [ ] Confirm production host prerequisites, Compose shape, disk/RAM headroom, and UID/GID 1000 data ownership.
- [ ] Watch the host-side update process; confirm expected commit, image ID, health, and served asset/API through the configured domain.
- [ ] Keep rollback image/snapshot and release evidence until post-deploy checks pass.

## Checks by changed surface

| Change touches | Required human check | Failure caught |
| --- | --- | --- |
| Chat rendering, composer, replies | Send/receive, reply banner, long/streaming response, scroll, duplicate status UI | Covered messages, jumps, duplicate Thinking/Harness indicators |
| Search, links, forwarding | Search result exact-message jump/highlight; forward across channels; reload and verify provenance | Dropped IDs or provenance |
| Tabs, panes, menus, Superkanban | Open every changed entry point; right-click/long-press; empty/populated states | Route fallthrough, clipping, immediate dismissal |
| Agent start and run lifecycle | Fresh/resumed run; startup failure; reload during run; reconnect/replay; cancel | Orphans, stuck state, lost output, duplicate processes |
| Agent prompt/context/helpers | Fresh/resumed turns; older-message reply; nested project; read/write a live note | Lost thread/project/helper context |
| Electron renderer/main | Browser runtime plus Electron smoke; `Ctrl/Cmd+R` during active run | Browser-only success hiding lifecycle failure |
| Resume, sockets, performance | Background/resume, offline/online, long run while switching windows | Resync storms, stalls, missed events |
| Android UI | Build/install APK; keyboard, rotation, status/nav safe areas, foldable layouts | Letterboxing, splash, viewport, foldable overflow |
| Android packaging/update | APK signing/version, release asset/download, checksum, install-over-current | Stale or unsigned/mis-versioned package |
| API, persistence, migrations | Fresh and upgraded DB; restart; reload; verify durable data | In-memory-only behavior or migration loss |
| Deployment/configuration | Clean revision-labelled image; host update; runtime shape; health; served bundle | Drift, stalled/OOM deployment, stale assets |

## Automated gates

Use the command that covers the changed surface; do not infer behavior from
source inspection:

| Surface | Command | Scope |
| --- | --- | --- |
| Chat | `npm test`, `npm run test:chat-mission`, `npm run verify:chat-mission-ui` | Client tests, mission lifecycle, built-client mission flow |
| Search/forward/reply | `npm run test:chat-forward`, `npm run verify:chat-forward-ui`, `npm run verify:reply-jump-ui` | Provenance, sockets/reload, real picker/reply jump |
| Tabs/menus | `npm run verify:tab-menus` | Real menu entry points, clipping, populated Superkanban route |
| Agent lifecycle | `npm run test:desktop-runner` | Reclaim, replay, duplicate-process avoidance |
| Vault settings | `npm run verify:vault-rename-ui` | Owner controls, API mutation, account preference |
| API/data | `npm run test:elixir:mix-check`, `npm run test:elixir:data-parity` | Fresh/upgraded schema, legacy rows, write compatibility |
| Backend release | `npm run test:release:backend` | Build, mix/contract/route/data/e2e and release-safety gates |
| Deployment | Host update plus served-bundle check | Real configured domain and running image, not local output |

The production-shaped capacity gate is not part of ordinary checkout parity.
Run it only for the capacity-sensitive classes above, and bind every artifact
to one immutable image ID. A capacity pass does not replace health, authenticated
live smoke, nginx, backup, rollback, or served-bundle checks.

## Environment and lifecycle coverage

| Surface | Fresh | Resume/reload | Disconnect/recover | Production |
| --- | --- | --- | --- | --- |
| Web | Baseline runtime smoke | Stateful UI reload | Socket offline/online | Configured public origin |
| Electron | Required for desktop changes | Renderer/run reload | Runner/socket recovery | In-place refresh; do not relaunch active runs |
| Android/foldable | Installed APK | Cached/session UI | Networking changes | Installed APK plus live hosted UI |
| Agent harness | Fresh session | Resumed session | Interrupted/reclaimed run | Deployed prompt/helper contract |

## Workflow and artifact truth

The repository currently has only two GitHub workflows:

- `desktop-build.yml` builds native macOS, Windows, and Linux installers and
  publishes the rolling `desktop-beta` release. These technical-beta installers
  are **unsigned**; uploaded SHA-256 values provide integrity checking, not code
  signing or publisher identity.
- `android-beta.yml` builds/publishes the sideload APK only when its signing
  secrets are configured; otherwise it explicitly skips the APK build.

Neither workflow builds, certifies, stages, promotes, or rolls back the server.
A successful Actions run or GitHub upload is not proof that production changed.

Ownership matters during handoff: the image builder owns the immutable local
image; capacity runner owns evidence files until the certifier consumes them;
the certifier owns the manifest/checksum; certified staging installs those as
root-owned `0600` files below `/var/lib/cascade-release`; the application owns
only UID/GID 1000 data below `/var/lib/cascade`. `deploy.result` is writable by
the application so the watcher can report status and is not an attestation.

## Release evidence

A release claim should identify what was verified, not merely say “tests
passed.” Include:

- Commit SHA, image ID, platform, and applicable Actions run result.
- Commands/checks executed and intentionally skipped matrix rows.
- Capacity manifest/checksum and retained artifact paths, when certification was required.
- Host health, authenticated live behavior, public TLS edge, and served asset/API check.
- Device and viewport for mobile UI changes.
- Whether an active agent run survived reload/reconnect when lifecycle code changed.
- Rollback image/snapshot location and the operator who owns cleanup after sign-off.
