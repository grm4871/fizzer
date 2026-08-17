defmodule Cascade.Accounts.PublicVaults do
  @moduledoc "Owner-curated public discovery with viewer-only joins and sanitized previews."

  alias Cascade.Accounts.{DirectMessages, Moderation, SQL, VaultMembers}

  @visibilities ~w(private public)
  @join_policies ~w(open request invite)

  def parse_topics(raw) do
    decoded =
      cond do
        is_list(raw) ->
          raw

        is_binary(raw) ->
          case Jason.decode(raw) do
            {:ok, list} when is_list(list) -> list
            _ -> []
          end

        true ->
          []
      end

    case normalize_topics(decoded, false) do
      {:ok, topics} -> topics
      _ -> []
    end
  end

  def normalize_topics(value, require_one \\ true)

  def normalize_topics(value, require_one) when is_list(value) do
    result =
      Enum.reduce_while(value, [], fn raw, topics ->
        topic = normalize_topic(raw)

        cond do
          topic == "" ->
            {:cont, topics}

          String.length(topic) > 32 ->
            {:halt, {:error, "Each topic must be 32 characters or fewer"}}

          topic in topics ->
            {:cont, topics}

          true ->
            {:cont, topics ++ [topic]}
        end
      end)

    case result do
      {:error, _} = error -> error
      topics when length(topics) > 5 -> {:error, "Choose no more than 5 topics"}
      topics when require_one and topics == [] -> {:error, "Choose at least 1 topic"}
      topics -> {:ok, topics}
    end
  end

  def normalize_topics(_value, _require_one), do: {:error, "Topics must be a list"}

  def settings(vault_id) do
    case SQL.one(
           """
           SELECT visibility, public_summary, public_topics, public_guidelines,
             public_home_note_id, public_join_policy FROM vaults WHERE id = ?
           """,
           [vault_id]
         ) do
      nil ->
        nil

      [visibility, summary, topics, guidelines, home_note_id, join_policy] ->
        %{
          visibility: if(visibility in @visibilities, do: visibility, else: "private"),
          summary: summary || "",
          topics: parse_topics(topics),
          guidelines: guidelines || "",
          homeNoteId: home_note_id,
          joinPolicy: if(join_policy in @join_policies, do: join_policy, else: "invite")
        }
    end
  end

  def home_note_choices(vault_id, actor_id) do
    if VaultMembers.role(vault_id, actor_id) != "owner" do
      {:error, "Only the vault owner can curate public discovery"}
    else
      choices =
        SQL.all(
          """
          SELECT id, title FROM notes WHERE vault_id = ? AND is_listed = 1 AND is_archived = 0
            AND trim(content) NOT LIKE 'cascade://chat-channel%'
            AND trim(content_preview) NOT LIKE 'cascade://chat-channel%'
          ORDER BY title COLLATE NOCASE ASC
          """,
          [vault_id]
        )
        |> Enum.map(fn [id, title] -> %{id: id, title: title} end)

      {:ok, choices}
    end
  end

  def update(vault_id, actor_id, input) do
    current = settings(vault_id)

    cond do
      is_nil(current) ->
        {:error, "Vault not found"}

      VaultMembers.role(vault_id, actor_id) != "owner" ->
        {:error, "Only the vault owner can change public discovery"}

      true ->
        build_update(vault_id, actor_id, current, input)
    end
  end

  def list(user_id, options \\ []) do
    limit = options |> Keyword.get(:limit, 50) |> finite_integer(50) |> min(100) |> max(1)
    offset = options |> Keyword.get(:offset, 0) |> finite_integer(0) |> max(0)
    id = Keyword.get(options, :id)
    query = options |> Keyword.get(:query, "") |> to_string() |> String.trim()
    like = if query == "", do: nil, else: "%#{escape_like(query)}%"

    SQL.all(
      """
      SELECT v.id, v.name, v.created_by, u.username,
        COALESCE(NULLIF(u.display_name,''),u.username), COALESCE(u.avatar_url,''),
        (SELECT COUNT(*) FROM vault_members c WHERE c.vault_id = v.id),
        v.public_summary, v.public_topics, v.public_join_policy, v.created_at,
        COALESCE((SELECT MAX(n.updated_at) FROM notes n WHERE n.vault_id = v.id
          AND n.is_listed = 1 AND n.is_archived = 0
          AND trim(n.content) NOT LIKE 'cascade://chat-channel%'
          AND trim(n.content_preview) NOT LIKE 'cascade://chat-channel%'), v.created_at) AS lastActivity,
        (SELECT m.role FROM vault_members m WHERE m.vault_id = v.id AND m.user_id = ?),
        (SELECT r.status FROM public_vault_join_requests r WHERE r.vault_id = v.id AND r.user_id = ?)
      FROM vaults v JOIN users u ON u.id = v.created_by
      WHERE v.visibility = 'public' AND (? IS NULL OR v.id = ?)
        AND (? IS NULL OR v.name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.username LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR v.public_summary LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR v.public_topics LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY CASE WHEN ? IS NULL THEN 0 WHEN v.name = ? COLLATE NOCASE THEN 0
        WHEN v.name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 1
        WHEN u.username LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 2
        WHEN v.public_summary LIKE ? ESCAPE '\\' COLLATE NOCASE THEN 3 ELSE 4 END,
        datetime(lastActivity) DESC, v.name COLLATE NOCASE ASC LIMIT ? OFFSET ?
      """,
      [
        user_id,
        user_id,
        id,
        id,
        like,
        like,
        like,
        like,
        like,
        like,
        like,
        query,
        like,
        like,
        like,
        like,
        limit,
        offset
      ]
    )
    |> Enum.map(&map_summary/1)
  end

  def detail(vault_id, user_id) do
    case list(user_id, id: vault_id, limit: 1) do
      [] ->
        nil

      [summary] ->
        [guidelines, home_note_id] =
          SQL.one(
            "SELECT public_guidelines, public_home_note_id FROM vaults WHERE id = ? AND visibility = 'public'",
            [vault_id]
          )

        note = if home_note_id, do: public_home_note(vault_id, home_note_id), else: nil

        Map.merge(summary, %{
          guidelines: guidelines || "",
          homeNote:
            if(note,
              do: %{
                title: note.title,
                preview: sanitize_preview(note.preview),
                updatedAt: note.updated_at
              },
              else: nil
            )
        })
    end
  end

  def join(vault_id, user_id) do
    case SQL.one(
           "SELECT id, name, created_by, visibility, public_join_policy FROM vaults WHERE id = ?",
           [vault_id]
         ) do
      nil ->
        {:error, "Vault not found"}

      [_id, _name, _owner, visibility, _policy] when visibility != "public" ->
        {:error, "Vault not found"}

      [id, name, owner, _visibility, policy] ->
        do_join(id, name, owner, policy, user_id)
    end
  end

  def join_requests(vault_id, actor_id) do
    if VaultMembers.role(vault_id, actor_id) != "owner" do
      {:error, "Only the vault owner can review join requests"}
    else
      requests =
        SQL.all(
          """
          SELECT r.id, r.user_id, u.username, COALESCE(NULLIF(u.display_name,''),u.username),
            COALESCE(u.avatar_url,''), r.status, r.created_at
          FROM public_vault_join_requests r JOIN users u ON u.id = r.user_id
          WHERE r.vault_id = ? AND r.status = 'pending' ORDER BY r.created_at ASC, r.id ASC
          """,
          [vault_id]
        )
        |> Enum.map(fn [id, user_id, username, display_name, avatar_url, status, created_at] ->
          %{
            id: id,
            userId: user_id,
            username: username,
            displayName: display_name,
            avatarUrl: avatar_url,
            status: status,
            createdAt: created_at
          }
        end)

      {:ok, requests}
    end
  end

  def review_join(vault_id, request_id, actor_id, action) do
    cond do
      VaultMembers.role(vault_id, actor_id) != "owner" ->
        {:error, "Only the vault owner can review join requests"}

      action not in ["approve", "reject"] ->
        {:error, "Action must be approve or reject"}

      true ->
        review_pending(vault_id, request_id, actor_id, action)
    end
  end

  defp build_update(vault_id, actor_id, current, input) do
    visibility = field(input, "visibility", current.visibility)
    summary = field(input, "summary", current.summary) |> to_string() |> String.trim()
    guidelines = field(input, "guidelines", current.guidelines) |> to_string() |> String.trim()
    join_policy = field(input, "joinPolicy", current.joinPolicy)
    topics_input? = has_field?(input, "topics")

    topics_result =
      if topics_input?,
        do: normalize_topics(field(input, "topics"), visibility == "public"),
        else: {:ok, current.topics}

    home_note_id = normalize_home_note(field(input, "homeNoteId", current.homeNoteId))

    cond do
      visibility not in @visibilities ->
        {:error, "Visibility must be public or private"}

      String.length(summary) > 240 ->
        {:error, "Summary must be 240 characters or fewer"}

      String.length(guidelines) > 2_000 ->
        {:error, "Guidelines must be 2000 characters or fewer"}

      join_policy not in @join_policies ->
        {:error, "Join policy must be open, request, or invite"}

      match?({:error, _}, topics_result) ->
        topics_result

      home_note_id == :invalid ->
        {:error, "Home note must be a note id or null"}

      visibility == "public" and current.visibility != "public" and not topics_input? and
          current.topics == [] ->
        {:error, "Choose at least 1 topic before publishing"}

      home_note_id && is_nil(public_home_note(vault_id, home_note_id)) ->
        {:error, "Home note must be a listed non-chat note in this vault"}

      visibility == "public" and DirectMessages.vault_holds_direct_messages?(vault_id) ->
        {:error, "This vault holds direct messages and cannot be made public"}

      true ->
        persist_update(
          vault_id,
          actor_id,
          visibility,
          summary,
          elem(topics_result, 1),
          guidelines,
          home_note_id,
          join_policy
        )
    end
  end

  defp persist_update(
         vault_id,
         actor_id,
         visibility,
         summary,
         topics,
         guidelines,
         home_note_id,
         join_policy
       ) do
    SQL.transaction(fn ->
      SQL.exec(
        """
        UPDATE vaults SET visibility = ?, public_join_role = 'viewer', public_summary = ?,
          public_topics = ?, public_guidelines = ?, public_home_note_id = ?, public_join_policy = ? WHERE id = ?
        """,
        [
          visibility,
          summary,
          Jason.encode!(topics),
          guidelines,
          home_note_id,
          join_policy,
          vault_id
        ]
      )

      if visibility != "public" or join_policy != "request" do
        SQL.exec(
          """
          UPDATE public_vault_join_requests SET status = 'rejected', reviewed_by = ?, updated_at = datetime('now')
          WHERE vault_id = ? AND status = 'pending'
          """,
          [actor_id, vault_id]
        )
      end
    end)

    {:ok,
     %{
       visibility: visibility,
       summary: summary,
       topics: topics,
       guidelines: guidelines,
       homeNoteId: home_note_id,
       joinPolicy: join_policy
     }}
  end

  defp do_join(id, name, owner, policy, user_id) do
    case VaultMembers.role(id, user_id) do
      role when is_binary(role) ->
        {:ok, %{vaultId: id, name: name, role: role, alreadyMember: true, requestStatus: nil}}

      nil ->
        cond do
          Moderation.banned?(id, user_id) ->
            {:error, "This user is banned from this vault"}

          policy == "invite" ->
            {:error, "This vault is invite only"}

          policy == "request" ->
            SQL.exec(
              """
              INSERT INTO public_vault_join_requests (vault_id,user_id,status) VALUES (?,?,'pending')
              ON CONFLICT(vault_id,user_id) DO UPDATE SET status='pending',reviewed_by=NULL,updated_at=datetime('now')
              """,
              [id, user_id]
            )

            {:ok,
             %{vaultId: id, name: name, role: nil, alreadyMember: false, requestStatus: "pending"}}

          true ->
            now = DateTime.utc_now() |> DateTime.to_iso8601()

            SQL.exec(
              "INSERT INTO vault_members (vault_id,user_id,role,invited_by,created_at) VALUES (?,?,'viewer',?,?)",
              [id, user_id, owner, now]
            )

            {:ok,
             %{vaultId: id, name: name, role: "viewer", alreadyMember: false, requestStatus: nil}}
        end
    end
  end

  defp review_pending(vault_id, request_id, actor_id, action) do
    case SQL.one(
           """
           SELECT r.id, r.user_id, r.status, v.visibility, v.public_join_policy
           FROM public_vault_join_requests r JOIN vaults v ON v.id = r.vault_id
           WHERE r.id = ? AND r.vault_id = ?
           """,
           [request_id, vault_id]
         ) do
      nil ->
        {:error, "Join request not found"}

      [_id, _user_id, status, _visibility, _policy] when status != "pending" ->
        {:error, "Join request not found"}

      [_id, _user_id, _status, visibility, policy]
      when action == "approve" and (visibility != "public" or policy != "request") ->
        {:error, "This vault is not accepting join requests"}

      [id, user_id, _status, _visibility, _policy] ->
        if action == "approve" and Moderation.banned?(vault_id, user_id) do
          {:error, "This user is banned from this vault"}
        else
          status = if action == "approve", do: "approved", else: "rejected"

          SQL.transaction(fn ->
            if action == "approve" do
              SQL.exec(
                "INSERT OR IGNORE INTO vault_members (vault_id,user_id,role,invited_by,created_at) VALUES (?,?,'viewer',?,?)",
                [vault_id, user_id, actor_id, DateTime.utc_now() |> DateTime.to_iso8601()]
              )
            end

            SQL.exec(
              "UPDATE public_vault_join_requests SET status=?,reviewed_by=?,updated_at=datetime('now') WHERE id=?",
              [status, actor_id, id]
            )
          end)

          {:ok,
           %{
             requestId: id,
             status: status,
             userId: user_id,
             role: if(action == "approve", do: "viewer", else: nil)
           }}
        end
    end
  end

  defp public_home_note(vault_id, note_id) do
    case SQL.one(
           """
           SELECT id,title,content_preview,updated_at FROM notes WHERE id=? AND vault_id=?
             AND is_listed=1 AND is_archived=0 AND trim(content) NOT LIKE 'cascade://chat-channel%'
             AND trim(content_preview) NOT LIKE 'cascade://chat-channel%'
           """,
           [note_id, vault_id]
         ) do
      [id, title, preview, updated_at] ->
        %{id: id, title: title, preview: preview, updated_at: updated_at}

      nil ->
        nil
    end
  end

  defp map_summary([
         id,
         name,
         owner_id,
         owner_username,
         owner_name,
         owner_avatar,
         member_count,
         summary,
         topics,
         join_policy,
         created_at,
         last_activity,
         role,
         request_status
       ]) do
    %{
      id: id,
      name: name,
      ownerUserId: owner_id,
      ownerUsername: owner_username,
      ownerDisplayName: owner_name,
      ownerAvatarUrl: owner_avatar,
      memberCount: member_count,
      summary: summary || "",
      topics: parse_topics(topics),
      joinPolicy: if(join_policy in @join_policies, do: join_policy, else: "invite"),
      lastActivity: last_activity,
      createdAt: created_at,
      role: if(role in ~w(owner editor viewer), do: role, else: nil),
      requestStatus:
        if(request_status in ~w(pending approved rejected), do: request_status, else: nil)
    }
  end

  defp sanitize_preview(value) do
    value
    |> to_string()
    |> Cascade.Privacy.redact_private_preview()
    |> String.replace(~r/\bfile:\/\/\S+/i, "[path omitted]")
    |> String.replace(~r/\b[A-Za-z]:\\[^\s]+/, "[path omitted]")
    |> String.replace(~r/(^|\s)\/(?:home|Users|var|etc|tmp|opt|srv)\/\S+/, "\\1[path omitted]")
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> String.slice(0, 400)
  end

  defp normalize_topic(raw) when is_binary(raw) do
    raw
    |> :unicode.characters_to_nfkc_binary()
    |> String.trim()
    |> String.downcase()
    |> String.replace(~r/\s+/, " ")
  end

  defp normalize_topic(_), do: ""
  defp normalize_home_note(nil), do: nil

  defp normalize_home_note(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      id -> id
    end
  end

  defp normalize_home_note(_), do: :invalid
  defp escape_like(value), do: String.replace(value, ~r/[\\%_]/, fn char -> "\\#{char}" end)
  defp finite_integer(value, _fallback) when is_integer(value), do: value
  defp finite_integer(value, _fallback) when is_float(value), do: trunc(value)
  defp finite_integer(_value, fallback), do: fallback

  defp field(map, key, default \\ nil),
    do: Map.get(map, key, Map.get(map, String.to_atom(key), default))

  defp has_field?(map, key), do: Map.has_key?(map, key) or Map.has_key?(map, String.to_atom(key))
end
