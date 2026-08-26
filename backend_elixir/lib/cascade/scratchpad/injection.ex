defmodule Cascade.Scratchpad.Injection do
  @moduledoc "Builds bounded boot context from journal status, threads, skills, and policies."
  alias Cascade.Content.{Privacy, Query, Store}
  alias Cascade.Evolution
  alias Cascade.Scratchpad.{Journal, Schema, Skills, Support}
  @policies "POLICIES"
  @default_policies """
  # Scratchpad policies

  These policies are yours to evolve. When experience shows a rule is wrong,
  rewrite it here (note versions keep the audit trail). Keep this note short —
  it is injected into every run's context.

  ## Capture (during work)

  - Jot liberally with `cascade-scratchpad jot` — it is append-only and costs
    nothing to curate later. Do not stop to decide what is "durable".
  - Always jot: dead ends (`--kind dead-end`: what you tried and why it failed),
    surprising observations, decisions and their reasons, outcomes of risky steps.
  - One entry per fact. Plain prose, no formatting required.
  - Short chat runs still count: if you learned something the *next* ping would
    re-derive (a root cause, a fix path, a dead end), jot it before your final
    reply. One `jot` is enough; do not write a report.

  ## Recall (mid-task, when you're stuck)

  - The boot injection is a *guess* at what's relevant, made before you saw the
    problem. When you hit a familiar failure or a task you suspect you've handled
    before, don't re-derive — run `cascade-scratchpad recall <query>` to pull the
    few matching memory notes and skills. Empty results mean "nothing relevant" —
    do not invent a match. Prefer **skills** over auto-captured run dumps.
  - Read the full note/skill (`cascade-note get <title>`) before applying it,
    then report the outcome.

  ## Consolidation (when the boot context says it is due)

  - You do this yourself — no external process will. When the journal backlog is
    flagged as due (or you just finished a multi-step fix worth keeping),
    consolidate after finishing the user's actual task (or delegate it to a
    subagent so it doesn't cost the main thread focus).
  - Read unconsolidated journal entries oldest-first
    (`cascade-scratchpad journal --unconsolidated`); distill durable facts into
    memory notes (`cascade-note memory write/update`). Merge into existing notes
    rather than duplicating; cite source entries as `journal#<id>`.
  - Superseded beliefs: correct the note but keep a line noting what was
    previously believed and why it changed.
  - Session-local noise (progress chatter, one-off details) gets no note —
    marking it consolidated is enough. Forgetting is allowed.
  - Repeatable procedures become **skills**, not prose: if the journal shows the
    same sequence of steps worked twice, write it as a skill
    (`cascade-scratchpad skill write --title T` — first line says when to use
    it, body is the exact commands/steps). Next time, execute the skill instead
    of re-deriving it.
  - Finish by marking entries consolidated: `cascade-scratchpad done --through <id>`.

  ## Outcomes (close the loop)

  - When you apply a remembered note or skill, report how it went:
    `cascade-scratchpad outcome <note-title> --win` (or `--loss`). One command,
    right after you know the result.
  - During consolidation, use the counters: rewrite or retire notes that keep
    losing (several uses, mostly losses); trust and keep ones that keep winning.

  ## Open threads (private intentional trail — agent-owned)

  - Separate from the journal: open threads are what past-you wanted to *continue*,
    not every observation. At most a handful live at once.
  - **You manage them alone.** Users cannot see threads and should not be asked
    about them. Never say "want me to close #N?", never list threads in chat
    unless the user explicitly asks about your scratchpad/threads. Open and
    close silently as part of doing the work.
  - When a run ends unfinished, blocked, or with a clear "next", open a thread:
    `cascade-scratchpad open --text "continue: …" [--blocked "…"] [--next "…"] [--pointer journal#N|path]`.
    Shape the intent as continue/blocked/next so a cold run can act without
    re-reading chat history.
  - Do **not** open a thread for every completed task or for noise. Ruthlessly
    `cascade-scratchpad close <id> [--reason "…"]` when done or abandoned —
    stale threads are worse than none. Decide yourself; do not wait for the user.
  - Boot injects open threads when any exist — for *your* continuity, not as
    something to report. Prefer them over archaeology when the user asks what
    is left or says "continue", then just do the work.

  ## Promotion / demotion

  - INDEX holds one-line pointers, most useful first. Trim pointers that stopped
    earning recall; the notes remain searchable without them.
  - When a note or skill proves useful beyond your own context — it keeps
    winning, or another agent would clearly benefit — share it:
    `cascade-scratchpad promote <note-title>` moves it to the vault-wide agent
    folders every agent sees.
  - Promote a fact into POLICIES itself only if it changes how future runs
    should *behave*, not just what they know.
  """
  def ensure_schema, do: Schema.ensure_schema()

  def ensure_policies(vault_id, user_id, agent_key) do
    folder = Evolution.ensure_agent_named_memory_folders(vault_id, user_id, agent_key).memoryId

    existing =
      Query.one(
        "SELECT id FROM notes WHERE vault_id = ? AND folder_id = ? AND title = ? COLLATE NOCASE",
        [vault_id, folder, @policies]
      )

    if existing do
      nil
    else
      Store.create_note(vault_id, user_id, %{
        title: @policies,
        folder_id: folder,
        is_listed: true,
        content: @default_policies
      })
    end
  end

  def build_injection(vault_id, opts \\ []) do
    max_chars = opts |> Keyword.get(:max_chars, 1_600) |> Support.bounded(300, 4_000)
    key = Support.normalize_agent_key(Keyword.get(opts, :agent_key, ""))
    current = Journal.status(vault_id, key)

    lines = [
      "Scratchpad is optional persistent memory. Use `cascade-scratchpad jot` only for a reusable root cause, decision, or dead end; skip routine progress and simple Q&A. Use `recall <query>` only when the task looks familiar. Open threads are private: manage them yourself and never ask the user about them.",
      "Journal: #{current.unconsolidated} unconsolidated #{if current.unconsolidated == 1, do: "entry", else: "entries"}#{if current.lastConsolidationAt, do: "; last consolidation #{current.lastConsolidationAt}", else: ""}; open threads: #{current.openThreads}."
    ]

    lines =
      if consolidation_due?(current),
        do:
          lines ++
            ["Consolidation is due, but do not spend this chat run on it unless the user asks."],
        else: lines

    lines = append_thread_injection(lines, vault_id, key, current.openThreads)

    lines =
      if Keyword.has_key?(opts, :user_id) do
        skills = Skills.list_skill_notes(Keyword.fetch!(opts, :user_id), vault_id, key) |> Enum.take(8)

        if skills == [],
          do: lines,
          else:
            lines ++
              [
                "Skills (read the full note with `cascade-note get <title>` before applying):\n" <>
                  Enum.map_join(skills, "\n", &skill_line/1)
              ]
      else
        lines
      end

    append_policies(lines, vault_id, key, max_chars)
  end

  defp append_thread_injection(lines, vault_id, key, open_count) do
    limit =
      min(
        Support.env_int("SCRATCHPAD_BOOT_OPEN_THREADS", 5, 1, 20),
        Support.env_int("SCRATCHPAD_MAX_OPEN_THREADS", 7, 1, 20)
      )

    filter = if key == "", do: "", else: "AND agent_key = ?"
    params = if key == "", do: [vault_id, limit], else: [vault_id, key, limit]

    rows =
      Query.all(
        "SELECT * FROM agent_open_threads WHERE vault_id = ? #{filter} AND closed_at IS NULL ORDER BY id DESC LIMIT ?",
        params
      )
      |> Enum.map(&open_thread/1)

    if rows == [] do
      lines
    else
      more =
        if open_count > length(rows),
          do: " (+#{open_count - length(rows)} more — cascade-scratchpad open)",
          else: ""

      body = Enum.map_join(rows, "\n", fn thread -> "  - " <> thread_line(thread) end)

      lines ++
        [
          "Your open threads#{more} (private — continue or close yourself; do not ask the user; stale is worse than empty):\n#{body}"
        ]
    end
  end

  defp append_policies(lines, vault_id, key, max_chars) do
    rows =
      Query.maps(
        "SELECT n.id, n.content, f.parent_id FROM notes n JOIN folders f ON f.id = n.folder_id WHERE n.vault_id = ? AND n.title = ? COLLATE NOCASE AND f.name = 'memory' COLLATE NOCASE",
        [vault_id, @policies],
        [:id, :content, :parent_id]
      )

    note =
      cond do
        rows == [] ->
          nil

        length(rows) == 1 or key == "" ->
          hd(rows)

        true ->
          parent =
            Query.map(
              "SELECT id FROM folders WHERE vault_id = ? AND name = ? COLLATE NOCASE",
              [vault_id, key],
              [:id]
            )

          Enum.find(rows, &(&1.parent_id == (parent && parent.id))) || hd(rows)
      end

    if note do
      body =
        note.content |> Privacy.redact_blocks() |> String.replace(~r/\s+/u, " ") |> String.trim()

      budget = max_chars - String.length(Enum.join(lines, "\n")) - 24

      if budget > 120,
        do: Enum.join(lines ++ ["Your POLICIES note: #{String.slice(body, 0, budget)}"], "\n"),
        else: Enum.join(lines, "\n")
    else
      Enum.join(lines, "\n")
    end
  end

  defp consolidation_due?(current) do
    cond do
      current.unconsolidated == 0 ->
        false

      current.unconsolidated >= Support.env_int("SCRATCHPAD_DUE_ENTRIES", 3, 1, 2_147_483_647) ->
        true

      current.oldestUnconsolidatedAt ->
        case NaiveDateTime.from_iso8601(current.oldestUnconsolidatedAt) do
          {:ok, oldest} ->
            NaiveDateTime.diff(NaiveDateTime.utc_now(), oldest, :hour) >=
              Support.env_int("SCRATCHPAD_DUE_AGE_HOURS", 24, 1, 2_147_483_647)

          _ ->
            false
        end

      true ->
        false
    end
  end

  defp thread_line(thread) do
    [
      "##{thread.id} #{thread.intent}",
      if(thread.blockedOn != "", do: "blocked: #{thread.blockedOn}"),
      if(thread.nextTry != "", do: "next: #{thread.nextTry}"),
      if(thread.pointer != "", do: "ptr: #{thread.pointer}")
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join(" | ")
  end
  defp skill_line(skill) do
    record = Support.format_win_record(Map.get(skill, :stats))

    "  - [[#{skill.title}]]#{if skill.shared, do: " [shared]", else: ""} — #{skill.description}#{if record == "", do: "", else: " (#{record})"}"
  end

  defp open_thread([id, vault_id, agent_key, intent, blocked_on, next_try, pointer, run_id, created_at, updated_at, closed_at, close_reason]) do
    %{id: id, vaultId: vault_id, agentKey: agent_key, intent: intent, blockedOn: blocked_on, nextTry: next_try, pointer: pointer, runId: run_id, createdAt: created_at, updatedAt: updated_at, closedAt: closed_at, closeReason: close_reason}
  end
end
