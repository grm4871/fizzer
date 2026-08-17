defmodule Cascade.Privacy do
  @moduledoc "Agent-safe recursive JSON redaction compatible with Cascade private blocks."

  import Bitwise

  @private_start ~r/^[\t ]*:::private[\t ]*\r?$/m
  @private_end ~r/^[\t ]*:::[\t ]*\r?$/m
  @placeholder ~r/\[Private block hidden from agents\. id=[a-z0-9-]+\]/i

  def sanitize_agent_json(value) when is_binary(value), do: redact_private_blocks(value)
  def sanitize_agent_json(value) when is_list(value), do: Enum.map(value, &sanitize_agent_json/1)

  def sanitize_agent_json(value) when is_map(value) do
    Map.new(value, fn
      {key, item} when key in ["content_preview", :content_preview] and is_binary(item) ->
        {key, redact_private_preview(item)}

      {key, item} ->
        {key, sanitize_agent_json(item)}
    end)
  end

  def sanitize_agent_json(value), do: value

  def redact_private_blocks(content) when is_binary(content), do: redact_from(content, 0, 0, [])

  def redact_private_preview(content) when is_binary(content) do
    case Regex.run(~r/:::private\b/i, content, return: :index) do
      [{offset, _length}] ->
        (binary_part(content, 0, offset) <> "[Private block hidden from agents]") |> String.trim()

      nil ->
        content
    end
  end

  defp redact_from(content, cursor, block_index, output) do
    remaining = binary_part(content, cursor, byte_size(content) - cursor)

    case Regex.run(@private_start, remaining, return: :index) do
      nil ->
        IO.iodata_to_binary(Enum.reverse([remaining | output]))

      [{relative_start, opener_length}] ->
        block_start = cursor + relative_start
        search_start = block_start + opener_length
        after_opener = binary_part(content, search_start, byte_size(content) - search_start)

        block_end =
          case Regex.run(@private_end, after_opener, return: :index) do
            [{relative_end, closing_length}] -> search_start + relative_end + closing_length
            nil -> byte_size(content)
          end

        before = binary_part(content, cursor, block_start - cursor)
        raw = binary_part(content, block_start, block_end - block_start)

        replacement =
          if Regex.match?(@placeholder, raw), do: raw, else: placeholder(raw, block_index)

        next_output = [replacement, before | output]

        if block_end >= byte_size(content) do
          IO.iodata_to_binary(Enum.reverse(next_output))
        else
          redact_from(content, block_end, block_index + 1, next_output)
        end
    end
  end

  defp placeholder(raw, block_index) do
    ":::private\n[Private block hidden from agents. id=#{stable_block_id(raw, block_index)}]\n:::"
  end

  # Node hashes JavaScript UTF-16 code units (`charCodeAt`), not Unicode code
  # points. Mirroring that keeps IDs stable during shadow traffic.
  defp stable_block_id(raw, block_index) do
    utf16 = :unicode.characters_to_binary("#{block_index}\0#{raw}", :utf8, {:utf16, :little})

    hash =
      for <<unit::little-unsigned-16 <- utf16>>, reduce: 2_166_136_261 do
        accumulator -> band(bxor(accumulator, unit) * 16_777_619, 0xFFFFFFFF)
      end

    "p#{hash |> Integer.to_string(36) |> String.downcase()}-#{block_index + 1}"
  end
end
