defmodule Cascade.Chat.Collaborations do
  @moduledoc "Validated durable single-target collaboration handoffs; dispatch persistence is injected."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages, RoomContext, Schema}

  @relationships ~w(builds_on review_request question contradiction decision)

  def create(user, vault_id, channel_id, source_message_id, input, opts \\ []) do
    from_agent = Keyword.get(opts, :access) == :agent
    dispatch = Keyword.get(opts, :dispatch)
    relationship = value(input, "relationship", "") |> to_string()
    instruction = value(input, "instruction", "") |> to_string() |> String.trim()

    with :ok <- validate_dispatch(dispatch),
         {:ok, source} <- Messages.get(channel_id, user.id, source_message_id),
         :ok <- validate_request(relationship, instruction),
         {:ok, members} <- Agents.list_members(channel_id, user.id),
         {:ok, target} <- resolve_target(members, value(input, "target", "")),
         {:ok, caller} <- authorize_caller(user.id, members, target, input, from_agent),
         :ok <- validate_depth(from_agent, user.id, channel_id, source) do
      request_id =
        value(input, "requestId", "")
        |> to_string()
        |> String.trim()
        |> String.slice(0, 180)
        |> nonblank("collab-" <> Ecto.UUID.generate())

      reply = %{
        messageId: source.id,
        author: source.author,
        mention: source_mention(source, members),
        preview: preview(source),
        relationship: relationship
      }

      payload = %{id: request_id, body: "@#{target.mention} #{instruction}", replyTo: reply}
      payload = if from_agent, do: Map.put(payload, :registrationId, caller.id), else: payload

      SQL.transaction(fn ->
        message =
          case Messages.get(channel_id, user.id, request_id) do
            {:ok, existing} ->
              validate_existing!(existing, payload, target)

            _ ->
              case Messages.create(user, vault_id, channel_id, payload,
                     access: if(from_agent, do: :agent, else: :user)
                   ) do
                {:ok, created} -> created
                {:error, reason} -> raise reason
              end
          end

        case dispatch.(%{
               message: message,
               targetRegistrationId: target.id,
               sourceMessageId: source.id,
               relationship: relationship
             }) do
          {:ok, dispatch_record} ->
            %{message: message, dispatch: dispatch_record}

          dispatch_record when is_map(dispatch_record) ->
            %{message: message, dispatch: dispatch_record}

          {:error, reason} ->
            raise "Dispatch unavailable: #{reason}"

          _ ->
            raise "Dispatch unavailable"
        end
      end)
      |> then(&{:ok, &1})
    else
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp resolve_target(members, ref) do
    ref = ref |> to_string() |> String.trim()
    mention = Schema.normalize_mention(ref, "")

    case Enum.find(
           members,
           &(&1.id == ref or Schema.normalize_mention(&1.mention, &1.agentId) == mention)
         ) do
      nil -> {:error, "Agent not found"}
      target -> {:ok, target}
    end
  end

  defp authorize_caller(user_id, members, target, input, true) do
    caller_id = value(input, "registrationId", "") |> to_string() |> String.trim()
    caller = Enum.find(members, &(&1.id == caller_id))

    cond do
      is_nil(caller) or caller.ownerUserId != user_id ->
        {:error, "Agent helper identity is invalid"}

      caller.id == target.id ->
        {:error, "An agent cannot hand work to itself"}

      not target.taggableByAgents ->
        {:error, "@#{target.mention} is not accepting agent handoffs"}

      target.ownerUserId != user_id and not target.pingableByOthers ->
        {:error, "@#{target.mention} is not accepting pings from other users"}

      true ->
        {:ok, caller}
    end
  end

  defp authorize_caller(user_id, _members, target, _input, false) do
    if target.ownerUserId != user_id and not target.pingableByOthers,
      do: {:error, "@#{target.mention} is not accepting pings from other users"},
      else: {:ok, nil}
  end

  defp validate_existing!(existing, input, target) do
    if existing.body != input.body or
         value(existing.replyTo, "messageId", "") != input.replyTo.messageId or
         value(existing.replyTo, "relationship", "") != input.replyTo.relationship,
       do: raise("Collaboration request id is already in use")

    Map.put(existing, :targetRegistrationId, target.id)
  end

  defp validate_dispatch(dispatch),
    do:
      if(is_function(dispatch, 1),
        do: :ok,
        else: {:error, "Agent dispatch integration is unavailable"}
      )

  defp validate_request(relationship, _instruction) when relationship not in @relationships,
    do: {:error, "Invalid collaboration relationship"}

  defp validate_request(_relationship, ""), do: {:error, "Collaboration instruction is required"}

  defp validate_request(_relationship, instruction) when byte_size(instruction) > 8_000,
    do: {:error, "Collaboration instruction is too long"}

  defp validate_request(_relationship, _instruction), do: :ok
  defp validate_depth(false, _user_id, _channel_id, _source), do: :ok

  defp validate_depth(true, user_id, channel_id, source),
    do:
      if(RoomContext.relationship_depth(user_id, channel_id, source) < RoomContext.max_hops(),
        do: :ok,
        else: {:error, "Collaboration hop limit (#{RoomContext.max_hops()}) reached"}
      )

  defp source_mention(source, members) do
    case Enum.find(members, &(&1.id == source[:registrationId])) do
      nil -> Schema.normalize_mention(source.author, "agent")
      member -> member.mention
    end
  end

  defp preview(message) do
    body = message.body |> to_string() |> String.replace(~r/\s+/, " ") |> String.trim()

    cond do
      body != "" ->
        if(String.length(body) > 120, do: String.slice(body, 0, 119) <> "…", else: body)

      message[:hasImages] ->
        "[1 image]"

      List.wrap(message[:attachments]) != [] ->
        List.first(message.attachments)[:name] || "[attachment]"

      true ->
        "(message)"
    end
  end

  defp value(map, key, fallback),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))

  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value
end
