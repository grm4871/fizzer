defmodule Cascade.Realtime.Protocol.EngineIO do
  @moduledoc "Engine.IO v4 text-packet codec used by the Socket.IO compatibility edge."

  @separator <<0x1E>>
  @types %{
    ?0 => :open,
    ?1 => :close,
    ?2 => :ping,
    ?3 => :pong,
    ?4 => :message,
    ?5 => :upgrade,
    ?6 => :noop
  }
  @codes Map.new(@types, fn {code, type} -> {type, code} end)

  @type packet :: %{required(:type) => atom(), optional(:data) => binary() | map()}

  def decode_payload(payload, max_payload \\ 1_000_000)

  def decode_payload(payload, max_payload)
      when is_binary(payload) and byte_size(payload) <= max_payload do
    payload
    |> :binary.split(@separator, [:global])
    |> Enum.reject(&(&1 == ""))
    |> Enum.reduce_while({:ok, []}, fn raw, {:ok, packets} ->
      case decode_packet(raw) do
        {:ok, packet} -> {:cont, {:ok, [packet | packets]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, packets} -> {:ok, Enum.reverse(packets)}
      error -> error
    end
  end

  def decode_payload(payload, max_payload)
      when is_binary(payload) and byte_size(payload) > max_payload,
      do: {:error, :payload_too_large}

  def decode_payload(_, _), do: {:error, :invalid_payload}

  def decode_packet(<<code, rest::binary>>) do
    case @types[code] do
      nil -> {:error, :unknown_packet_type}
      :open -> decode_open(rest)
      type -> {:ok, if(rest == "", do: %{type: type}, else: %{type: type, data: rest})}
    end
  end

  def decode_packet(_), do: {:error, :empty_packet}

  def encode_payload(packets) when is_list(packets) do
    packets |> Enum.map(&encode_packet/1) |> Enum.intersperse(@separator) |> IO.iodata_to_binary()
  end

  def encode_packet(%{type: type} = packet) do
    case @codes[type] do
      nil -> raise ArgumentError, "unsupported Engine.IO packet type #{inspect(type)}"
      code -> <<code>> <> encode_data(type, Map.get(packet, :data))
    end
  end

  def open_packet(sid, upgrades, ping_interval, ping_timeout, max_payload) do
    %{
      type: :open,
      data: %{
        sid: sid,
        upgrades: upgrades,
        pingInterval: ping_interval,
        pingTimeout: ping_timeout,
        maxPayload: max_payload
      }
    }
  end

  defp decode_open(""), do: {:error, :invalid_open_packet}

  defp decode_open(json) do
    case Jason.decode(json) do
      {:ok, data} when is_map(data) -> {:ok, %{type: :open, data: data}}
      _ -> {:error, :invalid_open_packet}
    end
  end

  defp encode_data(_type, nil), do: ""
  defp encode_data(:open, data), do: Jason.encode!(data)
  defp encode_data(_type, data) when is_binary(data), do: data
  defp encode_data(_type, data), do: Jason.encode!(data)
end
