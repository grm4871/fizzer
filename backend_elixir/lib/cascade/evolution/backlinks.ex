defmodule Cascade.Evolution.Backlinks do
  @moduledoc """
  Maintains chat-to-note backlink records.

  The SQL tables are authoritative. Writes are idempotent per message and title;
  tombstones remain queryable only when explicitly requested.
  """

  alias Cascade.Content.{Query, Store}
  alias Cascade.Evolution.Schema

  def ensure_schema, do: Schema.ensure_schema()

  def extract_wiki_titles(body) do
    ~r/!?\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/u
    |> Regex.scan(to_string(body), capture: :all_but_first)
    |> List.flatten()
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.reduce({MapSet.new(), []}, fn title, {seen, titles} ->
      key = String.downcase(title)

      if MapSet.member?(seen, key),
        do: {seen, titles},
        else: {MapSet.put(seen, key), [title | titles]}
    end)
    |> elem(1)
    |> Enum.reverse()
  end

  def index_chat_message_backlinks(vault_id, channel_id, message) do
    ensure_schema()
    titles = extract_wiki_titles(value(message, :body, ""))
    snippet = truncate_snippet(value(message, :body, ""))
    created_at = value(message, :created_at, nil) || value(message, :createdAt, nil) || now()

    Enum.each(titles, fn title ->
      resolved = resolve_note_by_title(vault_id, title)

      Query.execute(
        """
        INSERT INTO chat_note_backlinks
          (id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(message_id, target_title) DO UPDATE SET
          note_id = excluded.note_id, author = excluded.author, snippet = excluded.snippet, deleted = 0
        """,
        [
          uuid(),
          vault_id,
          resolved && resolved.id,
          title,
          value(message, :id),
          channel_id,
          value(message, :author, ""),
          snippet,
          created_at
        ]
      )
    end)

    length(titles)
  end

  def tombstone_chat_message_backlinks(message_id) do
    ensure_schema()
    Query.execute("UPDATE chat_note_backlinks SET deleted = 1 WHERE message_id = ?", [message_id])
    :ok
  end

  def reresolve_chat_backlinks(vault_id, note_id, title) do
    ensure_schema()

    Query.execute(
      "UPDATE chat_note_backlinks SET note_id = ? WHERE vault_id = ? AND note_id IS NULL AND target_title = ? COLLATE NOCASE AND deleted = 0",
      [note_id, vault_id, title]
    ).num_rows
  end

  def list_chat_note_backlinks(note_id, opts \\ []) do
    ensure_schema()
    limit = opts |> Keyword.get(:limit, 50) |> bounded(1, 200)
    offset = opts |> Keyword.get(:offset, 0) |> bounded(0, 2_147_483_647)
    note = Store.get_note(note_id)

    if note do
      reresolve_chat_backlinks(note.vault_id, note.id, note.title)
      deleted = if Keyword.get(opts, :include_deleted, false), do: "", else: "AND deleted = 0"

      Query.maps(
        """
        SELECT id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted
        FROM chat_note_backlinks
        WHERE (note_id = ? OR (note_id IS NULL AND target_title = ? COLLATE NOCASE AND vault_id = ?))
          #{deleted}
        ORDER BY created_at DESC LIMIT ? OFFSET ?
        """,
        [note_id, note.title, note.vault_id, limit, offset],
        [
          :id,
          :vaultId,
          :noteId,
          :targetTitle,
          :messageId,
          :channelId,
          :author,
          :snippet,
          :createdAt,
          :deleted
        ]
      )
      |> Enum.map(&Map.update!(&1, :deleted, fn value -> value != 0 end))
    else
      []
    end
  end

  def backfill_chat_note_backlinks(vault_id, opts \\ []) do
    ensure_schema()
    limit = opts |> Keyword.get(:limit, 500) |> bounded(1, 5_000)
    after_rowid = opts |> Keyword.get(:after_rowid, 0) |> number(0) |> trunc()

    rows =
      Query.maps(
        """
        SELECT rowid, id, channel_id, author, body, created_at FROM chat_messages
        WHERE vault_id = ? AND rowid > ? ORDER BY rowid ASC LIMIT ?
        """,
        [vault_id, after_rowid, limit],
        [:rowid, :id, :channel_id, :author, :body, :created_at]
      )

    indexed =
      Enum.reduce(rows, 0, fn row, count ->
        count + index_chat_message_backlinks(vault_id, row.channel_id, row)
      end)

    next = if length(rows) == limit, do: List.last(rows).rowid, else: nil
    %{processed: length(rows), indexed: indexed, nextAfterRowid: next}
  end

  defp resolve_note_by_title(vault_id, title) do
    Query.map(
      "SELECT id, title FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE LIMIT 1",
      [vault_id, title],
      [:id, :title]
    )
  end

  defp truncate_snippet(value),
    do:
      value |> to_string() |> String.replace(~r/\s+/u, " ") |> String.trim() |> clip_ellipsis(500)

  defp clip_ellipsis(value, limit),
    do: if(String.length(value) > limit, do: String.slice(value, 0, limit - 1) <> "…", else: value)

  defp now, do: DateTime.utc_now() |> DateTime.to_iso8601()
  defp uuid, do: Ecto.UUID.generate()


  defp bounded(value, low, high), do: value |> number(low) |> trunc() |> max(low) |> min(high)
  defp number(nil, fallback), do: fallback
  defp number(value, _fallback) when is_integer(value) or is_float(value), do: value

  defp number(value, fallback) do
    case Float.parse(to_string(value)) do
      {parsed, _} -> parsed
      :error -> fallback
    end
  end

  defp value(map, key, default \\ nil),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), default))

end
