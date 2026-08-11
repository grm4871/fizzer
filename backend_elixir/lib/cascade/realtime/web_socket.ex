defmodule Cascade.Realtime.WebSocket do
  @moduledoc false
  @behaviour WebSock

  alias Cascade.Realtime.Session

  @max_payload 1_000_000

  @impl true
  def init(%{sid: sid, mode: mode} = state) do
    case Session.attach_websocket(sid, self(), mode) do
      {:ok, packets} ->
        session_ref = monitor_session(sid)
        push_or_ok(packets, Map.put(state, :session_ref, session_ref))

      {:error, reason} ->
        {:stop, reason, 1008, state}
    end
  end

  @impl true
  def handle_in({_data, opcode: :binary}, state),
    do: {:stop, :binary_unsupported, {1003, "Binary Socket.IO packets are unsupported"}, state}

  def handle_in({data, opcode: :text}, state) when byte_size(data) <= @max_payload do
    case Session.websocket_packet(state.sid, data, self()) do
      {:ok, packets} -> push_or_ok(packets, state)
      {:error, :unknown_sid} -> {:stop, :unknown_sid, {1008, "Session ID unknown"}, state}
      {:error, reason} -> {:stop, reason, {1002, "Invalid Engine.IO packet"}, state}
    end
  end

  def handle_in({_data, opcode: :text}, state),
    do: {:stop, :payload_too_large, {1009, "Payload too large"}, state}

  @impl true
  def handle_info({:socket_io_packets, packets}, state), do: push_or_ok(packets, state)

  def handle_info({:DOWN, ref, :process, _pid, _reason}, %{session_ref: ref} = state),
    do: {:stop, :normal, state}

  def handle_info(_message, state), do: {:ok, state}

  @impl true
  def terminate(_reason, state) do
    Session.websocket_closed(state.sid, self())
    :ok
  end

  defp push_or_ok([], state), do: {:ok, state}
  defp push_or_ok([packet], state), do: {:push, {:text, packet}, state}
  defp push_or_ok(packets, state), do: {:push, Enum.map(packets, &{:text, &1}), state}

  defp monitor_session(sid) do
    case Cascade.Realtime.lookup(sid) do
      {:ok, pid} -> Process.monitor(pid)
      :error -> nil
    end
  end
end
