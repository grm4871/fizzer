# Fizzer user guide

Fizzer is a shared workspace for people, notes, conversations, and locally-run
AI agents. The repository is named `cascade-browser`, but the product is
**Fizzer**. It is early-beta software, so interface details and available agent
adapters may change.

## The mental model

### Accounts and vaults

Your **account** is your identity: username, display name, avatar, password,
mentions, invitations, direct-message settings, blocks, and ownership. Your
login handle is stable; your display name and avatar can change.

A **vault** is the top-level project or community boundary. It contains folders,
notes, channels, members, agents, work items, missions, and activity. Use
separate vaults when context or permissions must be separate. A vault member has
one of three roles:

- **owner** — manages membership, invitations, discovery, moderation, and
  settings;
- **editor** — can read and write notes, folders, and chats;
- **viewer** — read-only access, subject to the vault's access rules.

### Notes, channels, and agents

A **note** is a Markdown-backed durable document for requirements, decisions,
research, specifications, checklists, and reference material. Notes can live in
folders, link to other notes, be searched, become Kanban boards, and be published
as public snapshots.

A **channel** is a persistent conversation inside a vault. Use it for questions,
decisions, status updates, agent requests, and project discussion. A channel
transcript is shared and realtime.

An **agent registration** attaches a locally authenticated provider CLI to a
vault/channel. The agent process and provider credentials stay on the owner's
computer. Fizzer stores workspace conversation, run events, and results, not the
provider secret.

## Ways to use Fizzer

| Goal | Use | Result |
| --- | --- | --- |
| Keep team knowledge | Notes and folders | Searchable, editable information that outlives chat |
| Discuss work | Vault channels | One durable transcript for members |
| Ask an AI to work | Agent mention | A run through the owner's local CLI |
| Coordinate multi-step work | Missions | Durable ownership, dependencies, retries, and review |
| Track implementation | Work items and Kanban | An addressable lifecycle, branch, workspace, and review record |
| Protect human-only context | Private blocks | Content redacted from agent/model surfaces |
| Share a finished document | Publish | A public snapshot without vault membership |
| Find prior decisions | Workspace search | Ranked note and chat results |
| Catch up | Updates | Mentions, replies, note changes, and activity by vault |

## Getting started

### Desktop beta

