defmodule Cascade.Scratchpad.Schema do
  @moduledoc "Database schema for the append-only scratchpad journal and thread state."
  alias Cascade.Content.Query

  def ensure_schema do
    Enum.each(
      [
        """
        CREATE TABLE IF NOT EXISTS agent_journal (
          id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL,
          agent_key TEXT NOT NULL DEFAULT '', run_id INTEGER,
          kind TEXT NOT NULL DEFAULT 'observation', body TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), consolidated_at TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS agent_journal_vault_idx ON agent_journal(vault_id, agent_key, id)",
        "CREATE INDEX IF NOT EXISTS agent_journal_open_idx ON agent_journal(vault_id, agent_key, consolidated_at)",
        """
        CREATE TABLE IF NOT EXISTS scratchpad_state (
          vault_id TEXT NOT NULL, agent_key TEXT NOT NULL DEFAULT '',
          last_consolidation_at TEXT, PRIMARY KEY (vault_id, agent_key)
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS scratchpad_note_stats (
          note_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL,
          uses INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0,
          losses INTEGER NOT NULL DEFAULT 0, last_result TEXT, last_used_at TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS scratchpad_note_stats_vault_idx ON scratchpad_note_stats(vault_id)",
        """
        CREATE TABLE IF NOT EXISTS agent_open_threads (
          id INTEGER PRIMARY KEY AUTOINCREMENT, vault_id TEXT NOT NULL,
          agent_key TEXT NOT NULL DEFAULT '', intent TEXT NOT NULL,
          blocked_on TEXT NOT NULL DEFAULT '', next_try TEXT NOT NULL DEFAULT '',
          pointer TEXT NOT NULL DEFAULT '', run_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')), closed_at TEXT, close_reason TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS agent_open_threads_open_idx ON agent_open_threads(vault_id, agent_key, closed_at, id)"
      ],
      &Query.execute/1
    )

    if table_exists?("notes") do
      Query.execute(
        "DELETE FROM scratchpad_note_stats WHERE note_id NOT IN (SELECT id FROM notes)"
      )
    end

    :ok
  end

  def delete_note_stats(note_id) do
    ensure_schema()
    Query.execute("DELETE FROM scratchpad_note_stats WHERE note_id = ?", [note_id])
    :ok
  end
  defp table_exists?(name), do: Query.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) != nil
end
