defmodule Cascade.Realtime.SessionDispatch do
  @moduledoc "Socket.IO packet dispatch and domain-action application for a realtime session."

  @ping_interval 25_000

  alias Cascade.Realtime.{Hub, SessionHandshake, SessionRecovery}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}

  def process_engine_packets(packets, source, state) do
    Enum.reduce_while(packets, {:ok, state}, fn packet, {:ok, state} ->
      case process_engine_packet(packet, source, state) do
        {:ok, state} -> {:cont, {:ok, state}}
        other -> {:halt, other}
      end
    end)
  end

  def process_engine_packet(%{type: :pong}, _source, state) do
    SessionRecovery.cancel_timer(state.pong_timer)
    timer = Process.send_after(self(), :heartbeat_ping, @ping_interval)
    {:ok, %{state | pong_timer: nil, heartbeat_timer: timer}}
  end

  def process_engine_packet(%{type: :message, data: data}, _source, state),
    do: process_socket_packet(data, state)

  def process_engine_packet(%{type: :close}, _source, state), do: {:close, :client_close, state}

  def process_engine_packet(%{type: type}, _source, _state),
    do: {:error, {:unexpected_packet, type}}

  def process_websocket_packet(%{type: :ping, data: "probe"}, pid, state) do
    if state.upgrade_socket == pid do
      state = state |> SessionRecovery.release_upgrade_poll() |> Map.put(:upgrade_probed, true)
      {:ok, [EngineIO.encode_packet(%{type: :pong, data: "probe"})], state}
    else
      {:error, :invalid_upgrade_probe}
    end
  end

  def process_websocket_packet(%{type: :upgrade}, pid, state) do
    if state.upgrade_socket == pid do
      state = SessionRecovery.release_upgrade_poll(state)
      {queued, state} = SessionRecovery.drain_packets(%{state | active_transport: :websocket})

      {:ok, queued,
       %{
         state
         | websocket: pid,
           upgrade_socket: nil,
           upgrade_probed: false,
           poll_waiter: nil,
           poll_timer: nil
       }}
    else
      {:error, :invalid_upgrade}
    end
  end

  def process_websocket_packet(packet, pid, state) do
    if state.websocket == pid do
      case process_engine_packet(packet, :websocket, state) do
        {:ok, state} -> {:ok, [], state}
        other -> other
      end
    else
      {:error, :transport_mismatch}
    end
  end

  def process_socket_packet(raw, state) do
    case SocketIO.decode(raw) do
      {:ok, %{type: :connect} = packet} ->
        SessionHandshake.connect_namespace(packet, state)

      {:ok, %{type: :disconnect, namespace: namespace}} ->
        {:ok, SessionRecovery.disconnect_namespace_state(namespace, :client_disconnect, false, state)}

      {:ok, %{type: :event} = packet} ->
        handle_domain_event(packet, state)

      {:ok, %{type: :ack, id: id} = packet} ->
        handle_ack(id, Map.get(packet, :data, []), state)

      {:ok, %{type: type}} ->
        {:error, {:unexpected_socket_packet, type}}

      error ->
        error
    end
  end

  def handle_domain_event(%{namespace: namespace, data: [event | args]} = packet, state) do
    with %{identity: identity, context: context} <- state.namespaces[namespace],
         {:ok, actions} <-
           safe_domain_event(state.domain, namespace, event, args, identity, context),
         {:ok, state} <- apply_actions(actions, namespace, Map.get(packet, :id), identity, state) do
      {:ok, state}
    else
      nil -> maybe_error_ack(packet, "Namespace is not connected", state)
      {:error, message} -> maybe_error_ack(packet, message, state)
    end
  end

  def handle_ack(id, data, state) do
    case Map.pop(state.pending_acks, id) do
      {nil, _} ->
        {:ok, state}

      {{from, timer}, pending} ->
        SessionRecovery.cancel_timer(timer)
        GenServer.reply(from, {:ok, data})
        {:ok, %{state | pending_acks: pending}}
    end
  end

  def safe_domain_event(domain, namespace, event, args, identity, context) do
    domain.handle_event(namespace, event, args, identity, context)
  rescue
    _ -> {:error, "Realtime domain handler failed"}
  catch
    _, _ -> {:error, "Realtime domain handler failed"}
  end

  def safe_authorize(domain, namespace, identity, metadata) do
    domain.authorize_namespace(namespace, identity, metadata)
  rescue
    _ -> {:error, "Namespace authorization failed"}
  catch
    _, _ -> {:error, "Namespace authorization failed"}
  end

  def apply_actions(actions, namespace, ack_id, identity, state) when is_list(actions) do
    Enum.reduce_while(actions, {:ok, state}, fn action, {:ok, state} ->
      case apply_action(action, namespace, ack_id, identity, state) do
        {:ok, state} -> {:cont, {:ok, state}}
        error -> {:halt, error}
      end
    end)
  end

  def apply_actions(_, _namespace, _ack_id, _identity, _state),
    do: {:error, "Invalid realtime domain result"}

  def apply_action({:join, room}, namespace, _ack_id, _identity, state) do
    case Hub.join(state.sid, namespace, room) do
      :ok -> {:ok, state}
      {:error, _reason} -> {:error, "Realtime room capacity reached"}
    end
  end

  def apply_action({:leave, room}, namespace, _ack_id, _identity, state) do
    :ok = Hub.leave(state.sid, namespace, room)
    {:ok, state}
  end

  def apply_action({:emit, event, args}, namespace, _ack_id, _identity, state),
    do: enqueue_action(SocketIO.event(namespace, event, args), state)

  def apply_action({:broadcast, room, event, args}, namespace, _ack_id, _identity, state) do
    Hub.broadcast(room, namespace, event, args)
    {:ok, state}
  end

  def apply_action(
         {:refresh_chat_presence, source_vault_id, source_channel_id},
         _namespace,
         _ack_id,
         _identity,
         state
       ) do
    Cascade.Realtime.Events.emit_presence(source_vault_id, source_channel_id)
    {:ok, state}
  end

  def apply_action({:ack, data}, namespace, ack_id, _identity, state) when is_integer(ack_id),
    do: enqueue_action(SocketIO.ack(namespace, ack_id, data), state)

  def apply_action({:ack, _data}, _namespace, nil, _identity, state), do: {:ok, state}

  def apply_action({:register_runner, metadata}, namespace, _ack_id, identity, state) do
    :ok = Hub.register_runner(identity.id, state.sid, namespace, metadata)
    {:ok, state}
  end

  def apply_action(_action, _namespace, _ack_id, _identity, _state),
    do: {:error, "Invalid realtime domain action"}

  def enqueue_action(packet, state) do
    case SessionRecovery.enqueue(SessionRecovery.engine_message(packet), state) do
      {:ok, state} -> {:ok, state}
      {:error, _reason, _state} -> {:error, "Realtime client is too slow"}
    end
  end

  def maybe_error_ack(%{id: id, namespace: namespace}, message, state) do
    data = [%{success: false, error: message}]

    case SessionRecovery.enqueue(SessionRecovery.engine_message(SocketIO.ack(namespace, id, data)), state) do
      {:ok, state} -> {:ok, state}
      {:error, reason, state} -> {:close, reason, state}
    end
  end

  def maybe_error_ack(_packet, _message, state), do: {:ok, state}
end