1. Download a desktop release from [Fizzer Releases](https://github.com/grm4871/fizzer/releases).
2. Install and authenticate a supported agent CLI on the computer that should
   execute runs.
3. Open Fizzer and create an account.
4. Create a vault from the vault switcher.
5. Create a note or channel and begin working.

The desktop installers are currently unsigned, so your operating system may ask
you to confirm that you trust the application.

### From source

For ordinary note and chat work, browser/headless mode is enough. Agent
execution requires the desktop shell or another compatible runner.

```bash
cp .env.example .env
npm install
npm install --prefix cascade-electron
npm run dev
```

This starts the API at `http://localhost:3000`, Vite at
`http://localhost:5173`, and the Electron shell. Use `npm run dev-headless` for
API plus Vite without Electron. Prerequisites and data overrides are in the
[getting-started guide](getting-started.md).

By default, the backend database is `docs.db` in the repository root. Vault
files/assets default to `~/.cascade/vaults/`; QMD search data defaults to
`~/.cascade/qmd/`. Set `DOCS_DB_PATH`, `CASCADE_VAULTS_BASE_DIR`, or
`CASCADE_QMD_DIR` independently when needed.

## The main workspace

### Sidebar

The left sidebar provides the current vault and switcher, new note/folder/channel
actions, the note tree, unread badges, public vault discovery, direct messages,
and account/vault management. Right-click notes and folders to rename, delete,
move, or create items. Drag them to reorder or move them. `Notes` is the drop
target for moving an item to the vault root.

### Tabs and panes

Notes, channels, and Superkanban open as tabs. Tabs and pane layout are restored
per vault in the browser's local session. Drag a tab onto another pane's center
to dock it, toward an edge to split, or drag a divider to resize.

**Only note tabs can pop out into a separate Electron desktop window.** Chat,
Superkanban, and new tabs remain in the main workspace. Drag a popped-out note's
header back to merge it into the workspace.

### Toolbar

- **Orbit** — a live view of locally discovered Claude Code and Codex sessions;
- **Updates** — unread mentions, replies, note changes, and other activity;
- **Sessions** — active Fizzer runs, timing, output, and cancellation;
- **Members** — the current vault's people and agent panel when available.

## Vaults, sharing, and community

### Create and organize a vault

1. Open the vault name at the top of the sidebar.
2. Choose **New vault**, enter a name, and create it.
3. Switch vaults from the same menu.
4. Add folders and notes using quick actions, context menus, or `Cmd/Ctrl+N`.

A new vault is private and starts with a `General` channel note. The vault menu
also permits rename or permanent deletion when your role allows it.

### Invite and manage members

Open account settings and choose **Current vault**, or use channel member
controls. Owners can invite by username, copy a role-specific invite link,
change roles, remove or ban members, unban members, review reports, and approve
or decline public-vault join requests. A viewer cannot modify vault content.

### Public vault discovery

Owners can list a vault publicly with a summary, topics, community guidelines,
and an optional sanitized home-note preview. Choose one join policy:

- **Open** — anyone can join as a viewer;
- **Request** — the owner must approve a join request;
- **Invite only** — discovery does not allow self-joining.

Choose **Browse public vaults** in the switcher to search by vault name, owner,
purpose, or topic. Open a detail page to read guidelines and join or request
access. Before membership, only the configured sanitized preview is exposed;
working notes remain private.

### Moderation and reporting

Use **Report** on a vault, note, message, or member for a Trust-and-safety
report. A vault owner can review reports for that vault; the server owner can
A report records its target, reason, details, and reporter internally. In the
vault moderation queue, the reporter's identity is intentionally hidden from
vault owners; the queue shows the report target and details without exposing who
filed it. The server owner can see reporter identity and vault ownership context
in the global moderation queue. Owners cannot report themselves or review their
own member-target report.

A reviewer chooses **Dismiss** when the report does not require action or
**Resolve** when it has been handled. These actions close the report with a
reviewer and timestamp; they do not silently delete the underlying content.
Bans and public-vault unlisting are separate moderation actions.

### Product feedback is different

**Product feedback** is a private message to the Fizzer server owner about a
product bug or usability suggestion. It is not a Trust-and-safety report and it
does not create a GitHub issue. The owner can Dismiss or Resolve feedback from
Administration.

## Notes

### Edit and save

Open a note from the sidebar. The editor is Markdown with a live preview; the
title is editable. Edits mark the tab dirty. Save with `Cmd/Ctrl+S` on desktop
or **Save** on mobile. Save before closing a tab or switching context if the
latest draft must persist.

Note bodies are loaded on demand. A restored tab does not imply its previous
body is cached; Fizzer re-fetches it from the server.

### Supported formatting and media

The editor supports bold, italic, strikethrough, inline code, links, headings
1–3, lists, checklists, rules, tables, images, MP3 audio, MP4 video, pasted or
dropped images, Fizzer note links, private blocks, publishing, and Kanban view.
Note media uploads are validated by `backend_elixir/lib/cascade/content/assets.ex`:
images (PNG, JPEG, GIF, WebP), MP3, and MP4 are supported; SVG uploads are not.
Each upload is limited to 8 MB.

Chat attachments use the composer input (`image/*`, `video/*`, `audio/*`,
`.pdf`, `.txt`, `.md`). Each file is limited to 8 MB and one message accepts at
most 8 media items. The composer previews images/video and names other files.
Pasted clipboard images count toward the same limit.

### Link notes

Use the link control (or the mobile note-link action) to search for a note and
insert a link. Obsidian-style links also work:

```markdown
[[Decision log]]
```

Clicking a link opens the matching note. A note can also embed a linked chat
note where that message grants access to it.

### Private blocks and search

Mark human-only material with the private-block action or:

```markdown
:::private
credential=value
internal-only context
:::
```

Private blocks remain in the note for members who can read it, but are redacted
when an **agent** receives note/chat data, search results, memory, previews,
publishing output, or model prompts. This is not a password manager.

A member's normal workspace search is not an agent request: member search can
match and show private content the member is authorized to read. Agent-scoped
search uses the redacted corpus. The server selects this behavior from the
authenticated access type; see `backend_elixir/lib/cascade/content/privacy.ex`
and `backend_elixir/lib/cascade/search/qmd.ex`.

### Ask an agent from a note

An AI directive has the form:

```markdown
{{ai: Summarize this note into three decisions}}
```

Place the cursor on it and press `Cmd/Ctrl+Enter`. For a small note-local action,
Fizzer sends it through the active agent path. Use a channel and mission for
larger work with durable context and review.

### Publish a note

1. Open the note and select the globe action.
2. Review the public snapshot and copy its link.
3. Use the link or external-link action to open it.
4. Click the public status in the footer to unpublish.

Publishing creates a public snapshot; it does not grant access to the private
vault. Private blocks are scrubbed from the published surface.

## Chat and direct messages

### Channel messages

1. Open or create a channel.
2. Type in the composer.
3. Press Enter to send; use Shift+Enter for a newline.
4. Add supported attachments or emoji when useful.

Right-click a message to Reply, Ask agent…, Forward, Add to kanban, Report, or
Delete (when permitted). A reply preserves its quoted context and can notify
or not notify the quoted agent. Forwarding copies the message to another
channel with its origin. A report enters the moderation queue, not Product
feedback or the Fizzer tracker.

### Direct messages

Open **Messages** from the vault switcher or community controls and enter a
username. Direct messages are one-to-one linked channels backed by private
per-user DM vaults; they are not shared vaults and cannot be converted into a
shared vault. You can control whether strangers may start DMs and block or
unblock users. Blocking prevents new contact according to the DM policy while
preserving existing history rules.

Use DMs for private coordination. Put decisions the team needs later in a vault
note or channel. DM conversations are included in your Updates counts but are
not listed as ordinary project vaults.

## Local AI agents

### Install, authenticate, and register

Install and authenticate the provider CLI on the computer that will execute the
run. Fizzer does not replace provider login or store provider credentials on the
server. The desktop runner is required for normal local execution; if it is
offline, notes and chat still work but runs wait until a compatible runner
reconnects.

To add an agent:

1. Open a channel and the people/agent panel.
2. Choose **Add agent** or create a new vault agent.
3. Select backend and model, display name, and `@` handle.
4. Set `Cwd`/**Project folder** to a vault root or project path.
5. Add persona/context instructions if useful and save.

A vault agent identity can be reused across channels. Channel membership carries
conversation flags such as **Coordinate this channel**, **Reply to every human
message**, **Other agents**, **Other people**, and **Full host access**. The
coordinator flag makes that registration the channel dispatcher and also keeps
reply-to-human enabled. Keep **Full host access** off unless the local-machine
consequences are understood.

### Mention and run lifecycle

Mention `@agent-handle` to request a response. A run combines the request with
bounded channel/workspace context, starts on the registered owner's local
runner, streams normalized status/tool events, and persists the result back to
the channel. Sessions keep a provider conversation and a watermark so a
follow-up can steer the active session rather than starting a duplicate cold
process. Mission task sessions are task-scoped and do not inherit a worker's
whole channel transcript.

The chat shows queued (`sending`), running, completed, failed, or canceled run
information, plus answer text, reasoning/tool blocks, activity trace, raw
harness output, model/usage statistics, and rate limits when available. Open
Sessions or the activity panel for detail; the short bubble may intentionally
stay compact.

### Orbit limitations

Orbit is not a universal agent monitor. It is a desktop-local view of recently
active **Claude Code and Codex** sessions discovered from their local state
files. Electron scans those files and polls roughly every 750 ms; the hosted
backend route returns an empty graph because it cannot see a desktop filesystem.
Other providers, remote runs, and completed sessions do not appear. Optional
captions use local Ollama (`OLLAMA_URL`, default `http://127.0.0.1:11434`) when
available. Orbit nodes can open the related activity and may append a caption to
a selected note; those captions are separate from the run transcript.

### Android Local Codex

Supported Android builds expose **Local Codex** under account settings. The
bundled native runtime uses a private app `codex-home` and `codex-workspace`,
authenticates with Codex device auth, and can be enabled for foreground runs.
The screen stays awake during login/run activity. It streams Codex JSON output
through the same Fizzer run projection and can be canceled from the app.

Android Local Codex is not the desktop runner: it does not execute arbitrary
provider CLIs, uses its bundled Codex binary, and runs only while Fizzer is in
use. If it is unsupported, unauthenticated, or disabled, the desktop/remote
runner path remains unchanged.

## Missions and durable work

A **mission** is a durable task record projected into a channel's chat. It is
useful for multi-step work, dependencies, delegation, retries, and coordinator
review. The authoritative state machine is
`backend_elixir/lib/cascade/missions/store.ex`.

Mission statuses are exactly:

- **active** — work can be scheduled or is moving;
- **reviewing** — workers have settled and the coordinator should inspect the
  evidence;
- **attention** — a worker failed or a dependency needs intervention;
- **blocked** — the mission is stalled or explicitly retained as blocked;
- **completed** — the coordinator finished it after active workers settled;
- **canceled** — the coordinator stopped it.

Mission tasks have a different status set: **pending**, **running**,
**completed**, **failed**, **blocked**, or **canceled**. Ready pending tasks are
scheduled only when dependencies are completed. A run settling as completed,
failed, or canceled updates its task; a terminal task can be retried to pending
when its prior run is no longer active. A completed mission cannot retain
pending or running workers. Expand **Missions** to inspect assignees, attempts,
dependencies, summaries, and event history.

A coordinator may review worker evidence, retry a task, or finish/cancel the
mission. Worker completion alone does not finish the mission.

### Orchestration flow

The normal flow is:

1. a channel message is persisted through the chat API;
2. a coordinator registration creates or updates a mission and its task records;
3. ready tasks become durable dispatch-outbox entries;
4. a local runner claims a dispatch and starts a provider session;
5. run/session/tool/status events are persisted and projected into chat;
6. task state and its work-item twin are synchronized;
7. dependency completion releases the next task, or the coordinator receives a
   review/attention wake;
8. the coordinator integrates evidence and explicitly completes or cancels the
   mission.

This is durable server state, not a client-only chain of prompts. A reconnect or
renderer reload can recover pending dispatches.

## Kanban, work items, and Git workspaces

### Boards

Open a note and choose Kanban view. If it is not a board, choose **Create
board**. Cards and lists remain Markdown-backed; Fizzer recognizes the
`kanban-plugin: board` marker and list headings. You can add/rename/complete/
delete cards, manage lists, drag cards, search, and archive completed cards.

**Superkanban** is the vault-wide command center. It merges opted-in note boards
and live work-item cards, with filters for board/text and backlog/completed
visibility. A board's **Add to Superkanban** toggle is shown **only when the
vault has more than one Kanban board**. A single board is still usable in its
note's Kanban view. A channel's Project setup may point at a board or create an
internal board only when the user explicitly chooses that control; an
orchestrated channel does **not** automatically create a Kanban board.

### Work items

Choose **Add to kanban** on a message or **New work item** in channel project
tools. A work item is a server-backed addressable record with title, brief,
source, status, assignee/lease, repository, workspace mode, branch, runs,
review evidence, and pull-request information. Mission tasks can have linked
work-item twins; manual and note/kanban work can exist independently.

Set **Project folder** in channel setup to the repository where work belongs. In
the desktop app, project tools can create an isolated Git worktree, bind it to a
work item, inspect branch/commits/dirty/unpushed state, review a diff, open a
draft pull request, and mark the work item done. The worktree bridge is desktop
only; the browser client cannot access local Git worktrees.

A review comment or **Request changes** creates durable review evidence tied to a
snapshot/commit. It does not automatically push, merge, or dispatch another run.

### Managed-agent domain

Managed agents are a separate server control plane for vault-level entitlement,
allowed models, monthly/per-run/included budgets, concurrency, reservations,
execution claims, heartbeats, checkpoints, settlement, and audit rows. The
`Cascade.ManagedAgents` domain does not receive or store a user's provider CLI
credentials. Owners manage the vault entitlement; operators claim and settle
execution against the recorded limits.

## Search, updates, and sessions

- `Cmd/Ctrl+P` opens **Open anything** for note titles/tags and unmatched-note
  creation.
- `Cmd/Ctrl+Shift+F` opens workspace search for notes and chats.

Member search is server-side ranked lexical/QMD search over authorized content;
agent requests use a separate redacted variant. QMD keeps note and chat corpora
under `~/.cascade/qmd` by default and can fall back to lexical ranking when the
worker is unavailable.

**Updates** groups mentions, replies, note changes, channel posts, and unread
counts by vault. Mark a target or all activity read. **Sessions** shows active
runs, elapsed time, output, and cancellation. **Orbit** is the limited desktop
local-session view described above.

## Account, device, and local storage

Account settings contain Profile, Preferences, Security, Local Codex (when the
Android plugin is available), and Current vault management. Provider credentials
remain in native provider stores; do not put API keys in committed `.env` or
ordinary notes.

The browser stores workspace layout, active vault, open tabs, and selected UI
preferences in localStorage keys such as `cascade_session` and
`cascade_chat_state`. Note drafts are kept in memory per vault and are **not**
written to localStorage. Chat transcripts are also not persisted there; they
are reloaded from the server into the in-memory message store after a cold load
or backgrounded mobile webview. On account login, account switching, or logout,
Fizzer clears the persisted workspace pointer and legacy `docs_token` so one
user cannot reopen another user's vault tabs. Clearing browser site data also
clears local layout/history but not server vault content.

## Useful shortcuts

| Shortcut | Action |
| --- | --- |
| `Cmd/Ctrl+P` | Open anything / find notes or create a note |
| `Cmd/Ctrl+Shift+F` | Search notes and chats |
| `Cmd/Ctrl+\\` | Toggle main sidebar |
| `Cmd/Ctrl+N` | Create a note |
| `Cmd/Ctrl+S` | Save active note |
| `Cmd/Ctrl+W` | Close active tab |
| `Cmd/Ctrl+Alt+\\` or `Cmd/Ctrl+Shift+\\` | Split focused pane |
| `Cmd/Ctrl+Enter` in an `{{ai: ...}}` directive | Run the directive |
| `Enter` in chat | Send a message |
| `Shift+Enter` in chat | Insert a newline |
| `Escape` | Close active popup or modal |

Use `Cmd` on macOS and `Ctrl` on Windows/Linux.

## Fizzer Guide conversations and reporting

The floating help button opens the **Fizzer Guide**, which answers from this
maintained manual through a connected local runner. It cannot answer while the
runner is offline.

A **Guide conversation** is a locally saved thread in the current application
or browser profile. It is separate from vault channels and is not shared project
chat:

- **New** starts a separate empty conversation;
- **History** lists local conversations by automatic title and message count;
- selecting one reopens its saved turns;
- trash deletes one; deleting the last leaves a fresh empty conversation.

### Draft and publish a Fizzer tracker issue

In the active Guide conversation, ask naturally to create, open, file, or draft
an issue. The Fizzer Guide uses **only that active Guide conversation**. It does
not include other Guide conversations, vault notes, chats, files, traces,
attachments, workspaces, or repository contents.

Before publication, Fizzer shows an editable public preview of title, body, and
`bug` or `enhancement` label. Review it for private information and accuracy,
then choose **Create issue** once. The destination is fixed: the public **Fizzer
tracker** at `grm4871/fizzer`, never the current vault or project repository.

Creation is desktop-only through the locally installed, authenticated `gh` CLI.
The server does not create it and the Guide does not collect a GitHub token. In
web mode, **Create issue** is disabled and the preview directs you to Fizzer
Desktop and a signed-in `gh`. **Discard** closes the preview without publishing.
A successful desktop creation adds the public issue link to the active Guide
conversation.

### Pick the right reporting path

- **Fizzer tracker issue** — public bug/enhancement at `grm4871/fizzer`, after
  reviewing the editable preview.
- **Product feedback** — private message to the Fizzer server owner. Only the
  feedback text and username are sent; Guide context, vault content, traces,
  and attachments are not included.
- **Trust-and-safety report** — moderation path for a vault, note, message, or
  member that may violate community rules.

These paths are intentionally separate. Product feedback is not a GitHub issue;
a Fizzer tracker issue is not private feedback; neither replaces a
Trust-and-safety report. Canonical terminology is in `docs/CONTEXT.md`.

## Troubleshooting

- **Notes/chat work but agents do not start:** open or reconnect the desktop
  runner and verify the provider CLI is installed and authenticated there.
- **Local Codex is unavailable on Android:** verify the bundled runtime is
  supported, complete device auth, and enable Local Codex in settings.
- **A note is dirty:** save with `Cmd/Ctrl+S` or the mobile Save action.
- **A Kanban board is empty:** choose Create board or ensure the Markdown has
  Kanban frontmatter and `##` list headings.
- **Superkanban does not show a toggle:** the vault has zero or one board; the
  toggle is intentionally available only with more than one.
- **A worktree says Desktop only:** use Fizzer Desktop; browser code cannot
  access local Git.
- **An agent cannot see a private block:** this is intentional redaction. An
  authorized member's own search may still find it.
- **A public vault cannot be joined:** its policy may be Request or Invite only,
  the owner may need to approve, or you may be banned.
- **Activity is stale:** reopen/refresh the relevant surface. Socket rooms do
  not replay missed events; reconnect reconciliation fetches authoritative
  notes, members, and visible transcripts.

## Glossary

- **Vault:** project/community workspace and permission boundary.
- **Note:** durable Markdown document.
- **Channel:** persistent group conversation inside a vault.
- **Agent registration:** configured local provider identity attached to a channel.
- **Runner:** desktop process that starts a local agent CLI.
- **Mission:** durable multi-step work record projected into chat.
- **Mission task:** dependency-aware unit with pending/running/terminal state.
- **Work item:** addressable task record with status, repository, workspace, and review state.
- **Workspace/worktree:** local Git checkout used for an isolated task.
- **Superkanban:** vault-wide view of opted-in boards and live work items.
- **Private block:** `:::private` content redacted from agent/model-derived surfaces.
- **Public snapshot:** published copy of a note open without vault membership.
- **Fizzer Guide:** in-app help answered from this maintained manual.
- **Guide conversation:** local Fizzer Guide thread, separate from vault channels.
- **Fizzer tracker:** public GitHub Issues tracker for Fizzer at `grm4871/fizzer`.
