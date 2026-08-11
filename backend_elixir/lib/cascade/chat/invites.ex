defmodule Cascade.Chat.Invites do
  @moduledoc "Username and signed-link channel invitations with anti-enumeration and DM isolation."

  alias Cascade.Accounts.{DirectMessages, JWT, SQL}
  alias Cascade.Chat.{Channel, Messages}
  alias Cascade.Content.Store

  @username ~r/^[a-z0-9_]{3,32}$/
  @unreachable "This user is not accepting direct messages"

  def invite_by_username(user, vault_id, channel_id, username) do
    normalized = username |> to_string() |> String.trim() |> String.downcase()

    with {:ok, route} <- source_owner_route(user.id, vault_id, channel_id),
         :ok <- DirectMessages.assert_shareable_channel(route.sourceChannelId),
         true <- Regex.match?(@username, normalized),
         [target_id, target_username, display_name, avatar_url] <-
           SQL.one("SELECT id,username,display_name,avatar_url FROM users WHERE username=?", [
             normalized
           ]),
         false <- target_id == user.id,
         :ok <- DirectMessages.assert_channel_push_allowed(user.id, target_id),
         {:ok, linked} <- link_to_user(route, target_id, user.id),
         {:ok, message} <-
           Messages.create(
             user,
             vault_id,
             channel_id,
             %{
               author: "Cascade",
               body:
                 "@#{user.username} invited @#{target_username} to add this chat to their vault."
             },
             access: :system
           ) do
      {:ok,
       %{
         user: %{
           id: target_id,
           username: target_username,
           displayName: nonblank(display_name, target_username),
           avatarUrl: avatar_url || ""
         },
         vaultId: linked.vaultId,
         channelId: linked.channelId,
         title: linked.title,
         message: message
       }}
    else
      false ->
        {:error, "You already have this chat"}

      true ->
        {:error, @unreachable}

      nil ->
        {:error, @unreachable}

      {:error, "User not found"} ->
        {:error, @unreachable}

      {:error, message} when message in [@unreachable, "Unblock the user to send messages"] ->
        {:error, @unreachable}

      {:error, _} = error ->
        error

      _ ->
        {:error, @unreachable}
    end
  end

  def create_link(user_id, vault_id, channel_id) do
    with {:ok, route} <- source_owner_route(user_id, vault_id, channel_id),
         :ok <- DirectMessages.assert_shareable_channel(route.sourceChannelId) do
      token =
        JWT.sign(
          %{
            "type" => "chat-invite",
            "sourceVaultId" => route.sourceVaultId,
            "sourceChannelId" => route.sourceChannelId
          },
          7 * 24 * 60 * 60
        )

      {:ok, token}
    end
  end

  def preview(token) do
    with {:ok, invite} <- verify(token),
         [title, vault_name, owner] <-
           SQL.one(
             """
               SELECT n.title,v.name,u.username FROM notes n JOIN vaults v ON v.id=n.vault_id
               JOIN users u ON u.id=v.created_by
               WHERE n.id=? AND n.vault_id=? AND n.is_archived=0
                 AND (trim(n.content) LIKE 'cascade://chat-channel%' OR trim(n.content_preview) LIKE 'cascade://chat-channel%')
             """,
             [invite.sourceChannelId, invite.sourceVaultId]
           ),
         false <- DirectMessages.direct_message_channel?(invite.sourceChannelId) do
      {:ok, %{title: title, vaultName: vault_name, owner: owner || "unknown"}}
    else
      _ -> {:error, "Invite not found"}
    end
  end

  def accept(token, user_id) do
    with {:ok, invite} <- verify(token),
         [title, owner_id] <-
           SQL.one(
             """
               SELECT n.title,v.created_by FROM notes n JOIN vaults v ON v.id=n.vault_id
               WHERE n.id=? AND n.vault_id=? AND n.is_archived=0
                 AND (trim(n.content) LIKE 'cascade://chat-channel%' OR trim(n.content_preview) LIKE 'cascade://chat-channel%')
             """,
             [invite.sourceChannelId, invite.sourceVaultId]
           ),
         false <- DirectMessages.direct_message_channel?(invite.sourceChannelId) do
      if owner_id == user_id do
        {:ok,
         %{
           vaultId: invite.sourceVaultId,
           channelId: invite.sourceChannelId,
           title: title,
           alreadyOwned: true
         }}
      else
        link_to_user(
          %{sourceVaultId: invite.sourceVaultId, sourceChannelId: invite.sourceChannelId},
          user_id,
          owner_id
        )
      end
    else
      _ -> {:error, "Invite not found"}
    end
  end

  def verify(token) do
    with {:ok, claims} <- JWT.verify(to_string(token)),
         "chat-invite" <- claims["type"],
         source_vault_id when is_binary(source_vault_id) <- claims["sourceVaultId"],
         source_channel_id when is_binary(source_channel_id) <- claims["sourceChannelId"] do
      {:ok, %{sourceVaultId: source_vault_id, sourceChannelId: source_channel_id}}
    else
      _ -> {:error, "Invalid invite link"}
    end
  end

  def link_to_user(route, user_id, created_by) do
    case SQL.one(
           """
             SELECT l.local_channel_id,l.local_vault_id,n.title FROM chat_channel_links l
             JOIN vaults v ON v.id=l.local_vault_id JOIN notes n ON n.id=l.local_channel_id
             WHERE l.source_channel_id=? AND v.created_by=? ORDER BY l.created_at LIMIT 1
           """,
           [route.sourceChannelId, user_id]
         ) do
      [channel_id, vault_id, title] ->
        {:ok, %{vaultId: vault_id, channelId: channel_id, title: title, created: false}}

      nil ->
        create_projection(route, user_id, created_by)
    end
  end

  defp create_projection(route, user_id, created_by) do
    with [source_title] <-
           SQL.one("SELECT title FROM notes WHERE id=? AND vault_id=?", [
             route.sourceChannelId,
             route.sourceVaultId
           ]) do
      vault = first_owned_vault(user_id) || Store.create_vault(user_id, %{name: "My Vault"})
      title = unique_title(vault.id, source_title)

      note =
        Store.create_note(vault.id, user_id, %{
          title: title,
          content: "cascade://chat-channel\nshared_from=#{route.sourceChannelId}"
        })

      case Channel.link(route.sourceVaultId, route.sourceChannelId, vault.id, note.id, created_by) do
        {:ok, _} ->
          {:ok, %{vaultId: vault.id, channelId: note.id, title: note.title, created: true}}

        {:error, _} = error ->
          error
      end
    else
      _ -> {:error, "Chat channel not found"}
    end
  end

  defp source_owner_route(user_id, vault_id, channel_id) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id),
         true <- route.localChannelId == route.sourceChannelId,
         [^user_id] <- SQL.one("SELECT created_by FROM vaults WHERE id=?", [route.sourceVaultId]) do
      {:ok, route}
    else
      false -> {:error, "Only the chat owner can invite users"}
      [_] -> {:error, "Only the chat owner can invite users"}
      {:error, _} = error -> error
      _ -> {:error, "Chat channel not found"}
    end
  end

  defp first_owned_vault(user_id) do
    case SQL.one(
           """
             SELECT id,name,created_by,created_at FROM vaults WHERE created_by=?
               AND id NOT IN (SELECT vault_id FROM user_dm_vaults) ORDER BY created_at LIMIT 1
           """,
           [user_id]
         ) do
      [id, name, created_by, created_at] ->
        %{id: id, name: name, created_by: created_by, created_at: created_at}

      nil ->
        nil
    end
  end

  defp unique_title(vault_id, requested) do
    base = String.trim(to_string(requested)) |> nonblank("Shared chat")

    if is_nil(
         SQL.one("SELECT 1 FROM notes WHERE vault_id=? AND title=? COLLATE NOCASE", [
           vault_id,
           base
         ])
       ) do
      base
    else
      Enum.find_value(2..500, fn number ->
        candidate = "#{base} (#{number})"

        if is_nil(
             SQL.one("SELECT 1 FROM notes WHERE vault_id=? AND title=? COLLATE NOCASE", [
               vault_id,
               candidate
             ])
           ),
           do: candidate
      end) || "#{base} (#{String.slice(Ecto.UUID.generate(), 0, 8)})"
    end
  end

  defp nonblank(value, fallback),
    do: if(is_binary(value) and String.trim(value) != "", do: String.trim(value), else: fallback)
end
