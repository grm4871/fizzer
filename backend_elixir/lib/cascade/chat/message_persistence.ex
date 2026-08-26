defmodule Cascade.Chat.MessagePersistence do
  @moduledoc """
  Persistence, authorization, and domain command helpers for canonical chat messages.

  All mutations run in the caller's transaction boundary and preserve channel
  ownership, agent attribution, relationship validation, and wire-field shape.
  """

  alias Cascade.Accounts.{DirectMessages, SQL}
  alias Cascade.Content.Store
  alias Cascade.Evolution
  import Cascade.Chat.MessageCodec

  @relationships ~w(builds_on review_request question contradiction decision)
  @full_columns "id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,reply_to_json,forwarded_from_json,change_request_json,clarification_json,mission_json,mission_task_id,rowid,CASE WHEN harness_log IS NOT NULL AND length(harness_log)>0 THEN 1 ELSE 0 END"

    def insert_message(route, message) do
      activity = if countable?(message), do: now(), else: nil
  
      SQL.exec(
        """
        INSERT INTO chat_messages(id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,
          status,agent_id,registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,
          reply_to_json,forwarded_from_json,change_request_json,clarification_json,mission_json,mission_task_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET
          author=excluded.author,body=excluded.body,created_at=excluded.created_at,
          activity_at=COALESCE(chat_messages.activity_at,excluded.activity_at),actor_user_id=excluded.actor_user_id,
          status=excluded.status,agent_id=excluded.agent_id,registration_id=excluded.registration_id,run_id=excluded.run_id,
          blocks_json=excluded.blocks_json,harness_log=excluded.harness_log,images_json=excluded.images_json,
          attachments_json=excluded.attachments_json,reply_to_json=excluded.reply_to_json,
          forwarded_from_json=excluded.forwarded_from_json,change_request_json=excluded.change_request_json,
          clarification_json=excluded.clarification_json,mission_json=excluded.mission_json,mission_task_id=excluded.mission_task_id
        """,
        message_params(route, message, activity)
      )
    end
  
    def persist(route, message) do
      activity = if countable?(message), do: now(), else: nil
  
      rows =
        SQL.exec(
          """
          UPDATE chat_messages SET author=?,body=?,created_at=?,activity_at=COALESCE(activity_at,?),status=?,agent_id=?,
            registration_id=?,run_id=?,blocks_json=?,harness_log=?,images_json=?,attachments_json=?,reply_to_json=?,
            forwarded_from_json=?,change_request_json=?,clarification_json=?,mission_json=?,mission_task_id=?
          WHERE id=? AND channel_id=?
          RETURNING #{@full_columns}
          """,
          [
            message.author,
            message.body,
            message.createdAt,
            activity,
            message[:status],
            message[:agentId],
            message[:registrationId],
            message[:runId],
            encode(message[:blocks]),
            message[:harnessLog],
            encode(message[:images]),
            encode(message[:attachments]),
            encode(message[:replyTo]),
            encode(message[:forwardedFrom]),
            encode(message[:changeRequest]),
            encode(message[:clarification]),
            encode(message[:mission]),
            message[:missionTaskId],
            message.id,
            route.sourceChannelId
          ]
        )
        |> Map.fetch!(:rows)
  
      case rows do
        [row] -> {:ok, row_to_message(row, :full, route.localChannelId)}
        [] -> {:error, "Message not found"}
      end
    end
  
    def persist!(route, message) do
      case persist(route, message) do
        {:ok, value} -> value
        {:error, reason} -> raise reason
      end
    end
  
    def message_params(route, message, activity) do
      [
        message.id,
        route.sourceChannelId,
        route.sourceVaultId,
        message.author,
        message.body,
        message.createdAt,
        activity,
        message[:actorUserId],
        message[:status],
        message[:agentId],
        message[:registrationId],
        message[:runId],
        encode(message[:blocks]),
        message[:harnessLog],
        encode(message[:images]),
        encode(message[:attachments]),
        encode(message[:replyTo]),
        encode(message[:forwardedFrom]),
        encode(message[:changeRequest]),
        encode(message[:clarification]),
        encode(message[:mission]),
        message[:missionTaskId]
      ]
    end
  
    def normalized_message(input, source_channel_id, attribution, actor_user_id) do
      change = normalize_change(map_value(input, "changeRequest"))
      clarification = normalize_clarification(map_value(input, "clarification"))
  
      %{
        id:
          map_value(input, "id", "")
          |> to_string()
          |> String.trim()
          |> nonblank(Ecto.UUID.generate()),
        channelId: source_channel_id,
        author: attribution.author,
        body: map_value(input, "body", "") |> to_string(),
        createdAt: map_value(input, "createdAt", "") |> to_string() |> nonblank(now()),
        actorUserId: actor_user_id,
        status: nilable(map_value(input, "status")),
        agentId: attribution.agent_id,
        registrationId: attribution.registration_id,
        runId: map_value(input, "runId"),
        blocks: map_value(input, "blocks"),
        harnessLog: nilable(map_value(input, "harnessLog")),
        images: list_or_nil(map_value(input, "images")),
        attachments: list_or_nil(map_value(input, "attachments")),
        replyTo: normalize_reply(map_value(input, "replyTo")),
        forwardedFrom: map_value(input, "forwardedFrom"),
        changeRequest: change,
        clarification: clarification,
        mission: map_value(input, "mission"),
        missionTaskId: nilable(map_value(input, "missionTaskId"))
      }
    end
  
    def attribution(user, route, input, :agent) do
      registration_id = map_value(input, "registrationId", "") |> to_string() |> String.trim()
      user_id = user.id
  
      if registration_id == "" do
        author = input |> map_value("author", "") |> to_string() |> String.trim()
        agent_id = input |> map_value("agentId") |> nilable()
  
        if author == "" do
          {:error, "Author is required"}
        else
          {:ok, %{author: author, agent_id: agent_id, registration_id: nil}}
        end
      else
        case SQL.one(
               """
                 SELECT m.display_name,m.agent_id,va.owner_user_id FROM chat_agent_members m
                 JOIN vault_agents va ON va.id=m.vault_agent_id WHERE m.id=? AND m.channel_id=?
               """,
               [registration_id, route.sourceChannelId]
             ) do
          [display_name, agent_id, ^user_id] ->
            {:ok,
             %{
               author: nonblank(String.trim(display_name || ""), agent_id),
               agent_id: agent_id,
               registration_id: registration_id
             }}
  
          [_name, _agent, _owner] ->
            {:error, "Only an agent owner can post as that agent"}
  
          _ ->
            {:error, "Agent registration is required"}
        end
      end
    end
  
    def attribution(_user, _route, input, :system) do
      author = input |> map_value("author", "Cascade") |> to_string() |> String.trim()
      {:ok, %{author: nonblank(author, "Cascade"), agent_id: nil, registration_id: nil}}
    end
  
    def attribution(user, _route, _input, _access),
      do: {:ok, %{author: user.username, agent_id: nil, registration_id: nil}}
  
    def authorize_edit(_user, existing, patch, :agent) do
      cond do
        is_nil(existing[:agentId]) and is_nil(existing[:registrationId]) ->
          {:error, "Agents cannot edit human messages"}
  
        map_value(patch, "author") not in [nil, existing.author] ->
          {:error, "Agents cannot reassign message authors"}
  
        existing[:registrationId] &&
            map_value(patch, "registrationId") not in [nil, existing.registrationId] ->
          {:error, "Agents cannot reassign registration ownership"}
  
        true ->
          :ok
      end
    end
  
    def authorize_edit(user, existing, _patch, _access),
      do:
        if(existing.author == user.username,
          do: :ok,
          else: {:error, "You can only edit your own messages"}
        )
  
    def authorize_delete(user, route, message) do
      host =
        case SQL.one("SELECT created_by FROM vaults WHERE id=?", [route.sourceVaultId]) do
          [id] -> id
          _ -> nil
        end
  
      if host == user.id or message.author == user.username,
        do: :ok,
        else: {:error, "You can only delete your own messages"}
    end
  
    def merge_patch(existing, patch, :agent) do
      Enum.reduce(
        [
          "body",
          "createdAt",
          "status",
          "runId",
          "blocks",
          "harnessLog",
          "images",
          "attachments",
          "replyTo",
          "changeRequest",
          "clarification"
        ],
        existing,
        fn key, acc ->
          case fetch_value(patch, key) do
            {:ok, value} -> Map.put(acc, atom_key(key), value)
            :error -> acc
          end
        end
      )
    end
  
    def merge_patch(existing, patch, _access) do
      Enum.reduce(["body", "images", "attachments", "replyTo"], existing, fn key, acc ->
        case fetch_value(patch, key) do
          {:ok, value} -> Map.put(acc, atom_key(key), value)
          :error -> acc
        end
      end)
    end
  
    def row_to_message(
           [
             id,
             _channel,
             _vault,
             author,
             body,
             created_at,
             activity_at,
             actor_user_id,
             status,
             agent_id,
             registration_id,
             run_id,
             blocks,
             harness_log,
             images,
             attachments,
             reply_to,
             forwarded,
             change,
             clarification,
             mission,
             mission_task_id,
             rowid,
             has_harness
           ],
           :full,
           local_channel_id
         ) do
      build_message(
        %{
          id: id,
          author: author,
          body: body,
          created_at: created_at,
          activity_at: activity_at,
          actor_user_id: actor_user_id,
          status: status,
          agent_id: agent_id,
          registration_id: registration_id,
          run_id: run_id,
          blocks: blocks,
          harness_log: harness_log,
          images: images,
          attachments: attachments,
          reply_to: reply_to,
          forwarded: forwarded,
          change: change,
          clarification: clarification,
          mission: mission,
          mission_task_id: mission_task_id,
          rowid: rowid,
          has_harness: has_harness
        },
        :full,
        local_channel_id
      )
    end
  
    def row_to_message(
           [
             id,
             _channel,
             _vault,
             author,
             body,
             created_at,
             activity_at,
             actor_user_id,
             status,
             agent_id,
             registration_id,
             run_id,
             blocks,
             images,
             attachments,
             reply_to,
             forwarded,
             change,
             clarification,
             mission,
             mission_task_id,
             rowid,
             has_harness
           ],
           :list,
           local_channel_id
         ) do
      build_message(
        %{
          id: id,
          author: author,
          body: body,
          created_at: created_at,
          activity_at: activity_at,
          actor_user_id: actor_user_id,
          status: status,
          agent_id: agent_id,
          registration_id: registration_id,
          run_id: run_id,
          blocks: blocks,
          harness_log: nil,
          images: images,
          attachments: attachments,
          reply_to: reply_to,
          forwarded: forwarded,
          change: change,
          clarification: clarification,
          mission: mission,
          mission_task_id: mission_task_id,
          rowid: rowid,
          has_harness: has_harness
        },
        :list,
        local_channel_id
      )
    end
  
    def build_message(row, detail, local_channel_id) do
      images = decode(row.images, [])
  
      blocks = decode(row.blocks)
  
      %{
        id: row.id,
        channelId: local_channel_id,
        author: row.author,
        body: row.body,
        createdAt: row.created_at,
        activityAt: row.activity_at,
        status: row.status,
        agentId: row.agent_id,
        registrationId: row.registration_id,
        runId: row.run_id,
        blocks: if(detail == :list, do: truncate_blocks(blocks), else: blocks),
        harnessLog: row.harness_log,
        attachments: nil_if_empty(decode(row.attachments, [])),
        replyTo: decode(row.reply_to),
        forwardedFrom: decode(row.forwarded),
        changeRequest: decode(row.change),
        clarification: decode(row.clarification),
        mission: decode(row.mission),
        missionTaskId: row.mission_task_id,
        seq: row.rowid
      }
      |> reject_nil_values()
      |> maybe_put(:hasHarness, row.has_harness != 0, true)
      |> put_images(images, detail)
    end
  
    def put_images(message, [], _detail), do: message
  
    def put_images(message, images, :full), do: Map.put(message, :images, images)
  
    def put_images(message, images, :list) do
      light =
        Enum.filter(images, fn image ->
          is_binary(image) and not String.starts_with?(image, "data:") and byte_size(image) < 2_048
        end)
  
      cond do
        length(light) == length(images) -> Map.put(message, :images, light)
        light == [] -> Map.put(message, :hasImages, true)
        true -> message |> Map.put(:images, light) |> Map.put(:hasImages, true)
      end
    end
  
    def maybe_put(message, key, actual, expected) do
      if actual == expected, do: Map.put(message, key, actual), else: message
    end
  
    def normalize_reply(nil), do: nil
  
    def normalize_reply(reply) when is_map(reply) do
      relationship = map_value(reply, "relationship")
  
      if relationship in @relationships,
        do: reply,
        else: if(is_nil(relationship), do: reply, else: nil)
    end
  
    def normalize_reply(_), do: nil
  
    def relationship_allowed(input) do
      case map_value(map_value(input, "replyTo", %{}), "relationship") do
        nil -> :ok
        relationship when relationship in @relationships -> :ok
        _ -> {:error, "Invalid chat relationship"}
      end
    end
  
    def normalize_change(nil), do: nil
  
    def normalize_change(value) when is_map(value) do
      files =
        value
        |> map_value("files", [])
        |> Enum.take(100)
        |> Enum.map(fn file ->
          %{
            path: file |> map_value("path", "") |> to_string() |> String.slice(0, 500),
            additions: file |> map_value("additions", 0) |> number(0) |> floor_nonnegative(),
            deletions: file |> map_value("deletions", 0) |> number(0) |> floor_nonnegative()
          }
        end)
        |> Enum.reject(&(&1.path == ""))
  
      %{files: files, approvals: []}
      |> maybe_put(:commit, value |> map_value("commit", "") |> to_string() |> String.slice(0, 80))
      |> maybe_put(:ref, value |> map_value("ref", "") |> to_string() |> String.slice(0, 200))
    end
  
    def normalize_change(_), do: nil
  
    def normalize_clarification(nil), do: nil
  
    def normalize_clarification(value) when is_map(value) do
      questions =
        value
        |> map_value("questions", [])
        |> Enum.take(3)
        |> Enum.with_index()
        |> Enum.map(fn {question, index} ->
          kind = map_value(question, "kind", map_value(question, "type", "text")) |> to_string()
          kind = if kind in ~w(text single multi), do: kind, else: "text"
  
          options =
            map_value(question, "options", [])
            |> List.wrap()
            |> Enum.map(&(to_string(&1) |> String.trim() |> String.slice(0, 200)))
            |> Enum.reject(&(&1 == ""))
            |> Enum.take(8)
  
          answer =
            map_value(question, "answer", map_value(question, "default", ""))
            |> to_string()
            |> String.trim()
            |> String.slice(0, 4000)
  
          answer =
            if answer == "" and kind == "single" and options != [], do: hd(options), else: answer
  
          %{
            id: map_value(question, "id", "q#{index + 1}") |> to_string() |> String.slice(0, 80),
            prompt: map_value(question, "prompt", "") |> to_string() |> String.slice(0, 2000),
            kind: kind,
            options: options,
            answer: answer
          }
        end)
  
      %{
        title: map_value(value, "title", "Clarification") |> to_string() |> String.slice(0, 240),
        status: "pending",
        questions: questions,
        tokenBudget: map_value(value, "tokenBudget", 0) |> number(0) |> trunc() |> max(0)
      }
      |> maybe_put(
        :assigneeRegistrationId,
        map_value(value, "assigneeRegistrationId", "") |> to_string() |> String.slice(0, 80)
      )
    end
  
    def normalize_clarification(_), do: nil
  
    def index_backlinks(route, message) do
      Evolution.index_chat_message_backlinks(route.sourceVaultId, route.sourceChannelId, %{
        id: message.id,
        author: message.author,
        body: message.body,
        createdAt: message.createdAt
      })
    rescue
      _ -> :ok
    end
  
    def live_or_preview(id, title, preview) do
      case Store.get_note(id) do
        nil ->
          %{id: id, title: title, content: preview || "", content_preview: preview || ""}
  
        note ->
          %{
            id: note.id,
            title: note.title,
            content: note.content || "",
            content_preview: note.content_preview || ""
          }
      end
    end
  
    def dm_allowed(channel_id, user_id) do
      case DirectMessages.assert_send_allowed(channel_id, user_id) do
        :ok -> :ok
        {:error, message} -> {:error, message}
      end
    rescue
      _ -> :ok
    end
  
    def merge_available(request) do
      cond do
        map_value(request, "mergedAt") -> {:error, "Change request is unavailable"}
        map_value(request, "approvals", []) == [] -> {:error, "At least one approval is required"}
        true -> :ok
      end
    end
  
    def valid_ref(request) do
      ref =
        map_value(request, "ref", map_value(request, "commit", "")) |> to_string() |> String.trim()
  
      if ref != "" and not String.starts_with?(ref, "-") and not String.contains?(ref, "..") and
           Regex.match?(~r{^[A-Za-z0-9_./-]+$}, ref),
         do: {:ok, ref},
         else: {:error, "Change request has an invalid git ref"}
    end
  
    def channel_cwd(channel_id, root) do
      case SQL.one("SELECT cwd FROM chat_channel_settings WHERE channel_id=?", [channel_id]) do
        [cwd] when is_binary(cwd) and cwd != "" -> String.trim(cwd)
        _ -> root
      end
    end
  
    def default_merge(cwd, ref) do
      case System.cmd("git", ["-C", cwd, "merge", "--ff-only", ref], stderr_to_stdout: true) do
        {_output, 0} -> :ok
        {output, _} -> {:error, String.trim(output)}
      end
    end
  
    def normalize_merge_result(:ok), do: :ok
    def normalize_merge_result({:ok, _}), do: :ok
    def normalize_merge_result({:error, reason}), do: {:error, to_string(reason)}
    def normalize_merge_result(other), do: {:error, "Merge failed: #{inspect(other)}"}
  
    def clarification_open(value) do
      status = map_value(value, "status", "pending")
      work_item_id = map_value(value, "workItemId")
  
      case status do
        "accepted" when not is_nil(work_item_id) ->
          {:error, "Clarification is already accepted"}
  
        "canceled" ->
          {:error, "Clarification was canceled"}
  
        _ ->
          :ok
      end
    end
  
    def clarification_contract(value) do
      questions = map_value(value, "questions", [])
  
      unanswered =
        Enum.count(questions, &(String.trim(to_string(map_value(&1, "answer", ""))) == ""))
  
      if unanswered > 0,
        do: {:error, "Answer all questions first (#{unanswered} remaining)"},
        else:
          {:ok,
           questions
           |> Enum.with_index(1)
           |> Enum.map_join("\n\n", fn {q, i} ->
             "Q#{i}: #{map_value(q, "prompt", "")}\nA#{i}: #{String.trim(to_string(map_value(q, "answer", "")))}"
           end)}
    end
  
    def countable?(message),
      do:
        is_nil(message[:agentId]) or
          (message[:status] not in ["sending", "running"] and
             String.trim(message.body || "") not in ["", "Thinking..."])
  
    def terminal_shell?(message),
      do:
        message[:agentId] && message[:status] != "running" &&
          String.trim(message.body || "") in ["", "Thinking..."]
  
    def forwardable?(message),
      do:
        String.trim(message.body || "") != "" or List.wrap(message[:images]) != [] or
          List.wrap(message[:attachments]) != []
  
    def fetch(route, message_id) do
      case SQL.one("SELECT #{@full_columns} FROM chat_messages WHERE id=? AND channel_id=?", [
             message_id,
             route.sourceChannelId
           ]) do
        nil -> {:error, "Message not found"}
        row -> {:ok, row_to_message(row, :full, route.localChannelId)}
      end
    end

    def fetch!(route, message_id) do
      case fetch(route, message_id) do
        {:ok, message} -> message
        {:error, reason} -> raise reason
      end
    end
end
