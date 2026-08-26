# Agent runtime

This page describes the implemented desktop-runner path. It is intentionally
specific about trust boundaries and provider quirks. **Invariant** means a
property enforced by the current code. **Risk** means an operational or
privacy consequence that the code does not remove.

## Topology and trust boundaries

A run is created by the authenticated Elixir API, but the provider process runs
on the desktop that owns the run:

```text
browser / client
    ├─ HTTPS API → create/cancel run and read owner-scoped data
    └─ Chromium Socket.IO /runners → register desktop, receive delegation,
                                    send run events
                         │
                         └─ Electron main via IPC → local CLI/provider process
```

The `/runners` Socket.IO connection lives in the Chromium renderer because its
network stack is more reliable on some networks. Electron main owns the child
process and its event buffer; it does not own that socket. The renderer uses
Socket.IO polling with upgrade disabled. A renderer reload therefore must not
be treated as a process cancellation.

`runner:setToken` configures main-process helper state only. Electron accepts an
API URL only when it has the same origin selected at desktop startup. For a
remote HTTPS API, main starts a loopback HTTP proxy and Electron
`net.fetch` re-issues helper requests upstream; only an allowlist of request
headers (`authorization`, content type, request id, and run id) crosses that
proxy. The proxy is a transport workaround, not an additional authentication
boundary.

The `agent:start` IPC method is a local renderer-to-main boundary. Main validates
that a run id, agent, and prompt are present, but it does not independently ask
the server whether the payload is authorized. Server delegation and event
acceptance are the authorization boundaries: the server sends `run:delegate`
to the registered owner runner, records that owner, and accepts
`runner:runEvent` only when the authenticated runner owns that delegated run.

## Authentication and ownership

The normal user JWT is valid for seven days. The separate token returned by
`POST /api/auth/agent-token` has an `access: "agent"` claim and a **12-hour
expiration**. Both tokens are HS256-signed and checked against the current user
and `authVersion`; logout/password security changes can revoke a token through
that version. The agent token is intended for `cascade-note`, `cascade-chat`,
and related helper API calls, not for sharing provider credentials with the
server.

The general `CascadeWeb.Auth` boundary restricts agent access to an explicit
route allowlist and rejects user-only operations for an agent token. Agent JSON
responses are recursively sanitized: private blocks and private note previews
are redacted. The orchestration controller currently calls
`Session.authenticate/1` directly, so do not assume the generic agent-route
allowlist is applied to every `/api/runs` method. Run reads and cancellation
still have an independent owner check: `GET /api/runs/:id`,
`GET /api/runs/:id/events`, and cancel return no run to a different user.

**Invariant:** raw run events and the `/runs` realtime room are owner-only.
`joinRun` checks `runs.owner_user_id`; the HTTP events endpoint uses the same
check. A runner may submit events only for the owner recorded in
`delegated_runs`. A vault member is not thereby entitled to raw provider
output, prompts, tool results, or terminal bytes.

Chat is a separate projection. Text, tool blocks, status, and a bounded harness
log are folded into the agent's chat message and emitted on the source chat
channel. Shared-channel users who can read that channel can see this folded
projection, even though they cannot read the raw run-events endpoint. The
projection is written through an agent-scoped message update using the owner's
route, so a cross-user ping replies in the owner's local channel projection.

## Run and session lifecycle

A `conversation_id` is Cascade's stable grouping key for one chat-agent
registration. A `session_id` is a provider-owned id (Codex thread, Claude
session, Hermes session, and so on). Cascade looks up the latest provider
session by vault, note, agent, and conversation, then supplies it as a resume
id where that provider supports resume.

Provider session ids are not guaranteed to appear only at completion. Adapters
emit `session` as soon as a provider reports an id (for example Claude's early
stream messages or Codex `thread.started`), and the server persists each such
id immediately. A failed run may therefore have a resumable provider id, while
an adapter that never reports one has none.

The normal lifecycle is:

1. The API creates a queued run and stores the effective prompt, owner,
   conversation, and optional prior session.
2. The owner desktop receives a delegation, starts its local provider, and
   emits `status: running` followed by provider/text/tool/harness events.
3. `session` events update `runs.session_id`; terminal status updates the run,
   clears its delegated-run ownership, and is also appended to the event log.
4. Each persisted event is eligible for chat folding. Folding is incremental
   by sequence number and rebuilds from the full log if it detects a gap.

