defmodule Cascade.Realtime.Session do
  @moduledoc "GenServer session preserving polling/websocket ordering, handshake state, and recovery boundaries."
  use GenServer, restart: :temporary

  alias Cascade.Realtime.{Hub, SessionDispatch, SessionRecovery}
  alias Cascade.Realtime.Protocol.{EngineIO, SocketIO}

  @ping_interval 25_000
  @ping_timeout 60_000
  @max_payload 1_000_000
  @poll_timeout 20_000
  @max_queue_packets 256
  @max_queue_bytes 1_000_000
  @max_mailbox 512
  @max_pending_acks 128
  @auth_cache_wave_ms 5_000

  def start_link(opts) do
    sid = Keyword.fetch!(opts, :sid)

    hibernate_after =
      Keyword.get_lazy(opts, :hibernate_after_ms, fn ->
        Application.fetch_env!(:cascade_elixir, :realtime_hibernate_after_ms)
      end)

    GenServer.start_link(__MODULE__, opts, name: via(sid), hibernate_after: hibernate_after)
  end

  def poll(sid, timeout \\ @poll_timeout + 2_000), do: call(sid, :poll, timeout)
  def receive_payload(sid, payload), do: call(sid, {:payload, payload})
  def attach_websocket(sid, pid, mode), do: call(sid, {:attach_websocket, pid, mode})
  def websocket_packet(sid, raw, pid), do: call(sid, {:websocket_packet, raw, pid})
  def websocket_closed(sid, pid), do: cast(sid, {:websocket_closed, pid})

  def emit(sid, namespace, event, args) do
    cast(sid, {:server_event, namespace, event, args})
  end

  def emit_with_ack(sid, namespace, event, args, timeout) do
    call(sid, {:server_event_ack, namespace, event, args, timeout}, timeout + 1_000)
  end

  def disconnect_namespace(sid, namespace, reason),
    do: cast(sid, {:disconnect_namespace, namespace, reason})

  def disconnect(sid, reason), do: cast(sid, {:disconnect, reason})

  @impl true
  def init(opts) do
    sid = Keyword.fetch!(opts, :sid)
    domain = Keyword.get(opts, :domain, configured(:domain, Cascade.Realtime.Domain.FailClosed))
    cookie_token = Keyword.get(opts, :cookie_token)
    transport = Keyword.get(opts, :transport, :polling)
    Hub.track(sid, self())

    open =
      EngineIO.open_packet(
        sid,
        if(transport == :polling, do: ["websocket"], else: []),
        @ping_interval,
        @ping_timeout,
        @max_payload
      )
      |> EngineIO.encode_packet()

    state = %{
      sid: sid,
      domain: domain,
      cookie_token: cookie_token,
      authenticated_identity: nil,
      authenticated_token: nil,
      authenticated_expires_at: nil,
      auth_cache_deadline_ms: nil,
      auth_cache_wave_ms: Keyword.get(opts, :auth_cache_wave_ms, @auth_cache_wave_ms),
      auth_attempted_namespaces: MapSet.new(),
      active_transport: transport,
      websocket: nil,
      upgrade_socket: nil,
      upgrade_probed: false,
      namespaces: %{},
      queue: :queue.in(open, :queue.new()),
      queue_packets: 1,
      queue_bytes: byte_size(open),
      poll_waiter: nil,
      poll_timer: nil,
      heartbeat_timer: Process.send_after(self(), :heartbeat_ping, @ping_interval),
      pong_timer: nil,
      next_ack_id: 0,
      pending_acks: %{},
      max_queue_packets: Keyword.get(opts, :max_queue_packets, @max_queue_packets),
      max_queue_bytes: Keyword.get(opts, :max_queue_bytes, @max_queue_bytes),
      max_mailbox: Keyword.get(opts, :max_mailbox, @max_mailbox),
      max_pending_acks: Keyword.get(opts, :max_pending_acks, @max_pending_acks)
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:poll, from, state) do
    cond do
      state.active_transport == :websocket ->
        {:reply, {:error, :transport_mismatch}, state}

      state.poll_waiter != nil ->
        {:reply, {:error, :overlapping_poll}, state}

      state.queue_packets > 0 ->
        {payload, state} = drain_queue(state)
        {:reply, {:ok, payload}, state}

      state.upgrade_probed ->
        {:reply, {:ok, EngineIO.encode_packet(%{type: :noop})}, state}

      true ->
        timer = Process.send_after(self(), :poll_timeout, @poll_timeout)
        {:noreply, %{state | poll_waiter: from, poll_timer: timer}}
    end
  end

  def handle_call({:payload, payload}, _from, state) do
    with {:ok, packets} <- EngineIO.decode_payload(payload, @max_payload),
         {:ok, state} <- process_engine_packets(packets, :polling, state) do
      {:reply, :ok, state}
    else
      {:close, :client_close, state} -> {:stop, :normal, :ok, state}
      {:close, reason, state} -> {:stop, reason, {:error, reason}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:attach_websocket, pid, :direct}, _from, state) do
    if state.active_transport == :websocket and state.websocket == nil do
      Process.monitor(pid)
      {packets, state} = drain_packets(state)
      {:reply, {:ok, packets}, %{state | websocket: pid}}
    else
      {:reply, {:error, :transport_mismatch}, state}
    end
  end

  def handle_call({:attach_websocket, pid, :upgrade}, _from, state) do
    if state.active_transport == :polling and state.upgrade_socket == nil do
      Process.monitor(pid)
      {:reply, {:ok, []}, %{state | upgrade_socket: pid, upgrade_probed: false}}
    else
      {:reply, {:error, :transport_mismatch}, state}
    end
  end

  def handle_call({:websocket_packet, raw, pid}, _from, state) do
    with {:ok, packet} <- EngineIO.decode_packet(raw),
         {:ok, replies, state} <- process_websocket_packet(packet, pid, state) do
      {:reply, {:ok, replies}, state}
    else
      {:close, reason, state} -> {:stop, reason, {:error, reason}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:server_event_ack, namespace, event, args, timeout}, from, state) do
    cond do
      not Map.has_key?(state.namespaces, namespace) ->
        {:reply, {:error, :namespace_not_connected}, state}

      map_size(state.pending_acks) >= state.max_pending_acks ->
        {:reply, {:error, :ack_backpressure}, state}

      true ->
        id = state.next_ack_id
        raw = SessionRecovery.engine_message(SocketIO.event(namespace, event, args, id))
        timer = Process.send_after(self(), {:ack_timeout, id}, timeout)
        pending = Map.put(state.pending_acks, id, {from, timer})

        case enqueue(raw, state) do
          {:ok, state} ->
            {:noreply, %{state | pending_acks: pending, next_ack_id: rem(id + 1, 2_147_483_647)}}

          {:error, reason, state} ->
            Process.cancel_timer(timer)
            {:reply, {:error, reason}, state}
        end
    end
  end

  @impl true
  def handle_cast({:server_event, namespace, event, args}, state) do
    if Map.has_key?(state.namespaces, namespace) do
      case enqueue(SessionRecovery.engine_message(SocketIO.event(namespace, event, args)), state) do
        {:ok, state} -> {:noreply, state}
        {:error, reason, state} -> {:stop, reason, state}
      end
    else
      {:noreply, state}
    end
  end

  def handle_cast({:disconnect_namespace, namespace, reason}, state) do
    {:noreply, SessionRecovery.disconnect_namespace_state(namespace, reason, true, state)}
  end

  def handle_cast({:disconnect, reason}, state), do: {:stop, {:shutdown, reason}, state}

  def handle_cast({:websocket_closed, pid}, state) do
    cond do
      state.websocket == pid ->
        {:stop, :normal, %{state | websocket: nil}}

      state.upgrade_socket == pid ->
        {:noreply, %{state | upgrade_socket: nil, upgrade_probed: false}}

      true ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(:heartbeat_ping, state) do
    state = %{state | heartbeat_timer: nil}

    case enqueue(EngineIO.encode_packet(%{type: :ping}), state) do
      {:ok, state} ->
        timer = Process.send_after(self(), :pong_timeout, @ping_timeout)
        {:noreply, %{state | pong_timer: timer}}

      {:error, reason, state} ->
        {:stop, reason, state}
    end
  end

  def handle_info(:pong_timeout, state), do: {:stop, :heartbeat_timeout, state}

  def handle_info(:poll_timeout, %{poll_waiter: nil} = state),
    do: {:noreply, %{state | poll_timer: nil}}

  def handle_info(:poll_timeout, state) do
    GenServer.reply(state.poll_waiter, {:ok, EngineIO.encode_packet(%{type: :noop})})
    {:noreply, %{state | poll_waiter: nil, poll_timer: nil}}
  end

  def handle_info({:ack_timeout, id}, state) do
    case Map.pop(state.pending_acks, id) do
      {nil, _} ->
        {:noreply, state}

      {{from, _timer}, pending} ->
        GenServer.reply(from, {:error, :ack_timeout})
        {:noreply, %{state | pending_acks: pending}}
    end
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    cond do
      state.websocket == pid ->
        {:stop, :normal, %{state | websocket: nil}}

      state.upgrade_socket == pid ->
        {:noreply, %{state | upgrade_socket: nil, upgrade_probed: false}}

      true ->
        {:noreply, state}
    end
  end

  @impl true
  def terminate(reason, state) do
    cancel_timer(state.heartbeat_timer)
    cancel_timer(state.pong_timer)
    cancel_timer(state.poll_timer)

    Enum.each(state.pending_acks, fn {_id, {from, timer}} ->
      cancel_timer(timer)
      GenServer.reply(from, {:error, :disconnected})
    end)

    Enum.each(Map.keys(state.namespaces), fn namespace ->
      SessionRecovery.disconnect_namespace_state(namespace, reason, false, state)
    end)

    :ok
  end

  defp process_engine_packets(packets, source, state), do: SessionDispatch.process_engine_packets(packets, source, state)
  defp process_websocket_packet(packet, pid, state), do: SessionDispatch.process_websocket_packet(packet, pid, state)
  defp enqueue(raw, state), do: SessionRecovery.enqueue(raw, state)
  defp drain_queue(state), do: SessionRecovery.drain_queue(state)
  defp drain_packets(state), do: SessionRecovery.drain_packets(state)
  defp cancel_timer(timer), do: SessionRecovery.cancel_timer(timer)

  defp call(sid, request, timeout \\ 5_000) do
    case Registry.lookup(Cascade.Realtime.Registry, sid) do
      [{pid, _}] -> GenServer.call(pid, request, timeout)
      [] -> {:error, :unknown_sid}
    end
  catch
    :exit, _ -> {:error, :unknown_sid}
  end

  defp cast(sid, request) do
    case Registry.lookup(Cascade.Realtime.Registry, sid) do
      [{pid, _}] ->
        case Process.info(pid, :message_queue_len) do
          {:message_queue_len, length} when length >= @max_mailbox ->
            Process.exit(pid, :backpressure)

          _ ->
            GenServer.cast(pid, request)
        end

      [] ->
        :ok
    end
  end

  defp via(sid), do: {:via, Registry, {Cascade.Realtime.Registry, sid}}
  defp configured(key, default),
    do: Application.get_env(:cascade_elixir, Cascade.Realtime, [])[key] || default
end