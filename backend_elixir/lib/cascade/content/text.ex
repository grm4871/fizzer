defmodule Cascade.Content.Text do
  @moduledoc """
  Builds the persisted plain-text preview and word count for note Markdown.

  Both interactive note writes and filesystem rescans use this module so the
  database projection is independent of the ingestion path.
  """

  @spec preview(term()) :: String.t()
  def preview(content) do
    stripped =
      content
      |> to_string()
      |> String.replace(~r/\\+`/u, "`")
      |> String.replace(~r/^[#]{1,6}\s+/mu, "")
      |> String.replace(~r/\*\*([^*]+)\*/u, "\\1")
      |> String.replace(~r/\*([^*]+)\*/u, "\\1")
      |> String.replace(~r/__([^_]+)__/u, "\\1")
      |> String.replace(~r/_([^_]+)_/u, "\\1")
      |> String.replace(~r/~~([^~]+)~~/u, "\\1")
      |> String.replace(~r/`([^`]+)`/u, "\\1")
      |> String.replace(~r/```[\s\S]*?```/u, "")
      |> String.replace(~r/\[([^\]]+)\]\([^)]+\)/u, "\\1")
      |> String.replace(~r/!\[([^\]]*)\]\([^)]+\)/u, "\\1")
      |> String.replace(~r/\[\[([^\]]+)\]\]/u, "\\1")
      |> String.replace(~r/[-*+]\s+/u, "")
      |> String.replace(~r/>\s+/u, "")
      |> String.replace(~r/\n{2,}/u, " ")
      |> String.replace("\n", " ")
      |> String.trim()

    String.slice(stripped, 0, 200)
  end

  @spec word_count(term()) :: non_neg_integer()
  def word_count(content) do
    case content |> to_string() |> String.trim() do
      "" -> 0
      trimmed -> trimmed |> String.split(~r/\s+/u, trim: true) |> length()
    end
  end
end
