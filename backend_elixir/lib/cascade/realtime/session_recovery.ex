defmodule Cascade.Realtime.SessionRecovery do
  @moduledoc "Realtime disconnect, queue backpressure, polling release, and packet recovery operations."

  alias Cascade.Realtime.{Hub}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}

  def disconnect_namespace_state(namespace, reason, notify_client, state) do
    case Map.pop(state.namespaces, namespace) do
      {nil, _} ->
        state

      {%{identity: identity, context: context}, namespaces} ->
        rooms = Hub.rooms_for_session(state.sid, namespace)
        Hub.leave_namespace(state.sid, namespace, reason)

        safe_disconnected(
          state.domain,
          namespace,
          identity,
          put_disconnect_rooms(context, rooms),
          reason
        )

        state = %{state | namespaces: namespaces}

        if notify_client do
          case enqueue(engine_message(%{type: :disconnect, namespace: namespace}), state) do
            {:ok, state} -> state
            {:error, _reason, state} -> state
          end
        else
          state
        end
    end
  end

  def safe_connected(domain, namespace, identity, context, metadata) do
    if function_exported?(domain, :namespace_connected, 4),
      do: domain.namespace_connected(namespace, identity, context, metadata),
      else: :ok
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  def safe_disconnected(domain, namespace, identity, context, reason) do
    domain.namespace_disconnected(namespace, identity, context, reason)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  def put_disconnect_rooms(context, rooms) when is_map(context),
    do: Map.put(context, :rooms, rooms)

  def put_disconnect_rooms(context, rooms), do: %{domain_context: context, rooms: rooms}

  def enqueue(raw, state) do
    cond do
      state.websocket != nil and state.active_transport == :websocket ->
        case Process.info(state.websocket, :message_queue_len) do
          {:message_queue_len, length} when length >= state.max_mailbox ->
            {:error, :websocket_backpressure, state}

          nil ->
            {:error, :websocket_closed, state}

          _ ->
            send(state.websocket, {:socket_io_packets, [raw]})
            {:ok, state}
        end

      state.poll_waiter != nil ->
        cancel_timer(state.poll_timer)
        GenServer.reply(state.poll_waiter, {:ok, raw})
        {:ok, %{state | poll_waiter: nil, poll_timer: nil}}

      state.queue_packets + 1 > state.max_queue_packets or
          state.queue_bytes + byte_size(raw) > state.max_queue_bytes ->
        {:error, :outbound_backpressure, state}

      true ->
        {:ok,
         %{
           state
           | queue: :queue.in(raw, state.queue),
             queue_packets: state.queue_packets + 1,
             queue_bytes: state.queue_bytes + byte_size(raw)
         }}
    end
  end

  def drain_queue(state) do
    {packets, state} = drain_packets(state)
    {packets |> Enum.intersperse(<<0x1E>>) |> IO.iodata_to_binary(), state}
  end

  def drain_packets(state) do
    packets = :queue.to_list(state.queue)
    {packets, %{state | queue: :queue.new(), queue_packets: 0, queue_bytes: 0}}
  end

  def release_upgrade_poll(%{poll_waiter: nil} = state), do: state

  def release_upgrade_poll(state) do
    cancel_timer(state.poll_timer)
    GenServer.reply(state.poll_waiter, {:ok, EngineIO.encode_packet(%{type: :noop})})
    %{state | poll_waiter: nil, poll_timer: nil}
  end

  def engine_message(packet),
    do: EngineIO.encode_packet(%{type: :message, data: SocketIO.encode(packet)})

  def cancel_timer(nil), do: :ok
  def cancel_timer(timer), do: Process.cancel_timer(timer)
end
