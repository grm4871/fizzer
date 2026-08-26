defmodule Cascade.Evolution.Schema do
  @moduledoc "Database schema for evolution backlinks, distillation jobs, and memory settings."
  alias Cascade.Content.Query

  def ensure_schema do
    Enum.each(
      [
        """
        CREATE TABLE IF NOT EXISTS chat_note_backlinks (
          id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, note_id TEXT,
          target_title TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          author TEXT NOT NULL, snippet TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted INTEGER NOT NULL DEFAULT 0,
          UNIQUE(message_id, target_title)
        )
        """,
        "CREATE INDEX IF NOT EXISTS chat_note_backlinks_note_idx ON chat_note_backlinks(note_id, created_at DESC)",
        "CREATE INDEX IF NOT EXISTS chat_note_backlinks_msg_idx ON chat_note_backlinks(message_id)",
        "CREATE INDEX IF NOT EXISTS chat_note_backlinks_unresolved_idx ON chat_note_backlinks(vault_id, note_id, target_title)",
        """
        CREATE TABLE IF NOT EXISTS vault_settings (
          vault_id TEXT PRIMARY KEY, agent_memory_enabled INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS distill_jobs (
          id TEXT PRIMARY KEY, vault_id TEXT NOT NULL, channel_id TEXT NOT NULL,
          mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', note_id TEXT,
          message_ids_json TEXT NOT NULL DEFAULT '[]', created_by INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')), fingerprint TEXT
        )
        """,
        "CREATE INDEX IF NOT EXISTS distill_jobs_fp_idx ON distill_jobs(vault_id, fingerprint)"
      ],
      &Query.execute/1
    )

    backlink_schema =
      case Query.one(
             "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_note_backlinks'"
           ) do
        [sql] -> sql || ""
        _ -> ""
      end

    unless Regex.match?(
             ~r/UNIQUE\s*\(\s*message_id\s*,\s*target_title\s*\)/i,
             backlink_schema
           ) do
      Query.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS chat_note_backlinks_message_title_unique ON chat_note_backlinks(message_id, target_title)"
      )
    end

    :ok
  end
end
