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

## Prompt and context layers

A chat run may combine:

1. a short agent/channel instruction;
2. the current user request;
3. current workspace ancestry and project context;
4. recent channel messages on a cold start;
5. bounded memory and scratchpad recall for cold starts.

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
