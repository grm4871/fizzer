defmodule Cascade.Evolution.Distillation do
  @moduledoc """
  Turns ordered chat messages into notes, with explicit create, append, and merge
  policies. Message selection, provenance, and duplicate fingerprints are kept
  stable so repeated requests cannot create duplicate create-mode notes.
  """

  alias Cascade.Content.{Query, Store, Versions}
  alias Cascade.Evolution.{Backlinks, Schema}
  @chat_marker "cascade://chat-channel"

  def ensure_schema, do: Schema.ensure_schema()

  def distill_chat_to_note(user_id, vault_id, channel_id, input) do
    ensure_schema()
    vault = Store.get_vault(vault_id, user_id) || raise(ArgumentError, "Vault not found")
    route = assert_chat_channel(channel_id, user_id)
    if route.local_vault_id != vault.id, do: raise(ArgumentError, "Chat channel not found")

    selected = route.source_channel_id |> list_chat_messages() |> select_messages(input)
    if selected == [], do: raise(ArgumentError, "No messages to distill")

    message_ids = Enum.map(selected, & &1.id)

    fingerprint =
      :crypto.hash(:sha256, Enum.join(message_ids, "\n"))
      |> Base.encode16(case: :lower)
      |> String.slice(0, 24)

    mode = value(input, :mode, "create") |> to_string()

    if mode == "create" do
      prior =
        Query.one(
          "SELECT note_id FROM distill_jobs WHERE vault_id = ? AND fingerprint = ? AND mode = 'create' AND note_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [vault_id, fingerprint]
        )

      if prior do
        case Store.get_note(hd(prior)) do
          nil ->
            :ok

          note ->
            throw(
              {:distill_result,
               %{
                 status: "exists",
                 mode: mode,
                 note: note,
                 messageIds: message_ids,
                 priorNoteId: note.id
               }}
            )
        end
      end
    end

    do_distill(mode, selected, route, user_id, vault_id, input, message_ids, fingerprint)
  catch
    {:distill_result, result} -> result
  end
  defp do_distill(mode, selected, route, user_id, vault_id, input, message_ids, fingerprint) do
    summary = extractive_summary(selected)
    transcript = format_transcript(selected)
    by = value(input, :by, "distill")
    at = now()

    provenance =
      [
        "",
        "---",
        "",
        "## Sources",
        "",
        "distilled_from:",
        "- channel_id: `#{route.source_channel_id}`",
        "- at: #{at}",
        "- by: #{by}",
        "- mode: #{mode}",
        "- message_ids:"
      ] ++
        Enum.map(message_ids, &"  - `#{&1}`") ++
        ["", Enum.map_join(message_ids, "\n", &"- `#{&1}`"), ""]

    provenance = Enum.join(provenance, "\n")
    body_core = "#{summary}\n\n## Transcript\n\n#{transcript}#{provenance}"

    case mode do
      "merge" ->
        target =
          required_target(vault_id, value(input, :note_ref, nil), "merge mode requires --note")

        draft =
          [
            String.trim_trailing(target.content),
            "",
            "---",
            "",
            "## Distilled update (#{at})",
            "",
            summary,
            "",
            "### Incoming transcript",
            "",
            transcript,
            provenance
          ]
          |> Enum.join("\n")

        if value(input, :confirm, false) != true do
          %{
            status: "needs_confirm",
            mode: mode,
            draft: draft,
            messageIds: message_ids,
            priorNoteId: target.id
          }
        else
          note = Store.update_note(target.id, draft, user_id)
          Versions.create(note.id, draft, "distill-merge")

          completed_distill(
            note,
            mode,
            selected,
            route,
            user_id,
            vault_id,
            message_ids,
            fingerprint
          )
        end

      "append" ->
        target =
          required_target(vault_id, value(input, :note_ref, nil), "append mode requires --note")

        content =
          [
            String.trim_trailing(target.content),
            "",
            "---",
            "",
            "## Distilled from chat (#{at})",
            "",
            body_core
          ]
          |> Enum.join("\n")

        note = Store.update_note(target.id, content, user_id)
        Versions.create(note.id, content, "distill-append")

        completed_distill(
          note,
          mode,
          selected,
          route,
          user_id,
          vault_id,
          message_ids,
          fingerprint
        )

      _ ->
        title =
          input
          |> value(:title, "Chat distill #{String.slice(at, 0, 10)}")
          |> to_string()
          |> String.trim()

        note =
          Store.create_note(vault_id, user_id, %{
            title: title,
            content: "# #{title}\n\n#{body_core}\n",
            is_listed: false
          })

        Versions.create(note.id, note.content, "distill-create")

        completed_distill(
          note,
          "create",
          selected,
          route,
          user_id,
          vault_id,
          message_ids,
          fingerprint
        )
    end
  end

  defp completed_distill(note, mode, selected, route, user_id, vault_id, message_ids, fingerprint) do
    Enum.each(selected, fn message ->
      Backlinks.index_chat_message_backlinks(vault_id, route.source_channel_id, %{
        id: message.id,
        author: message.author,
        body: "#{message.body}\n![[#{note.title}]]",
        created_at: message.created_at
      })
    end)

    job_id = uuid()

    Query.execute(
      "INSERT INTO distill_jobs (id, vault_id, channel_id, mode, status, note_id, message_ids_json, created_by, fingerprint) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?)",
      [
        job_id,
        vault_id,
        route.source_channel_id,
        mode,
        note.id,
        Jason.encode!(message_ids),
        user_id,
        fingerprint
      ]
    )

    %{status: "completed", mode: mode, note: note, messageIds: message_ids, jobId: job_id}
  end

  defp assert_chat_channel(channel_id, user_id) do
    note = Store.get_note(channel_id)

    if is_nil(note) or not chat_note?(note) or is_nil(Store.get_vault(note.vault_id, user_id)) do
      raise ArgumentError, "Chat channel not found"
    end

    link =
      if table_exists?("chat_channel_links") do
        Query.map(
          "SELECT local_channel_id, local_vault_id, source_channel_id, source_vault_id FROM chat_channel_links WHERE local_channel_id = ?",
          [channel_id],
          [:local_channel_id, :local_vault_id, :source_channel_id, :source_vault_id]
        )
      end

    link ||
      %{
        local_channel_id: note.id,
        local_vault_id: note.vault_id,
        source_channel_id: note.id,
        source_vault_id: note.vault_id
      }
  end

  defp list_chat_messages(channel_id) do
    Query.maps(
      """
      SELECT id, author, body, created_at FROM (
        SELECT id, author, body, created_at, rowid FROM chat_messages
        WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500
      ) ORDER BY created_at ASC, rowid ASC
      """,
      [channel_id],
      [:id, :author, :body, :created_at]
    )
  end

  defp select_messages(messages, input) do
    last_n = value(input, :last_n, nil) |> number(nil)
    from = value(input, :from_message_id, nil)
    to = value(input, :to_message_id, nil)

    cond do
      is_number(last_n) and last_n > 0 -> Enum.take(messages, -min(trunc(last_n), 500))
      from -> select_range(messages, from, to)
      true -> Enum.take(messages, -30)
    end
  end

  defp select_range(messages, from, to) do
    start = Enum.find_index(messages, &(&1.id == from))
    if is_nil(start), do: raise(ArgumentError, "from message not found: #{from}")

    if to do
      finish = Enum.find_index(messages, &(&1.id == to))
      if is_nil(finish), do: raise(ArgumentError, "to message not found: #{to}")
      {first, last} = if finish < start, do: {finish, start}, else: {start, finish}
      Enum.slice(messages, first..last)
    else
      Enum.slice(messages, start, 200)
    end
  end

  defp extractive_summary(messages) do
    authors = messages |> Enum.map(& &1.author) |> Enum.uniq() |> Enum.join(", ")

    lines = [
      "## Summary",
      "",
      "- **Participants:** #{if authors == "", do: "—", else: authors}",
      "- **Messages:** #{length(messages)}",
      "- **Span:** #{List.first(messages).created_at} → #{List.last(messages).created_at}",
      "",
      "## Highlights",
      ""
    ]

    candidates =
      messages
      |> Enum.filter(
        &(String.length(String.trim(&1.body)) > 40 and
            not Regex.match?(~r/^thinking\.\.\.?$/iu, &1.body))
      )
      |> Enum.take(-12)

    highlights =
      if candidates == [] do
        ["_No long messages to highlight — see transcript._"]
      else
        Enum.map(candidates, fn message ->
          body = message.body |> String.replace(~r/\s+/u, " ") |> String.slice(0, 220)

          "- **#{message.author}:** #{body}#{if String.length(message.body) > 220, do: "…", else: ""}"
        end)
      end

    decisions =
      messages
      |> Enum.filter(
        &Regex.match?(~r/\b(decid|action|todo|ship|fix|deploy|agree|will|should)\b/iu, &1.body)
      )
      |> Enum.take(-10)

    decision_lines =
      if decisions == [],
        do: ["_None auto-detected — review transcript._"],
        else:
          Enum.map(
            decisions,
            &"- (#{&1.author}) #{String.slice(String.replace(&1.body, ~r/\s+/u, " "), 0, 200)}"
          )

    Enum.join(
      lines ++ highlights ++ ["", "## Decisions / action items", ""] ++ decision_lines,
      "\n"
    )
  end

  defp format_transcript(messages) do
    Enum.map_join(messages, "\n\n", fn message ->
      timestamp = if message.created_at in [nil, ""], do: "", else: " — #{message.created_at}"

      "### #{message.author} (#{message.id})#{timestamp}\n\n#{if message.body == "", do: "(empty)", else: message.body}"
    end)
  end

  defp required_target(_vault_id, nil, error), do: raise(ArgumentError, error)

  defp required_target(vault_id, ref, _error) do
    resolve_note_ref(vault_id, ref) || raise(ArgumentError, "Note not found: #{ref}")
  end

  defp resolve_note_ref(vault_id, ref) do
    case Store.get_note(to_string(ref)) do
      %{vault_id: ^vault_id} = note -> note
      _ -> resolve_note_by_title(vault_id, ref) |> then(&(&1 && Store.get_note(&1.id)))
    end
  end

  defp resolve_note_by_title(vault_id, title) do
    Query.map(
      "SELECT id, title FROM notes WHERE vault_id = ? AND title = ? COLLATE NOCASE LIMIT 1",
      [vault_id, title],
      [:id, :title]
    )
  end
  defp chat_note?(note),
    do:
      String.starts_with?(String.trim(note.content_preview), @chat_marker) or
        String.starts_with?(String.trim(note.content), @chat_marker)


  defp now, do: DateTime.utc_now() |> DateTime.to_iso8601()
  defp uuid, do: Ecto.UUID.generate()

  defp table_exists?(name),
    do: Query.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name]) != nil

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