Chat provider sessions remain continuous until the user explicitly clears one.
There is **no implemented `CHAT_SESSION_MAX_RUNS` or
`CHAT_SESSION_MAX_AGE_HOURS` rotation**. Those names are not runtime knobs;
manual `/clear` (or `/reset`) in chat changes the registration's
`conversation_id` and leaves old chat history intact. Provider-side compaction
may still occur according to the provider CLI.

A follow-up turn is serialized per registration/client watermark. A pending
steer cancels the active turn before asking the provider to resume it; an
ordinary next turn waits for the prior turn to settle. Codex additionally
serializes writes per resumed thread because its app-server permits one active
writer.

### Missions and retry

A mission and its `chat_mission_tasks` are authoritative durable records;
`chat_mission_events` is append-only history. Retrying a terminal task is not a
new task: it sets the current task back to `pending`, replaces its current
summary with the supplied retry summary (possibly empty), clears its current
`dispatch_id` and `run_id`, and increments `attempt`. The old dispatch/run
association is therefore reset for scheduling, while `chat_mission_events`
retains the prior transitions, summaries, run ids, and attempts. A retry is
rejected while the task or its run is still active.

## Prompt, workspace, and media inputs

On a cold/default start, prompt assembly can include the app instruction, the
current request, workspace ancestry/project context, recent channel activity,
and bounded agent memory/scratchpad recall. A resumed provider receives the new
request rather than another copy of the full prior transcript. The chat context
uses a message cursor and can direct the provider to `cascade-chat history` or
`cascade-chat search` when more room context is needed. Private blocks are
redacted after context assembly, immediately before delegation.

`cwd` is normalized and then resolved on the owner desktop. An empty value or
`root`/`vault root` means no override; an existing requested directory wins,
then the vault root, then the owner's home directory. For an owner-owned
channel, the channel's authoritative cwd can override the registration cwd. An
isolated work item can override both with its prepared worktree; preparation
fails if an isolated task has no repository directory. A requester cannot use a
shared projection to redirect execution to their own cwd.

### Owner, ping, and yolo gates

For a registered chat agent, execution is resolved through the agent owner's
vault/channel projection. The person sending the ping is not automatically the
execution owner. A ping is accepted when the requester is the agent owner or
the registration has `pingableByOthers`; otherwise the API returns 403. The
owner's runner, owner memory key, owner channel cwd, and owner work-item
workspace are used for the run.

`yolo` is not a requester-controlled privilege for a shared registration:
effective yolo is `registration.yolo AND requester_is_owner`. A non-owner may
ping a pingable agent, but cannot turn on its dangerous mode. Direct runs
created for the authenticated user can request yolo themselves. The provider
table below describes what each adapter does with that effective flag; some
adapters (Copilot, Akron, OMP, and Pi) pass permissive provider flags
unconditionally.

The server accepts only image objects with string MIME/data fields and keeps the
first **eight**. Images are written to short-lived desktop temp files for
Codex, OMP, and Pi; Claude receives structured base64 image blocks. Grok,
Hermes, Copilot, Akron, and Antigravity have no adapter image argument. Inline
SVGs in prompts are rendered to temporary PNG attachments where possible, and
replaced in prompt text by a source-path notice; failed rendering leaves the
SVG text in the prompt.

**Risk — prompt persistence:** the effective prompt is stored in `runs.prompt`
(up to two million characters) and is sent in the delegation payload. It can
include user text, app context, memory, scratchpad excerpts, and channel
context. Redaction removes recognized private blocks; it is not a general
secret detector. Do not put credentials in prompts, and remember that a
provider/tool may echo prompt material into harness output or a chat projection.

## Provider adapters and safety posture

All provider binaries are local to the owning desktop. Binary names can be
changed with the `*_BIN` settings in `.env`; provider login state is not copied
to the server.

