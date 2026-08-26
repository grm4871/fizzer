defmodule Cascade.Content.Notes do
  @moduledoc "Note CRUD, ordering, links, markdown projections, and mutation policy."
  alias Cascade.Content.{Folders, Query, StorageSecurity, Store, Text}
  @note_summary_fields [:id, :vault_id, :folder_id, :title, :content_preview, :is_pinned, :is_archived, :is_listed, :position, :word_count, :created_at, :updated_at]
  @chat_channel_marker "cascade://chat-channel"

  def extract_links(content) do
    ~r/\[\[([^\]]+)\]\]/u
    |> Regex.scan(to_string(content), capture: :all_but_first)
    |> Enum.map(fn [title] -> String.trim(title) end)
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  def list_notes(vault_id, opts \\ %{}) do
    {clauses, params} = note_filters(opts)

    rows =
      Query.maps(
        """
        SELECT n.id, n.vault_id, n.folder_id, n.title, n.content_preview,
               n.is_pinned, n.is_archived, n.is_listed, n.position, n.word_count,
               n.created_at, n.updated_at
        FROM notes n
        WHERE n.vault_id = ? #{Enum.join(clauses, "")}
        ORDER BY n.is_pinned DESC, n.updated_at DESC
        """,
        [vault_id | params],
        @note_summary_fields
      )

    tags = tags_by_note(Enum.map(rows, & &1.id))
    Enum.map(rows, &Map.put(&1, :tags, Map.get(tags, &1.id, [])))
  end

  def get_note(note_id) do
    row =
      Query.map(
        """
        SELECT id, vault_id, folder_id, title, content_preview,
               is_pinned, is_archived, is_listed, position, word_count, created_at, updated_at
        FROM notes WHERE id = ?
        """,
        [note_id],
        @note_summary_fields
      )

    with row when not is_nil(row) <- row,
         file_path when not is_nil(file_path) <- Store.resolve_note_path(note_id) do
      content =
        case File.read(file_path) do
          {:ok, body} ->
            body

          _ ->
            case Query.one("SELECT content FROM notes WHERE id = ?", [note_id]) do
              [body] -> body || ""
              nil -> ""
            end
        end

      row
      |> Map.put(:tags, tags_for_note(note_id))
      |> Map.put(:content, content)
      |> Map.put(:file_path, file_path)
    else
      _ -> nil
    end
  end

  def create_note(vault_id, user_id, opts) do
    id = Ecto.UUID.generate()

    content =
      case value(opts, :content) do
        nil -> ""
        body -> to_string(body)
      end
      |> normalize_backticks()

    folder_id = blank_nil(value(opts, :folder_id))
    is_listed = if value(opts, :is_listed) == false, do: 0, else: 1
    requested_title = value(opts, :title) |> default_string("Untitled")
    title = unique_note_title(vault_id, folder_id, is_listed, requested_title)

    next_position =
      if is_listed == 1 do
        Query.one(
          "SELECT COALESCE(MAX(position), -1) + 1 FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1",
          [vault_id, folder_id]
        )
        |> hd()
      else
        0
      end

    vault = Store.raw_vault(vault_id) || raise(ArgumentError, "Vault not found")
    file_path = note_path_for(vault, folder_id, title, is_listed)
    File.mkdir_p!(Path.dirname(file_path))
    File.write!(file_path, content)

    Query.execute(
      """
      INSERT INTO notes
        (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, is_listed, position, word_count, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
      """,
      [
        id,
        vault_id,
        folder_id,
        title,
        Text.preview(content),
        is_listed,
        next_position,
        Text.word_count(content),
        user_id
      ]
      |> List.insert_at(4, content)
    )

    reindex_links(id, vault_id, content)
    Store.notify_note_mutation(id, user_id, :create)
    maybe_invalidate_presence_channels(nil, content)
    get_note(id)
  end

  def update_note(note_id, content, actor_user_id \\ nil) do
    existing =
      Query.map(
        "SELECT id, vault_id, folder_id, title, content FROM notes WHERE id = ?",
        [note_id],
        [:id, :vault_id, :folder_id, :title, :content]
      )

    existing = existing || raise(ArgumentError, "Note not found")
    normalized = normalize_backticks(content)

    if normalized == existing.content do
      get_note(note_id)
    else
      if file_path = Store.resolve_note_path(note_id) do
        File.mkdir_p!(Path.dirname(file_path))
        File.write!(file_path, normalized)
      end

      Query.execute(
        "UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?",
        [normalized, Text.preview(normalized), Text.word_count(normalized), note_id]
      )

      reindex_links(note_id, existing.vault_id, normalized)
      Store.notify_note_mutation(note_id, actor_user_id, :content)
      maybe_invalidate_presence_channels(existing.content, normalized)
      get_note(note_id)
    end
  end

  def rename_note(note_id, new_title_raw, actor_user_id \\ nil) do
    existing =
      Query.map("SELECT id, vault_id, title FROM notes WHERE id = ?", [note_id], [
        :id,
        :vault_id,
        :title
      ])

    existing = existing || raise(ArgumentError, "Note not found")
    new_title = new_title_raw |> to_string() |> String.trim()
    if new_title == "", do: raise(ArgumentError, "Title cannot be empty")

    if new_title == existing.title do
      get_note(note_id)
    else
      if Query.one(
           "SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE AND id != ?",
           [existing.vault_id, new_title, note_id]
         ) do
        raise ArgumentError, "A note with that title already exists"
      end

      old_path = Store.resolve_note_path(note_id)

      Query.execute("UPDATE notes SET title = ?, updated_at = datetime('now') WHERE id = ?", [
        new_title,
        note_id
      ])

      new_path = Store.resolve_note_path(note_id)

      if old_path && new_path && old_path != new_path do
        try do
          File.mkdir_p!(Path.dirname(new_path))
          if File.exists?(old_path), do: File.rename!(old_path, new_path)
        rescue
          _ -> :ok
        end
      end

      update_wikilink_targets(existing.vault_id, existing.title, new_title, actor_user_id)
      Store.notify_note_mutation(note_id, actor_user_id, :rename)
      get_note(note_id)
    end
  end

  def delete_note(note_id) do
    # These tables exist in the full Node schema. Their eager cleanup preserves
    # the current FTS/shared-channel deletion ordering.
    Query.execute("DELETE FROM chat_agent_members WHERE channel_id = ?", [note_id])
    Query.execute("DELETE FROM chat_messages WHERE channel_id = ?", [note_id])

    Query.execute(
      "DELETE FROM chat_channel_links WHERE local_channel_id = ? OR source_channel_id = ?",
      [note_id, note_id]
    )

    if file_path = Store.resolve_note_path(note_id) do
      try do
        if File.exists?(file_path), do: File.rm!(file_path)
      rescue
        _ -> :ok
      end
    end

    Query.execute("DELETE FROM notes WHERE id = ?", [note_id])
    Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
    :ok
  end

  def move_note(note_id, folder_id, requested_position \\ nil, actor_user_id \\ nil) do
    note =
      Query.map(
        "SELECT id, vault_id, folder_id, title, is_listed, position FROM notes WHERE id = ?",
        [note_id],
        [:id, :vault_id, :folder_id, :title, :is_listed, :position]
      )

    note = note || raise(ArgumentError, "Note not found")

    if folder_id do
      folder = Query.map("SELECT vault_id FROM folders WHERE id = ?", [folder_id], [:vault_id])

      if is_nil(folder) or folder.vault_id != note.vault_id,
        do: raise(ArgumentError, "Folder not found")
    end

    old_path = Store.resolve_note_path(note_id)

    target_ids =
      Query.all(
        """
        SELECT id FROM notes
        WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1 AND id != ?
        ORDER BY position ASC, updated_at DESC, id ASC
        """,
        [note.vault_id, folder_id, note_id]
      )
      |> List.flatten()

    position =
      cond do
        not is_number(requested_position) and note.is_listed == 1 and note.folder_id == folder_id ->
          min(note.position, length(target_ids))

        not is_number(requested_position) ->
          length(target_ids)

        true ->
          requested_position |> trunc() |> max(0) |> min(length(target_ids))
      end

    Query.execute(
      """
      UPDATE notes
      SET folder_id = ?, is_listed = 1, position = ?,
          updated_at = CASE WHEN folder_id IS NOT ? OR is_listed = 0 THEN datetime('now') ELSE updated_at END
      WHERE id = ?
      """,
      [folder_id, position, folder_id, note_id]
    )

    target_ids |> List.insert_at(position, note_id) |> resequence_notes()

    if note.is_listed == 1 and note.folder_id != folder_id do
      Query.all(
        """
        SELECT id FROM notes
        WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1
        ORDER BY position ASC, updated_at DESC, id ASC
        """,
        [note.vault_id, note.folder_id]
      )
      |> List.flatten()
      |> resequence_notes()
    end

    new_path = Store.resolve_note_path(note_id)
    best_effort_move(old_path, new_path)
    Store.notify_note_mutation(note_id, actor_user_id, :move)
    :ok
  end

  def unlist_note(note_id, actor_user_id \\ nil) do
    if is_nil(Query.one("SELECT id FROM notes WHERE id = ?", [note_id])),
      do: raise(ArgumentError, "Note not found")

    old_path = Store.resolve_note_path(note_id)

    Query.execute(
      "UPDATE notes SET folder_id = NULL, is_listed = 0, updated_at = datetime('now') WHERE id = ?",
      [note_id]
    )

    best_effort_move(old_path, Store.resolve_note_path(note_id))
    Store.notify_note_mutation(note_id, actor_user_id, :unlist)
    :ok
  end

  def toggle_pin(note_id, actor_user_id \\ nil) do
    Query.execute(
      "UPDATE notes SET is_pinned = CASE WHEN is_pinned = 0 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ?",
      [note_id]
    )

    Store.notify_note_mutation(note_id, actor_user_id, :pin)
    :ok
  end

  def toggle_archive(note_id, actor_user_id \\ nil) do
    Query.execute(
      "UPDATE notes SET is_archived = CASE WHEN is_archived = 0 THEN 1 ELSE 0 END, updated_at = datetime('now') WHERE id = ?",
      [note_id]
    )

    Store.notify_note_mutation(note_id, actor_user_id, :archive)
    :ok
  end

  def get_backlinks(note_id) do
    case Query.one("SELECT id, title FROM notes WHERE id = ?", [note_id]) do
      nil ->
        []

      [_id, title] ->
        Query.maps(
          """
          SELECT DISTINCT n.id, n.title, nl.context
          FROM note_links nl
          JOIN notes n ON n.id = nl.source_id
          WHERE nl.target_id = ? OR nl.target_title = ? COLLATE NOCASE
          """,
          [note_id, title],
          [:id, :title, :context]
        )
    end
  end

  def list_chat_backlinks(note_id, opts \\ %{}) do
    note =
      Query.map("SELECT id, title, vault_id FROM notes WHERE id = ?", [note_id], [
        :id,
        :title,
        :vault_id
      ])

    if is_nil(note) do
      []
    else
      reresolve_chat_backlinks(note.vault_id, note.id, note.title)
      limit = opts |> value(:limit) |> numeric_default(50) |> max(1) |> min(200)
      offset = opts |> value(:offset) |> numeric_default(0) |> max(0)
      deleted_clause = if value(opts, :include_deleted), do: "", else: "AND deleted = 0"

      Query.maps(
        """
        SELECT id, vault_id, note_id, target_title, message_id, channel_id, author, snippet, created_at, deleted
        FROM chat_note_backlinks
        WHERE (note_id = ? OR (note_id IS NULL AND target_title = ? COLLATE NOCASE AND vault_id = ?))
          #{deleted_clause}
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
        """,
        [note_id, note.title, note.vault_id, limit, offset],
        [
          :id,
          :vault_id,
          :note_id,
          :target_title,
          :message_id,
          :channel_id,
          :author,
          :snippet,
          :created_at,
          :deleted
        ]
      )
      |> Enum.map(fn row ->
        %{
          id: row.id,
          vaultId: row.vault_id,
          noteId: row.note_id,
          targetTitle: row.target_title,
          messageId: row.message_id,
          channelId: row.channel_id,
          author: row.author,
          snippet: row.snippet,
          createdAt: row.created_at,
          deleted: row.deleted != 0
        }
      end)
    end
  end

  def reresolve_chat_backlinks(vault_id, note_id, title) do
    try do
      Query.execute(
        """
        UPDATE chat_note_backlinks SET note_id = ?
        WHERE vault_id = ? AND note_id IS NULL AND target_title = ? COLLATE NOCASE AND deleted = 0
        """,
        [note_id, vault_id, title]
      ).num_rows
    rescue
      _ -> 0
    end
  end

  defp note_filters(opts) do
    {clauses, params} =
      if has_key?(opts, :folder_id) do
        case value(opts, :folder_id) do
          "" -> {[" AND n.folder_id IS NULL"], []}
          folder_id -> {[" AND n.folder_id = ?"], [folder_id]}
        end
      else
        {[], []}
      end

    {clauses, params} =
      if has_key?(opts, :is_archived) do
        {clauses ++ [" AND n.is_archived = ?"],
         params ++ [if(value(opts, :is_archived), do: 1, else: 0)]}
      else
        {clauses, params}
      end

    {clauses, params} =
      case value(opts, :tag) do
        tag when is_binary(tag) and tag != "" ->
          {clauses ++
             [
               " AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = n.id AND t.name = ? COLLATE NOCASE)"
             ], params ++ [tag]}

        _ ->
          {clauses, params}
      end

    {clauses, params} =
      if has_key?(opts, :title) do
        {clauses ++ [" AND n.title = ? COLLATE NOCASE"], params ++ [value(opts, :title)]}
      else
        {clauses, params}
      end

    case value(opts, :title_contains) do
      title when is_binary(title) and title != "" ->
        escaped = String.replace(title, ~r/[\\%_]/u, fn char -> "\\" <> char end)

        {clauses ++ [" AND n.title LIKE ? ESCAPE '\\' COLLATE NOCASE"],
         params ++ ["%#{escaped}%"]}

      _ ->
        {clauses, params}
    end
  end

  defp tags_by_note([]), do: %{}

  defp tags_by_note(note_ids) do
    placeholders = Enum.map_join(note_ids, ",", fn _ -> "?" end)

    try do
      Query.all(
        "SELECT nt.note_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id IN (#{placeholders}) ORDER BY t.name ASC",
        note_ids
      )
      |> Enum.reduce(%{}, fn [note_id, name], acc ->
        Map.update(acc, note_id, [name], &(&1 ++ [name]))
      end)
    rescue
      _ -> %{}
    end
  end

  defp tags_for_note(note_id) do
    Query.all(
      "SELECT t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id WHERE nt.note_id = ? ORDER BY t.name ASC",
      [note_id]
    )
    |> List.flatten()
  end

  defp resequence_notes(ids) do
    {:ok, _} =
      Query.transaction(fn ->
        Enum.with_index(ids, fn id, position ->
          Query.execute("UPDATE notes SET position = ? WHERE id = ?", [position, id])
        end)
      end)

    :ok
  end

  defp note_path_for(vault, folder_id, title, is_listed) do
    cond do
      is_listed == 0 ->
        StorageSecurity.resolve_under_vault(vault.root_path, [
          ".cascade-unlisted",
          StorageSecurity.sanitize_path_segment(title) <> ".md"
        ])

      folder_id ->
        StorageSecurity.resolve_under_vault(Folders.folder_path(vault, folder_id), [StorageSecurity.sanitize_path_segment(title) <> ".md"])

      true ->
        StorageSecurity.resolve_under_vault(vault.root_path, [StorageSecurity.sanitize_path_segment(title) <> ".md"])
    end
  end

  defp unique_note_title(vault_id, folder_id, is_listed, desired) do
    desired = desired |> to_string() |> String.trim() |> default_string("Untitled")

    taken =
      Query.all(
        "SELECT title FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = ?",
        [vault_id, folder_id, is_listed]
      )
      |> List.flatten()
      |> Enum.map(&(StorageSecurity.sanitize_path_segment(&1) |> String.downcase()))
      |> MapSet.new()

    if not MapSet.member?(taken, StorageSecurity.sanitize_path_segment(desired) |> String.downcase()) do
      desired
    else
      Enum.find_value(2..999, fn number ->
        candidate = "#{desired} #{number}"

        if not MapSet.member?(taken, StorageSecurity.sanitize_path_segment(candidate) |> String.downcase()),
          do: candidate
      end) || "#{desired} #{String.slice(Ecto.UUID.generate(), 0, 8)}"
    end
  end

  defp reindex_links(note_id, vault_id, content) do
    Query.execute("DELETE FROM note_links WHERE source_id = ?", [note_id])

    Enum.each(extract_links(content), fn title ->
      target_id =
        case Query.one("SELECT id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE", [
               vault_id,
               title
             ]) do
          [id] -> id
          nil -> nil
        end

      marker = "[[#{title}]]"
      context = link_context(content, marker)

      Query.execute(
        "INSERT OR REPLACE INTO note_links (source_id, target_id, target_title, context) VALUES (?, ?, ?, ?)",
        [note_id, target_id, title, context]
      )
    end)
  end

  defp link_context(content, marker) do
    case :binary.match(content, marker) do
      :nomatch ->
        nil

      {index, length} ->
        start = max(0, index - 40)
        finish = min(byte_size(content), index + length + 40)

        content
        |> binary_part(start, finish - start)
        |> String.replace("\n", " ")
        |> String.trim()
    end
  end

  defp update_wikilink_targets(vault_id, old_title, new_title, actor_user_id) do
    regex = Regex.compile!("(\\[\\[)#{Regex.escape(old_title)}(?=[\\]|#])", "iu")

    Query.maps("SELECT id, content FROM notes WHERE vault_id = ?", [vault_id], [:id, :content])
    |> Enum.each(fn note ->
      if String.contains?(note.content, "[[") do
        updated = Regex.replace(regex, note.content, "\\1#{new_title}")
        if updated != note.content, do: update_note(note.id, updated, actor_user_id)
      end
    end)
  end


  defp normalize_backticks(content),
    do: content |> to_string() |> String.replace(~r/\\+`/u, "`")

  defp best_effort_move(old_path, new_path) do
    if old_path && new_path && old_path != new_path do
      try do
        if File.exists?(old_path) do
          File.mkdir_p!(Path.dirname(new_path))
          File.rename!(old_path, new_path)
        end
      rescue
        _ -> :ok
      end
    end
  end

  defp default_string(nil, fallback), do: fallback
  defp default_string("", fallback), do: fallback

  defp default_string(value, _fallback),
    do: value |> to_string() |> String.trim() |> then(&if(&1 == "", do: "", else: &1))

  defp blank_nil(nil), do: nil
  defp blank_nil(""), do: nil
  defp blank_nil(value), do: value

  defp has_key?(map, key) when is_map(map),
    do: Map.has_key?(map, key) or Map.has_key?(map, Atom.to_string(key))

  defp has_key?(_, _), do: false
  defp value(map, key) when is_map(map), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp value(_, _), do: nil
  defp maybe_invalidate_presence_channels(before, after_content) do
    if chat_channel_content?(before) != chat_channel_content?(after_content) do
      Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
    end

    :ok
  end

  defp chat_channel_content?(content),
    do: String.starts_with?(String.trim(to_string(content || "")), @chat_channel_marker)
  defp numeric_default(value, _default) when is_integer(value), do: value
  defp numeric_default(value, _default) when is_float(value), do: trunc(value)

  defp numeric_default(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {number, _} -> number
      :error -> default
    end
  end

  defp numeric_default(_, default), do: default
end
