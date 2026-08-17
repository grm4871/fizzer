# Fizzer release matrix

Use this matrix to choose release checks from the boundaries touched by a change. Frontend and backend verification are intentionally independent; do not run one merely because the other changed.

Record pass, fail, or not applicable in the commit, run trace, or release notes. A build passing is not evidence that the user-visible flow works.

## Baseline for every production release

Run the scoped suite from the exact commit being shipped: `npm run test:release:frontend` for every hosted/client UI change, `npm run test:release:backend` for API/Elixir/agent-server changes, and `npm run test:release:desktop` for Electron main-process or packaging changes. Add only the UI verifier(s) from the table below that cover the changed flow. `npm run test:release:frontend:full` retains the exhaustive browser sweep for periodic or cross-cutting UI work; it is not the routine frontend gate. Run `npm run test:release` only for a change that crosses all three runtime boundaries. The human items below still need doing.

- [ ] Review `git status` and the committed diff; confirm every intended file is in the commit and unrelated work is not.
- [ ] Run the applicable scoped release suite(s); any failure in a touched boundary blocks release.
- [ ] For frontend changes, confirm the runtime check reports no console errors, uncaught exceptions, or failed module loads.
- [ ] For backend changes, require contract, route, data, deploy/rollback/edge, and load-harness unit parity.
- [ ] For a source release, confirm the GitHub workflow passes on the exact commit.
- [ ] For an installer release, verify each native package and its published SHA-256 checksum.
- [ ] Self-hosted deployments must define and verify their own health, rollback, and served-bundle checks.

## Checks by change class

| Change touches | Required checks | Recurring failure caught |
| --- | --- | --- |
| Chat rendering, composer, replies | Send and receive; reply banner; long/streaming response; scroll remains usable; no duplicate status UI | Reply banner covering messages, scroll jumps, duplicate Thinking/Harness indicators |
| Search, links, forwarding | Open a chat search result and verify exact-message jump/highlight; forward across channels and verify provenance after reload | Message IDs dropped between components, implementation or migration omitted from commit |
| Tabs, panes, menus, Superkanban | Open every changed tab from its real entry point; right-click/long-press menus; verify empty and populated states | Route fallthrough, missing props, clipped or immediately dismissed menus |
| Agent start and run lifecycle | Fresh run; resumed session; startup failure; renderer reload during an active run; reconnect and replay; cancel | Orphaned ID-less placeholders, stuck running state, lost output, duplicate processes |
| Agent prompt, context, helpers | Fresh and resumed turns; reply to an older message; nested project channel; read/write a live note using `cascade-note` | Ignored thread context, lost project ancestry, helper contract disappearing on resume, vault mistaken for cwd |
| Electron renderer or main process | Browser runtime check plus Electron smoke; Ctrl/Cmd+R during an active run; verify the main process and agent continue | Browser-only success hiding Electron lifecycle failures |
| Resume, sockets, performance | Brief and long background/resume; offline/online; stream a long run while switching windows | Focus-triggered resync storms, renderer stalls, missed socket events |
| Android UI | Build/install the actual APK; test status/nav safe areas, keyboard open/close, rotation, and outer/inner foldable layouts | Letterboxing, stuck splash, keyboard viewport breakage, foldable-only overflow |
| Android packaging/update | Verify APK signing/version, release asset, download endpoint, size, install-over-current, and launch | Broken self-update, APK accidentally bloating the Docker context, stale download |
| API, persistence, migrations | Test a fresh database and an upgraded copy; restart server; reload client and verify data survives | Features working in memory but failing after deploy/restart or on existing databases |
| Deployment/configuration | Clean-checkout revision-labelled image; host autodeploy completion; disk/RAM headroom; container health; expected commit, image ID, and served assets | Local-only fixes, artifact drift, stalled/OOM deploys, old production bundle reported as current |

## Automated gates

Where a row above has a command, run the command instead of reasoning about the code — each of these was verified to fail when its bug is reintroduced, not merely to pass today.

