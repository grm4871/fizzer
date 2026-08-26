defmodule Cascade.Content.Folders do
  @moduledoc "Folder CRUD, hierarchy validation, ordering, and filesystem renames."
  alias Cascade.Content.{Query, StorageSecurity, Store}
  @folder_fields [:id, :vault_id, :parent_id, :name, :position, :created_at]

  def list_folders(vault_id) do
    Query.maps(
      "SELECT id, vault_id, parent_id, name, position, created_at FROM folders WHERE vault_id = ? ORDER BY position ASC, name ASC",
      [vault_id],
      @folder_fields
    )
  end

  def get_folder(folder_id) do
    Query.map(
      "SELECT id, vault_id, parent_id, name, position, created_at FROM folders WHERE id = ?",
      [folder_id],
      @folder_fields
    )
  end

  def create_folder(vault_id, opts) do
    id = Ecto.UUID.generate()
    name = value(opts, :name) |> default_string("New Folder") |> StorageSecurity.sanitize_path_segment()
    parent_id = blank_nil(value(opts, :parent_id))

    [next_position] =
      Query.one(
        "SELECT COALESCE(MAX(position), -1) + 1 FROM folders WHERE vault_id = ? AND parent_id IS ?",
        [vault_id, parent_id]
      )

    Query.execute(
      "INSERT INTO folders (id, vault_id, parent_id, name, position) VALUES (?, ?, ?, ?, ?)",
      [id, vault_id, parent_id, name, next_position]
    )

    if vault = Store.raw_vault(vault_id), do: folder_path(vault, id) |> File.mkdir_p!()
    get_folder(id)
  end

  def update_folder(folder_id, opts) do
    folder = get_folder(folder_id) || raise(ArgumentError, "Folder not found")
    vault = Store.raw_vault(folder.vault_id)
    old_path = folder_path(vault, folder_id)

    name =
      if has_key?(opts, :name) do
        opts
        |> value(:name)
        |> to_string()
        |> String.trim()
        |> default_string(folder.name)
        |> StorageSecurity.sanitize_path_segment()
      else
        folder.name
      end

    parent_id = if has_key?(opts, :parent_id), do: value(opts, :parent_id), else: folder.parent_id

    requested_position =
      case value(opts, :position) do
        position when is_integer(position) -> max(0, position)
        position when is_float(position) -> max(0, trunc(position))
        _ -> nil
      end

    position = requested_position || folder.position

    if parent_id do
      if parent_id == folder_id, do: raise(ArgumentError, "Cannot move a folder into itself")
      parent = get_folder(parent_id)

      if is_nil(parent) or parent.vault_id != folder.vault_id,
        do: raise(ArgumentError, "Parent folder not found")

      if descendant_folder?(folder_id, parent_id),
        do: raise(ArgumentError, "Cannot move a folder into its own subfolder")
    end

    Query.execute("UPDATE folders SET name = ?, parent_id = ?, position = ? WHERE id = ?", [
      name,
      parent_id,
      position,
      folder_id
    ])

    if parent_id != folder.parent_id or not is_nil(requested_position) do
      target_ids = sibling_folder_ids(folder.vault_id, parent_id, folder_id)

      insert_at =
        if is_nil(requested_position),
          do: length(target_ids),
          else: min(requested_position, length(target_ids))

      target_ids |> List.insert_at(insert_at, folder_id) |> resequence_folders()

      if folder.parent_id != parent_id,
        do: sibling_folder_ids(folder.vault_id, folder.parent_id, nil) |> resequence_folders()
    end

    new_path = folder_path(vault, folder_id)

    if old_path != new_path and File.exists?(old_path) do
      File.mkdir_p!(Path.dirname(new_path))
      File.rename!(old_path, new_path)
    end

    get_folder(folder_id)
  end

  def delete_folder(folder_id, actor_user_id \\ nil) do
    folder = get_folder(folder_id) || raise(ArgumentError, "Folder not found")

    moved_note_ids =
      Query.all("SELECT id FROM notes WHERE folder_id = ?", [folder_id]) |> List.flatten()

    Query.execute("UPDATE notes SET folder_id = ? WHERE folder_id = ?", [
      folder.parent_id,
      folder_id
    ])

    Enum.each(moved_note_ids, &Store.notify_note_mutation(&1, actor_user_id, :move))

    Query.execute("UPDATE folders SET parent_id = ? WHERE parent_id = ?", [
      folder.parent_id,
      folder_id
    ])

    Query.execute("DELETE FROM folders WHERE id = ?", [folder_id])

    # Preserve Node's cleanup ordering: resolving after deletion points at the vault root.
    if vault = Store.raw_vault(folder.vault_id) do
      folder_path = folder_path(vault, folder_id)

      with true <- File.dir?(folder_path),
           {:ok, []} <- File.ls(folder_path) do
        File.rmdir(folder_path)
      else
        _ -> :ok
      end
    end

    :ok
  end

  defp raw_folder(folder_id) do
    Query.map("SELECT id, parent_id, name FROM folders WHERE id = ?", [folder_id], [
      :id,
      :parent_id,
      :name
    ])
  end

  def folder_path(vault, folder_id) do
    parts = folder_parts(folder_id, [], MapSet.new())
    StorageSecurity.resolve_under_vault(vault.root_path, parts)
  end

  defp folder_parts(nil, parts, _seen), do: parts

  defp folder_parts(folder_id, parts, seen) do
    if MapSet.member?(seen, folder_id), do: raise(ArgumentError, "Invalid folder hierarchy")

    case raw_folder(folder_id) do
      nil ->
        parts

      folder ->
        folder_parts(
          folder.parent_id,
          [StorageSecurity.sanitize_path_segment(folder.name) | parts],
          MapSet.put(seen, folder_id)
        )
    end
  end

  defp descendant_folder?(folder_id, candidate_id) do
    case raw_folder(candidate_id) do
      nil -> false
      %{parent_id: nil} -> false
      %{parent_id: ^folder_id} -> true
      %{parent_id: parent_id} -> descendant_folder?(folder_id, parent_id)
    end
  end

  defp sibling_folder_ids(vault_id, parent_id, excluded_id) do
    sql =
      if excluded_id do
        "SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? AND id != ? ORDER BY position ASC, name ASC, id ASC"
      else
        "SELECT id FROM folders WHERE vault_id = ? AND parent_id IS ? ORDER BY position ASC, name ASC, id ASC"
      end

    params = if excluded_id, do: [vault_id, parent_id, excluded_id], else: [vault_id, parent_id]
    Query.all(sql, params) |> List.flatten()
  end

  defp resequence_folders(ids) do
    {:ok, _} =
      Query.transaction(fn ->
        Enum.with_index(ids, fn id, position ->
          Query.execute("UPDATE folders SET position = ? WHERE id = ?", [position, id])
        end)
      end)

    :ok
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
end
