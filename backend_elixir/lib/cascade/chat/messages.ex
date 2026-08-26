defmodule Cascade.Chat.Messages do
  @moduledoc "Canonical chat message persistence with linked-channel projection and transactional mutations."

  alias Cascade.Accounts.{SQL, VaultMembers}
  alias Cascade.Chat.Channel
  alias Cascade.Content.{Privacy, Store}
  alias Cascade.Evolution
  import Cascade.Chat.MessagePersistence
  import Cascade.Chat.MessageCodec

  @list_columns "id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,registration_id,run_id,blocks_json,images_json,attachments_json,reply_to_json,forwarded_from_json,change_request_json,clarification_json,mission_json,mission_task_id,rowid,CASE WHEN harness_log IS NOT NULL AND length(harness_log)>0 THEN 1 ELSE 0 END"
  @full_columns "id,channel_id,vault_id,author,body,created_at,activity_at,actor_user_id,status,agent_id,registration_id,run_id,blocks_json,harness_log,images_json,attachments_json,reply_to_json,forwarded_from_json,change_request_json,clarification_json,mission_json,mission_task_id,rowid,CASE WHEN harness_log IS NOT NULL AND length(harness_log)>0 THEN 1 ELSE 0 END"

  def list(channel_id, user_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      detail = Keyword.get(opts, :detail, :list)
      limit = opts |> Keyword.get(:limit, 120) |> number(120) |> trunc() |> max(1) |> min(500)
      columns = if detail == :full, do: @full_columns, else: @list_columns

      messages =
        SQL.all(
          "SELECT #{columns} FROM chat_messages WHERE channel_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
          [route.sourceChannelId, limit]
        )
        |> Enum.reverse()
        |> Enum.map(&row_to_message(&1, detail, route.localChannelId))
        |> Enum.reject(&terminal_shell?/1)

      {:ok, messages}
    end
  end

  def get(channel_id, user_id, message_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      fetch(route, message_id)
    end
  end

  def create(user, vault_id, channel_id, input, opts \\ []) do
    access = Keyword.get(opts, :access, :user)

    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id),
         :ok <- dm_allowed(route.sourceChannelId, user.id),
         {:ok, attribution} <- attribution(user, route, input, access),
         :ok <- relationship_allowed(input) do
      message = normalized_message(input, route.sourceChannelId, attribution, user.id)

      result =
        SQL.transaction(fn ->
          insert_message(route, message)
          refresh_note_grants(user.id, vault_id, route.sourceChannelId, message)
          index_backlinks(route, message)
          fetch!(route, message.id)
        end)

      {:ok, result}
    end
  rescue
    error in Exqlite.Error -> {:error, sqlite_message(error)}
  end

  def update(user, vault_id, channel_id, message_id, patch, opts \\ []) do
    access = Keyword.get(opts, :access, :user)

    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id),
         {:ok, existing} <- fetch(route, message_id),
         :ok <- authorize_edit(user, existing, patch, access) do
      next = merge_patch(existing, patch, access)

      result =
        SQL.transaction(fn ->
          updated = persist!(route, next)
          refresh_note_grants(user.id, vault_id, route.sourceChannelId, next)
          Evolution.tombstone_chat_message_backlinks(message_id)
          index_backlinks(route, next)
          updated
        end)

      {:ok, result}
    end
  end

  def delete(user, vault_id, channel_id, message_id) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id),
         {:ok, message} <- fetch(route, message_id),
         :ok <- authorize_delete(user, route, message) do
      deleted =
        SQL.transaction(fn ->
          changes =
            SQL.changes("DELETE FROM chat_messages WHERE id=? AND channel_id=?", [
              message_id,
              route.sourceChannelId
            ])

          if changes > 0, do: Evolution.tombstone_chat_message_backlinks(message_id)
          changes > 0
        end)

      if deleted, do: {:ok, route}, else: {:error, "Message not found"}
    end
  end

  def forward(user, from_channel_id, message_id, to_vault_id, to_channel_id, comment \\ "") do
    with {:ok, source} <- get(from_channel_id, user.id, message_id),
         {:ok, _target} <- Channel.assert_vault_channel(to_vault_id, to_channel_id, user.id),
         false <- from_channel_id == to_channel_id,
         true <- forwardable?(source) do
      name =
        case SQL.one("SELECT title FROM notes WHERE id=?", [from_channel_id]) do
          [title] -> title
          _ -> "channel"
        end

      body =
        if String.trim(to_string(comment)) == "",
          do: source.body,
          else: String.trim(to_string(comment)) <> "\n\n" <> source.body

      create(user, to_vault_id, to_channel_id, %{
        body: body,
        images: source[:images],
        attachments: source[:attachments],
        forwardedFrom: %{
          messageId: source.id,
          channelId: from_channel_id,
          channelName: name,
          author: source.author,
          createdAt: source.createdAt
        }
      })
    else
      true -> {:error, "Cannot forward a message into the same channel"}
      false -> {:error, "Nothing to forward"}
      {:error, _} = error -> error
    end
  end

  def embeds(channel_id, user_id, message_id, opts \\ []) do
    agent? = Keyword.get(opts, :access) == :agent

    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, _message} <- fetch(route, message_id) do
      notes =
        SQL.all(
          """
          SELECT g.note_id,COALESCE(g.title_snapshot,n.title),g.content_snapshot,
            COALESCE(g.preview_snapshot,n.content_preview),n.vault_id
          FROM chat_note_grants g JOIN notes n ON n.id=g.note_id
          WHERE g.channel_id=? AND g.message_id=? ORDER BY 2 COLLATE NOCASE
          """,
          [route.sourceChannelId, message_id]
        )
        |> Enum.map(fn [id, title, snapshot, preview, note_vault_id] ->
          note =
            cond do
              is_binary(snapshot) and snapshot != "" ->
                %{id: id, title: title, content: snapshot, content_preview: preview || ""}

              VaultMembers.role(note_vault_id, user_id) ->
                live_or_preview(id, title, preview)

              true ->
                %{id: id, title: title, content: preview || "", content_preview: preview || ""}
            end

          Privacy.redact_note(note, agent?)
        end)

      {:ok, notes}
    end
  end

  def approve(user_id, channel_id, message_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, message} <- fetch(route, message_id),
         request when is_map(request) <- message[:changeRequest],
         [username] <- SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      approvals =
        request
        |> map_value("approvals", [])
        |> Enum.reject(&(map_value(&1, "userId") == user_id))

      next =
        Map.put(
          request,
          key_style(request, "approvals"),
          approvals ++ [%{userId: user_id, username: username}]
        )

      updated = Map.put(message, :changeRequest, next)
      persist(route, updated)
    else
      nil -> {:error, "Message is not a change request"}
      _ -> {:error, "Change request not found"}
    end
  end

  def merge(user_id, channel_id, message_id, merger \\ &default_merge/2) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         [^user_id, root] <-
           SQL.one("SELECT created_by,root_path FROM vaults WHERE id=?", [route.sourceVaultId]),
         {:ok, message} <- fetch(route, message_id),
         request when is_map(request) <- message[:changeRequest],
         :ok <- merge_available(request),
         {:ok, ref} <- valid_ref(request),
         cwd <- channel_cwd(route.sourceChannelId, root),
         :ok <- normalize_merge_result(merger.(cwd, ref)),
         [username] <- SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      request = request |> put_flexible("mergedAt", now()) |> put_flexible("mergedBy", username)
      updated = Map.put(message, :changeRequest, request)
      persist(route, updated)
    else
      [_other, _root] -> {:error, "Only the repository owner can merge"}
      {:error, _} = error -> error
      nil -> {:error, "Change request is unavailable"}
      _ -> {:error, "Change request not found"}
    end
  end

  def answer_clarification(user_id, channel_id, message_id, answers) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, message} <- fetch(route, message_id),
         clarification when is_map(clarification) <- message[:clarification],
         "pending" <- map_value(clarification, "status", "pending") do
      by_id =
        Map.new(answers || [], fn item ->
          {to_string(map_value(item, "id", "")),
           item
           |> map_value("answer", "")
           |> to_string()
           |> String.trim()
           |> String.slice(0, 4000)}
        end)

      questions =
        clarification
        |> map_value("questions", [])
        |> Enum.map(fn question ->
          id = to_string(map_value(question, "id", ""))

          if Map.has_key?(by_id, id),
            do: put_flexible(question, "answer", by_id[id]),
            else: question
        end)

      next = put_flexible(clarification, "questions", questions)
      updated = Map.put(message, :clarification, next)
      persist(route, updated)
    else
      nil -> {:error, "Message is not a clarification"}
      "accepted" -> {:error, "Clarification is already closed"}
      "canceled" -> {:error, "Clarification is already closed"}
      {:error, _} = error -> error
      _ -> {:error, "Message not found"}
    end
  end

  def accept_clarification(user_id, channel_id, message_id, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         {:ok, message} <- fetch(route, message_id),
         clarification when is_map(clarification) <- message[:clarification],
         :ok <- clarification_open(clarification),
         {:ok, contract} <- clarification_contract(clarification),
         [username] <- SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      title =
        opts
        |> Keyword.get(:title, map_value(clarification, "title", "Contract"))
        |> to_string()
        |> String.trim()
        |> String.slice(0, 240)
        |> nonblank("Contract")

      token_budget =
        opts
        |> Keyword.get(:token_budget, map_value(clarification, "tokenBudget", 0))
        |> number(0)
        |> trunc()
        |> max(0)

      work_item_id = Ecto.UUID.generate()

      updated =
        clarification
        |> put_flexible("status", "accepted")
        |> put_flexible("workItemId", work_item_id)
        |> put_flexible("tokenBudget", token_budget)
        |> put_flexible("acceptedAt", now())
        |> put_flexible("acceptedBy", username)

      result =
        SQL.transaction(fn ->
          SQL.exec(
            """
            INSERT INTO work_items(id,vault_id,channel_id,title,brief,source_kind,source_id,
              assignee_registration_id,branch,workspace_mode,verification,contract,token_budget,created_by)
            VALUES(?,?,?,?,?,'contract',?,?,?,'isolated',?,?,?,?)
            """,
            [
              work_item_id,
              route.sourceVaultId,
              route.sourceChannelId,
              title,
              message.body || "",
              message_id,
              blank_to_nil(map_value(clarification, "assigneeRegistrationId", "")),
              "cascade/contract/" <> String.slice(message_id, 0, 8),
              "Drive until completed, token budget hit, or manually stopped.",
              contract,
              token_budget,
              user_id
            ]
          )

          persist!(route, Map.put(message, :clarification, updated))
        end)

      {:ok,
       %{
         message: result,
         workItemId: work_item_id,
         missionId: nil,
         contract: contract,
         title: title,
         tokenBudget: token_budget
       }}

    else
      nil -> {:error, "Message is not a clarification"}
      {:error, _} = error -> error
      _ -> {:error, "Message not found"}
    end
  end
  defp authorize_create(user, vault_id, channel_id, input, access) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id),
         :ok <- dm_allowed(route.sourceChannelId, user.id),
         {:ok, attribution} <- attribution(user, route, input, access),
         :ok <- relationship_allowed(input) do
      message = normalized_message(input, route.sourceChannelId, attribution, user.id)
      {:ok, route, message}
    end
  end

  defp authorize_update(user, vault_id, channel_id, message_id, patch, access) do
    with {:ok, route} <- Channel.assert_vault_channel(vault_id, channel_id, user.id),
         {:ok, existing} <- fetch(route, message_id),
         :ok <- authorize_edit(user, existing, patch, access) do
      {:ok, route, merge_patch(existing, patch, access)}
    end
  end

  defp emit_message_write(operation, stage, outcome) do
    :telemetry.execute(
      [:cascade, :chat, :message_write],
      %{count: 1},
      %{operation: operation, stage: stage, outcome: outcome}
    )
  end

  def refresh_note_grants(user_id, local_vault_id, source_channel_id, message) do
    SQL.exec("DELETE FROM chat_note_grants WHERE message_id=? AND granted_by=?", [
      message.id,
      user_id
    ])

    ~r/!\[\[([^\]\n]+)\]\]/u
    |> Regex.scan(message.body || "", capture: :all_but_first)
    |> List.flatten()
    |> Enum.map(fn raw ->
      raw
      |> String.split("|", parts: 2)
      |> hd()
      |> String.split("#", parts: 2)
      |> hd()
      |> String.trim()
    end)
    |> Enum.reject(&(&1 == ""))
    |> Enum.uniq_by(&String.downcase/1)
    |> Enum.each(fn title ->
      case SQL.one(
             "SELECT id,title,content,content_preview FROM notes WHERE vault_id=? AND title=? COLLATE NOCASE AND is_archived=0 ORDER BY updated_at DESC LIMIT 1",
             [local_vault_id, title]
           ) do
        [id, stored_title, content, preview] ->
          note = Store.get_note(id)

          SQL.exec(
            """
            INSERT OR IGNORE INTO chat_note_grants(message_id,channel_id,note_id,granted_by,title_snapshot,content_snapshot,preview_snapshot)
            VALUES(?,?,?,?,?,?,?)
            """,
            [
              message.id,
              source_channel_id,
              id,
              user_id,
              (note && note.title) || stored_title,
              (note && note.content) || content || "",
              String.slice((note && note.content_preview) || preview || "", 0, 400)
            ]
          )

        _ ->
          :ok
      end
    end)

    :ok
  end
end

