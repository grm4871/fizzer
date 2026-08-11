defmodule Cascade.Realtime.Protocol.SocketIO do
  @moduledoc "Socket.IO protocol 5 codec for Cascade's non-binary packet subset."

  @types %{
    ?0 => :connect,
    ?1 => :disconnect,
    ?2 => :event,
    ?3 => :ack,
    ?4 => :connect_error,
    ?5 => :binary_event,
    ?6 => :binary_ack
  }
  @codes Map.new(@types, fn {code, type} -> {type, code} end)

  @type packet :: %{
          required(:type) => atom(),
          optional(:namespace) => binary(),
          optional(:id) => non_neg_integer(),
          optional(:data) => term()
        }

  def decode(<<code, rest::binary>>) do
    case @types[code] do
      nil -> {:error, :unknown_packet_type}
      type when type in [:binary_event, :binary_ack] -> {:error, :binary_unsupported}
      type -> decode_fields(type, rest)
    end
  end

  def decode(_), do: {:error, :empty_packet}

  def encode(%{type: type} = packet) do
    if type in [:binary_event, :binary_ack],
      do: raise(ArgumentError, "binary Socket.IO packets are unsupported")

    case @codes[type] do
      nil -> raise ArgumentError, "unsupported Socket.IO packet type #{inspect(type)}"
      code -> <<code>> <> encode_namespace(packet) <> encode_id(packet) <> encode_data(packet)
    end
  end

  def event(namespace, name, args \\ [], id \\ nil) when is_binary(name) and is_list(args) do
    %{type: :event, namespace: namespace, data: [name | args]}
    |> maybe_put_id(id)
  end

  def ack(namespace, id, data) when is_integer(id) and id >= 0,
    do: %{type: :ack, namespace: namespace, id: id, data: List.wrap(data)}

  defp decode_fields(type, rest) do
    with {:ok, namespace, rest} <- take_namespace(rest),
         {:ok, id, rest} <- take_id(rest),
         {:ok, data} <- decode_data(rest),
         :ok <- validate_shape(type, data) do
      packet = %{type: type, namespace: namespace}
      packet = if is_nil(id), do: packet, else: Map.put(packet, :id, id)
      {:ok, if(data == :none, do: packet, else: Map.put(packet, :data, data))}
    end
  end

  defp take_namespace(<<?/, rest::binary>>) do
    case :binary.match(rest, ",") do
      {index, 1} ->
        <<namespace_tail::binary-size(^index), ?,, remaining::binary>> = rest
        {:ok, "/" <> namespace_tail, remaining}

      :nomatch ->
        {:ok, "/" <> rest, ""}
    end
  end

  defp take_namespace(rest), do: {:ok, "/", rest}

  defp take_id(rest), do: take_id(rest, 0, 0)

  defp take_id(<<digit, rest::binary>>, value, count)
       when digit in ?0..?9 and count < 10,
       do: take_id(rest, value * 10 + digit - ?0, count + 1)

  defp take_id(<<digit, _rest::binary>>, _value, 10) when digit in ?0..?9,
    do: {:error, :invalid_id}

  defp take_id(rest, _value, 0), do: {:ok, nil, rest}
  defp take_id(rest, value, _count) when value <= 2_147_483_647, do: {:ok, value, rest}
  defp take_id(_rest, _value, _count), do: {:error, :invalid_id}

  defp decode_data(""), do: {:ok, :none}

  defp decode_data(json) do
    case Jason.decode(json) do
      {:ok, value} -> {:ok, value}
      _ -> {:error, :invalid_json}
    end
  end

  defp validate_shape(:event, data) when is_list(data) and data != [] and is_binary(hd(data)),
    do: :ok

  defp validate_shape(:event, _), do: {:error, :invalid_event}
  defp validate_shape(:ack, data) when is_list(data), do: :ok
  defp validate_shape(:ack, _), do: {:error, :invalid_ack}
  defp validate_shape(:disconnect, :none), do: :ok
  defp validate_shape(_type, _data), do: :ok

  defp encode_namespace(%{namespace: namespace}) when is_binary(namespace) and namespace != "/",
    do: namespace <> ","

  defp encode_namespace(_), do: ""

  defp encode_id(%{id: id}) when is_integer(id) and id >= 0, do: Integer.to_string(id)
  defp encode_id(_), do: ""
  defp encode_data(%{data: data}), do: Jason.encode!(data)
  defp encode_data(_), do: ""

  defp maybe_put_id(packet, nil), do: packet
  defp maybe_put_id(packet, id) when is_integer(id) and id >= 0, do: Map.put(packet, :id, id)
end
