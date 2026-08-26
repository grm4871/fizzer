defmodule Cascade.Scratchpad.Support do
  @moduledoc "Shared normalization, bounds, and input helpers for scratchpad modules."

  def normalize_agent_key(value),
    do: value |> to_string() |> String.replace(~r/^@+/u, "") |> String.trim() |> String.slice(0, 64)

  def bounded(value, low, high), do: number(value, low) |> trunc() |> max(low) |> min(high)
  def number(nil, fallback), do: fallback
  def number(value, _fallback) when is_integer(value) or is_float(value), do: value

  def number(value, fallback) do
    case Float.parse(to_string(value)) do
      {parsed, _} -> parsed
      :error -> fallback
    end
  end

  def positive_number(value) do
    case number(value, nil) do
      number when is_number(number) and number > 0 -> trunc(number)
      _ -> nil
    end
  end

  def maybe_clause(items, false, _clause, _param), do: items
  def maybe_clause(items, true, clause, nil), do: items ++ [{clause, nil}]
  def maybe_clause(items, true, clause, param), do: items ++ [{clause, param}]

  def env_int(name, default, low, high),
    do: System.get_env(name) |> number(default) |> trunc() |> max(low) |> min(high)

  def format_win_record(nil), do: ""
  def format_win_record(stats) do
    uses = value(stats, :uses, 0)
    wins = value(stats, :wins, 0)
    losses = value(stats, :losses, 0)
    decided = wins + losses
    cond do
      uses == 0 -> ""
      decided == 0 -> "used #{uses}×"
      true -> "won #{wins}/#{decided}"
    end
  end

  def value(map, key, default \\ nil),
    do: Map.get(map, key, Map.get(map, Atom.to_string(key), default))
end
