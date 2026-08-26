defmodule Cascade.Scratchpad.Recall do
  @moduledoc "Privacy-redacted lexical recall over scoped memory and skill notes."
  alias Cascade.Content.{Privacy, Query, Store}
  alias Cascade.Scratchpad.{Schema, Skills, Support}
  @agent_root "_agent"
  @memory "memory"
  @skills "skills"
  def ensure_schema, do: Schema.ensure_schema()
  def scope(vault_id, key), do: recall_scope(vault_id, key)

  def recall(user_id, vault_id, input) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    query = input |> Support.value(:query, "") |> to_string() |> String.trim()

    if query == "" do
      []
    else
      limit = input |> Support.value(:limit, 5) |> Support.bounded(1, 20)
      scope = recall_scope(vault.id, Support.normalize_agent_key(Support.value(input, :agent_key, "")))

      if map_size(scope) == 0 do
        []
      else
        recall_scored(vault.id, scope, query, limit, Support.value(input, :ranked_ids, []))
      end
    end
  end
  defp recall_scored(vault_id, scope, query, limit, ranked_ids) do
    folder_ids = Map.keys(scope)
    placeholders = Enum.map_join(folder_ids, ",", fn _ -> "?" end)

    notes =
      Query.maps(
        "SELECT id, title, content, folder_id FROM notes WHERE vault_id = ? AND folder_id IN (#{placeholders}) AND is_archived = 0 AND title <> 'INDEX' COLLATE NOCASE",
        [vault_id | folder_ids],
        [:id, :title, :content, :folder_id]
      )

    terms = query_terms(query)
    ranks = ranked_ids |> Enum.with_index() |> Map.new()
    stats = note_stats(vault_id)

    notes
    |> Enum.flat_map(fn note ->
      meta = scope[note.folder_id]
      body = note.content |> Privacy.redact_blocks() |> String.replace(~r/^---[\s\S]*?---\n/u, "")
      auto = meta.kind == "memory" and auto_capture?(note.title, body)
      title_hits = lexical_hits(terms, note.title)
      body_hits = lexical_hits(terms, "#{note.title}\n#{body}")
      minimum = if auto, do: min(2, length(terms)), else: 1

      if terms == [] or body_hits < minimum do
        []
      else
        score =
          body_hits + title_hits * 0.75 + if(meta.kind == "skill", do: 2.5, else: 0.0) +
            if(meta.shared, do: 0.0, else: 0.5) - if(auto, do: 2.0, else: 0.0)

        score =
          score + if(stats[note.id], do: smoothed_win_rate(stats[note.id]) * 0.75, else: 0.0)

        score =
          score +
            if(Map.has_key?(ranks, note.id), do: max(0, 1.2 - ranks[note.id] * 0.08), else: 0.0)

        [%{note: note, meta: meta, score: score}]
      end
    end)
    |> Enum.filter(&(&1.score >= 1.0))
    |> Enum.sort_by(&{-&1.score, &1.note.title})
    |> Enum.take(limit)
    |> Enum.map(fn hit ->
      body =
        hit.note.content
        |> Privacy.redact_blocks()
        |> String.replace(~r/^---[\s\S]*?---\n/u, "")
        |> String.replace(~r/\s+/u, " ")
        |> String.trim()
        |> String.slice(0, 240)

      %{
        id: hit.note.id,
        title: hit.note.title,
        snippet: body,
        kind: hit.meta.kind,
        shared: hit.meta.shared
      }
      |> maybe_put(:stats, stats[hit.note.id])
    end)
  end

  defp recall_scope(vault_id, key) do
    folders = Store.list_folders(vault_id)
    root = Enum.find(folders, &(is_nil(&1.parent_id) and String.downcase(&1.name) == @agent_root))

    if is_nil(root) do
      %{}
    else
      shared = children_scope(folders, root.id, true)

      agent =
        Enum.find(
          folders,
          &(&1.parent_id == root.id and String.downcase(&1.name) == String.downcase(key))
        )

      Map.merge(shared, if(agent, do: children_scope(folders, agent.id, false), else: %{}))
    end
  end

  defp children_scope(folders, parent_id, shared) do
    folders
    |> Enum.filter(
      &(&1.parent_id == parent_id and String.downcase(&1.name) in [@memory, @skills])
    )
    |> Map.new(fn folder ->
      {folder.id,
       %{
         kind: if(String.downcase(folder.name) == @memory, do: "memory", else: "skill"),
         shared: shared
       }}
    end)
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
          scope = recall_scope(vault_id, key)
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

  defp note_stats(vault_id), do: Skills.note_stats(vault_id)
  defp auto_capture?(title, body),
    do:
      Regex.match?(~r/Captured from completed run/iu, body) or
        (Regex.match?(~r/##\s*Request\b/iu, body) and Regex.match?(~r/##\s*Outcome\b/iu, body)) or
        (Regex.match?(~r/\(\d{2,}\)\s*$/u, title) and Regex.match?(~r/Channel:\s*/iu, body))

  defp query_terms(query),
    do: Regex.scan(~r/[a-z0-9_]{3,}/u, String.downcase(to_string(query))) |> List.flatten()

  defp lexical_hits(terms, haystack),
    do: Enum.count(terms, &String.contains?(String.downcase(haystack), &1))

  defp smoothed_win_rate(nil), do: 0.5

  defp smoothed_win_rate(stats),
    do: (Support.value(stats, :wins, 0) + 1) / (Support.value(stats, :wins, 0) + Support.value(stats, :losses, 0) + 2)

  defp decided(nil), do: 0
  defp decided(stats), do: Support.value(stats, :wins, 0) + Support.value(stats, :losses, 0)
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
