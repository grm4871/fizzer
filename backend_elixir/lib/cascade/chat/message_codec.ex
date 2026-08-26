defmodule Cascade.Chat.MessageCodec do
  @moduledoc """
  Shared message JSON codecs, normalization, and wire-shape helpers.

  Codec fallbacks are deliberately loss-averse: malformed optional JSON becomes
  the same safe nil/empty values used by the canonical message API.
  """

    def encode(nil), do: nil
    def encode(value), do: Jason.encode!(value)
    def decode(value, fallback \\ nil)
    def decode(nil, fallback), do: fallback
    def decode("", fallback), do: fallback
  
    def decode(value, fallback) do
      case Jason.decode(value) do
        {:ok, decoded} -> decoded
        _ -> fallback
      end
    end
  
    def truncate_blocks(nil), do: nil
  
    def truncate_blocks(blocks) when is_list(blocks),
      do:
        Enum.map(blocks, fn block ->
          if is_binary(map_value(block, "text")) and String.length(map_value(block, "text")) > 2_000,
            do:
              put_flexible(block, "text", String.slice(map_value(block, "text"), 0, 1_999) <> "…"),
            else: block
        end)
  
    def truncate_blocks(value), do: value
    def nil_if_empty([]), do: nil
    def nil_if_empty(value), do: value
    def reject_nil_values(map), do: Map.reject(map, fn {_key, value} -> is_nil(value) end)
    def list_or_nil(value) when is_list(value), do: value
    def list_or_nil(_), do: nil
    def nilable(nil), do: nil
    def nilable(""), do: nil
    def nilable(value), do: value
    def map_value(value, key, fallback \\ nil)
    def map_value(nil, _key, fallback), do: fallback
  
    def map_value(map, key, fallback) when is_map(map),
      do: Map.get(map, key, Map.get(map, String.to_atom(key), fallback))
  
    def map_value(_value, _key, fallback), do: fallback
  
    def fetch_value(map, key) when is_map(map) do
      case Map.fetch(map, key) do
        {:ok, value} -> {:ok, value}
        :error -> Map.fetch(map, String.to_atom(key))
      end
    end
  
    def fetch_value(_, _), do: :error
    def atom_key("createdAt"), do: :createdAt
    def atom_key("runId"), do: :runId
    def atom_key("harnessLog"), do: :harnessLog
    def atom_key("replyTo"), do: :replyTo
    def atom_key("changeRequest"), do: :changeRequest
    def atom_key(key), do: String.to_atom(key)
    def key_style(map, key), do: if(Map.has_key?(map, key), do: key, else: String.to_atom(key))
    def put_flexible(map, key, value), do: Map.put(map, key_style(map, key), value)
    def maybe_put(map, _key, ""), do: map
    def maybe_put(map, key, value), do: Map.put(map, key, value)
    def number(value, _fallback) when is_number(value), do: value
  
    def number(value, fallback) when is_binary(value) do
      case Float.parse(value) do
        {number, _} -> number
        :error -> fallback
      end
    end
  
    def number(_, fallback), do: fallback
    def floor_nonnegative(value), do: value |> Float.floor() |> trunc() |> max(0)
    def nonblank("", fallback), do: fallback
    def nonblank(value, _fallback), do: value
    def blank_to_nil(""), do: nil
    def blank_to_nil(value), do: value
    def now, do: DateTime.utc_now() |> DateTime.to_iso8601()
    def sqlite_message(error), do: Exception.message(error)
end