| Row | Command | What it actually asserts |
| --- | --- | --- |
| Chat rendering, composer, replies | `npm test`, `npm run test:chat-mission`, `npm run verify:chat-mission-ui` | Grouping/merge rules, reply refs, mention parsing, run blocks, steering; durable mission state across linked clients/reload; inline artifact and coordinator setting in the built client |
| Search, links, forwarding | `npm run test:chat-forward`, `npm run verify:chat-forward-ui`, `npm run verify:reply-jump-ui` | Copy fidelity + provenance across channels, socket broadcast, survives reload, refusals; then the same via real right-click → picker → banner; reply quotes scroll to and highlight the quoted message |
| Tabs, panes, menus, Superkanban | `npm run verify:tab-menus` | Every `+`/tab menu item present (catches a prop that never reached the component), menu survives the opening right-click, menu unclipped, Superkanban routes to a populated board, Close tab works |
| Agent start and run lifecycle | `npm run test:desktop-runner` | Run reclaim, replay, duplicate-process avoidance |
| Vault switcher, vault settings | `npm run verify:vault-rename-ui` | Rename reaches `PATCH /api/vaults/:id` and updates the switcher, non-owners get neither the control nor the API, and the agent-memory preference lives in account settings |
| API, persistence, migrations | `npm run test:elixir:mix-check` and `npm run test:elixir:data-parity` | Fresh **and** upgraded databases: every column the writers use exists after migration, legacy rows survive, and writes still work against a migrated table. Routine deploys classify rolling-safe from `sqlite_master` only; full row/corpus compare runs only when that schema changes. |
| Elixir backend | `npm run test:release:backend` | Sequential, fail-closed `mix check`; Elixir contract and route inventories; data compatibility; e2es; rollback, nginx edge, load-driver, monitor, and protocol regression suites |
| Deployment/configuration | Watch the update process on your host, then inspect the served bundle | Deploy completion plus the asset your configured domain really serves |

Still manual, by nature: Electron lifecycle (`Ctrl/Cmd+R` during an active run), Android/foldable layouts, background/resume and offline behavior, and any production exercise requiring a real account.

The checkout gate proves behavioral parity and data preservation; it does not certify production capacity. Run the production-shaped 10,000-user capacity test and 5,000-user two-hour durability soak only when changing concurrency, dispatch, realtime/presence, runner lifecycle, database contention, runtime resource limits, or deployment infrastructure. Those gates remain additive and bind to one exact image ID. UI presentation, Electron packaging, documentation, and ordinary contract/route parity fixes use the routine staged-image path. `deploy/remote-update.sh` never rebuilds: it validates the revision label, embedded route gate, production-shaped preflight, snapshot/rollback, authenticated smoke, and reopened edge on every cutover; when capacity certification is present it must match the exact image.

`npm run build:vps` still does not type-check the renderer. Frontend release coverage starts with `npm run typecheck:client`. Backend coverage is `mix check` plus the Elixir e2e and contract scripts, not `npm test`.

## Environment and lifecycle coverage

Use the smallest set that covers the changed boundary:

| Surface | Fresh | Resume/reload | Disconnect/recover | Production |
| --- | --- | --- | --- | --- |
| Web | Baseline runtime smoke | Required for stateful UI | Required for socket work | Required for client changes |
| Electron | Required for desktop changes | Required for renderer/run changes | Required for runner/socket work | Verify in-place refresh; never relaunch active runs |
| Android/foldable | Required for mobile changes | Required for cached/session UI | Required for networking changes | Verify installed APK and live hosted UI |
| Agent harness | Fresh session | Resumed session | Interrupted/reclaimed run | Verify the deployed prompt/helper contract |

## Release evidence

A release claim should say what was verified, not merely “tests passed.” Include:

- Commit SHA and Actions run result.
- Commands/checks executed and any intentionally skipped matrix rows.
- Production health plus the served asset or API behavior checked.
- Device and viewport for mobile UI changes.
- Whether an active agent run survived reload/reconnect when lifecycle code changed.
