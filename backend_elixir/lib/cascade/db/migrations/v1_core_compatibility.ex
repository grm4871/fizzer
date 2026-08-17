defmodule Cascade.DB.Migrations.V1CoreCompatibility do
  @moduledoc false

  use Cascade.DB.Migration

  alias Cascade.DB.Repo
  alias Ecto.Adapters.SQL

  @impl true
  def version, do: 1

  @impl true
  def name, do: "core_node_schema_compatibility"

  @impl true
  def checksum_material, do: {:v1, :legacy_column_and_position_backfill, statements()}

  @impl true
  def statements do
    [
      """
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        avatar_url TEXT NOT NULL DEFAULT '',
        auth_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS registration_invites_used (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        used_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS vaults (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_path TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        content_preview TEXT NOT NULL DEFAULT '',
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        is_listed INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        word_count INTEGER NOT NULL DEFAULT 0,
        created_by INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT,
        UNIQUE(vault_id, name)
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS note_tags (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, tag_id)
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS note_links (
        source_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        target_id TEXT,
        target_title TEXT NOT NULL,
        context TEXT,
        PRIMARY KEY (source_id, target_title)
      )
      """,
      """
      CREATE TABLE IF NOT EXISTS note_versions (
        id TEXT PRIMARY KEY,
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
      """,
      "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(title, content, content='notes', content_rowid='rowid')",
      """
      CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
        INSERT INTO notes_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
      END
      """,
      """
      CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', OLD.rowid, OLD.title, OLD.content);
      END
      """,
      """
      CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
        INSERT INTO notes_fts(notes_fts, rowid, title, content) VALUES('delete', OLD.rowid, OLD.title, OLD.content);
        INSERT INTO notes_fts(rowid, title, content) VALUES (NEW.rowid, NEW.title, NEW.content);
      END
      """
    ]
  end

  @impl true
  def after_up do
    ensure_column("users", "display_name", "TEXT NOT NULL DEFAULT ''")
    ensure_column("users", "avatar_url", "TEXT NOT NULL DEFAULT ''")
    ensure_column("users", "auth_version", "INTEGER NOT NULL DEFAULT 0")
    ensure_column("notes", "is_listed", "INTEGER NOT NULL DEFAULT 1")

    if ensure_column("notes", "position", "INTEGER NOT NULL DEFAULT 0") == :added do
      backfill_note_positions()
    end

    :ok
  end

  defp ensure_column(table, column, definition) do
    columns = SQL.query!(Repo, "PRAGMA table_info(#{table})", []).rows

    unless Enum.any?(columns, fn [_cid, name | _rest] -> name == column end) do
      SQL.query!(Repo, "ALTER TABLE #{table} ADD COLUMN #{column} #{definition}", [])
      :added
    else
      :present
    end
  end

  defp backfill_note_positions do
    rows =
      SQL.query!(
        Repo,
        """
        SELECT id, vault_id, folder_id
        FROM notes
        WHERE is_listed = 1
        ORDER BY vault_id, folder_id, is_pinned DESC, updated_at DESC, id
        """,
        []
      ).rows

    Enum.reduce(rows, %{}, fn [id, vault_id, folder_id], positions ->
      key = {vault_id, folder_id}
      position = Map.get(positions, key, 0)
      SQL.query!(Repo, "UPDATE notes SET position = ? WHERE id = ?", [position, id])
      Map.put(positions, key, position + 1)
    end)

    :ok
  end
end
