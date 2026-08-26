defmodule Cascade.Scratchpad.Threads do
  @moduledoc "Private open-thread lifecycle with bounded fields and per-agent limits."
  alias Cascade.Content.{Query, Store}
  alias Cascade.Scratchpad.{Schema, Support}
  @max_thread_field 500
  def ensure_schema, do: Schema.ensure_schema()

  def list_open_threads(user_id, vault_id, opts \\ []) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    key = Support.normalize_agent_key(Keyword.get(opts, :agent_key, ""))
    limit = opts |> Keyword.get(:limit, 50) |> Support.bounded(1, 200)

    {clauses, params} =
      [{"vault_id = ?", vault.id}]
      |> Support.maybe_clause(key != "", "agent_key = ?", key)
      |> Support.maybe_clause(not Keyword.get(opts, :include_closed, false), "closed_at IS NULL", nil)
      |> Enum.unzip()

    params = Enum.reject(params, &is_nil/1)

    Query.all(
      "SELECT * FROM agent_open_threads WHERE #{Enum.join(clauses, " AND ")} ORDER BY CASE WHEN closed_at IS NULL THEN 0 ELSE 1 END, id DESC LIMIT ?",
      params ++ [limit]
    )
    |> Enum.map(&open_thread/1)
  end

  def open_thread(user_id, vault_id, input) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    key = Support.normalize_agent_key(Support.value(input, :agent_key, ""))
    intent = clip_thread(Support.value(input, :intent, ""), "intent", true)
    blocked = clip_thread(Support.value(input, :blocked_on, ""), "blockedOn")
    next_try = clip_thread(Support.value(input, :next_try, ""), "nextTry")
    pointer = clip_thread(Support.value(input, :pointer, ""), "pointer")

    [open_count] =
      Query.one(
        "SELECT COUNT(*) FROM agent_open_threads WHERE vault_id = ? AND agent_key = ? AND closed_at IS NULL",
        [vault.id, key]
      )

    max_open = Support.env_int("SCRATCHPAD_MAX_OPEN_THREADS", 7, 1, 20)

    if open_count >= max_open do
      raise ArgumentError,
            "already have #{open_count} open threads (max #{max_open}); close one first with cascade-scratchpad close <id>"
    end

    Query.execute(
      "INSERT INTO agent_open_threads (vault_id, agent_key, intent, blocked_on, next_try, pointer, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        vault.id,
        key,
        intent,
        blocked,
        next_try,
        pointer,
        Support.positive_number(Support.value(input, :run_id, nil))
      ]
    )

    [id] = Query.one("SELECT last_insert_rowid()")
    open_thread(Query.one("SELECT * FROM agent_open_threads WHERE id = ?", [id]))
  end

  def close_open_thread(user_id, vault_id, opts) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")

    thread_id =
      Support.positive_number(Keyword.get(opts, :thread_id)) ||
        raise(ArgumentError, "threadId is required")

    key = Support.normalize_agent_key(Keyword.get(opts, :agent_key, ""))

    row =
      Query.one("SELECT * FROM agent_open_threads WHERE id = ? AND vault_id = ?", [
        thread_id,
        vault.id
      ])

    if is_nil(row), do: raise(ArgumentError, "open thread ##{thread_id} not found")
    thread = open_thread(row)

    if key != "" and thread.agentKey != "" and thread.agentKey != key do
      raise ArgumentError, "open thread ##{thread_id} belongs to @#{thread.agentKey}, not @#{key}"
    end

    if thread.closedAt do
      thread
    else
      reason = clip_thread(Keyword.get(opts, :reason, ""), "reason")
      reason = if reason == "", do: "closed", else: reason

      Query.execute(
        "UPDATE agent_open_threads SET closed_at = datetime('now'), close_reason = ?, updated_at = datetime('now') WHERE id = ?",
        [reason, thread_id]
      )

      Query.one("SELECT * FROM agent_open_threads WHERE id = ?", [thread_id]) |> open_thread()
    end
  end
  defp open_thread([
         id,
         vault_id,
         agent_key,
         intent,
         blocked_on,
         next_try,
         pointer,
         run_id,
         created_at,
         updated_at,
         closed_at,
         close_reason
       ]) do
    %{
      id: id,
      vaultId: vault_id,
      agentKey: agent_key,
      intent: intent,
      blockedOn: blocked_on || "",
      nextTry: next_try || "",
      pointer: pointer || "",
      runId: run_id,
      createdAt: created_at,
      updatedAt: updated_at,
      closedAt: closed_at,
      closeReason: close_reason
    }
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
  defp clip_thread(value, label, required \\ false) do
    text = value |> to_string() |> String.trim() |> String.slice(0, @max_thread_field)
    if required and text == "", do: raise(ArgumentError, "#{label} is required"), else: text
  end
end
