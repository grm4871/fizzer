defmodule Cascade.Chat.Avatars do
  @moduledoc "Durable, publicly renderable copies of agent profile images."

  alias Cascade.Accounts.VaultMembers
  alias Cascade.Content.{Assets, Store}

  @image_types ~w(image/png image/jpeg image/gif image/webp)

  def persist(_user_id, agent_id, "") do
    purge(agent_id)
    {:ok, ""}
  end

  def persist(_user_id, agent_id, "data:" <> data) do
    with [media_type, encoded] <- String.split(data, ";base64,", parts: 2),
         true <- media_type in @image_types,
         true <- byte_size(encoded) <= 2_796_204,
         bytes <- Assets.decode_data(encoded),
         true <- byte_size(bytes) <= 2 * 1_024 * 1_024,
         true <- Assets.matches_media_type?(media_type, bytes) do
      extension = "." <> String.replace_prefix(media_type, "image/", "")
      write_image(agent_id, extension, bytes)
    else
      _ -> {:error, "Profile picture must be a PNG, JPEG, GIF or WebP image up to 2MB"}
    end
  rescue
    ArgumentError -> {:error, "Profile picture data is not valid base64"}
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
      write_image(agent_id, Path.extname(source), File.read!(source))
    else
      nil -> {:error, "Profile picture asset was not found"}
      _ -> {:error, "Profile picture must be a readable image asset"}
    end
  end

  defp write_image(agent_id, extension, bytes) do
    File.mkdir_p!(directory())
    asset_id = "#{agent_id}-#{System.system_time(:microsecond)}"
    destination = Path.join(directory(), asset_id <> extension)

    temporary =
      Path.join(directory(), ".upload-") <>
        Base.url_encode64(:crypto.strong_rand_bytes(6), padding: false)

    File.write!(temporary, bytes)
    File.chmod!(temporary, 0o644)
    purge(agent_id)
    File.rename!(temporary, destination)
    {:ok, "/api/notes/agent-avatars/assets/#{asset_id}"}
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
