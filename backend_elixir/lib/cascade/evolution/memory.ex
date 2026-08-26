defmodule Cascade.Evolution.Memory do
  @moduledoc """
  Stores and injects agent memory notes.

  Folder creation is idempotent, note bodies are privacy-redacted at injection,
  and the character budget is a hard upper bound on the generated prompt text.
  """

  alias Cascade.Content.{Privacy, Query, Store}
  alias Cascade.Evolution.Schema

  @agent_root "_agent"
  @memory "memory"

  def ensure_schema, do: Schema.ensure_schema()

  def ensure_agent_memory_folders(vault_id, user_id) do
    root = get_or_create_folder(vault_id, @agent_root, nil)
    memory = get_or_create_folder(vault_id, @memory, root.id)
    ensure_index(vault_id, user_id, memory.id, "Agent memory index (shared)")
    %{rootId: root.id, memoryId: memory.id}
  end

  def ensure_agent_named_memory_folders(vault_id, user_id, agent_key) do
    root = get_or_create_folder(vault_id, @agent_root, nil)
    key = sanitize_agent_folder(agent_key)

    if key in ["", "memory"] do
      shared = ensure_agent_memory_folders(vault_id, user_id)
      %{rootId: shared.rootId, agentRootId: shared.rootId, memoryId: shared.memoryId}
    else
      agent_root = get_or_create_folder(vault_id, key, root.id)
      memory = get_or_create_folder(vault_id, @memory, agent_root.id)
      ensure_index(vault_id, user_id, memory.id, "Agent memory — @#{key}")
      %{rootId: root.id, agentRootId: agent_root.id, memoryId: memory.id}
    end
  end

  def agent_memory_enabled?(vault_id) do
    ensure_schema()

    case Query.one("SELECT agent_memory_enabled FROM vault_settings WHERE vault_id = ?", [
           vault_id
         ]) do
      [value] -> value != 0
      _ -> true
    end
  end

  def set_agent_memory_enabled(vault_id, enabled) do
    ensure_schema()

    Query.execute(
      """
      INSERT INTO vault_settings (vault_id, agent_memory_enabled, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(vault_id) DO UPDATE SET agent_memory_enabled = excluded.agent_memory_enabled, updated_at = datetime('now')
      """,
      [vault_id, if(enabled, do: 1, else: 0)]
    )

    :ok
  end

  def build_agent_memory_injection(vault_id, opts \\ []) do
    if not agent_memory_enabled?(vault_id) do
      %{enabled: false, text: "", noteIds: [], truncated: false}
    else
      max_chars = opts |> Keyword.get(:max_chars, 4_000) |> bounded(500, 12_000)
      folders = Store.list_folders(vault_id)

      root =
        Enum.find(folders, &(is_nil(&1.parent_id) and String.downcase(&1.name) == @agent_root))

      shared =
        root &&
          Enum.find(folders, &(&1.parent_id == root.id and String.downcase(&1.name) == @memory))

      key = sanitize_agent_folder(Keyword.get(opts, :agent_key, ""))

      named_root =
        root && key != "" &&
          Enum.find(
            folders,
            &(&1.parent_id == root.id and String.downcase(&1.name) == String.downcase(key))
          )

      named =
        named_root &&
          Enum.find(
            folders,
            &(&1.parent_id == named_root.id and String.downcase(&1.name) == @memory)
          )

      folder_ids = [named && named.id, shared && shared.id] |> Enum.reject(&is_nil/1)

      if folder_ids == [] do
        %{enabled: true, text: "", noteIds: [], truncated: false}
      else
        notes = memory_notes(vault_id, folder_ids)
        ranked = Keyword.get(opts, :ranked_note_ids, []) |> Enum.with_index() |> Map.new()
        topic_terms = query_terms(Keyword.get(opts, :channel_topic, ""))
        index = Enum.find(notes, &(String.downcase(&1.title) == "index"))
        others = Enum.reject(notes, &(String.downcase(&1.title) == "index"))

        semantic =
          others
          |> Enum.filter(&Map.has_key?(ranked, &1.id))
          |> Enum.sort_by(&Map.fetch!(ranked, &1.id))

        seen = MapSet.new(Enum.map(semantic, & &1.id))

        keyword =
          if topic_terms == [] do
            []
          else
            Enum.filter(others, fn note ->
              not MapSet.member?(seen, note.id) and
                Enum.any?(
                  topic_terms,
                  &String.contains?(String.downcase("#{note.title}\n#{note.content}"), &1)
                )
            end)
          end

        matched =
          if semantic == [] and keyword == [], do: Enum.take(others, 8), else: semantic ++ keyword

        ordered = if(index, do: [index], else: []) ++ Enum.take(matched, 12)
        inject_notes(ordered, max_chars, Keyword.get(opts, :note_stats, %{}))
      end
    end
  end

  def create_agent_memory_note(user_id, vault_id, input) do
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    agent_key = value(input, :agent_key, nil)

    memory_id =
      if agent_key,
        do: ensure_agent_named_memory_folders(vault_id, user_id, agent_key).memoryId,
        else: ensure_agent_memory_folders(vault_id, user_id).memoryId

    body = input |> value(:body, "") |> to_string() |> String.trim()
    if body == "", do: raise(ArgumentError, "Memory body is required")

    title =
      input
      |> value(:title, String.split(body, "\n") |> List.first() || "Memory")
      |> to_string()
      |> String.slice(0, 80)

    note =
      Store.create_note(vault_id, user_id, %{
        title: title,
        folder_id: memory_id,
        content: body <> "\n",
        is_listed: value(input, :listed, false) == true
      })

    prepend_index_pointer(vault_id, memory_id, note, body, user_id)
    note
  end
  defp get_or_create_folder(vault_id, name, parent_id) do
    existing =
      if parent_id do
        Query.map(
          "SELECT id, name FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE",
          [vault_id, parent_id, name],
          [:id, :name]
        )
      else
        Query.map(
          "SELECT id, name FROM folders WHERE vault_id = ? AND parent_id IS NULL AND name = ? COLLATE NOCASE",
          [vault_id, name],
          [:id, :name]
        )
      end

    existing || Store.create_folder(vault_id, %{name: name, parent_id: parent_id})
  end

  defp ensure_index(vault_id, user_id, folder_id, heading) do
    index =
      Query.map(
        "SELECT id, is_listed FROM notes WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE",
        [vault_id, folder_id],
        [:id, :is_listed]
      )

    cond do
      index && index.is_listed == 0 ->
        Query.execute("UPDATE notes SET is_listed = 1 WHERE id = ?", [index.id])
        Store.notify_note_mutation(index.id, user_id, :move)

      is_nil(index) ->
        Store.create_note(vault_id, user_id, %{
          title: "INDEX",
          folder_id: folder_id,
          is_listed: true,
          content:
            "# #{heading}\n\nOne-line pointers to memory notes in this folder. Higher lines = higher priority when trimming injection.\n\n## Pointers\n\n- (add bullets as agents learn facts)\n"
        })

      true ->
        :ok
    end
  end

  defp memory_notes(vault_id, folder_ids) do
    placeholders = Enum.map_join(folder_ids, ",", fn _ -> "?" end)

    Query.maps(
      "SELECT id, title, content, folder_id, updated_at FROM notes WHERE vault_id = ? AND folder_id IN (#{placeholders}) AND is_archived = 0 ORDER BY CASE WHEN title = 'INDEX' COLLATE NOCASE THEN 0 ELSE 1 END, updated_at DESC",
      [vault_id | folder_ids],
      [:id, :title, :content, :folder_id, :updated_at]
    )
    |> Enum.map(&Map.update!(&1, :content, fn body -> Privacy.redact_blocks(body) end))
  end

  defp inject_notes(notes, max_chars, stats) do
    initial = "Agent memory (vault):"

    {parts, ids, _used, truncated} =
      Enum.reduce_while(notes, {[initial], [], String.length(initial), false}, fn note,
                                                                                  {parts, ids,
                                                                                   used, _} ->
        body =
          note.content
          |> String.replace(~r/^---[\s\S]*?---\n/u, "")
          |> String.replace(~r/\s+/u, " ")
          |> String.trim()
          |> String.slice(0, 600)

        record = stats_record(Map.get(stats, note.id))
        chunk = "\n- [[#{note.title}]]#{record}: #{body}"

        if used + String.length(chunk) > max_chars do
          {:halt, {parts, ids, used, true}}
        else
          {:cont, {parts ++ [chunk], ids ++ [note.id], used + String.length(chunk), false}}
        end
      end)

    %{
      enabled: true,
      text: if(ids == [], do: "", else: Enum.join(parts)),
      noteIds: ids,
      truncated: truncated
    }
  end

  defp prepend_index_pointer(vault_id, memory_id, note, body, user_id) do
    index =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE",
        [vault_id, memory_id],
        [:id, :content]
      )

    if index do
      pointer_body =
        body
        |> Privacy.redact_blocks()
        |> String.replace(~r/\s+/u, " ")
        |> String.slice(0, 120)

      pointer = "- [[#{note.title}]] — #{pointer_body}"

      next =
        if String.contains?(index.content, "## Pointers\n"),
          do:
            String.replace(index.content, "## Pointers\n", "## Pointers\n\n#{pointer}\n",
              global: false
            ),
          else: String.trim_trailing(index.content) <> "\n\n#{pointer}\n"

      Store.update_note(index.id, next, user_id)
    end
  end

  defp stats_record(nil), do: ""

  defp stats_record(stats) do
    uses = value(stats, :uses, 0)
    wins = value(stats, :wins, 0)
    losses = value(stats, :losses, 0)
    decided = wins + losses

    cond do
      uses <= 0 -> ""
      decided > 0 -> " [won #{wins}/#{decided}]"
      true -> " [used #{uses}×]"
    end
  end

  defp sanitize_agent_folder(name) do
    name
    |> to_string()
    |> String.replace(~r/^@+/u, "")
    |> String.trim()
    |> String.replace(~r|[<>:"/\\\|?*\x00-\x1f]+|u, "-")
    |> String.replace(~r/\s+/u, "-")
    |> String.slice(0, 64)
    |> case do
      "" -> "agent"
      value -> value
    end
  end
  defp query_terms(query),
    do: Regex.scan(~r/[a-z0-9_]{3,}/u, String.downcase(to_string(query))) |> List.flatten()

  defp bounded(value, low, high), do: value |> number(low) |> trunc() |> max(low) |> min(high)
  defp number(nil, fallback), do: fallback
  defp number(value, _fallback) when is_integer(value) or is_float(value), do: value

  defp number(value, fallback),
    do:
      case(Float.parse(to_string(value)),
        do: (
          {parsed, _} -> parsed
          :error -> fallback
        )
      )
  defp value(map, key, default),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), default))

end
