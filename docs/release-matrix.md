# Cascade release matrix

Use this matrix to choose release checks from the boundaries touched by a change. It is not a demand to test every cell for every commit: run the **baseline** every time, then the rows matching the change.

Record pass, fail, or not applicable in the commit, run trace, or release notes. A build passing is not evidence that the user-visible flow works.

## Baseline for every production release

`npm run test:release` runs the automated part of this baseline in order (build → client/Node unit → Node server → Elixir cutover → Node e2e → runtime/UI). Run it from the exact commit being shipped; the human items below still need doing.

- [ ] Review `git status` and the committed diff; confirm every intended file is in the commit and unrelated work is not.
- [ ] Run `npm run build:vps` from the exact commit being shipped.
- [ ] Run `npm test` (client unit) and `npm run test:server` (server unit, including schema migrations).
- [ ] Run `npm run test:elixir-release`; any contract, route, data, unchanged-e2e, differential, deploy/rollback/edge, or load-harness mismatch blocks Elixir cutover.
- [ ] Run `npm run verify:client-runtime` and confirm no console errors, uncaught exceptions, or failed module loads.
- [ ] Build the full-SHA release image from a clean commit, certify the exact image ID with the 10,000-user evidence, and stage it before pushing.
- [ ] Push once, watch the webhook-triggered host deploy to completion (`ssh root@66.135.24.172 journalctl -u cascade-autodeploy -f`), and read the failure rather than guessing. The Actions workflow is manual fallback only.
- [ ] Confirm production health, expected commit, and that `docker inspect cascade` matches the certified manifest image ID.
- [ ] For client changes, inspect the JavaScript asset actually served by `cscd.online` for the feature and its call site, then exercise the affected flow in production.

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
| Deployment/configuration | Clean-checkout certified image; host autodeploy completion; disk/RAM headroom; container health; expected commit, image ID, and served assets | Local-only fixes, artifact drift, stalled/OOM deploys, old production bundle reported as current |

## Automated gates

Where a row above has a command, run the command instead of reasoning about the code — each of these was verified to fail when its bug is reintroduced, not merely to pass today.

| Row | Command | What it actually asserts |
| --- | --- | --- |
| Chat rendering, composer, replies | `npm test`, `npm run test:chat-mission`, `npm run verify:chat-mission-ui` | Grouping/merge rules, reply refs, mention parsing, run blocks, steering; durable mission state across linked clients/reload; inline artifact and coordinator setting in the built client |
| Search, links, forwarding | `npm run test:chat-forward`, `npm run verify:chat-forward-ui`, `npm run verify:reply-jump-ui` | Copy fidelity + provenance across channels, socket broadcast, survives reload, refusals; then the same via real right-click → picker → banner; reply quotes scroll to and highlight the quoted message |
| Tabs, panes, menus, Superkanban | `npm run verify:tab-menus` | Every `+`/tab menu item present (catches a prop that never reached the component), menu survives the opening right-click, menu unclipped, Superkanban routes to a populated board, Close tab works |
| Agent start and run lifecycle | `npm run test:desktop-runner` | Run reclaim, replay, duplicate-process avoidance |
| Vault switcher, vault settings | `npm run verify:vault-rename-ui` | Rename reaches `PATCH /api/vaults/:id` and updates the switcher, non-owners get neither the control nor the API, and the agent-memory preference lives in account settings |
| API, persistence, migrations | `npm run test:server` | Fresh **and** upgraded databases: every column the writers use exists after migration, legacy rows survive, and writes still work against a migrated table |
| Elixir backend cutover | `npm run test:elixir-release` | Sequential, fail-closed `mix check`; Node contract and Elixir route inventories; data compatibility; six unchanged Elixir e2es; Node-vs-Elixir differential; then certification, rollback, nginx edge, load-driver, monitor, and protocol regression suites |
| Deployment/configuration | `journalctl -u cascade-autodeploy -f` on the host, then grep the served bundle | Deploy completion plus the asset `cscd.online` really serves (see AGENTS.md) |

Still manual, by nature: Electron lifecycle (`Ctrl/Cmd+R` during an active run), Android/foldable layouts, background/resume and offline behavior, and any production exercise requiring a real account.

The checkout gate proves behavioral parity and data preservation, but it does not certify production capacity. Elixir cutover also remains blocked until `mix cascade.parity` succeeds inside the exact immutable release image and the production-shaped 10,000-user load, runner/SQLite recovery, and additional 5,000-user two-hour durability soak gates in `loadtest_elixir/README.md` are recorded for that same image ID. The 5,000-user soak tests long-lived churn, resource return, and durable run events; it is additive and can never substitute for the exact 10,000-user/30-minute capacity certification. `deploy/remote-update.sh` accepts only the staged, checksummed certification for its full Git revision and never rebuilds. Do not bypass either gate or normalize a differential mismatch away.

Two failure classes are invisible to `npm run build:vps`, so never treat a green build as coverage: the client bundle is **not** type-checked (a misplaced JSX attribute compiles and ships), and `server/*.test.ts` is not part of `npm test` — it needs `npm run test:server`.

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
