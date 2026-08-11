defmodule Cascade.Missions.Dispatches do
  @moduledoc "Durable, idempotent chat-to-agent dispatch outbox used by mission scheduling."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages, RoomContext, Schema}

  def create_for_message(user_id, channel_id, message) do
    if String.starts_with?(to_string(field(message, :id, "")), "sys-") do
      {:ok, []}
    else
      with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
           {:ok, members} <- Agents.list_members(channel_id, user_id) do
        targets = resolve_targets(user_id, channel_id, message, members)
        remove_stale_coordinator_wakes(route.sourceChannelId, message, targets)

        Enum.reduce_while(targets, {:ok, []}, fn registration, {:ok, dispatches} ->
          case create(user_id, channel_id, message, registration.id) do
            {:ok, dispatch} -> {:cont, {:ok, dispatches ++ [dispatch]}}
            {:error, _} = error -> {:halt, error}
          end
        end)
      end
    end
  end

  def create(user_id, channel_id, message, registration_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, members} <- Agents.list_members(channel_id, user_id),
         registration when not is_nil(registration) <-
           Enum.find(members, &(&1.id == registration_id)) do
      effort = opts |> Keyword.get(:reasoning_effort, "") |> clean(20) |> String.downcase()

      SQL.exec(
        """
        INSERT OR IGNORE INTO chat_agent_dispatches
          (id,message_id,channel_id,registration_id,reasoning_effort)
        VALUES (?,?,?,?,?)
        """,
        [Ecto.UUID.generate(), message.id, route.sourceChannelId, registration.id, effort]
      )

      case SQL.one(
             "SELECT id,message_id,channel_id,registration_id,run_id,reasoning_effort,created_at FROM chat_agent_dispatches WHERE message_id=? AND registration_id=?",
             [message.id, registration.id]
           ) do
        nil -> {:error, "Could not create chat agent dispatch"}
        row -> hydrate(user_id, channel_id, row)
      end
    else
      nil -> {:error, "Agent not found"}
      {:error, _} = error -> error
    end
  rescue
    error in Exqlite.Error -> {:error, Exception.message(error)}
  end

  def list_pending(user_id, channel_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      dispatches =
        SQL.all(
          """
          SELECT id,message_id,channel_id,registration_id,run_id,reasoning_effort,created_at
          FROM chat_agent_dispatches
          WHERE channel_id=? AND run_id IS NULL
          ORDER BY created_at ASC,id ASC
          """,
          [route.sourceChannelId]
        )
        |> Enum.reduce([], fn row, acc ->
          case hydrate(user_id, channel_id, row) do
            {:ok, dispatch}
            when dispatch.registration.ownerUserId == user_id or
                   dispatch.registration.pingableByOthers ->
              [dispatch | acc]

            _ ->
              acc
          end
        end)
        |> Enum.reverse()

      {:ok, dispatches}
    end
  end

  def get(user_id, channel_id, dispatch_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         row when not is_nil(row) <-
           SQL.one(
             "SELECT id,message_id,channel_id,registration_id,run_id,reasoning_effort,created_at FROM chat_agent_dispatches WHERE id=? AND channel_id=?",
             [dispatch_id, route.sourceChannelId]
           ) do
      hydrate(user_id, channel_id, row)
    else
      nil -> {:error, "Chat dispatch not found"}
      {:error, _} = error -> error
    end
  end

  def attach_run(dispatch_id, run_id) when is_integer(run_id) and run_id > 0 do
    SQL.exec("UPDATE chat_agent_dispatches SET run_id=COALESCE(run_id,?) WHERE id=?", [
      run_id,
      dispatch_id
    ])

    :ok
  end

  def attach_run(_dispatch_id, _run_id), do: {:error, "Invalid run id"}

  defp resolve_targets(user_id, channel_id, message, registrations) do
    from_agent = present?(field(message, :registrationId)) or present?(field(message, :agentId))

    if from_agent and is_map(field(message, :replyTo)) and
         present?(field(field(message, :replyTo), :relationship)) and
         RoomContext.relationship_depth(user_id, channel_id, message) > RoomContext.max_hops() do
      []
    else
      do_resolve_targets(user_id, channel_id, message, registrations, from_agent)
    end
  end

  defp do_resolve_targets(user_id, channel_id, message, registrations, from_agent) do
    reply = field(message, :replyTo) || %{}

    replied =
      case field(reply, :messageId) do
        id when is_binary(id) and id != "" ->
          case Messages.get(channel_id, user_id, id) do
            {:ok, item} -> item
            _ -> nil
          end

        _ ->
          nil
      end

    implicit_reply =
      if not from_agent and is_map(replied) and present?(field(replied, :registrationId)) and
           present?(field(reply, :mention)),
         do: "@#{field(reply, :mention)}",
         else: ""

    direct_source = message_source(message)
    has_direct_mention = Enum.any?(registrations, &mentions?(direct_source, &1))

    source =
      Enum.join(
        Enum.reject(
          [if(has_direct_mention, do: "", else: implicit_reply), direct_source],
          &(&1 == "")
        ),
        " "
      )

    explicit_ids =
      registrations
      |> Enum.filter(&mentions?(source, &1))
      |> MapSet.new(& &1.id)

    calls_specialist =
      Enum.any?(registrations, &(not &1.orchestrator and MapSet.member?(explicit_ids, &1.id)))

    registrations
    |> Enum.reduce({[], MapSet.new()}, fn registration, {selected, seen} ->
      explicit = MapSet.member?(explicit_ids, registration.id)

      always =
        not from_agent and registration.ownerUserId == user_id and
          registration.replyToEveryMessage and
          not (registration.orchestrator and calls_specialist)

      identity = registration.vaultAgentId || registration.id

      allowed =
        registration.id != field(message, :registrationId) and
          if(from_agent,
            do: registration.taggableByAgents,
            else: registration.ownerUserId == user_id or registration.pingableByOthers
          ) and
          (explicit or always) and not MapSet.member?(seen, identity)

      if allowed,
        do: {selected ++ [registration], MapSet.put(seen, identity)},
        else: {selected, seen}
    end)
    |> elem(0)
  end

  defp remove_stale_coordinator_wakes(source_channel_id, message, targets) do
    from_agent = present?(field(message, :registrationId)) or present?(field(message, :agentId))

    if not from_agent do
      targets
      |> Enum.filter(& &1.orchestrator)
      |> Enum.each(fn registration ->
        SQL.exec(
          """
          DELETE FROM chat_agent_dispatches
          WHERE channel_id=? AND registration_id=? AND run_id IS NULL
            AND message_id LIKE 'sys-mission-%'
          """,
          [source_channel_id, registration.id]
        )
      end)
    end
  end

  defp message_source(message) do
    attachments =
      message
      |> field(:attachments, [])
      |> List.wrap()
      |> Enum.map(&field(&1, :name, ""))

    [field(message, :body, "") | attachments]
    |> Enum.map(&to_string/1)
    |> Enum.reject(&(&1 == ""))
    |> Enum.join(" ")
  end

  defp mentions?(text, registration) do
    mention = Schema.normalize_mention(registration.mention, registration.agentId)

    mention != "" and
      Regex.match?(
        Regex.compile!("@\\s*" <> Regex.escape(mention) <> "(?=$|[\\s.,:;!?\\])}])", "i"),
        text
      )
  end

  defp hydrate(user_id, local_channel_id, [
         id,
         message_id,
         _source_channel_id,
         registration_id,
         run_id,
         reasoning_effort,
         created_at
       ]) do
    with {:ok, members} <- Agents.list_members(local_channel_id, user_id),
         registration when not is_nil(registration) <-
           Enum.find(members, &(&1.id == registration_id)),
         {:ok, message} <- Messages.get(local_channel_id, user_id, message_id) do
      {:ok,
       %{
         id: id,
         messageId: message_id,
         channelId: local_channel_id,
         registration: registration,
         message: message,
         runId: run_id,
         reasoningEffort: reasoning_effort || "",
         createdAt: created_at
       }}
    else
      _ -> {:error, "Chat dispatch not found"}
    end
  end

  defp clean(value, max) do
    value |> to_string() |> String.trim() |> String.slice(0, max)
  end

  defp field(map, key, fallback \\ nil)

  defp field(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))

  defp field(_map, _key, fallback), do: fallback
  defp present?(value), do: not is_nil(value) and String.trim(to_string(value)) != ""
end
