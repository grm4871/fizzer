defmodule Cascade.Content.Store do
  @moduledoc "Node-compatible vault, folder, note, tag, link, graph, and filesystem storage."


  alias Cascade.Content.Query
  alias Cascade.Content.Search
  alias Cascade.Content.Vaults
  alias Cascade.Content.Folders
  alias Cascade.Content.Filesystem
  alias Cascade.Content.Notes

  alias Cascade.Content.StorageSecurity

  @vault_fields [
    :id,
    :name,
    :root_path,
    :created_by,
    :created_at,
    :visibility,
    :public_join_role,
    :public_summary,
    :public_topics,
    :public_guidelines,
    :public_home_note_id,
    :public_join_policy
  ]
  def vaults_base_dir, do: StorageSecurity.vaults_base_dir()
  def sanitize_filename(title), do: StorageSecurity.sanitize_filename(title)
  def sanitize_path_segment(name), do: StorageSecurity.sanitize_path_segment(name)
  def resolve_under_vault(vault_root, parts), do: StorageSecurity.resolve_under_vault(vault_root, parts)


  def extract_links(content) do
    ~r/\[\[([^\]]+)\]\]/u
    |> Regex.scan(to_string(content), capture: :all_but_first)
    |> Enum.map(fn [title] -> String.trim(title) end)
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq()
  end

  def list_vaults(user_id), do: Vaults.list_vaults(user_id)
  def get_vault(vault_id, user_id), do: Vaults.get_vault(vault_id, user_id)
  def get_writable_vault(vault_id, user_id), do: Vaults.get_writable_vault(vault_id, user_id)
  def vault_role(vault_id, user_id), do: Vaults.vault_role(vault_id, user_id)
  def create_vault(user_id, opts), do: Vaults.create_vault(user_id, opts)
  def rename_vault(vault_id, name), do: Vaults.rename_vault(vault_id, name)
  def delete_vault(vault_id, user_id), do: Vaults.delete_vault(vault_id, user_id)
  def enforce_storage_isolation, do: Vaults.enforce_storage_isolation()
  def list_folders(vault_id), do: Folders.list_folders(vault_id)
  def get_folder(folder_id), do: Folders.get_folder(folder_id)
  def create_folder(vault_id, opts), do: Folders.create_folder(vault_id, opts)
  def update_folder(folder_id, opts), do: Folders.update_folder(folder_id, opts)
  def delete_folder(folder_id, actor_user_id \\ nil), do: Folders.delete_folder(folder_id, actor_user_id)
  def list_notes(vault_id, opts \\ %{}), do: Notes.list_notes(vault_id, opts)
  def get_note(note_id), do: Notes.get_note(note_id)
  def create_note(vault_id, user_id, opts), do: Notes.create_note(vault_id, user_id, opts)
  def update_note(note_id, content, actor_user_id \\ nil), do: Notes.update_note(note_id, content, actor_user_id)
  def rename_note(note_id, new_title, actor_user_id \\ nil), do: Notes.rename_note(note_id, new_title, actor_user_id)
  def delete_note(note_id), do: Notes.delete_note(note_id)
  def move_note(note_id, folder_id, requested_position \\ nil, actor_user_id \\ nil), do: Notes.move_note(note_id, folder_id, requested_position, actor_user_id)
  def unlist_note(note_id, actor_user_id \\ nil), do: Notes.unlist_note(note_id, actor_user_id)
  def toggle_pin(note_id, actor_user_id \\ nil), do: Notes.toggle_pin(note_id, actor_user_id)
  def toggle_archive(note_id, actor_user_id \\ nil), do: Notes.toggle_archive(note_id, actor_user_id)
  def get_backlinks(note_id), do: Notes.get_backlinks(note_id)
  def list_chat_backlinks(note_id, opts \\ %{}), do: Notes.list_chat_backlinks(note_id, opts)
  def reresolve_chat_backlinks(vault_id, note_id, title), do: Notes.reresolve_chat_backlinks(vault_id, note_id, title)
  def list_tags(vault_id) do
    Query.maps(
      """
      SELECT t.id, t.name, t.color, COUNT(nt.note_id) AS count
      FROM tags t LEFT JOIN note_tags nt ON nt.tag_id = t.id
      WHERE t.vault_id = ? GROUP BY t.id ORDER BY t.name ASC
      """,
      [vault_id],
      [:id, :name, :color, :count]
    )
  end

  def add_tag(note_id, vault_id, name, color \\ nil, actor_user_id \\ nil) do
    tag_name = name |> to_string() |> String.trim() |> String.downcase()
    if tag_name == "", do: raise(ArgumentError, "Tag name is required")

    tag_id =
      case Query.one("SELECT id FROM tags WHERE vault_id = ? AND name = ?", [vault_id, tag_name]) do
        [id] ->
          if color, do: Query.execute("UPDATE tags SET color = ? WHERE id = ?", [color, id])
          id

        nil ->
          id = Ecto.UUID.generate()

          Query.execute("INSERT INTO tags (id, vault_id, name, color) VALUES (?, ?, ?, ?)", [
            id,
            vault_id,
            tag_name,
            color
          ])

          id
      end

    Query.execute("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)", [
      note_id,
      tag_id
    ])

    notify_mutation(note_id, actor_user_id, :tag)
    :ok
  end

  def remove_tag(note_id, tag_id, actor_user_id \\ nil) do
    Query.execute("DELETE FROM note_tags WHERE note_id = ? AND tag_id = ?", [note_id, tag_id])
    [[count]] = Query.all("SELECT COUNT(*) FROM note_tags WHERE tag_id = ?", [tag_id])
    if count == 0, do: Query.execute("DELETE FROM tags WHERE id = ?", [tag_id])
    notify_mutation(note_id, actor_user_id, :tag)
    :ok
  end

  def graph(vault_id) do
    %{
      nodes:
        Query.maps("SELECT id, title, folder_id FROM notes WHERE vault_id = ?", [vault_id], [
          :id,
          :title,
          :folder_id
        ]),
      edges:
        Query.maps(
          """
          SELECT nl.source_id, nl.target_id FROM note_links nl
          JOIN notes n ON n.id = nl.source_id
          WHERE n.vault_id = ? AND nl.target_id IS NOT NULL
          """,
          [vault_id],
          [:source, :target]
        )
    }
  end
  @doc "Searches indexed notes and chat messages with bounded, UTF-8-safe snippets."
  def search(vault_id, query, opts \\ %{}), do: Search.search(vault_id, query, opts)
  def rescan_vault(vault_id, user_id), do: Filesystem.rescan_vault(vault_id, user_id)
  def resolve_note_path(note_id), do: Filesystem.resolve_note_path(note_id)

  def raw_vault(vault_id) do
    Query.map(
      "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults WHERE id = ?",
      [vault_id],
      @vault_fields
    )
  end


  def notify_note_mutation(note_id, actor_user_id, kind) do
    notify_mutation(note_id, actor_user_id, kind)
  end

  defp notify_mutation(note_id, actor_user_id, kind) do
    case Application.get_env(:cascade_elixir, :note_mutation_sink) do
      function when is_function(function, 3) and is_integer(actor_user_id) ->
        function.(note_id, actor_user_id, kind)

      _ ->
        :ok
    end
  end

end
