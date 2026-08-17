defmodule Cascade.Content.Versions do
  @moduledoc "Node-compatible note snapshots and line-oriented LCS diffs."

  alias Cascade.Content.Query

  @valid_labels ~w(manual auto ai-edit pre-ai save created)

  def create(note_id, content, label \\ nil) do
    id = Ecto.UUID.generate()
    safe_label = if label in @valid_labels, do: label, else: nil

    Query.execute(
      "INSERT INTO note_versions (id, note_id, content, label) VALUES (?, ?, ?, ?)",
      [id, note_id, content, safe_label]
    )

    get(id)
  end

  def list(note_id) do
    Query.maps(
      "SELECT id, note_id, label, created_at FROM note_versions WHERE note_id = ? ORDER BY created_at DESC",
      [note_id],
      [:id, :note_id, :label, :created_at]
    )
  end

  def get(id) do
    Query.map(
      "SELECT id, note_id, content, label, created_at FROM note_versions WHERE id = ?",
      [id],
      [:id, :note_id, :content, :label, :created_at]
    )
  end

  def diff_versions(from_id, to_id) do
    with from when not is_nil(from) <- get(from_id),
         to when not is_nil(to) <- get(to_id) do
      diff_text(
        from.content,
        to.content,
        "version-#{String.slice(from.id, 0, 8)}",
        "version-#{String.slice(to.id, 0, 8)}"
      )
    else
      _ -> nil
    end
  end

  def diff_text(from, to, from_label \\ "before", to_label \\ "after") do
    left = String.split(from, ~r/\r?\n/u)
    right = String.split(to, ~r/\r?\n/u)
    table = lcs_table(left, right)

    lines = walk_diff(left, right, table, 0, 0, [])
    Enum.join(["--- #{from_label}", "+++ #{to_label}", "@@" | lines], "\n")
  end

  defp lcs_table(left, right) do
    left_size = length(left)
    right_size = length(right)
    left_tuple = List.to_tuple(left)
    right_tuple = List.to_tuple(right)

    Enum.reduce((left_size - 1)..0//-1, %{}, fn i, table ->
      Enum.reduce((right_size - 1)..0//-1, table, fn j, current ->
        value =
          if elem(left_tuple, i) == elem(right_tuple, j) do
            Map.get(current, {i + 1, j + 1}, 0) + 1
          else
            max(Map.get(current, {i + 1, j}, 0), Map.get(current, {i, j + 1}, 0))
          end

        Map.put(current, {i, j}, value)
      end)
    end)
  end

  defp walk_diff(left, right, table, i, j, output) do
    cond do
      i < length(left) and j < length(right) and Enum.at(left, i) == Enum.at(right, j) ->
        walk_diff(left, right, table, i + 1, j + 1, [" #{Enum.at(left, i)}" | output])

      i < length(left) and
          (j >= length(right) or Map.get(table, {i + 1, j}, 0) >= Map.get(table, {i, j + 1}, 0)) ->
        walk_diff(left, right, table, i + 1, j, ["-#{Enum.at(left, i)}" | output])

      j < length(right) ->
        walk_diff(left, right, table, i, j + 1, ["+#{Enum.at(right, j)}" | output])

      true ->
        Enum.reverse(output)
    end
  end
end
