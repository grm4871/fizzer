defmodule Cascade.Chat.Avatars do
  @moduledoc "Durable, publicly renderable copies of agent profile images."

  alias Cascade.Accounts.VaultMembers
  alias Cascade.Content.{Assets, Store}

  @image_types ~w(image/png image/jpeg image/gif image/webp)

  def persist(user_id, agent_id, url) do
    case internal_asset(url) do
      {:ok, note_id, asset_id} -> copy_asset(user_id, agent_id, note_id, asset_id)
      :external -> {:ok, url}
    end
  end

  def resolve(agent_id) do
    if Regex.match?(~r/^[A-Za-z0-9_-]+$/u, agent_id) do
      directory = directory()

      with {:ok, files} <- File.ls(directory),
           filename when not is_nil(filename) <-
             Enum.find(files, &String.starts_with?(&1, agent_id <> ".")),
           path = Path.join(directory, filename),
           {:ok, %{type: :regular}} <- File.lstat(path) do
        path
      else
        _ -> nil
      end
    end
  end

  defp copy_asset(user_id, agent_id, note_id, asset_id) do
    with note when not is_nil(note) <- Store.get_note(note_id),
         role when not is_nil(role) <- VaultMembers.role(note.vault_id, user_id),
         source when not is_nil(source) <- Assets.resolve_path(note_id, asset_id),
         %{content_type: media_type} when media_type in @image_types <-
           Assets.response_metadata(source) do
      extension = Path.extname(source)
      File.mkdir_p!(directory())
      destination = Path.join(directory(), agent_id <> extension)

      temporary =
        destination <> ".tmp-" <> Base.url_encode64(:crypto.strong_rand_bytes(6), padding: false)

      File.cp!(source, temporary)
      File.chmod!(temporary, 0o644)

      directory()
      |> Path.join(agent_id <> ".*")
      |> Path.wildcard()
      |> Enum.reject(&(&1 == temporary))
      |> Enum.each(&File.rm/1)

      File.rename!(temporary, destination)
      version = File.stat!(destination).mtime |> :calendar.datetime_to_gregorian_seconds()
      {:ok, "/api/notes/agent-avatars/assets/#{agent_id}?v=#{version}"}
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
