defmodule Cascade.Content.Search do
  @moduledoc "Full-text note and chat search with bounded results and UTF-8-safe snippets."
  import Bitwise
  alias Cascade.Content.Query

  def search(vault_id, query, opts \\ %{}) do
    scope = value(opts, :scope) || "notes"
    limit = opts |> value(:limit) |> numeric_default(40) |> max(1) |> min(100)
    fts_query = search_terms(query)
    redact_private? = value(opts, :redact_private) == true

    if fts_query == "" do
      []
    else
      note_hits =
        if scope in ["notes", "all"],
          do: search_notes(vault_id, fts_query, query, limit, redact_private?),
          else: []

      chat_hits =
        if scope in ["chat", "all"],
          do: search_chat(vault_id, fts_query, query, limit, redact_private?),
          else: []

      (note_hits ++ chat_hits)
      |> Enum.sort_by(& &1.score, :desc)
      |> Enum.take(limit)
    end
  end
  defp search_terms(query) do
    ~r/[a-z0-9_@#\.\/:-]{2,}/u
    |> Regex.scan(query |> to_string() |> String.downcase())
    |> List.flatten()
    |> Enum.uniq()
    |> Enum.map_join(" OR ", &"\"#{String.replace(&1, "\"", "\"\"")}\"")
  end

  defp search_notes(vault_id, fts_query, query, limit, redact_private?) do
    Query.maps(
      """
      SELECT n.id, n.title, n.content, -bm25(notes_fts)
      FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
      WHERE notes_fts MATCH ? AND n.vault_id = ? AND n.is_archived = 0
      ORDER BY bm25(notes_fts) LIMIT ?
      """,
      [fts_query, vault_id, limit],
      [:id, :title, :body, :score]
    )
    |> Enum.map(fn hit ->
      body =
        if redact_private?, do: Cascade.Content.Privacy.redact_blocks(hit.body), else: hit.body

      hit
      |> Map.drop([:body])
      |> Map.put(:snippet, search_snippet(body, query))
      |> Map.put(:type, "note")
    end)
  end

  defp search_chat(vault_id, fts_query, query, limit, redact_private?) do
    try do
      Query.maps(
        """
        SELECT m.id, m.author, m.channel_id, m.body, -bm25(chat_messages_fts), m.created_at
        FROM chat_messages_fts JOIN chat_messages m ON m.rowid = chat_messages_fts.rowid
        WHERE chat_messages_fts MATCH ? AND m.vault_id = ? AND m.body != '' AND m.status IS NULL
        ORDER BY bm25(chat_messages_fts) LIMIT ?
        """,
        [fts_query, vault_id, limit],
        [:id, :title, :channelId, :body, :score, :timestamp]
      )
      |> Enum.map(fn hit ->
        body =
          if redact_private?, do: Cascade.Content.Privacy.redact_blocks(hit.body), else: hit.body

        hit
        |> Map.drop([:body])
        |> Map.put(:snippet, search_snippet(body, query))
        |> Map.put(:type, "chat")
      end)
    rescue
      _ -> []
    end
  end

  defp search_snippet(text, query) do
    clean = text |> String.replace(~r/\s+/u, " ") |> String.trim()

    terms =
      ~r/[a-z0-9_@#\.\/:-]{2,}/u
      |> Regex.scan(query |> to_string() |> String.downcase())
      |> List.flatten()

    lower = String.downcase(clean)

    at =
      terms
      |> Enum.map(fn term ->
        case :binary.match(lower, term) do
          :nomatch -> -1
          {index, _length} -> index
        end
      end)
      |> Enum.reject(&(&1 < 0))
      |> Enum.min(fn -> -1 end)

    start = max(0, if(at < 0, do: 0, else: at) - 70)
    requested_length = min(240, byte_size(clean) - start)
    value = safe_binary_slice(clean, start, requested_length)
    prefix = if start > 0, do: "…", else: ""
    suffix = if start + requested_length < byte_size(clean), do: "…", else: ""
    prefix <> value <> suffix
  end

  defp safe_binary_slice(value, start, length) do
    start = advance_to_utf8_boundary(value, min(start, byte_size(value)))
    finish = retreat_to_utf8_boundary(value, min(start + length, byte_size(value)))
    binary_part(value, start, max(0, finish - start))
  end

  defp advance_to_utf8_boundary(value, index) when index >= byte_size(value), do: byte_size(value)

  defp advance_to_utf8_boundary(value, index) do
    if (:binary.at(value, index) &&& 0xC0) == 0x80,
      do: advance_to_utf8_boundary(value, index + 1),
      else: index
  end

  defp retreat_to_utf8_boundary(_value, 0), do: 0
  defp retreat_to_utf8_boundary(value, index) when index >= byte_size(value), do: byte_size(value)

  defp retreat_to_utf8_boundary(value, index) do
    if (:binary.at(value, index) &&& 0xC0) == 0x80,
      do: retreat_to_utf8_boundary(value, index - 1),
      else: index
  end
  defp numeric_default(value, _default) when is_integer(value), do: value
  defp numeric_default(value, _default) when is_float(value), do: trunc(value)
  defp numeric_default(value, default) when is_binary(value) do
    case Integer.parse(value) do
      {number, _} -> number
      :error -> default
    end
  end
  defp numeric_default(_, default), do: default
  defp value(map, key) when is_map(map), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp value(_, _), do: nil
end
