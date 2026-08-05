# Unhardened surfaces & architectural inefficiency (2026-08-04)

Survey of Cascade multi-tenant, auth, and performance design gaps. **Prefer redesigns over rate-limit papering.** Items marked **shipped** were fixed in the same change set as this note.

## Hardening / isolation

### P0

| ID | Surface | Problem | Architectural direction | Status |
| --- | --- | --- | --- | --- |
| H1 | Vault FS paths (`server/vault.ts`) | Folder names were not path-safe; `..` / separators could escape `root_path` | Path segments sanitized; resolve always assert-under-root | **shipped** |
| H2 | Chat `![[note]]` grants | Auto full-note capability from title mention into channel | Explicit share capability / preview snapshot; no live full-body auto-grant | open |
| H3 | Agent JWT | 12h user-shaped token; broad allowlist; agent message patch skips author | Run/vault/channel capability tokens; server-owned authorship | open |

### P1

| ID | Surface | Problem | Architectural direction | Status |
| --- | --- | --- | --- | --- |
| H4 | Chat invite = open registration | Multi-use 7d JWT registers accounts + joins channel | Split account invites (single-use, stored) from channel joins | open |
| H5 | Incomplete vault RBAC | Tags / agent-memory / publish used read membership for writes | Single `requireVaultRole` primitive; editor+ for mutates | **partial** (tags, memory, publish) |
| H6 | Public publish HTML | marked → raw HTML; client snapshot accepted | Server note only; HTML allowlist/sanitize | **partial** (server body + basic HTML strip) |
| H7 | Note assets SVG | Served as `image/svg+xml` on app origin | Separate origin / sandbox / disallow active SVG | open |
| H8 | Channel links | Second tenancy model without channel membership roles | First-class channel members + scopes | open |
| H9 | Deploy token RCE | Long-lived secret → host git reset | CI OIDC only; pin refs | open |

### P2

| ID | Surface | Problem | Direction | Status |
| --- | --- | --- | --- | --- |
| H10 | Dual note storage + `file_path` API | Host paths leak; dual SoT | Metadata index + no host paths to clients | open |
| H11 | NETWORK_MODE optional | Prod can start open CORS | Fail closed in Docker image | open |
| H12 | Profile broadcast / 30d JWT | Vault-wide / global fanout | Scope presence; shorter tokens | open |

## Efficiency (architecture, not micro-opts)

### P0

| ID | Surface | Problem | Redesign | Status |
| --- | --- | --- | --- | --- |
| E1 | Run→chat fold | Full `run_events` rebuild + full message broadcast every ~250ms | Incremental projection + delta socket events | open |
| E2 | Message store | Channel-wide array replace on every stream tick | Message-keyed store + virtualized window | open |
| E3 | Note sockets | Any note change → full vault folder+notes reload | Tree delta protocol; full list only on connect | open |

### P1

| ID | Surface | Problem | Redesign | Status |
| --- | --- | --- | --- | --- |
| E4 | Dual stream owners | Client `/runs` + server fold both drive UI | Server projection sole owner; channel rooms | open |
| E5 | SQLite N+1 lists | tags/agents/work-items per-row; list side-effects; no `run_id` index | Batch joins; pure reads; index | **partial** (`chat_messages_run_idx`) |
| E6 | Prompt cold stack | App contract + project docs + chat stuffed every new session | Pin system contract; tool-fetch workspace docs | open |
| E7 | Runner split-brain | Control plane in renderer, processes in main | Main-owned lease + process supervisor | open |
| E8 | App shell fanout | Full `notes[]` into every ChatView | External note resolver / tree store | open |

### P2

| ID | Surface | Problem | Redesign | Status |
| --- | --- | --- | --- | --- |
| E9 | Monolithic deploy image | UI-only pays full server rebuild | Split static client + server image | open |
| E10 | CodeMirror language-data | Kitchen-sink langs | Explicit language allowlist | open |
| E11 | Work-item list hydrate | Full graph for board views | Board projection query | open |
| E12 | Harness on ChatMessage | Multi-MB traces on transcript rows | Run artifact store by `runId` | open |

## Suggested program order

1. **Path + RBAC consistency** (started) — finish remaining write routes with one auth helper.
2. **Chat projection deltas** (E1/E2/E4) — biggest multiplayer cost.
3. **Note-tree deltas** (E3) — stops vault reload storms under agents.
4. **Capability tokens + channel membership** (H3/H8/H2) — multi-tenant story.
5. **Deploy identity + dual storage cleanup** (H9/H10/E9).

## What already looks intentional

- Vault `root_path` isolation (unique roots, boot rehome, ignore client path).
- Note routes re-check vault membership after `getNote`.
- Soft vault reload coalesce; messageStore out of App for stream ticks.
- Ship hard gate in AGENTS.md (tsc before push, watch Deploy).
