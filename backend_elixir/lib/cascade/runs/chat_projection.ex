defmodule Cascade.Runs.ChatProjection do
  @moduledoc "Folds durable runner events into the authoritative chat reply and mission state."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.Messages
  alias Cascade.Missions.Scheduler
  alias Cascade.Missions.Store, as: MissionStore
  alias Cascade.Realtime.Events
  alias Cascade.Runs.Store

  @harness_max 512_000

  def build(events) do
    state =
      Enum.reduce(events, empty_state(), fn event, state ->
        case Jason.decode(event.payload_json || "") do
          {:ok, payload} -> fold(state, event.type, payload)
          _ -> state
        end
      end)

    content(state)
  end

  def sync(run_id, owner_id \\ nil) when is_integer(run_id) do
    projection = build(Store.events(run_id))
    target = target(run_id, owner_id)

    if target do
      persist_target(target, run_id, projection)
    end

    if projection.done do
      run = Store.get(run_id)
      summary = nonblank(projection.body, if(run, do: run.summary || "", else: ""))
      status = projection.terminal_status || if(run, do: run.status, else: "completed")

      if status in ["completed", "failed", "canceled"] do
        _ = Scheduler.settle_run(run_id, status, summary, events: Events)
      end
    end

    projection
  rescue
    _ -> %{body: "", blocks: [], harnessLog: "", status: "running", done: false}
  end

  defp empty_state do
    %{
      assistant_text: "",
      blocks: [],
      harness_log: "",
      status: "running",
      terminal_status: nil,
      terminal_summary: "",
      suppress_chat_body: false,
      visible_text: false
    }
  end

  defp fold(state, "text", payload) do
    content = value(value(payload, "message", %{}), "content")
    text = text_content(content)

    %{
      state
      | assistant_text: state.assistant_text <> text,
        blocks: append_blocks(state.blocks, normalize_blocks(content)),
        visible_text:
          state.visible_text or (value(payload, "chatVisible") == true and trim(text) != "")
    }
  end

  defp fold(state, "user", payload) do
    content = value(value(payload, "message", %{}), "content")
    %{state | blocks: append_blocks(state.blocks, normalize_blocks(content))}
  end

  defp fold(state, "harness", payload) do
    chunk = value(payload, "data", "")

    if is_binary(chunk) and chunk != "" do
      next = state.harness_log <> chunk

      next =
        if String.length(next) > @harness_max,
          do: String.slice(next, -@harness_max, @harness_max),
          else: next

      %{state | harness_log: next}
    else
      state
    end
  end

  defp fold(state, "status", payload) do
    state =
      if value(payload, "suppressChatBody") == true,
        do: %{state | suppress_chat_body: true},
        else: state

    case value(payload, "status") do
      "completed" ->
        %{
          state
          | status: nil,
            terminal_status: "completed",
            terminal_summary: to_string(value(payload, "summary", ""))
        }

      "failed" ->
        %{
          state
          | status: "failed",
            terminal_status: "failed",
            terminal_summary: to_string(value(payload, "summary", "Agent failed."))
        }

      "canceled" ->
        %{
          state
          | status: "canceled",
            terminal_status: "canceled",
            terminal_summary: to_string(value(payload, "summary", "Run canceled by user."))
        }

      _ ->
        state
    end
  end

  defp fold(state, _type, _payload), do: state

  defp content(state) do
    text = trim(state.assistant_text)
    done = state.status != "running"

    body =
      cond do
        not done ->
          if state.visible_text and text != "", do: text, else: "Thinking..."

        state.suppress_chat_body ->
          ""

        state.status in ["failed", "canceled"] ->
          fallback =
            if state.status == "canceled", do: "Run canceled by user.", else: "Agent failed."

          reason = nonblank(trim(state.terminal_summary), fallback)
          useful = if text != "" and not generic_summary?(text), do: text, else: ""
          if useful == "", do: reason, else: useful <> "\n\n> ⚠️ " <> reason

        trim(state.terminal_summary) != "" and not generic_summary?(state.terminal_summary) ->
          trim(state.terminal_summary)

        text != "" and not generic_summary?(text) ->
          text

        true ->
          ""
      end

    %{
      body: body,
      blocks: state.blocks,
      harnessLog: state.harness_log,
      status: state.status,
      terminal_status: state.terminal_status,
      done: done
    }
  end

  defp target(run_id, owner_id) do
    case SQL.one(
           "SELECT id,vault_id,channel_id,actor_user_id FROM chat_messages WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1",
           [run_id]
         ) do
      [message_id, source_vault_id, source_channel_id, actor_user_id] ->
        owner_id = owner_id || actor_user_id

        with owner when is_integer(owner) <- owner_id,
             [username] <- SQL.one("SELECT username FROM users WHERE id=?", [owner]),
             {:ok, route} <- MissionStore.owner_route(owner, source_vault_id, source_channel_id) do
          %{
            user: %{id: owner, username: username},
            vault_id: route.localVaultId,
            channel_id: route.localChannelId,
            source_vault_id: route.sourceVaultId,
            source_channel_id: route.sourceChannelId,
            message_id: message_id
          }
        else
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp persist_target(target, run_id, projection) do
    patch = %{body: projection.body, status: projection.status, runId: run_id}

    patch =
      if projection.blocks == [], do: patch, else: Map.put(patch, :blocks, projection.blocks)

    patch =
      if projection.harnessLog == "",
        do: patch,
        else: Map.put(patch, :harnessLog, projection.harnessLog)

    case Messages.update(
           target.user,
           target.vault_id,
           target.channel_id,
           target.message_id,
           patch,
           access: :agent
         ) do
      {:ok, message} ->
        emit_message(target, message)

        if projection.done and trim(projection.body) == "" do
          SQL.exec("DELETE FROM chat_messages WHERE id=? AND channel_id=?", [
            target.message_id,
            target.source_channel_id
          ])

          Events.emit(%{
            event: "vault:chatMessageDeleted",
            vaultId: target.source_vault_id,
            channelId: target.source_channel_id,
            messageId: target.message_id
          })
        end

      _ ->
        :ok
    end
  end

  defp emit_message(target, message) do
    Events.emit(%{
      event: "vault:chatMessageUpdated",
      vaultId: target.source_vault_id,
      channelId: target.source_channel_id,
      message: message
    })
  end

  defp text_content(content) when is_binary(content), do: content

  defp text_content(content) when is_list(content) do
    Enum.map_join(content, "", fn block ->
      if value(block, "type") == "text" and is_binary(value(block, "text")),
        do: value(block, "text"),
        else: ""
    end)
  end

  defp text_content(_content), do: ""

  defp normalize_blocks(content) when is_binary(content) do
    if trim(content) == "", do: [], else: [%{type: "text", text: content}]
  end

  defp normalize_blocks(content) when is_list(content) do
    Enum.flat_map(content, fn block ->
      type = value(block, "type")
      text = value(block, "text")

      case type do
        "text" ->
          if is_binary(text), do: [%{type: "text", text: text}], else: []

        "thinking" ->
          [
            %{
              type: "thinking",
              text: to_string(value(block, "thinking", value(block, "text", "")))
            }
          ]

        "redacted_thinking" ->
          [%{type: "thinking", text: "", redacted: true}]

        "tool_use" ->
          [
            %{
              type: "tool_use",
              id: value(block, "id"),
              name: value(block, "name", "tool"),
              input: value(block, "input")
            }
            |> reject_nil()
          ]

        "tool_result" ->
          result = tool_result_text(value(block, "content"))

          [
            %{
              type: "tool_result",
              toolUseId: value(block, "tool_use_id", value(block, "toolUseId")),
              content: result,
              text: result,
              isError: value(block, "is_error") == true or value(block, "isError") == true
            }
            |> reject_nil()
          ]

        _ ->
          []
      end
    end)
  end

  defp normalize_blocks(_content), do: []

  defp append_blocks(existing, blocks) do
    Enum.reduce(blocks, existing, fn block, acc ->
      last = List.last(acc)

      cond do
        not is_nil(last) and value(last, "type") == value(block, "type") and
            value(block, "type") in ["text", "thinking"] ->
          List.replace_at(
            acc,
            -1,
            Map.put(
              last,
              :text,
              to_string(value(last, "text", "")) <> to_string(value(block, "text", ""))
            )
          )

        value(block, "type") == "tool_use" and value(block, "id") not in [nil, ""] ->
          case Enum.find_index(
                 acc,
                 &(value(&1, "type") == "tool_use" and value(&1, "id") == value(block, "id"))
               ) do
            nil -> acc ++ [block]
            index -> List.replace_at(acc, index, Map.merge(Enum.at(acc, index), block))
          end

        true ->
          acc ++ [block]
      end
    end)
  end

  defp tool_result_text(value) when is_binary(value), do: value

  defp tool_result_text(value) when is_list(value) do
    value
    |> Enum.map(&value(&1, "text", ""))
    |> Enum.reject(&(&1 == ""))
    |> Enum.join("\n")
  end

  defp tool_result_text(nil), do: ""
  defp tool_result_text(value), do: Jason.encode!(value)

  defp generic_summary?(value) do
    text = trim(value)

    Regex.match?(~r/^(done\.?|completed note operations successfully\.?|agent failed\.?)$/i, text) or
      Regex.match?(~r/^I will\b/i, text) or Regex.match?(~r/^I(?:'ll| am going to)\b/i, text) or
      Regex.match?(~r/^Let me\b/i, text)
  end

  defp value(map, key, fallback \\ nil)

  defp value(map, key, fallback) when is_map(map),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))

  defp value(_other, _key, fallback), do: fallback
  defp reject_nil(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)
  defp trim(value), do: value |> to_string() |> String.trim()
  defp nonblank(value, fallback) when value in [nil, ""], do: fallback
  defp nonblank(value, _fallback), do: value
end
