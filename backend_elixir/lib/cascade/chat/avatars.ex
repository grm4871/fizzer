defmodule Cascade.Chat.Avatars do
  @moduledoc "Durable, publicly renderable copies of agent profile images."

  alias Cascade.Accounts.VaultMembers
  alias Cascade.Content.{Assets, Store}

  @image_types ~w(image/png image/jpeg image/gif image/webp)

  def persist(_user_id, agent_id, "") do
    purge(agent_id)
    {:ok, ""}
  end

  def persist(user_id, agent_id, url) do
    case internal_asset(url) do
      {:ok, note_id, asset_id} -> copy_asset(user_id, agent_id, note_id, asset_id)
      :external -> {:error, "Profile picture must be an uploaded note image"}
    end
  end

  def resolve(asset_id) do
    if Regex.match?(~r/^[A-Za-z0-9_-]+$/u, asset_id) do
      directory = directory()

      with {:ok, files} <- File.ls(directory),
           filename when not is_nil(filename) <-
             Enum.find(files, &String.starts_with?(&1, asset_id <> ".")),
           path = Path.join(directory, filename),
           {:ok, %{type: :regular}} <- File.lstat(path) do
        path
      else
        _ -> nil
      end
    end
  end

  def purge(agent_id) do
    if Regex.match?(~r/^[A-Za-z0-9_-]+$/u, agent_id) do
      for pattern <- [agent_id <> ".*", agent_id <> "-*"] do
        directory()
        |> Path.join(pattern)
        |> Path.wildcard()
        |> Enum.each(&File.rm/1)
      end
    end

    :ok
  end

  defp copy_asset(user_id, agent_id, note_id, asset_id) do
    with note when not is_nil(note) <- Store.get_note(note_id),
         role when not is_nil(role) <- VaultMembers.role(note.vault_id, user_id),
         source when not is_nil(source) <- Assets.resolve_path(note_id, asset_id),
         %{content_type: media_type} when media_type in @image_types <-
           Assets.response_metadata(source) do
      extension = Path.extname(source)
      File.mkdir_p!(directory())
      purge(agent_id)
      asset_id = "#{agent_id}-#{System.system_time(:microsecond)}"
      destination = Path.join(directory(), asset_id <> extension)

      temporary =
        destination <> ".tmp-" <> Base.url_encode64(:crypto.strong_rand_bytes(6), padding: false)

      File.cp!(source, temporary)
      File.chmod!(temporary, 0o644)

      File.rename!(temporary, destination)
      {:ok, "/api/notes/agent-avatars/assets/#{asset_id}"}
    else
      nil -> {:error, "Profile picture asset was not found"}
      _ -> {:error, "Profile picture must be a readable image asset"}
    end
  end

  defp internal_asset(url) do
    path = URI.parse(url).path || ""

    case Regex.run(~r{^/api/notes/([^/]+)/assets/([^/]+)$}, path) do
      [_, note_id, asset_id] -> {:ok, note_id, asset_id}
      _ -> :external
    end
  end

  defp directory, do: Path.join(Cascade.Config.data_dir(), "agent-avatars")
end
