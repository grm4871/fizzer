# Agent runtime

## Supported adapters

The shared agent adapter is `cli-agents/cli-agent.ts`. Current agent IDs include
Claude Code, Codex, Grok, Antigravity, Copilot, Hermes, Akron Grok, and OMP.
Available models may be supplemented by a live capability probe from the
desktop.

Provider credentials are not stored on the Cascade server. Authentication is
owned by the local CLI or provider SDK on the desktop that executes the run.

## Chat run lifecycle

Chat agent registrations have a stable Cascade conversation ID. The server maps
that conversation to a provider session ID when the provider supports resume.

These IDs are deliberately distinct:

- `conversation_id` groups Cascade runs for one registered chat agent;
- `session_id` is the backing provider/CLI session returned by a completed run.

Follow-up steering is serialized per registered agent conversation. A second
top-level prompt waits for the active turn to settle so the server can persist
its provider session ID before the next run resumes it.

Backing chat sessions remain continuous by default so the provider harness can
compact them just as it does in the direct CLI. Optional rotation bounds are
documented in `.env.example`:

```text
CHAT_SESSION_MAX_RUNS=0
CHAT_SESSION_MAX_AGE_HOURS=0
```

A rotation retains the Cascade conversation ID and injects bounded recent
channel context into the new provider session.

## Event protocol

Providers normalize their output into run events such as:

- `status` — queued, running, completed, failed, or canceled;
- `text` — response, reasoning, and tool-use blocks;
- `user` — tool results represented as user-side provider messages;
- `harness` — raw terminal trace;
- `cascade-stats` — model, token, context, turn, and rate-limit telemetry.

`client/src/chat/runBlocks.ts` and the server-side folding helpers in
`server/chat.ts` convert this event stream into persisted chat content. The
session manager exposes readable activity and a separate raw console view.

## Agent helpers

Agent subprocesses receive these commands on `PATH`:

- `cascade-note` — list, read, create, edit, move, and find live notes;
- `cascade-chat` — inspect channel history, open attachments, and send messages;
- `cascade-scratchpad` — store and recall durable agent knowledge.

Run each command with `--help` for its current interface. Helpers use a
restricted token and scoped environment supplied by the desktop runner.

Use scratchpad storage only for durable causes, decisions, and dead ends.
Routine progress belongs in the run trace.

## Chat-first orchestration

A channel may designate one registered agent as its coordinator. This is a
membership setting, not a separate project-management surface:

- ordinary human messages route to the coordinator;
- an explicit `@specialist` mention takes the direct zero-hop path instead;
- the coordinator answers small requests itself;
- for parallel or long work it creates a mission and delegates focused tasks
  to other registered channel agents.

The provider session remains the reasoning and execution environment. Cascade
only supplies the durable coordination substrate through `cascade-chat`:

```text
cascade-chat members
cascade-chat mission start --title "..." --objective "..."
cascade-chat mission delegate --mission <id> --to @agent --task "..." --message "..."
cascade-chat mission status --mission <id>
cascade-chat mission finish --mission <id> --summary "..."
```

`chat_missions` and `chat_mission_tasks` are authoritative. A compact mission
projection is materialized on the root chat message so it arrives in the normal
transcript, Socket.IO updates, linked multiplayer channels, and reloads without
a second client-owned task store. Worker terminal events update their task. The
coordinator wakes once after all workers settle, reviews and integrates their
evidence, and explicitly finishes the mission; worker completion alone puts a
mission in `reviewing`, not `completed`.

Chat-to-agent intent is also an outbox (`chat_agent_dispatches`). Message and
target survive renderer reloads and reconnects, and a unique run key ensures
multiple clients recovering the same dispatch still launch only one provider
process. Explicit mission delegation is the permission boundary that lets a
coordinator call a worker which has disabled ordinary agent-to-agent mentions.
Shared-channel users can only launch registrations whose owner enabled
multiplayer pings.

## Prompt and context layers

A chat run may combine:

1. a short agent/channel instruction;
2. the current user request;
3. current workspace ancestry and project context;
4. recent channel messages on a cold start;
5. bounded memory and scratchpad recall for cold starts.

Every agent path also receives a shared chat-brevity rule from
`formatAgentChatPrompt` / `CHAT_REPLY_BREVITY`: the final bubble stays short
(outcome first; no process essay). Verification and intermediate detail belong
in the run trace. Coordinators keep mission finish summaries short as well.

Stable application capability context is not re-sent to a resumed session.
Private note blocks are redacted after all context assembly and immediately
before delegation.

## Cancellation and recovery

Cancellation is routed to the owning desktop and then persisted server-side.
Run events and linked chat messages are settled even when the initiating client
is no longer connected.

Brief runner disconnects receive a grace period. After a server restart, the
desktop reports active run IDs so ownership can be reclaimed before orphaned
runs are failed.