| Adapter | Implemented invocation and session behavior | Approval, sandbox, and network behavior |
| --- | --- | --- |
| Claude Code | `claude --print --verbose --output-format stream-json --include-partial-messages`; resumes with `--resume`. Emits streamed thinking/text/tool blocks and early session ids. A no-startup-event window is 45 seconds and retries once. A missing local resumed session is discarded and retried fresh. | Default permission mode is `acceptEdits`; `yolo` selects `bypassPermissions` plus `--allow-dangerously-skip-permissions`. Only the helper commands are supplied in `--allowedTools`. No Cascade sandbox or network flag is added. |
| Copilot | `copilot -p ... --output-format json --yolo`; resumed runs pass `--session-id`. JSONL reasoning, text, tools, and results are normalized. | The adapter always passes `--yolo`, regardless of the registration's yolo flag. No Cascade sandbox or network flag is passed; the exact scope is the installed Copilot CLI's behavior. |
| Grok | `grok --single --output-format streaming-json --always-approve --cwd ...`; can pass `--resume`. Thought/text/end JSON is normalized; provider tools are not surfaced in its stream. | The adapter always approves (`--always-approve`). No Cascade sandbox, network, or image option is passed. |
| Antigravity | Uses local `agentapi`, then polls the owner's `transcript.jsonl`; fresh runs use `new-conversation`, resumed runs use `send-message`. Only `flash_lite`, `flash`, and `pro` tiers are sent; configured model labels are mapped to those tiers. | The project config is patched for allowed file access, eager command execution, and turbo artifact review; cwd and `.env` read/write grants plus common command grants are added. `yolo` additionally allows the Antigravity internet policy. A language-server address and CSRF token are required. |
| Copilot | `copilot -p ... --output-format json --yolo`; resumed runs pass `--session-id`. JSONL reasoning, text, tools, and results are normalized. | The adapter always passes `--yolo`, regardless of the registration's yolo flag. No Cascade sandbox or network flag is passed. Treat the local Copilot CLI's own posture as unrestricted. |
| Hermes | `hermes chat -Q -q`, with optional profile, model, `--resume`, `--yolo`, and `--safe-mode`. Final answer is stdout; session id and optional Cascade NDJSON reasoning are stderr. No-output startup can retry twice with a fresh bridge. A provider-only 503/unavailable response is retried with bounded backoff (configured retry budget defaults to 50). | Safety is delegated to Hermes: Cascade only forwards `--yolo` and `--safe-mode`; it does not add a sandbox or network policy. |
| Akron Grok | Native Akron `--grok -z --yolo` oneshot. It intentionally does not claim resume support; fresh channel context is supplied each time. A no-byte provider bridge can be retried once. | `--yolo` is unconditional. No Cascade sandbox, network, or image option is passed. |
| OMP | JSON mode with `--allow-home`, optional `--model`, and temp-image `@path` arguments; resume is passed as `--resume` when present. | `--allow-home` is unconditional. No separate Cascade approval, sandbox, or network flag is passed. |
| Pi | JSON mode with `--approve`, optional `--session`, `--model`, and temp-image `@path` arguments. | `--approve` is unconditional. No separate Cascade sandbox or network flag is passed. |

The table describes adapter behavior, not a guarantee that a provider will
honor every flag in every installed CLI version. `RUNNER_CLI_TIMEOUT` is not a
wall-clock cap: it is a compatibility override for the shared inactivity
watchdog. The timer resets on every stdout/stderr chunk and kills only after a
quiet interval. `RUNNER_CLI_IDLE_TIMEOUT` is the preferred name. Hermes and
Akron also have provider-specific inactivity bounds because their bridges can
hold a request open before producing a byte.

## Event protocol and projection

The durable `run_events` table stores a per-run sequence, type, JSON payload,
and timestamp. Typical types are:

- `status`: running, completed, failed, or canceled;
- `session`: a provider session id;
- `text`: assistant text, thinking, redacted-thinking, and tool-use blocks;
- `user`: provider/tool results represented as user-side messages;
- `harness`: raw terminal/provider trace chunks.

Adapters may also forward provider `result` or `system` records as raw events;
the chat fold intentionally ignores types it does not understand. A malformed
JSON payload is skipped by the fold without stopping later events.

`cascade-stats` is **not** a run-event type and is not a separate telemetry
record. Adapters write a machine-readable `# cascade-stats {JSON}` line inside
a `harness` chunk. The client parses that harness text, merges successive
non-null fields, and uses it for model/token/context/rate-limit chips. The
server does not give it special event semantics.

The client receives structured events for chat blocks and retains a raw
read-only harness terminal. The server folds `text`, `user`, `harness`, and
terminal `status` into the cross-user chat message. Harness retention is a
**512,000-character (~512 KB) tail**: when the projection exceeds that size,
older terminal output is discarded. Structured blocks and the final body are
separate from this tail and may still contain echoed provider content.

Parser behavior is intentionally provider-specific:

- shared JSONL drivers ignore one malformed line and flush a trailing partial
  line; a successful process with no parseable answer can complete with an
  empty summary, which causes an empty completed chat shell to be removed;
