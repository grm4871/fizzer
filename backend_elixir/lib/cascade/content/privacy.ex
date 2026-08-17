defmodule Cascade.Content.Privacy do
  @moduledoc false

  import Bitwise

  @start ~r/^[\t ]*:::private[\t ]*$/iu
  @finish ~r/^[\t ]*:::[\t ]*$/u
  @placeholder ~r/\[Private block hidden from agents\. id=([a-z0-9-]+)\]/iu

  def redact_note(nil, _agent?), do: nil

  def redact_note(note, agent?) do
    note = Map.delete(note, :file_path)

    if agent? do
      note
      |> maybe_update(:content, &redact_blocks/1)
      |> maybe_update(:content_preview, &redact_preview/1)
    else
      note
    end
  end

  def redact_blocks(content) do
    replace_blocks(to_string(content), fn block ->
      if Regex.match?(@placeholder, block.raw), do: block.raw, else: placeholder(block)
    end)
  end

  def redact_preview(content) do
    value = to_string(content)

    case :binary.match(String.downcase(value), ":::private") do
      :nomatch ->
        value

      {offset, _length} ->
        String.trim(binary_part(value, 0, offset) <> "[Private block hidden from agents]")
    end
  end

  def sanitize_json(value) when is_binary(value), do: redact_blocks(value)
  def sanitize_json(value) when is_list(value), do: Enum.map(value, &sanitize_json/1)

  def sanitize_json(value) when is_map(value) do
    Map.new(value, fn
      {key, item} when key in [:content_preview, "content_preview"] and is_binary(item) ->
        {key, redact_preview(item)}

      {key, item} ->
        {key, sanitize_json(item)}
    end)
  end

  def sanitize_json(value), do: value

  def restore_blocks(existing, incoming) do
    blocks = private_blocks(existing)
    incoming = to_string(incoming)

    if blocks == [] do
      if Regex.match?(@placeholder, incoming),
        do: raise(ArgumentError, "Unknown private block placeholder.")

      incoming
    else
      expected = blocks |> Enum.map(& &1.id) |> MapSet.new()

      @placeholder
      |> Regex.scan(incoming, capture: :all_but_first)
      |> Enum.each(fn [id] ->
        if not MapSet.member?(expected, id),
          do: raise(ArgumentError, "Unknown private block placeholder.")
      end)

      Enum.reduce(blocks, incoming, fn block, restored ->
        marker = placeholder(block)

        if length(:binary.matches(restored, marker)) != 1 do
          raise ArgumentError,
                "Agent edits must preserve every private block placeholder exactly once."
        end

        String.replace(restored, marker, block.raw, global: false)
      end)
    end
  end

  defp private_blocks(content) do
    lines = content_lines(to_string(content))
    parse_blocks(lines, to_string(content), 0, [])
  end

  defp parse_blocks(lines, _content, index, blocks) when index >= length(lines),
    do: Enum.reverse(blocks)

  defp parse_blocks(lines, content, index, blocks) do
    line = Enum.at(lines, index)

    if Regex.match?(@start, line.text) do
      {finish, closing_index} = find_finish(lines, index + 1, byte_size(content))
      raw = binary_part(content, line.from, finish - line.from)
      block = %{from: line.from, to: finish, raw: raw, id: stable_id(raw, length(blocks))}

      if closing_index >= length(lines) do
        Enum.reverse([block | blocks])
      else
        parse_blocks(lines, content, closing_index + 1, [block | blocks])
      end
    else
      parse_blocks(lines, content, index + 1, blocks)
    end
  end

  defp find_finish(lines, index, default) when index >= length(lines),
    do: {default, length(lines)}

  defp find_finish(lines, index, default) do
    line = Enum.at(lines, index)

    if Regex.match?(@finish, line.text),
      do: {line.to, index},
      else: find_finish(lines, index + 1, default)
  end

  defp content_lines(""), do: []

  defp content_lines(content) do
    do_content_lines(content, 0, [])
  end

  defp do_content_lines(content, from, lines) when from >= byte_size(content),
    do: Enum.reverse(lines)

  defp do_content_lines(content, from, lines) do
    rest = binary_part(content, from, byte_size(content) - from)

    case :binary.match(rest, "\n") do
      :nomatch ->
        raw = rest

        text =
          if String.ends_with?(raw, "\r"), do: binary_part(raw, 0, byte_size(raw) - 1), else: raw

        Enum.reverse([%{from: from, to: byte_size(content), text: text} | lines])

      {relative, 1} ->
        raw = binary_part(content, from, relative)

        text =
          if String.ends_with?(raw, "\r"), do: binary_part(raw, 0, byte_size(raw) - 1), else: raw

        do_content_lines(content, from + relative + 1, [
          %{from: from, to: from + relative, text: text} | lines
        ])
    end
  end

  defp stable_id(raw, index) do
    input = Integer.to_string(index) <> <<0>> <> raw

    utf16 = :unicode.characters_to_binary(input, :utf8, {:utf16, :little})

    hash =
      for <<unit::little-16 <- utf16>>, reduce: 2_166_136_261 do
        current -> band(bxor(current, unit) * 16_777_619, 0xFFFFFFFF)
      end

    "p#{Integer.to_string(hash, 36)}-#{index + 1}"
  end

  defp placeholder(block) do
    ":::private\n[Private block hidden from agents. id=#{block.id}]\n:::"
  end

  defp replace_blocks(content, replacement) do
    blocks = private_blocks(content)

    {parts, cursor} =
      Enum.reduce(blocks, {[], 0}, fn block, {parts, cursor} ->
        prefix = binary_part(content, cursor, block.from - cursor)
        {[parts, prefix, replacement.(block)], block.to}
      end)

    IO.iodata_to_binary([parts, binary_part(content, cursor, byte_size(content) - cursor)])
  end

  defp maybe_update(map, key, function) do
    case Map.fetch(map, key) do
      {:ok, value} when is_binary(value) -> Map.put(map, key, function.(value))
      _ -> map
    end
  end
end
