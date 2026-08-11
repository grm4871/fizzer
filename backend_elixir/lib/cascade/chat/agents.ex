defmodule Cascade.Chat.Agents do
  @moduledoc "Owner-scoped agent identities and vault/channel membership lifecycle."

  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Chat.{Channel, Schema}

  @codex_efforts ~w(low medium high xhigh max ultra)
  @claude_efforts ~w(low medium high xhigh max)

  def list_vault(user_id, vault_id) do
    if VaultMembers.role(vault_id, user_id) do
      agents =
        SQL.all(
          """
          SELECT va.id,va.vault_id,va.agent_id,va.display_name,va.avatar_url,va.mention,
            va.model,va.cwd,va.context_prompt,va.owner_user_id,u.username,va.created_at,va.updated_at
          FROM vault_agents va LEFT JOIN users u ON u.id=va.owner_user_id
          WHERE (va.owner_user_id=? OR va.vault_id=? OR EXISTS(
            SELECT 1 FROM chat_agent_members m WHERE m.vault_agent_id=va.id AND m.vault_id=?
          )) AND NOT EXISTS(
            SELECT 1 FROM vault_agent_exclusions x WHERE x.vault_id=? AND x.vault_agent_id=va.id
          ) ORDER BY va.display_name COLLATE NOCASE,va.mention COLLATE NOCASE
          """,
          [user_id, vault_id, vault_id, vault_id]
        )
        |> Enum.map(&identity/1)
        |> Enum.map(&Map.put(&1, :channelIds, channel_ids(&1.id)))

      {:ok, agents}
    else
      {:error, "Vault not found"}
    end
  end

  def get(user_id, vault_id, identity_id) do
    with {:ok, agents} <- list_vault(user_id, vault_id) do
      case Enum.find(agents, &(&1.id == identity_id)) do
        nil -> {:error, "Vault agent not found"}
        agent -> {:ok, agent}
      end
    end
  end

  def upsert_identity(user_id, vault_id, input) do
    if VaultMembers.role(vault_id, user_id) do
      agent_id = input |> value("agentId", "") |> to_string() |> String.trim()

      id =
        input |> value("id", "") |> to_string() |> String.trim() |> nonblank(Ecto.UUID.generate())

      mention = Schema.normalize_mention(value(input, "mention", ""), agent_id)

      existing =
        SQL.one(
          "SELECT owner_user_id,avatar_url FROM vault_agents WHERE id=? AND (owner_user_id=? OR vault_id=?)",
          [id, user_id, vault_id]
        )

      cond do
        agent_id == "" ->
          {:error, "agentId is required"}

        existing && hd(existing) not in [nil, user_id] ->
          {:error, "Only the agent owner can edit it"}

        identity_clash?(id, mention, user_id, vault_id) ->
          {:error, "Mention @#{mention} is already used by another agent"}

        true ->
          persist_identity(user_id, vault_id, id, agent_id, mention, input, existing)
      end
    else
      {:error, "Vault not found"}
    end
  rescue
    error in Exqlite.Error -> {:error, Exception.message(error)}
  end

  @doc "Unlinks an agent from one vault; the owner-scoped profile and other vault memberships survive."
  def unlink_from_vault(user_id, vault_id, identity_id) do
    with true <- not is_nil(VaultMembers.role(vault_id, user_id)),
         [owner_id] <- SQL.one("SELECT owner_user_id FROM vault_agents WHERE id=?", [identity_id]),
         true <- owner_id in [nil, user_id] do
      SQL.transaction(fn ->
        SQL.exec(
          "INSERT OR IGNORE INTO vault_agent_exclusions(vault_id,vault_agent_id) VALUES(?,?)",
          [vault_id, identity_id]
        )

        SQL.exec("DELETE FROM chat_agent_members WHERE vault_agent_id=? AND vault_id=?", [
          identity_id,
          vault_id
        ])
      end)

      {:ok, true}
    else
      nil -> {:error, "Vault agent not found"}
      false -> {:error, "Vault not found"}
      [_other] -> {:error, "Only the agent owner can remove it"}
      _ -> {:error, "Vault agent not found"}
    end
  end

  @doc "Explicitly retires an owner-scoped profile and every membership."
  def delete_profile(user_id, vault_id, identity_id) do
    with true <- not is_nil(VaultMembers.role(vault_id, user_id)),
         [owner_id] <- SQL.one("SELECT owner_user_id FROM vault_agents WHERE id=?", [identity_id]),
         true <- owner_id in [nil, user_id] do
      deleted =
        SQL.transaction(fn ->
          SQL.exec("DELETE FROM chat_agent_members WHERE vault_agent_id=?", [identity_id])
          SQL.changes("DELETE FROM vault_agents WHERE id=?", [identity_id]) > 0
        end)

      {:ok, deleted}
    else
      false -> {:error, "Vault not found"}
      [_other] -> {:error, "Only the agent owner can delete it"}
      _ -> {:error, "Vault agent not found"}
    end
  end

  def list_members(channel_id, user_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      members =
        SQL.all(
          """
            SELECT m.id,m.vault_agent_id,va.owner_user_id,m.agent_id,m.display_name,m.avatar_url,
              m.mention,m.model,m.reasoning_effort,m.priority_service_tier,m.cwd,m.context_prompt,
              m.taggable_by_agents,m.reply_to_every_message,m.orchestrator,m.pingable_by_others,
              m.yolo,m.conversation_id FROM chat_agent_members m
            LEFT JOIN vault_agents va ON va.id=m.vault_agent_id
            WHERE m.channel_id=? ORDER BY m.created_at,m.rowid
          """,
          [route.sourceChannelId]
        )
        |> Enum.map(&member/1)

      {:ok, members}
    end
  end

  def add_to_channel(user_id, vault_id, channel_id, identity_id, flags \\ %{}) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id),
         [
           id,
           _home_vault,
           agent_id,
           display_name,
           avatar_url,
           mention,
           model,
           cwd,
           prompt,
           owner_id | _
         ] <-
           SQL.one(
             "SELECT id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt,owner_user_id,created_at,updated_at FROM vault_agents WHERE id=? AND (owner_user_id=? OR vault_id=?)",
             [identity_id, user_id, route.localVaultId]
           ),
         :ok <- manage_identity(owner_id, user_id),
         :ok <- member_handle_available(route.sourceChannelId, identity_id, mention) do
      existing =
        SQL.one(
          "SELECT id,reasoning_effort,priority_service_tier,taggable_by_agents,reply_to_every_message,orchestrator,pingable_by_others,yolo,conversation_id FROM chat_agent_members WHERE vault_agent_id=? AND channel_id=?",
          [identity_id, route.sourceChannelId]
        )

      registration_id = if existing, do: hd(existing), else: Ecto.UUID.generate()

      effort =
        supported_effort(
          agent_id,
          value(flags, "reasoningEffort", existing_value(existing, 1, ""))
        )

      priority =
        agent_id == "codex" and
          boolean(flags, "priorityServiceTier", existing_value(existing, 2, 0) != 0)

      taggable = boolean(flags, "taggableByAgents", existing_value(existing, 3, 0) != 0)
      orchestrator = boolean(flags, "orchestrator", existing_value(existing, 5, 0) != 0)

      reply_every =
        orchestrator or boolean(flags, "replyToEveryMessage", existing_value(existing, 4, 0) != 0)

      pingable = boolean(flags, "pingableByOthers", existing_value(existing, 6, 0) != 0)
      yolo = boolean(flags, "yolo", existing_value(existing, 7, 0) != 0)

      conversation_id =
        value(flags, "conversationId", existing_value(existing, 8, ""))
        |> to_string()
        |> String.trim()
        |> nonblank(Ecto.UUID.generate())

      with :ok <-
             coordinator_available(route.sourceChannelId, registration_id, owner_id, orchestrator) do
        SQL.transaction(fn ->
          SQL.exec("DELETE FROM vault_agent_exclusions WHERE vault_id=? AND vault_agent_id=?", [
            route.localVaultId,
            identity_id
          ])

          SQL.exec(
            """
            INSERT INTO chat_agent_members(id,channel_id,vault_id,vault_agent_id,agent_id,display_name,avatar_url,
              mention,model,reasoning_effort,priority_service_tier,cwd,context_prompt,taggable_by_agents,
              reply_to_every_message,orchestrator,pingable_by_others,yolo,conversation_id)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
              agent_id=excluded.agent_id,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
              mention=excluded.mention,model=excluded.model,reasoning_effort=excluded.reasoning_effort,
              priority_service_tier=excluded.priority_service_tier,cwd=excluded.cwd,
              context_prompt=excluded.context_prompt,taggable_by_agents=excluded.taggable_by_agents,
              reply_to_every_message=excluded.reply_to_every_message,orchestrator=excluded.orchestrator,
              pingable_by_others=excluded.pingable_by_others,yolo=excluded.yolo,
              conversation_id=excluded.conversation_id,updated_at=datetime('now')
            """,
            [
              registration_id,
              route.sourceChannelId,
              route.localVaultId,
              id,
              agent_id,
              display_name,
              avatar_url || "",
              mention,
              model || "",
              effort,
              bool_int(priority),
              cwd || "",
              prompt || "",
              bool_int(taggable),
              bool_int(reply_every),
              bool_int(orchestrator),
              bool_int(pingable),
              bool_int(yolo),
              conversation_id
            ]
          )
        end)

        list_members(channel_id, user_id) |> map_ok_find(registration_id)
      end
    else
      nil -> {:error, "Vault agent not found"}
      {:error, _} = error -> error
      _ -> {:error, "Vault agent not found"}
    end
  end

  def upsert_member(user_id, vault_id, channel_id, input) do
    case value(input, "vaultAgentId", "") |> to_string() |> String.trim() do
      "" ->
        with {:ok, identity} <- upsert_identity(user_id, vault_id, input) do
          add_to_channel(user_id, vault_id, channel_id, identity.id, input)
        end

      identity_id ->
        add_to_channel(user_id, vault_id, channel_id, identity_id, input)
    end
  end

  def remove_member(user_id, vault_id, channel_id, registration_id) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id),
         [owner_id] <-
           SQL.one(
             """
               SELECT va.owner_user_id FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
               WHERE m.id=? AND m.channel_id=?
             """,
             [registration_id, route.sourceChannelId]
           ),
         :ok <- manage_identity(owner_id, user_id) do
      {:ok,
       SQL.changes("DELETE FROM chat_agent_members WHERE id=? AND channel_id=?", [
         registration_id,
         route.sourceChannelId
       ]) > 0}
    else
      nil -> {:error, "Agent member not found"}
      {:error, _} = error -> error
    end
  end

  def set_avatar(user_id, vault_id, channel_id, registration_id, avatar_url) do
    url = avatar_url |> to_string() |> String.trim()

    with true <- url == "" or Regex.match?(~r{^https?://}i, url),
         true <- String.length(url) <= 2_048,
         {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user_id),
         [identity_id, ^user_id] <-
           SQL.one(
             """
               SELECT m.vault_agent_id,va.owner_user_id FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
               WHERE m.id=? AND m.channel_id=?
             """,
             [registration_id, route.sourceChannelId]
           ) do
      SQL.transaction(fn ->
        SQL.exec("UPDATE vault_agents SET avatar_url=?,updated_at=datetime('now') WHERE id=?", [
          url,
          identity_id
        ])

        SQL.exec(
          "UPDATE chat_agent_members SET avatar_url=?,updated_at=datetime('now') WHERE vault_agent_id=?",
          [url, identity_id]
        )
      end)

      list_members(channel_id, user_id) |> map_ok_find(registration_id)
    else
      false when byte_size(url) > 2_048 -> {:error, "Profile picture URL is too long"}
      false -> {:error, "Profile picture must be an http(s) URL"}
      [_id, _owner] -> {:error, "Only the agent owner can update its profile picture"}
      {:error, _} = error -> error
      _ -> {:error, "Agent not found"}
    end
  end

  def ensure_vault_wide(user_id, vault_id, channel_id) do
    with {:ok, identities} <- list_vault(user_id, vault_id) do
      Enum.each(identities, fn identity ->
        case add_to_channel(user_id, vault_id, channel_id, identity.id) do
          {:ok, _} -> :ok
          _ -> :ok
        end
      end)

      list_members(channel_id, user_id)
    end
  end

  def resolve_owner_projection(user_id, channel_id, registration_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         row when not is_nil(row) <-
           SQL.one(
             """
               SELECT m.id,m.vault_agent_id,va.owner_user_id FROM chat_agent_members m
               JOIN vault_agents va ON va.id=m.vault_agent_id WHERE m.id=? AND m.channel_id=?
             """,
             [registration_id, route.sourceChannelId]
           ) do
      [_registration, _identity, owner_id] = row

      owner_route =
        Enum.find(Channel.list_routes(route.sourceVaultId, route.sourceChannelId), fn candidate ->
          SQL.one("SELECT created_by FROM vaults WHERE id=?", [candidate.localVaultId]) == [
            owner_id
          ]
        end) || direct_owner_route(route, owner_id)

      if owner_route do
        {:ok,
         %{
           route: route,
           ownerId: owner_id,
           ownerChannelId: owner_route.localChannelId,
           ownerVaultId: owner_route.localVaultId
         }}
      else
        {:error, "Agent not found"}
      end
    else
      _ -> {:error, "Agent not found"}
    end
  end

  defp persist_identity(user_id, vault_id, id, agent_id, mention, input, existing) do
    display_name =
      value(input, "displayName", "") |> to_string() |> String.trim() |> nonblank(agent_id)

    avatar =
      value(input, "avatarUrl", if(existing, do: Enum.at(existing, 1) || "", else: ""))
      |> to_string()
      |> String.trim()

    model = value(input, "model", "") |> to_string()
    cwd = value(input, "cwd", "") |> to_string()
    prompt = value(input, "contextPrompt", "") |> to_string()

    SQL.transaction(fn ->
      SQL.exec(
        """
        INSERT INTO vault_agents(id,vault_id,agent_id,display_name,avatar_url,mention,model,cwd,context_prompt,owner_user_id)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
          agent_id=excluded.agent_id,display_name=excluded.display_name,avatar_url=excluded.avatar_url,
          mention=excluded.mention,model=excluded.model,cwd=excluded.cwd,context_prompt=excluded.context_prompt,
          updated_at=datetime('now')
        """,
        [id, vault_id, agent_id, display_name, avatar, mention, model, cwd, prompt, user_id]
      )

      SQL.exec(
        """
        UPDATE chat_agent_members SET agent_id=?,display_name=?,avatar_url=?,mention=?,model=?,cwd=?,
          context_prompt=?,updated_at=datetime('now') WHERE vault_agent_id=?
        """,
        [agent_id, display_name, avatar, mention, model, cwd, prompt, id]
      )

      SQL.exec("DELETE FROM vault_agent_exclusions WHERE vault_id=? AND vault_agent_id=?", [
        vault_id,
        id
      ])
    end)

    get(user_id, vault_id, id)
  end

  defp identity([
         id,
         vault_id,
         agent_id,
         display_name,
         avatar,
         mention,
         model,
         cwd,
         prompt,
         owner_id,
         owner_username,
         created_at,
         updated_at
       ]) do
    %{
      id: id,
      vaultId: vault_id,
      agentId: agent_id,
      displayName: display_name,
      avatarUrl: avatar || "",
      mention: mention,
      model: model || "",
      cwd: cwd || "",
      contextPrompt: prompt || "",
      ownerUserId: owner_id,
      ownerUsername: owner_username || "",
      createdAt: created_at,
      updatedAt: updated_at
    }
  end

  defp member([
         id,
         identity_id,
         owner_id,
         agent_id,
         name,
         avatar,
         mention,
         model,
         effort,
         priority,
         cwd,
         prompt,
         taggable,
         reply_every,
         orchestrator,
         pingable,
         yolo,
         conversation_id
       ]) do
    %{
      id: id,
      vaultAgentId: identity_id,
      ownerUserId: owner_id || 0,
      agentId: agent_id,
      displayName: name,
      avatarUrl: avatar || "",
      mention: mention,
      model: model || "",
      reasoningEffort: effort || "",
      priorityServiceTier: priority != 0,
      cwd: cwd || "",
      contextPrompt: prompt || "",
      taggableByAgents: taggable != 0,
      replyToEveryMessage: reply_every != 0,
      orchestrator: orchestrator != 0,
      pingableByOthers: pingable != 0,
      yolo: yolo != 0,
      conversationId: conversation_id || ""
    }
  end

  defp channel_ids(id),
    do:
      SQL.all(
        "SELECT DISTINCT channel_id FROM chat_agent_members WHERE vault_agent_id=? ORDER BY channel_id",
        [id]
      )
      |> List.flatten()

  defp identity_clash?(id, mention, user_id, vault_id),
    do:
      not is_nil(
        SQL.one(
          "SELECT 1 FROM vault_agents WHERE mention=? COLLATE NOCASE AND id!=? AND (owner_user_id=? OR vault_id=?)",
          [mention, id, user_id, vault_id]
        )
      )

  defp member_handle_available(channel_id, identity_id, mention),
    do:
      if(
        SQL.one(
          "SELECT 1 FROM chat_agent_members WHERE channel_id=? AND mention=? COLLATE NOCASE AND vault_agent_id!=?",
          [channel_id, mention, identity_id]
        ),
        do: {:error, "@#{mention} is already used by another agent in this vault"},
        else: :ok
      )

  defp manage_identity(owner_id, user_id),
    do:
      if(owner_id in [nil, user_id],
        do: :ok,
        else: {:error, "You can only manage assistants in your own roster"}
      )

  defp coordinator_available(_channel, _registration, _owner, false), do: :ok

  defp coordinator_available(channel, registration, owner, true) do
    case SQL.one(
           """
             SELECT m.display_name,m.mention FROM chat_agent_members m JOIN vault_agents va ON va.id=m.vault_agent_id
             WHERE m.channel_id=? AND m.orchestrator!=0 AND m.id!=? AND va.owner_user_id=? LIMIT 1
           """,
           [channel, registration, owner]
         ) do
      [name, mention] ->
        {:error, "#{nonblank(name || "", "@#{mention}")} already coordinates this channel"}

      _ ->
        :ok
    end
  end

  defp supported_effort("codex", effort),
    do: if(to_string(effort) in @codex_efforts, do: to_string(effort), else: "")

  defp supported_effort("claude-code", effort),
    do: if(to_string(effort) in @claude_efforts, do: to_string(effort), else: "")

  defp supported_effort(_, _), do: ""
  defp existing_value(nil, _index, fallback), do: fallback
  defp existing_value(row, index, _fallback), do: Enum.at(row, index)

  defp boolean(map, key, fallback) do
    case fetch(map, key) do
      {:ok, value} -> value == true
      :error -> fallback
    end
  end

  defp fetch(map, key) do
    case Map.fetch(map, key) do
      {:ok, value} -> {:ok, value}
      :error -> Map.fetch(map, String.to_atom(key))
    end
  end

  defp value(map, key, fallback),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))

  defp bool_int(true), do: 1
  defp bool_int(_), do: 0
  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value

  defp map_ok_find({:ok, values}, id) do
    case Enum.find(values, &(&1.id == id)) do
      nil -> {:error, "Agent not found"}
      value -> {:ok, value}
    end
  end

  defp map_ok_find(error, _id), do: error

  defp direct_owner_route(route, owner_id) do
    case Channel.assert_channel(route.sourceChannelId, owner_id) do
      {:ok, owner_route} -> owner_route
      _ -> nil
    end
  end
end