- Copilot falls back to treating a non-JSON line as answer text;
- Antigravity skips malformed transcript lines and drops planner-only/empty
  summaries rather than inventing a reply;
- Hermes accepts ordinary stdout lines as answer text, while malformed stderr
  events are ignored;
- an `agentapi` response that is not valid JSON or has no conversation id is a
  run failure, not an empty success.

A nonzero process exit is failed with a bounded diagnostic. Tool results are
truncated to 8,000 characters in structured blocks; harness output is retained
as the tail described above.

## Helpers and their credentials

The desktop installs wrappers for `cascade-note`, `cascade-chat`, and
`cascade-scratchpad` on the child PATH. It prefers the checked-out
`cli-agents` helper sources (or packaged dist), creates user-bin wrappers when
possible, and adds conventional per-user executable directories such as
`~/.local/bin` and `~/.bun/bin`.

For each run, main writes a `0600` JSON helper context under
`~/.cascade/run-contexts/<run-id>.json` in a `0700` directory. It contains the
live API URL, restricted bearer token, vault/channel/message identity,
registration, agent-memory key, and work-item/run identifiers. Concurrent runs
use different files so one agent cannot overwrite another run's author context;
the file is removed during runner cleanup. A legacy shared context file is used
only when no positive run id is available.

The helper token can be supplied as `CASCADE_NOTE_TOKEN`; for manual helper
use, `CASCADE_NOTE_USER` plus `CASCADE_NOTE_PASS` performs a login fallback.
Configured desktop runs clear the old user/password variables. Helpers send the
bearer token and (when present) `x-cascade-run-id`; they do not receive a
provider API key from the server.

`cascade-note` command names matter: the top-level note reader is
`cascade-note get <id|title>`. `read` is only a subcommand under memory:
`cascade-note memory read <id|title>`. Memory notes are agent-scoped scratchpad
notes, not the normal live-note list. `cascade-note` edits the live indexed API
record; ordinary filesystem edits in the provider cwd do not update the app's
note index. `cascade-chat attachment` writes an attachment to a local path
before an agent inspects it.

## Runner recovery and cancellation

Electron main keeps active run ownership and up to 4,000 bridge events in memory.
Each event has a main-process `bridgeSeq`; renderer reload recovery asks main for
active ids and buffered events. The renderer persists a cursor keyed by the
main `instanceId`, registers the runner first, then replays buffered events so
the server has re-established ownership before accepting terminal events. It
also retains terminal events for five minutes for reconnect replay.

On Linux, Hermes-family process groups carry a random lease token and a durable
lease file. A new runner process can verify the owner PID start time and token,
kill descendants left by a crashed Electron process, and remove stale leases.
This reclaim mechanism avoids killing an unrelated process after PID reuse.

The server's runner lifecycle gives a reconnecting desktop a 120-second orphan
reclaim window. Registration reports active run ids; only ids delegated to that
user are reclaimed. A changed desktop `runnerInstanceId` causes omitted open
runs from the previous instance to be failed, while a same-instance reconnect
can continue them. If the server restarts and the owner does not reclaim an
open delegated run before the window expires, it is failed as an orphan.

Cancellation is ordered but has a narrow race:

1. The server resolves the delegated owner and asks that desktop to cancel.
2. The desktop kills the provider (and, for grouped launchers, its process
   group), waits for child close/runner cleanup, then acknowledges.
3. The server persists and publishes canceled status; a steering cancel uses a
   continuation summary and lets the next turn resume the provider session.

A force cancel is intentionally fire-and-forget at the server edge (it emits a
short acknowledgement request and persists cancellation without waiting for
it). A normal cancel may fail while the owner is online but does not acknowledge
stopping. In Electron, the child registry can be cleared immediately before
its run promise settles; the cancellation acknowledgement waits briefly for
that promise so this cleanup race is not reported as a false failure. Late
provider output can still race a cancel request; terminal state and ordered
persistence prevent a second terminal transition, but cancellation is not a
transaction with the external provider.

## Configuration summary

The root `.env.example` lists only settings read by the current desktop/server
path. Provider binaries, Claude effort/model, Codex persistence, and the shared
inactivity compatibility override are local-desktop settings. There are no
implemented chat-session age/run rotation settings; remove any old
`CHAT_SESSION_MAX_RUNS` or `CHAT_SESSION_MAX_AGE_HOURS` entries rather than
expecting them to change behavior.
