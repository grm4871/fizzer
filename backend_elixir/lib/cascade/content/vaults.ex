defmodule Cascade.Content.Vaults do
  @moduledoc "Vault lifecycle, membership access, and storage isolation policy."
  alias Cascade.Content.{Query, StorageSecurity, Store}
  @vault_fields [:id, :name, :root_path, :created_by, :created_at, :visibility, :public_join_role, :public_summary, :public_topics, :public_guidelines, :public_home_note_id, :public_join_policy]
  def vaults_base_dir, do: StorageSecurity.vaults_base_dir()
  def sanitize_filename(title), do: StorageSecurity.sanitize_filename(title)

  def list_vaults(user_id) do
    hide_direct_messages =
      if Query.one(
           "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'user_dm_vaults'"
         ),
         do: "AND NOT EXISTS (SELECT 1 FROM user_dm_vaults dm WHERE dm.vault_id = v.id)",
         else: ""

    try do
      Query.maps(
        """
        SELECT v.id, v.name, v.root_path, v.created_by, v.created_at,
               v.visibility, v.public_join_role, v.public_summary, v.public_topics,
               v.public_guidelines, v.public_home_note_id, v.public_join_policy,
               m.role,
               (SELECT COUNT(*) FROM vault_members c WHERE c.vault_id = v.id) AS memberCount
        FROM vaults v
        JOIN vault_members m ON m.vault_id = v.id
        WHERE m.user_id = ?
          #{hide_direct_messages}
        ORDER BY v.created_at DESC
        """,
        [user_id],
        @vault_fields ++ [:role, :memberCount]
      )
    rescue
      _ ->
        Query.maps(
          "SELECT v.id, v.name, v.root_path, v.created_by, v.created_at, v.visibility, v.public_join_role, v.public_summary, v.public_topics, v.public_guidelines, v.public_home_note_id, v.public_join_policy FROM vaults v WHERE v.created_by = ? #{hide_direct_messages} ORDER BY v.created_at DESC",
          [user_id],
          @vault_fields
        )
        |> Enum.map(&Map.merge(&1, %{role: "owner", memberCount: 1}))
    end
  end
  def get_vault(vault_id, user_id) do
    try do
      Query.map(
        """
        SELECT v.id, v.name, v.root_path, v.created_by, v.created_at,
               v.visibility, v.public_join_role, v.public_summary, v.public_topics,
               v.public_guidelines, v.public_home_note_id, v.public_join_policy
        FROM vaults v
        JOIN vault_members m ON m.vault_id = v.id
        WHERE v.id = ? AND m.user_id = ?
        """,
        [vault_id, user_id],
        @vault_fields
      )
    rescue
      _ ->
        Query.map(
          "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults WHERE id = ? AND created_by = ?",
          [vault_id, user_id],
          @vault_fields
        )
    end
  end
  def get_writable_vault(vault_id, user_id) do
    try do
      Query.map(
        """
        SELECT v.id, v.name, v.root_path, v.created_by, v.created_at,
               v.visibility, v.public_join_role, v.public_summary, v.public_topics,
               v.public_guidelines, v.public_home_note_id, v.public_join_policy
        FROM vaults v
        JOIN vault_members m ON m.vault_id = v.id
        WHERE v.id = ? AND m.user_id = ? AND m.role IN ('owner', 'editor')
        """,
        [vault_id, user_id],
        @vault_fields
      )
    rescue
      _ -> get_vault(vault_id, user_id)
    end
  end

  def vault_role(vault_id, user_id) do
    case Query.one("SELECT role FROM vault_members WHERE vault_id = ? AND user_id = ?", [
           vault_id,
           user_id
         ]) do
      [role] -> role
      nil -> nil
    end
  end
  def create_vault(user_id, opts) do
    id = Ecto.UUID.generate()
    name = default_string(value(opts, :name), "My Vault")
    root_path = unique_vault_root_path(user_id, id, name)

    if vault_root_taken?(root_path),
      do: raise(ArgumentError, "Vault storage path is already in use")

    File.mkdir_p!(root_path)

    Query.execute("INSERT INTO vaults (id, name, root_path, created_by) VALUES (?, ?, ?, ?)", [
      id,
      name,
      root_path,
      user_id
    ])

    try do
      Query.execute(
        """
        INSERT INTO vault_members (vault_id, user_id, role, invited_by)
        VALUES (?, ?, 'owner', ?)
        ON CONFLICT(vault_id, user_id) DO UPDATE SET role = 'owner'
        """,
        [id, user_id, user_id]
      )
    rescue
      _ -> :ok
    end

    vault = Store.raw_vault(id)

    try do
      entries = File.ls!(root_path) |> Enum.reject(&(&1 == ".DS_Store"))

      if entries == [],
        do:
          Store.create_note(id, user_id, %{
            title: "General",
            content: "cascade://chat-channel",
            is_listed: true
          })

      Store.rescan_vault(id, user_id)
    rescue
      error ->
        require Logger
        Logger.error("Failed to prepopulate vault walkthrough: #{Exception.message(error)}")
    end

    vault
  end
  def rename_vault(vault_id, name) do
    next = name |> to_string() |> String.trim()
    if next == "", do: raise(ArgumentError, "Vault name is required")

    if String.length(next) > 80,
      do: raise(ArgumentError, "Vault name must be 80 characters or fewer")

    if is_nil(Store.raw_vault(vault_id)), do: raise(ArgumentError, "Vault not found")
    Query.execute("UPDATE vaults SET name = ? WHERE id = ?", [next, vault_id])
    Store.raw_vault(vault_id)
  end
  def delete_vault(vault_id, user_id) do
    case Query.map(
           "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults WHERE id = ? AND created_by = ?",
           [vault_id, user_id],
           @vault_fields
         ) do
      nil ->
        false

      vault ->
        root = Path.expand(vault.root_path || "")
        base = Path.expand(StorageSecurity.vaults_base_dir())

        unless String.starts_with?(root, base <> "/") do
          raise ArgumentError, "Vault storage path is outside the managed vault directory"
        end

        Query.execute("DELETE FROM vaults WHERE id = ? AND created_by = ?", [vault_id, user_id])
        File.rm_rf!(root)
        true
    end
  end
  def enforce_storage_isolation do
    vaults =
      Query.maps(
        "SELECT id, name, root_path, created_by, created_at, visibility, public_join_role, public_summary, public_topics, public_guidelines, public_home_note_id, public_join_policy FROM vaults ORDER BY created_at ASC, rowid ASC",
        [],
        @vault_fields
      )

    groups =
      vaults
      |> Enum.reject(fn vault -> Path.expand(vault.root_path || "") == Path.expand("/") end)
      |> Enum.group_by(fn vault -> Path.expand(vault.root_path || "") end)

    rehomed =
      Enum.reduce(groups, 0, fn {_root, group}, count ->
        case group do
          [_single] ->
            count

          [_canonical | intruders] ->
            Enum.each(intruders, fn vault ->
              next_root =
                unique_vault_root_path(vault.created_by, vault.id, vault.name || "My Vault")

              File.mkdir_p!(next_root)
              purge_vault_index(vault.id)
              Query.execute("UPDATE vaults SET root_path = ? WHERE id = ?", [next_root, vault.id])

              try do
                Store.create_note(vault.id, vault.created_by, %{
                  title: "General",
                  content: "cascade://chat-channel",
                  is_listed: true
                })

                Store.rescan_vault(vault.id, vault.created_by)
              rescue
                _ -> :ok
              end
            end)

            count + length(intruders)
        end
      end)

    Enum.each(vaults, fn vault ->
      resolved = Path.expand(vault.root_path || "")

      if resolved != vault.root_path and not vault_root_taken?(resolved, vault.id) do
        Query.execute("UPDATE vaults SET root_path = ? WHERE id = ?", [resolved, vault.id])
      end
    end)

    try do
      Query.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS vaults_root_path_uidx ON vaults(root_path)"
      )
    rescue
      _ -> :ok
    end

    %{rehomed: rehomed}
  end
  defp purge_vault_index(vault_id) do
    for {sql, params} <- [
          {"DELETE FROM note_links WHERE source_id IN (SELECT id FROM notes WHERE vault_id = ?) OR target_id IN (SELECT id FROM notes WHERE vault_id = ?)",
           [vault_id, vault_id]},
          {"DELETE FROM note_tags WHERE note_id IN (SELECT id FROM notes WHERE vault_id = ?)",
           [vault_id]}
        ] do
      try do
        Query.execute(sql, params)
      rescue
        _ -> :ok
      end
    end

    Query.execute("DELETE FROM notes WHERE vault_id = ?", [vault_id])
    Query.execute("DELETE FROM folders WHERE vault_id = ?", [vault_id])
  end

  defp unique_vault_root_path(user_id, vault_id, name) do
    Path.expand(
      Path.join([StorageSecurity.vaults_base_dir(), to_string(user_id), vault_id, sanitize_filename(name)])
    )
  end

  defp vault_root_taken?(root_path, except_vault_id \\ nil) do
    resolved = Path.expand(root_path)

    Query.maps("SELECT id, root_path FROM vaults", [], [:id, :root_path])
    |> Enum.any?(fn row ->
      row.id != except_vault_id and Path.expand(row.root_path || "") == resolved
    end)
  end

  defp default_string(nil, fallback), do: fallback
  defp default_string("", fallback), do: fallback

  defp default_string(value, _fallback),
    do: value |> to_string() |> String.trim() |> then(&if(&1 == "", do: "", else: &1))

  defp value(map, key) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key)))

  defp value(_, _), do: nil

end
