defmodule Cascade.Content.Filesystem do
  @moduledoc "Vault markdown scanning, note path resolution, and rescan synchronization."
  alias Cascade.Content.{Folders, Query, StorageSecurity, Store, Text}

  def rescan_vault(vault_id, user_id) do
    vault = Store.raw_vault(vault_id)

    if vault && not vault_root_taken?(vault.root_path, vault.id) do
      disk_files = scan_markdown(vault.root_path)

      Query.maps("SELECT id, title FROM notes WHERE vault_id = ?", [vault_id], [:id, :title])
      |> Enum.each(fn note ->
        file_path = resolve_note_path(note.id)

        if is_nil(file_path) or not File.exists?(file_path),
          do: Query.execute("DELETE FROM notes WHERE id = ?", [note.id])
      end)

      Enum.each(disk_files, &rescan_file(vault, &1, user_id))
    end

    Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()
    :ok
  end

  def resolve_note_path(note_id) do
    note =
      Query.map(
        "SELECT id, vault_id, folder_id, title, is_listed FROM notes WHERE id = ?",
        [note_id],
        [:id, :vault_id, :folder_id, :title, :is_listed]
      )

    with note when not is_nil(note) <- note,
         vault when not is_nil(vault) <- Store.raw_vault(note.vault_id) do
      cond do
        note.is_listed == 0 ->
          StorageSecurity.resolve_under_vault(vault.root_path, [
            ".cascade-unlisted",
            StorageSecurity.sanitize_path_segment(note.title) <> ".md"
          ])

        note.folder_id ->
          StorageSecurity.resolve_under_vault(Folders.folder_path(vault, note.folder_id), [
            StorageSecurity.sanitize_path_segment(note.title) <> ".md"
          ])

        true ->
          StorageSecurity.resolve_under_vault(vault.root_path, [StorageSecurity.sanitize_path_segment(note.title) <> ".md"])
      end
    else
      _ -> nil
    end
  end

  defp scan_markdown(root) do
    case File.ls(root) do
      {:ok, entries} ->
        Enum.flat_map(entries, fn entry ->
          path = Path.join(root, entry)

          cond do
            File.dir?(path) and String.starts_with?(entry, ".") -> []
            File.dir?(path) -> scan_markdown(path)
            File.regular?(path) and String.ends_with?(entry, ".md") -> [path]
            true -> []
          end
        end)

      _ ->
        []
    end
  end

  defp rescan_file(vault, file_path, user_id) do
    relative = Path.relative_to(Path.expand(file_path), Path.expand(vault.root_path))
    parts = Path.split(relative)
    {folder_parts, [filename]} = Enum.split(parts, max(length(parts) - 1, 0))

    folder_id =
      Enum.reduce(folder_parts, nil, fn folder_name, parent_id ->
        case Query.one(
               "SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? AND name = ?",
               [vault.id, parent_id, folder_name]
             ) do
          [id] ->
            id

          nil ->
            id = Ecto.UUID.generate()

            Query.execute(
              "INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, 0)",
              [id, vault.id, parent_id, folder_name]
            )

            id
        end
      end)

    title =
      if String.ends_with?(filename, ".md"),
        do: String.slice(filename, 0, String.length(filename) - 3),
        else: filename

    content = File.read!(file_path)

    existing =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND title = ? AND (folder_id IS ? OR folder_id = ?)",
        [vault.id, title, folder_id, folder_id],
        [:id, :content]
      )

    if existing do
      if existing.content != content do
        Query.execute(
          "UPDATE notes SET content = ?, content_preview = ?, word_count = ?, updated_at = datetime('now') WHERE id = ?",
          [content, Text.preview(content), Text.word_count(content), existing.id]
        )

        reindex_links(existing.id, vault.id, content)
        Store.notify_note_mutation(existing.id, user_id, :rescan)
      end
    else
      id = Ecto.UUID.generate()

      [position] =
        Query.one(
          "SELECT COALESCE(MAX(position), -1) + 1 FROM notes WHERE vault_id = ? AND folder_id IS ? AND is_listed = 1",
          [vault.id, folder_id]
        )

      Query.execute(
        """
        INSERT INTO notes (id, vault_id, folder_id, title, content, content_preview, is_pinned, is_archived, position, word_count, created_by)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
        """,
        [
          id,
          vault.id,
          folder_id,
          title,
          content,
          Text.preview(content),
          position,
          Text.word_count(content),
          user_id
        ]
      )

      reindex_links(id, vault.id, content)
      Store.notify_note_mutation(id, user_id, :rescan)
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

  defp vault_root_taken?(root_path, except_vault_id) do
    resolved = Path.expand(root_path)
    Query.maps("SELECT id, root_path FROM vaults", [], [:id, :root_path])
    |> Enum.any?(fn row -> row.id != except_vault_id and Path.expand(row.root_path || "") == resolved end)
  end
  defp extract_links(content) do
    ~r/\[\[([^\]]+)\]\]/u |> Regex.scan(to_string(content), capture: :all_but_first) |> Enum.map(fn [title] -> String.trim(title) end) |> Enum.reject(&(&1 == "")) |> Enum.uniq()
  end
end
