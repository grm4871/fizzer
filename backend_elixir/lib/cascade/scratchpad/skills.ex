defmodule Cascade.Scratchpad.Skills do
  @moduledoc "Agent skill note lifecycle, outcomes, scope, and promotion policy."
  alias Cascade.Content.{Privacy, Query, Store}
  alias Cascade.Evolution
  alias Cascade.Scratchpad.{Recall, Schema, Support}
  @agent_root "_agent"
  @memory "memory"
  @skills "skills"
  def ensure_schema, do: Schema.ensure_schema()

  def ensure_skills_folder(vault_id, user_id, agent_key) do
    key = Support.normalize_agent_key(agent_key)

    parent_id =
      if key == "" do
        Evolution.ensure_agent_memory_folders(vault_id, user_id).rootId
      else
        Evolution.ensure_agent_named_memory_folders(vault_id, user_id, key).agentRootId
      end

    %{skillsId: get_or_create_child(vault_id, @skills, parent_id).id}
  end

  def create_skill_note(user_id, vault_id, input) do
    ensure_schema()
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    title = input |> Support.value(:title, "") |> to_string() |> String.trim() |> String.slice(0, 120)
    body = input |> Support.value(:body, "") |> to_string() |> String.trim()
    if title == "", do: raise(ArgumentError, "Skill title is required")
    if body == "", do: raise(ArgumentError, "Skill body is required")
    folder_id = ensure_skills_folder(vault_id, user_id, Support.value(input, :agent_key, "")).skillsId

    existing =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND folder_id = ? AND title = ? COLLATE NOCASE",
        [vault_id, folder_id, title],
        [:id, :content]
      )

    if existing do
      if String.trim(existing.content) != body, do: Schema.delete_note_stats(existing.id)
      Store.update_note(existing.id, body <> "\n", user_id)
    else
      Store.create_note(vault_id, user_id, %{
        title: title,
        folder_id: folder_id,
        is_listed: true,
        content: body <> "\n"
      })
    end
  end

  def list_skill_notes(user_id, vault_id, agent_key \\ nil) do
    ensure_schema()
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    folders = skill_scope(vault_id, Support.normalize_agent_key(agent_key))

    if folders == [] do
      []
    else
      placeholders = Enum.map_join(folders, ",", fn _ -> "?" end)

      Query.maps(
        """
        SELECT n.id, n.title, n.content, n.folder_id, n.updated_at,
               s.uses, s.wins, s.losses
        FROM notes n LEFT JOIN scratchpad_note_stats s ON s.note_id = n.id
        WHERE n.vault_id = ? AND n.folder_id IN (#{placeholders}) AND n.is_archived = 0
        """,
        [vault_id | Enum.map(folders, & &1.id)],
        [:id, :title, :content, :folder_id, :updated_at, :uses, :wins, :losses]
      )
      |> Enum.map(fn row ->
        %{
          id: row.id,
          title: row.title,
          description: skill_description(Privacy.redact_blocks(row.content)),
          shared: Enum.any?(folders, &(&1.id == row.folder_id and &1.shared)),
          updated_at: row.updated_at,
          stats:
            if(is_nil(row.uses),
              do: nil,
              else: %{uses: row.uses, wins: row.wins || 0, losses: row.losses || 0}
            )
        }
      end)
      |> Enum.sort_by(fn skill ->
        {-smoothed_win_rate(skill.stats), -decided(skill.stats), invert_string(skill.updated_at)}
      end)
      |> Enum.map(&Map.drop(&1, [:updated_at]))
      |> Enum.map(fn skill -> if skill.stats, do: skill, else: Map.delete(skill, :stats) end)
    end
  end

  def record_note_outcome(user_id, vault_id, input) do
    ensure_schema()
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    ref = input |> Support.value(:note_ref, "") |> to_string()

    note =
      resolve_note_ref(vault_id, ref, Support.value(input, :agent_key, "")) ||
        raise(ArgumentError, "Note not found: #{ref}")

    result =
      if Support.value(input, :result, "neutral") in ["win", "loss"],
        do: Support.value(input, :result),
        else: "neutral"

    Query.execute(
      """
      INSERT INTO scratchpad_note_stats (note_id, vault_id, uses, wins, losses, last_result, last_used_at)
      VALUES (?, ?, 1, ?, ?, ?, datetime('now'))
      ON CONFLICT(note_id) DO UPDATE SET uses = uses + 1, wins = wins + excluded.wins,
        losses = losses + excluded.losses, last_result = excluded.last_result, last_used_at = datetime('now')
      """,
      [
        note.id,
        vault_id,
        if(result == "win", do: 1, else: 0),
        if(result == "loss", do: 1, else: 0),
        result
      ]
    )

    [uses, wins, losses] =
      Query.one("SELECT uses, wins, losses FROM scratchpad_note_stats WHERE note_id = ?", [
        note.id
      ])

    %{noteId: note.id, title: note.title, uses: uses, wins: wins, losses: losses}
  end

  def note_stats(vault_id) do
    ensure_schema()

    Query.maps(
      "SELECT note_id, uses, wins, losses FROM scratchpad_note_stats WHERE vault_id = ?",
      [vault_id],
      [:note_id, :uses, :wins, :losses]
    )
    |> Map.new(fn row -> {row.note_id, Map.take(row, [:uses, :wins, :losses])} end)
  end

  def promote_note(user_id, vault_id, input) do
    ensure_schema()
    Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    ref = input |> Support.value(:note_ref, "") |> to_string()

    note =
      resolve_note_ref(vault_id, ref, Support.value(input, :agent_key, "")) ||
        raise(ArgumentError, "Note not found: #{ref}")

    if is_nil(note.folder_id), do: raise(ArgumentError, "Note is not in an agent folder")

    folder =
      Query.map("SELECT id, name, parent_id FROM folders WHERE id = ?", [note.folder_id], [
        :id,
        :name,
        :parent_id
      ])

    if is_nil(folder), do: raise(ArgumentError, "Note folder not found")
    folder_name = String.downcase(folder.name)

    if folder_name not in [@memory, @skills] do
      raise ArgumentError, "Only notes in an agent memory or skills folder can be promoted"
    end

    kind = if folder_name == @memory, do: "memory", else: "skill"
    shared = Evolution.ensure_agent_memory_folders(vault_id, user_id)

    target =
      if kind == "memory",
        do: shared.memoryId,
        else: get_or_create_child(vault_id, @skills, shared.rootId).id

    if note.folder_id == target do
      %{note: note, kind: kind}
    else
      Store.move_note(note.id, target, nil, user_id)
      if kind == "memory", do: prepend_shared_pointer(vault_id, shared.memoryId, note, user_id)
      %{note: Store.get_note(note.id), kind: kind}
    end
  end

  defp skill_scope(vault_id, key) do
    folders = Store.list_folders(vault_id)
    root = Enum.find(folders, &(is_nil(&1.parent_id) and String.downcase(&1.name) == @agent_root))

    if is_nil(root) do
      []
    else
      shared =
        Enum.find(folders, &(&1.parent_id == root.id and String.downcase(&1.name) == @skills))

      agent_root =
        Enum.find(
          folders,
          &(&1.parent_id == root.id and String.downcase(&1.name) == String.downcase(key))
        )

      own =
        agent_root &&
          Enum.find(
            folders,
            &(&1.parent_id == agent_root.id and String.downcase(&1.name) == @skills)
          )

      [%{folder: shared, shared: true}, %{folder: own, shared: false}]
      |> Enum.reject(&is_nil(&1.folder))
      |> Enum.map(&%{id: &1.folder.id, shared: &1.shared})
    end
  end

  defp resolve_note_ref(vault_id, ref, key) do
    trimmed = String.trim(to_string(ref))
    by_id = Store.get_note(trimmed)

    cond do
      by_id && by_id.vault_id == vault_id -> by_id
      true -> resolve_title(vault_id, trimmed, key)
    end
  end

  defp resolve_title(vault_id, title, key) do
    rows =
      Query.maps(
        "SELECT id, folder_id FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE",
        [vault_id, title],
        [:id, :folder_id]
      )

    case rows do
      [] ->
        nil

      [row] ->
        Store.get_note(row.id)

      many ->
        key = Support.normalize_agent_key(key)

        if key != "" do
          scope = Recall.scope(vault_id, key)
          own = Enum.filter(many, &(scope[&1.folder_id] && not scope[&1.folder_id].shared))
          shared = Enum.filter(many, &(scope[&1.folder_id] && scope[&1.folder_id].shared))

          cond do
            length(own) == 1 -> Store.get_note(hd(own).id)
            length(own) > 1 -> ambiguous_title(title, many)
            length(shared) == 1 -> Store.get_note(hd(shared).id)
            true -> ambiguous_title(title, many)
          end
        else
          ambiguous_title(title, many)
        end
    end
  end

  defp ambiguous_title(title, rows),
    do:
      raise(
        ArgumentError,
        "Ambiguous title \"#{title}\" matches #{length(rows)} notes — use a note id: #{Enum.map_join(rows, ", ", & &1.id)}"
      )

  defp get_or_create_child(vault_id, name, parent_id) do
    Query.map(
      "SELECT id FROM folders WHERE vault_id = ? AND parent_id = ? AND name = ? COLLATE NOCASE",
      [vault_id, parent_id, name],
      [:id]
    ) || Store.create_folder(vault_id, %{name: name, parent_id: parent_id})
  end

  defp prepend_shared_pointer(vault_id, folder_id, note, user_id) do
    index =
      Query.map(
        "SELECT id, content FROM notes WHERE vault_id = ? AND folder_id = ? AND title = 'INDEX' COLLATE NOCASE",
        [vault_id, folder_id],
        [:id, :content]
      )

    if index && not String.contains?(index.content, "[[#{note.title}]]") do
      hook =
        note.content
        |> Privacy.redact_blocks()
        |> String.replace(~r/^---[\s\S]*?---\n/u, "")
        |> String.replace(~r/\s+/u, " ")
        |> String.trim()
        |> String.slice(0, 120)

      pointer = "- [[#{note.title}]] — #{hook}"

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
  defp smoothed_win_rate(nil), do: 0.5
  defp skill_description(content) do
    content
    |> String.replace(~r/^---[\s\S]*?---\n/u, "")
    |> String.split("\n")
    |> Enum.map(&(String.replace(&1, ~r/^#+\s*/u, "") |> String.trim()))
    |> Enum.find("", &(&1 != ""))
    |> String.slice(0, 140)
  end

  defp smoothed_win_rate(stats), do: (Support.value(stats, :wins, 0) + 1) / (Support.value(stats, :wins, 0) + Support.value(stats, :losses, 0) + 2)
  defp decided(nil), do: 0
  defp decided(stats), do: Support.value(stats, :wins, 0) + Support.value(stats, :losses, 0)
  defp invert_string(value), do: value |> to_string() |> String.to_charlist() |> Enum.map(&(0x10FFFF - &1))
end
