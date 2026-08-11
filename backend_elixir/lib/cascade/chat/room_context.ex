defmodule Cascade.Chat.RoomContext do
  @moduledoc "Bounded room snapshots and durable typed reply ancestry."

  alias Cascade.Chat.{Messages, Schema}

  @max_hops 4
  def max_hops, do: @max_hops

  def infer_relationship(text) do
    value =
      text |> to_string() |> String.replace(~r/\s+/, " ") |> String.trim() |> String.downcase()

    cond do
      value == "" ->
        nil

      Regex.match?(
        ~r/\b(?:contradict|disagree with|push back on|argue against|challenge (?:this|that|the)|find (?:the )?flaws? in|devil['’]s advocate)\b/,
        value
      ) ->
        "contradiction"

      Regex.match?(
        ~r/\b(?:make the call|settle (?:this|that)|decide (?:this|that|between|which)|choose between|which (?:one|option|approach).{0,30}\bchoose)\b/,
        value
      ) ->
        "decision"

      Regex.match?(
        ~r/\b(?:what do you think|thoughts on (?:this|that|the)|review (?:this|that|the|my)|critique (?:this|that|the|my)|audit (?:this|that|the)|check (?:this|that|the (?:proposal|result|answer|approach|plan|evidence|claim)))\b/,
        value
      ) ->
        "review_request"

      Regex.match?(
        ~r/\b(?:build on|build upon|extend (?:this|that|the)|continue from|take (?:this|that) further|carry (?:this|that) forward)\b/,
        value
      ) ->
        "builds_on"

      String.contains?(value, "?") and
          Regex.match?(
            ~r/\b(?:this|that|it|above|previous|proposal|result|answer|approach|plan|evidence|claim)\b/,
            value
          ) ->
        "question"

      true ->
        nil
    end
  end

  def infer_natural_link(input, prior_messages, registrations) do
    reply = value(input, "replyTo")
    relationship = infer_relationship(value(input, "body", ""))

    cond do
      is_map(reply) and value(reply, "relationship") ->
        input

      is_nil(relationship) ->
        input

      is_map(reply) ->
        put_flexible(input, "replyTo", put_flexible(reply, "relationship", relationship))

      not mentions_any_agent?(input, registrations) ->
        input

      true ->
        infer_from_prior(input, prior_messages, registrations, relationship)
    end
  end

  def relationship_depth(user_id, channel_id, source) do
    do_depth(user_id, channel_id, source, MapSet.new(), 0)
  end

  def build_context(opts) do
    messages = value(opts, "messages", [])
    registrations = value(opts, "registrations", [])
    target_id = value(opts, "targetRegistrationId", "")
    continuation = value(opts, "continuation", false) == true
    cursor = value(opts, "cursorMessageId", "")
    max_chars = max(1_200, value(opts, "maxChars", 2_800))
    excluded = MapSet.new(value(opts, "excludeMessageIds", []))

    visible =
      messages
      |> Enum.reject(&MapSet.member?(excluded, value(&1, "id")))
      |> Enum.filter(fn message ->
        body = value(message, "body", "") |> to_string() |> String.trim()

        body != "Thinking..." and
          (body != "" or value(message, "hasImages", false) or
             List.wrap(value(message, "images")) != [] or
             List.wrap(value(message, "attachments")) != [])
      end)

    last_own_index =
      visible
      |> Enum.with_index()
      |> Enum.filter(fn {message, _index} -> value(message, "registrationId") == target_id end)
      |> List.last()
      |> case do
        nil -> -1
        {_message, index} -> index
      end

    delta =
      if last_own_index >= 0,
        do: Enum.drop(visible, last_own_index + 1),
        else: Enum.take(visible, -8)

    delta = Enum.reject(delta, &(value(&1, "registrationId") == target_id)) |> Enum.take(-10)
    target = Enum.find(registrations, &(value(&1, "id") == target_id))

    participant_labels =
      (visible
       |> Enum.filter(&(is_nil(value(&1, "agentId")) and value(&1, "author") != "Cascade"))
       |> Enum.map(&value(&1, "author", ""))
       |> Enum.reject(&(&1 == ""))
       |> Enum.uniq()
       |> Enum.take(-8)) ++
        (registrations
         |> Enum.take(10)
         |> Enum.map(fn registration ->
           "#{value(registration, "displayName", value(registration, "agentId", "agent"))} (@#{value(registration, "mention", value(registration, "agentId", "agent"))})"
         end))

    sections = []

    sections =
      if not continuation and participant_labels != [],
        do: ["Participants: " <> compact(Enum.join(participant_labels, "; "), 720) | sections],
        else: sections

    label =
      if last_own_index >= 0 and target,
        do: "Since @#{value(target, "mention", value(target, "agentId", "agent"))} last spoke",
        else: "Recent room conversation"

    sections =
      if delta != [],
        do: [label <> ":\n" <> Enum.map_join(delta, "\n", &message_line/1) | sections],
        else: sections

    body = sections |> Enum.reverse() |> Enum.join("\n\n")

    header =
      if continuation,
        do: "Shared room delta (append-only cursor message #{cursor}):",
        else: "Shared room state (cold-start snapshot message #{cursor}):"

    footer =
      "The focused request is authoritative. For lossless context around the cursor, use `cascade-chat history --around-message-id #{if cursor == "", do: "<id>", else: cursor} --include-reply-context`; use `cascade-chat search <query>` for older topics."

    compact("#{header}\n#{body}\n\n#{footer}", max_chars)
  end

  defp do_depth(_user_id, _channel_id, _source, _seen, depth) when depth > @max_hops, do: depth

  defp do_depth(user_id, channel_id, source, seen, depth) do
    id = value(source, "id")
    reply = value(source, "replyTo")
    parent_id = value(reply, "messageId")

    cond do
      not is_map(reply) or is_nil(value(reply, "relationship")) or is_nil(parent_id) ->
        depth

      MapSet.member?(seen, id) ->
        @max_hops + 1

      true ->
        case Messages.get(channel_id, user_id, parent_id) do
          {:ok, parent} -> do_depth(user_id, channel_id, parent, MapSet.put(seen, id), depth + 1)
          _ -> depth + 1
        end
    end
  end

  defp infer_from_prior(input, prior, registrations, relationship) do
    source =
      prior
      |> Enum.reverse()
      |> Enum.find(fn message ->
        preview = preview(message)

        body =
          value(message, "body", "")
          |> to_string()
          |> String.replace(~r/\s+/, " ")
          |> String.trim()

        value(message, "status") != "running" and preview != "(message)" and
          (value(message, "registrationId") || value(message, "agentId") ||
             String.length(body) >= 24 || has_media?(message))
      end)

    if source do
      registration =
        Enum.find(registrations, &(value(&1, "id") == value(source, "registrationId")))

      reply = %{
        messageId: value(source, "id"),
        author: value(source, "author", ""),
        mention:
          if(registration,
            do: value(registration, "mention", ""),
            else: Schema.normalize_mention(value(source, "author", "agent"))
          ),
        preview: preview(source, 120),
        relationship: relationship
      }

      put_flexible(input, "replyTo", reply)
    else
      input
    end
  end

  defp mentions_any_agent?(input, registrations) do
    text =
      ([value(input, "body", "")] ++
         Enum.map(List.wrap(value(input, "attachments")), &value(&1, "name", "")))
      |> Enum.join(" ")

    Enum.any?(registrations, fn registration ->
      mention =
        Schema.normalize_mention(
          value(registration, "mention", value(registration, "agentId", ""))
        )

      Regex.match?(
        Regex.compile!("@\\s*" <> Regex.escape(mention) <> "(?=$|[\\s.,:;!?\\])}])", "i"),
        text
      )
    end)
  end

  defp message_line(message) do
    reply = value(message, "replyTo")

    relation =
      if is_map(reply) and value(reply, "relationship"),
        do:
          "; #{value(reply, "relationship")} → #{value(reply, "author", value(reply, "mention", "linked message"))}",
        else: ""

    "- #{value(message, "author", "")} [#{value(message, "id", "")}#{relation}]: #{preview(message, 220)}"
  end

  defp preview(message, max_chars \\ 180) do
    body = value(message, "body", "") |> to_string() |> compact(max_chars)

    cond do
      body not in ["", "Thinking..."] ->
        body

      value(message, "hasImages", false) or List.wrap(value(message, "images")) != [] ->
        "[#{max(1, length(List.wrap(value(message, "images"))))} image]"

      List.wrap(value(message, "attachments")) != [] ->
        "[attachment: #{value(hd(List.wrap(value(message, "attachments"))), "name", "file")}]"

      true ->
        "(message)"
    end
  end

  defp has_media?(message),
    do:
      value(message, "hasImages", false) or List.wrap(value(message, "images")) != [] or
        List.wrap(value(message, "attachments")) != []

  defp compact(value, max_chars) do
    text = value |> to_string() |> String.replace(~r/\s+/, " ") |> String.trim()

    if String.length(text) <= max_chars,
      do: text,
      else: String.slice(text, 0, max(1, max_chars - 1)) <> "…"
  end

  defp value(value, key, fallback \\ nil)
  defp value(nil, _key, fallback), do: fallback

  defp value(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))

  defp value(_other, _key, fallback), do: fallback
  defp key_style(map, key), do: if(Map.has_key?(map, key), do: key, else: String.to_atom(key))
  defp put_flexible(map, key, value), do: Map.put(map, key_style(map, key), value)
end
