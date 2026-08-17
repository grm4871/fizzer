defmodule Cascade.Realtime.ProtocolTest do
  use ExUnit.Case, async: true

  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}

  test "Engine.IO v4 packets and polling record-separator payloads round trip" do
    open = EngineIO.open_packet("sid-1", ["websocket"], 25_000, 60_000, 1_000_000)
    packets = [open, %{type: :ping}, %{type: :message, data: "40/vault,{\"token\":\"t\"}"}]
    payload = EngineIO.encode_payload(packets)

    assert payload =~ <<0x1E>>

    assert {:ok, [decoded_open, %{type: :ping}, %{type: :message, data: message}]} =
             EngineIO.decode_payload(payload)

    assert decoded_open.data["sid"] == "sid-1"
    assert decoded_open.data["upgrades"] == ["websocket"]
    assert message == "40/vault,{\"token\":\"t\"}"
  end

  test "Engine.IO rejects oversized, empty, and unknown packets" do
    assert {:error, :payload_too_large} = EngineIO.decode_payload("12345", 4)
    assert {:error, :empty_packet} = EngineIO.decode_packet("")
    assert {:error, :unknown_packet_type} = EngineIO.decode_packet("9wat")
  end

  test "Socket.IO v5 namespace packets, ids, events, and acknowledgements round trip" do
    cases = [
      %{type: :connect, namespace: "/vault", data: %{"token" => "jwt"}},
      SocketIO.event("/runners", "run:cancel", [%{"runId" => 42}], 17),
      SocketIO.ack("/runners", 17, [%{"success" => true}]),
      %{type: :disconnect, namespace: "/runs"},
      %{type: :connect_error, namespace: "/vault", data: %{message: "no"}}
    ]

    Enum.each(cases, fn packet ->
      assert {:ok, decoded} = packet |> SocketIO.encode() |> SocketIO.decode()
      assert decoded.type == packet.type
      assert decoded.namespace == packet.namespace
      assert Map.get(decoded, :id) == Map.get(packet, :id)
      assert normalize(decoded[:data]) == normalize(packet[:data])
    end)
  end

  test "Socket.IO binary packets fail closed" do
    assert {:error, :binary_unsupported} = SocketIO.decode("5/vault,1-[{\"_placeholder\":true}]")
    assert_raise ArgumentError, fn -> apply(SocketIO, :encode, [%{type: :binary_event}]) end
  end

  test "Socket.IO validates event and ack shapes" do
    assert {:error, :invalid_event} = SocketIO.decode("2/vault,{\"not\":\"an array\"}")
    assert {:error, :invalid_ack} = SocketIO.decode("3/vault,7{\"not\":\"an array\"}")
    assert {:error, :invalid_json} = SocketIO.decode("2/vault,[")
    assert {:error, :invalid_id} = SocketIO.decode("2/vault,99999999999[\"event\"]")
  end

  defp normalize(nil), do: nil
  defp normalize(value), do: value |> Jason.encode!() |> Jason.decode!()
end
