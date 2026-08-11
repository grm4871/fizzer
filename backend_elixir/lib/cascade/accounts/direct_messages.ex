defmodule Cascade.Accounts.DirectMessages do
  @moduledoc "One-to-one linked chat channels with private per-user vaults and anti-enumeration policy."

  alias Cascade.Accounts.SQL
  alias Cascade.Content.Store

  @username ~r/^[a-z0-9_]{3,32}$/
  @marker "cascade://chat-channel"
  @vault_name "Direct Messages"
  @unreachable "This user is not accepting direct messages"

  def unreachable_message, do: @unreachable

  def direct_message_vault_id(user_id) do
    case SQL.one("SELECT vault_id FROM user_dm_vaults WHERE user_id=?", [user_id]) do
      [vault_id] -> vault_id
      nil -> nil
    end
  end

  def direct_message_vault?(vault_id) do
    SQL.one("SELECT 1 FROM user_dm_vaults WHERE vault_id=?", [vault_id]) != nil
  end

  def vault_holds_direct_messages?(vault_id) do
    SQL.one(
      """
      SELECT 1 FROM direct_message_channels WHERE source_vault_id=?
      UNION ALL
      SELECT 1 FROM chat_channel_links l
        JOIN direct_message_channels d ON d.source_channel_id=l.source_channel_id
        WHERE l.local_vault_id=?
      UNION ALL SELECT 1 FROM user_dm_vaults WHERE vault_id=? LIMIT 1
      """,
      [vault_id, vault_id, vault_id]
    ) != nil
  end

  def direct_message_channel?(channel_id) do
    SQL.one(
      """
      SELECT 1 FROM direct_message_channels WHERE source_channel_id=?
      UNION ALL
      SELECT 1 FROM chat_channel_links l
        JOIN direct_message_channels d ON d.source_channel_id=l.source_channel_id
        WHERE l.local_channel_id=? LIMIT 1
      """,
      [channel_id, channel_id]
    ) != nil
  end

  def assert_shareable_channel(channel_id) do
    if direct_message_channel?(channel_id),
      do: {:error, "Direct messages cannot be shared"},
      else: :ok
  end

  def resolve_user(username_raw) do
    username =
      username_raw
      |> to_string()
      |> String.trim()
      |> String.replace(~r/^@+/, "")
      |> String.downcase()

    if Regex.match?(@username, username) do
      case SQL.one("SELECT id,username,display_name,avatar_url FROM users WHERE username=?", [
             username
           ]) do
        nil -> {:error, "User not found"}
        row -> {:ok, map_user(row)}
      end
    else
      {:error, "User not found"}
    end
  end

  def allows?(user_id) do
    case SQL.one("SELECT allow_direct_messages FROM user_dm_settings WHERE user_id=?", [user_id]) do
      [0] -> false
      _ -> true
    end
  end

  def set_allows(user_id, allow) when is_boolean(allow) do
    SQL.exec(
      """
      INSERT INTO user_dm_settings (user_id,allow_direct_messages,updated_at)
      VALUES (?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET
        allow_direct_messages=excluded.allow_direct_messages,updated_at=excluded.updated_at
      """,
      [user_id, if(allow, do: 1, else: 0)]
    )

    allow
  end

  def blocked?(blocker_id, blocked_id) do
    SQL.one("SELECT 1 FROM user_blocks WHERE blocker_user_id=? AND blocked_user_id=?", [
      blocker_id,
      blocked_id
    ]) != nil
  end

  def list_blocks(user_id) do
    SQL.all(
      """
      SELECT u.id,u.username,u.display_name,u.avatar_url,b.created_at
      FROM user_blocks b JOIN users u ON u.id=b.blocked_user_id
      WHERE b.blocker_user_id=? ORDER BY u.username COLLATE NOCASE
      """,
      [user_id]
    )
    |> Enum.map(fn [id, username, display_name, avatar_url, created_at] ->
      Map.put(map_user([id, username, display_name, avatar_url]), :createdAt, created_at)
    end)
  end

  def block(user_id, target_id) do
    cond do
      user_id == target_id ->
        {:error, "You cannot block yourself"}

      true ->
        case SQL.one("SELECT id,username,display_name,avatar_url FROM users WHERE id=?", [
               target_id
             ]) do
          nil ->
            {:error, "User not found"}

          row ->
            SQL.exec(
              "INSERT OR IGNORE INTO user_blocks (blocker_user_id,blocked_user_id) VALUES (?,?)",
              [user_id, target_id]
            )

            [created_at] =
              SQL.one(
                "SELECT created_at FROM user_blocks WHERE blocker_user_id=? AND blocked_user_id=?",
                [user_id, target_id]
              )

            {:ok, Map.put(map_user(row), :createdAt, created_at)}
        end
    end
  end

  def unblock(user_id, target_id) do
    SQL.exec("DELETE FROM user_blocks WHERE blocker_user_id=? AND blocked_user_id=?", [
      user_id,
      target_id
    ])

    :ok
  end

  def permission(from_user_id, to_user) do
    cond do
      blocked?(from_user_id, to_user.id) ->
        {:error, "Unblock @#{to_user.username} to start a direct message"}

      blocked?(to_user.id, from_user_id) or not allows?(to_user.id) ->
        {:error, @unreachable}

      true ->
        :ok
    end
  end

  def assert_channel_push_allowed(actor_user_id, target_user_id) do
    if blocked?(actor_user_id, target_user_id) or blocked?(target_user_id, actor_user_id),
      do: {:error, @unreachable},
      else: :ok
  end

  def assert_send_allowed(source_channel_id, actor_user_id) do
    case SQL.one(
           "SELECT user_a_id,user_b_id FROM direct_message_channels WHERE source_channel_id=?",
           [source_channel_id]
         ) do
      nil ->
        :ok

      [a, b] when actor_user_id in [a, b] ->
        other = if actor_user_id == a, do: b, else: a

        if blocked?(actor_user_id, other) or blocked?(other, actor_user_id),
          do: {:error, "Direct message unavailable"},
          else: :ok

      _ ->
        {:error, "Direct message unavailable"}
    end
  end

  def open(actor_user_id, username_raw, options \\ []) do
    with {:ok, target} <- resolve_reachable_user(username_raw),
         :ok <- prevent_self(actor_user_id, target.id),
         :ok <- permission(actor_user_id, target),
         {:ok, actor} <- fetch_user(actor_user_id) do
      case find_pair(actor_user_id, target.id) do
        nil -> create_conversation(actor, target, options)
        pair -> reuse_conversation(pair, actor, target, options)
      end
    end
  end

  def list(user_id) do
    SQL.all(
      """
      SELECT user_a_id,user_b_id,source_vault_id,source_channel_id,created_by,created_at
      FROM direct_message_channels WHERE user_a_id=? OR user_b_id=? ORDER BY created_at DESC
      """,
      [user_id, user_id]
    )
    |> Enum.reduce([], fn row, conversations ->
      pair = map_pair(row)
      other_id = if pair.user_a_id == user_id, do: pair.user_b_id, else: pair.user_a_id

      with {:ok, other} <- fetch_user(other_id),
           mine when not is_nil(mine) <- channel_for_user(pair, user_id) do
        conversations ++ [Map.merge(mine, %{user: other, createdAt: pair.created_at})]
      else
        _ -> conversations
      end
    end)
  end

  def ensure_vault(user_id, options \\ []) do
    mapped = direct_message_vault_id(user_id)

    if mapped && usable_vault?(mapped, user_id) do
      {:ok, mapped}
    else
      create_vault = Keyword.get(options, :create_vault, &default_create_vault/2)

      with {:ok, vault_id} <- invoke_create_vault(create_vault, user_id),
           true <- usable_vault?(vault_id, user_id) do
        SQL.exec(
          """
          INSERT INTO user_dm_vaults (user_id,vault_id) VALUES (?,?)
          ON CONFLICT(user_id) DO UPDATE SET vault_id=excluded.vault_id,created_at=datetime('now')
          """,
          [user_id, vault_id]
        )

        {:ok, vault_id}
      else
        _ -> {:error, "Could not create a private vault for direct messages"}
      end
    end
  end

  defp create_conversation(actor, target, options) do
    with {:ok, source_vault_id} <- ensure_vault(actor.id, options),
         {:ok, source} <- create_channel(source_vault_id, actor.id, target.username, nil, options),
         {:ok, _mirror} <-
           create_mirror(source_vault_id, source.id, actor.id, target, actor.username, options) do
      {a, b} = normalize_pair(actor.id, target.id)

      SQL.exec(
        """
        INSERT INTO direct_message_channels
          (user_a_id,user_b_id,source_vault_id,source_channel_id,created_by)
        VALUES (?,?,?,?,?)
        """,
        [a, b, source_vault_id, source.id, actor.id]
      )

      [created_at] =
        SQL.one(
          "SELECT created_at FROM direct_message_channels WHERE user_a_id=? AND user_b_id=?",
          [a, b]
        )

      {:ok,
       %{
         user: target,
         vaultId: source_vault_id,
         channelId: source.id,
         title: source.title,
         createdAt: created_at,
         created: true
       }}
    end
  end

  defp reuse_conversation(pair, actor, target, options) do
    mine =
      channel_for_user(pair, actor.id) ||
        case create_mirror(
               pair.source_vault_id,
               pair.source_channel_id,
               actor.id,
               actor,
               target.username,
               options
             ) do
          {:ok, mirror} -> mirror
          {:error, _} -> nil
        end

    if mine do
      {:ok, Map.merge(mine, %{user: target, createdAt: pair.created_at, created: false})}
    else
      {:error, "Could not restore direct message"}
    end
  end

  defp create_mirror(source_vault_id, source_channel_id, created_by, user, counterpart, options) do
    with {:ok, vault_id} <- ensure_vault(user.id, options),
         {:ok, note} <- create_channel(vault_id, user.id, counterpart, source_channel_id, options) do
      SQL.exec(
        """
        INSERT INTO chat_channel_links
          (local_vault_id,local_channel_id,source_vault_id,source_channel_id,created_by)
        VALUES (?,?,?,?,?)
        """,
        [vault_id, note.id, source_vault_id, source_channel_id, created_by]
      )

      Cascade.Realtime.PresenceDispatcher.invalidate_user_channels()

      {:ok, %{vaultId: vault_id, channelId: note.id, title: note.title}}
    end
  end

  defp create_channel(vault_id, user_id, counterpart, source_channel_id, options) do
    create_note = Keyword.get(options, :create_note, &default_create_note/4)
    title = "DM — @#{counterpart}"
    suffix = if source_channel_id, do: "\nshared_from=#{source_channel_id}", else: ""
    content = "#{@marker}#{suffix}\ndm_with=#{counterpart}"

    case create_note.(vault_id, user_id, title, content) do
      %{id: id, title: actual_title} = note ->
        notify(options, vault_id, id, actual_title, user_id)
        {:ok, note}

      {:ok, %{id: id, title: actual_title} = note} ->
        notify(options, vault_id, id, actual_title, user_id)
        {:ok, note}

      {:error, _} = error ->
        error

      _ ->
        {:error, "Could not create direct message channel"}
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp channel_for_user(pair, user_id) do
    case SQL.one("SELECT created_by FROM vaults WHERE id=?", [pair.source_vault_id]) do
      [^user_id] ->
        case SQL.one("SELECT id,title FROM notes WHERE id=?", [pair.source_channel_id]) do
          [channel_id, title] ->
            %{vaultId: pair.source_vault_id, channelId: channel_id, title: title}

          nil ->
            nil
        end

      _ ->
        case SQL.one(
               """
               SELECT l.local_vault_id,l.local_channel_id,n.title FROM chat_channel_links l
               JOIN notes n ON n.id=l.local_channel_id WHERE l.source_channel_id=?
                 AND l.local_vault_id IN (SELECT id FROM vaults WHERE created_by=?)
               ORDER BY l.created_at ASC LIMIT 1
               """,
               [pair.source_channel_id, user_id]
             ) do
          [vault_id, channel_id, title] ->
            %{vaultId: vault_id, channelId: channel_id, title: title}

          nil ->
            nil
        end
    end
  end

  defp usable_vault?(vault_id, user_id) do
    SQL.one(
      """
      SELECT 1 FROM vaults v WHERE v.id=? AND v.created_by=?
        AND COALESCE(v.visibility,'private')='private'
        AND (SELECT COUNT(*) FROM vault_members m WHERE m.vault_id=v.id)<=1
      """,
      [vault_id, user_id]
    ) != nil
  end

  defp find_pair(a, b) do
    {first, second} = normalize_pair(a, b)

    case SQL.one(
           """
           SELECT user_a_id,user_b_id,source_vault_id,source_channel_id,created_by,created_at
           FROM direct_message_channels WHERE user_a_id=? AND user_b_id=?
           """,
           [first, second]
         ) do
      nil -> nil
      row -> map_pair(row)
    end
  end

  defp map_pair([a, b, source_vault_id, source_channel_id, created_by, created_at]) do
    %{
      user_a_id: a,
      user_b_id: b,
      source_vault_id: source_vault_id,
      source_channel_id: source_channel_id,
      created_by: created_by,
      created_at: created_at
    }
  end

  defp fetch_user(id) do
    case SQL.one("SELECT id,username,display_name,avatar_url FROM users WHERE id=?", [id]) do
      nil -> {:error, "User not found"}
      row -> {:ok, map_user(row)}
    end
  end

  defp resolve_reachable_user(username) do
    case resolve_user(username) do
      {:ok, user} -> {:ok, user}
      {:error, _} -> {:error, @unreachable}
    end
  end

  defp map_user([id, username, display_name, avatar_url]) do
    %{
      id: id,
      username: username,
      displayName: if(display_name in [nil, ""], do: username, else: display_name),
      avatarUrl: avatar_url || ""
    }
  end

  defp normalize_pair(a, b) when a < b, do: {a, b}
  defp normalize_pair(a, b), do: {b, a}
  defp prevent_self(id, id), do: {:error, "You cannot direct message yourself"}
  defp prevent_self(_actor, _target), do: :ok

  defp default_create_vault(user_id, name), do: Store.create_vault(user_id, %{name: name})

  defp default_create_note(vault_id, user_id, title, content),
    do: Store.create_note(vault_id, user_id, %{title: title, content: content})

  defp invoke_create_vault(fun, user_id) do
    case fun.(user_id, @vault_name) do
      vault_id when is_binary(vault_id) -> {:ok, vault_id}
      %{id: vault_id} when is_binary(vault_id) -> {:ok, vault_id}
      {:ok, vault_id} when is_binary(vault_id) -> {:ok, vault_id}
      {:ok, %{id: vault_id}} when is_binary(vault_id) -> {:ok, vault_id}
      {:error, _} = error -> error
      _ -> {:error, "Could not create a private vault for direct messages"}
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  defp notify(options, vault_id, channel_id, title, user_id) do
    case Keyword.get(options, :on_channel_created) do
      fun when is_function(fun, 1) ->
        fun.(%{vaultId: vault_id, channelId: channel_id, title: title, userId: user_id})

      _ ->
        :ok
    end
  end
end
