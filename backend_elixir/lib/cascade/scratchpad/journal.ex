defmodule Cascade.Scratchpad.Journal do
  @moduledoc "Append-only journal operations and consolidation status."
  alias Cascade.Content.{Query, Store}
  alias Cascade.Scratchpad.{Schema, Support}
  @journal_kinds ~w(observation outcome dead-end decision todo papercut)
  @max_body_chars 4_000
  def ensure_schema, do: Schema.ensure_schema()

  def append_journal_entry(user_id, vault_id, input) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")

    body =
      input
      |> Support.value(:body, "")
      |> to_string()
      |> String.trim()
      |> String.slice(0, @max_body_chars)

    if body == "", do: raise(ArgumentError, "Journal entry body is required")
    raw_kind = input |> Support.value(:kind, "") |> to_string()
    kind = if raw_kind in @journal_kinds, do: raw_kind, else: "observation"
    run_id = Support.positive_number(Support.value(input, :run_id, nil))

    Query.execute(
      "INSERT INTO agent_journal (vault_id, agent_key, run_id, kind, body) VALUES (?, ?, ?, ?, ?)",
      [vault.id, Support.normalize_agent_key(Support.value(input, :agent_key, "")), run_id, kind, body]
    )

    [id] = Query.one("SELECT last_insert_rowid()")
    journal_entry(Query.one("SELECT * FROM agent_journal WHERE id = ?", [id]))
  end

  def list_journal_entries(user_id, vault_id, opts \\ []) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    limit = opts |> Keyword.get(:limit, 100) |> Support.bounded(1, 500)
    key = Support.normalize_agent_key(Keyword.get(opts, :agent_key, ""))

    {clauses, params} =
      [{"vault_id = ?", vault.id}]
      |> Support.maybe_clause(key != "", "agent_key = ?", key)
      |> Support.maybe_clause(
        Keyword.get(opts, :unconsolidated_only, false),
        "consolidated_at IS NULL",
        nil
      )
      |> Support.maybe_clause(
        Support.positive_number(Keyword.get(opts, :since_id)) != nil,
        "id > ?",
        Support.positive_number(Keyword.get(opts, :since_id))
      )
      |> Enum.unzip()

    params = Enum.reject(params, &is_nil/1)

    Query.all(
      "SELECT * FROM agent_journal WHERE #{Enum.join(clauses, " AND ")} ORDER BY id ASC LIMIT ?",
      params ++ [limit]
    )
    |> Enum.map(&journal_entry/1)
  end

  def mark_journal_consolidated(user_id, vault_id, opts) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")

    through_id =
      Support.positive_number(Keyword.get(opts, :through_id)) ||
        raise(ArgumentError, "throughId is required")

    key = Support.normalize_agent_key(Keyword.get(opts, :agent_key, ""))

    {sql, params} =
      if key == "" do
        {"UPDATE agent_journal SET consolidated_at = datetime('now') WHERE vault_id = ? AND id <= ? AND consolidated_at IS NULL",
         [vault.id, through_id]}
      else
        {"UPDATE agent_journal SET consolidated_at = datetime('now') WHERE vault_id = ? AND agent_key = ? AND id <= ? AND consolidated_at IS NULL",
         [vault.id, key, through_id]}
      end

    result = Query.execute(sql, params)

    Query.execute(
      """
      INSERT INTO scratchpad_state (vault_id, agent_key, last_consolidation_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(vault_id, agent_key) DO UPDATE SET last_consolidation_at = datetime('now')
      """,
      [vault.id, key]
    )

    result.num_rows
  end

  def status(vault_id, agent_key \\ nil) do
    ensure_schema()
    key = Support.normalize_agent_key(agent_key)
    filter = if key == "", do: "", else: "AND agent_key = ?"
    params = if key == "", do: [vault_id], else: [vault_id, key]

    [count, oldest] =
      Query.one(
        "SELECT COUNT(*), MIN(created_at) FROM agent_journal WHERE vault_id = ? #{filter} AND consolidated_at IS NULL",
        params
      )

    state =
      Query.one(
        "SELECT last_consolidation_at FROM scratchpad_state WHERE vault_id = ? AND agent_key = ?",
        [vault_id, key]
      )

    [open] =
      Query.one(
        "SELECT COUNT(*) FROM agent_open_threads WHERE vault_id = ? #{filter} AND closed_at IS NULL",
        params
      )

    %{
      agentKey: key,
      unconsolidated: count || 0,
      oldestUnconsolidatedAt: oldest,
      lastConsolidationAt: if(state, do: hd(state), else: nil),
      openThreads: open || 0
    }
  end
  defp journal_entry([id, vault_id, agent_key, run_id, kind, body, created_at, consolidated_at]) do
    %{
      id: id,
      vaultId: vault_id,
      agentKey: agent_key,
      runId: run_id,
      kind: if(kind in @journal_kinds, do: kind, else: "observation"),
      body: body,
      createdAt: created_at,
      consolidatedAt: consolidated_at
    }
  end
end
