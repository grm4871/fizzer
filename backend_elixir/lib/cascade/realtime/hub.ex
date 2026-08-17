defmodule Cascade.Realtime.Hub do
  @moduledoc "Bounded room, session, and single-owner runner registry."
  use GenServer

  alias Cascade.Realtime.Session

  @rooms __MODULE__.Rooms
  @members __MODULE__.Members
  @runners __MODULE__.Runners
  @runner_sessions __MODULE__.RunnerSessions
  @max_memberships_per_session 256

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def admit(sid, max_sessions), do: GenServer.call(__MODULE__, {:admit, sid, max_sessions})
  def release(sid), do: GenServer.call(__MODULE__, {:release, sid})
  def track(sid, pid), do: GenServer.call(__MODULE__, {:track, sid, pid})
  def join(sid, namespace, room), do: GenServer.call(__MODULE__, {:join, sid, namespace, room})
  def leave(sid, namespace, room), do: GenServer.call(__MODULE__, {:leave, sid, namespace, room})

  def leave_namespace(sid, namespace, reason \\ :namespace_disconnect),
    do: GenServer.call(__MODULE__, {:leave_namespace, sid, namespace, reason})

  def rooms_for_session(sid, namespace \\ :all) do
    @members
    |> :ets.lookup(sid)
    |> Enum.flat_map(fn
      {^sid, member_namespace, room} when namespace == :all or member_namespace == namespace ->
        [room]

      _ ->
        []
    end)
  end

  def room_members(room, namespace) do
    @rooms
    |> :ets.lookup(room)
    |> Enum.flat_map(fn
      {^room, sid, ^namespace} -> [sid]
      _ -> []
    end)
    |> Enum.uniq()
  end

  def user_id_for_session(sid, namespace) do
    sid
    |> rooms_for_session(namespace)
    |> Enum.find_value(fn
      "user:" <> raw_id ->
        case Integer.parse(raw_id) do
          {id, ""} -> id
          _ -> nil
        end

      _ ->
        nil
    end)
  end

  def online_user?(user_id, namespace \\ "/vault") when is_integer(user_id),
    do: room_members("user:#{user_id}", namespace) != []

  def evict_user(user_id, namespace, room) when is_integer(user_id) do
    "user:#{user_id}"
    |> room_members(namespace)
    |> Enum.each(&leave(&1, namespace, room))

    :ok
  end

  def disconnect_user(user_id, namespaces \\ ["/vault", "/runs"]) when is_integer(user_id) do
    Enum.each(namespaces, fn namespace ->
      "user:#{user_id}"
      |> room_members(namespace)
      |> Enum.each(&Session.disconnect_namespace(&1, namespace, :session_revoked))
    end)

    :ok
  end

  def disconnect_user_sessions(user_id) when is_integer(user_id) do
    ["/vault", "/runs", "/runners"]
    |> Enum.flat_map(&room_members("user:#{user_id}", &1))
    |> Enum.uniq()
    |> Enum.each(&Session.disconnect(&1, :session_revoked))

    :ok
  end

  def broadcast(room, namespace, event, args, except_sid \\ nil) do
    @rooms
    |> :ets.lookup(room)
    |> Enum.each(fn
      {^room, sid, ^namespace} when sid != except_sid -> Session.emit(sid, namespace, event, args)
      _ -> :ok
    end)

    :ok
  end

  def register_runner(owner_id, sid, namespace, metadata) do
    GenServer.call(__MODULE__, {:register_runner, owner_id, sid, namespace, metadata})
  end

  def unregister_runner(owner_id, sid),
    do: GenServer.call(__MODULE__, {:unregister_runner, owner_id, sid})

  def runner(owner_id) do
    case :ets.lookup(@runners, owner_id) do
      [{^owner_id, value}] -> {:ok, value}
      [] -> :error
    end
  end

  def session_count, do: GenServer.call(__MODULE__, :session_count)

  @impl true
  def init(opts) do
    :ets.new(@rooms, [:named_table, :protected, :bag, read_concurrency: true])
    :ets.new(@members, [:named_table, :protected, :bag])
    :ets.new(@runners, [:named_table, :protected, :set, read_concurrency: true])
    :ets.new(@runner_sessions, [:named_table, :protected, :bag])
    callbacks = Keyword.get(opts, :runner_callbacks, Cascade.Realtime.RunnerCallbacks.Noop)
    {:ok, %{monitors: %{}, sessions: %{}, runner_callbacks: callbacks}}
  end

  @impl true
  def handle_call({:admit, sid, max_sessions}, _from, state) do
    cond do
      Map.has_key?(state.sessions, sid) ->
        {:reply, {:error, :duplicate_sid}, state}

      map_size(state.sessions) >= max_sessions ->
        {:reply, {:error, :capacity}, state}

      true ->
        {:reply, :ok, %{state | sessions: Map.put(state.sessions, sid, :reserved)}}
    end
  end

  def handle_call({:release, sid}, _from, state) do
    sessions =
      case state.sessions[sid] do
        :reserved -> Map.delete(state.sessions, sid)
        _ -> state.sessions
      end

    {:reply, :ok, %{state | sessions: sessions}}
  end

  def handle_call({:track, sid, pid}, _from, state) do
    ref = Process.monitor(pid)

    {:reply, :ok,
     %{
       state
       | monitors: Map.put(state.monitors, ref, sid),
         sessions: Map.put(state.sessions, sid, pid)
     }}
  end

  def handle_call({:join, sid, namespace, room}, _from, state) do
    membership = {sid, namespace, room}

    cond do
      not valid_room?(room) ->
        {:reply, {:error, :invalid_room}, state}

      membership in :ets.lookup(@members, sid) ->
        {:reply, :ok, state}

      length(:ets.lookup(@members, sid)) >= @max_memberships_per_session ->
        {:reply, {:error, :room_limit}, state}

      true ->
        :ets.insert(@rooms, {room, sid, namespace})
        :ets.insert(@members, membership)
        {:reply, :ok, state}
    end
  end

  def handle_call({:leave, sid, namespace, room}, _from, state) do
    :ets.delete_object(@rooms, {room, sid, namespace})
    :ets.delete_object(@members, {sid, namespace, room})
    {:reply, :ok, state}
  end

  def handle_call({:leave_namespace, sid, namespace, reason}, _from, state) do
    delete_members(sid, namespace)
    delete_runners(sid, namespace, reason, state.runner_callbacks)
    {:reply, :ok, state}
  end

  def handle_call({:register_runner, owner_id, sid, namespace, metadata}, _from, state) do
    previous = runner(owner_id)
    delete_runner_session_index(owner_id, previous)
    :ets.insert(@runners, {owner_id, %{sid: sid, namespace: namespace, metadata: metadata}})
    :ets.insert(@runner_sessions, {sid, owner_id, namespace})

    safe_callback(state.runner_callbacks, :registered, [
      owner_id,
      sid,
      metadata,
      runner_value(previous)
    ])

    case previous do
      {:ok, %{sid: old_sid, namespace: old_namespace}} when old_sid != sid ->
        Session.disconnect_namespace(old_sid, old_namespace, :runner_replaced)

      _ ->
        :ok
    end

    {:reply, :ok, state}
  end

  def handle_call({:unregister_runner, owner_id, sid}, _from, state) do
    case runner(owner_id) do
      {:ok, %{sid: ^sid} = value} ->
        :ets.delete(@runners, owner_id)
        delete_runner_session_index(owner_id, {:ok, value})

      _ ->
        :ok
    end

    {:reply, :ok, state}
  end

  def handle_call(:session_count, _from, state), do: {:reply, map_size(state.sessions), state}

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    case Map.pop(state.monitors, ref) do
      {nil, _} ->
        {:noreply, state}

      {sid, monitors} ->
        delete_members(sid, :all)
        delete_runners(sid, :all, reason, state.runner_callbacks)
        {:noreply, %{state | monitors: monitors, sessions: Map.delete(state.sessions, sid)}}
    end
  end

  defp delete_members(sid, namespace) do
    @members
    |> :ets.lookup(sid)
    |> Enum.each(fn
      {^sid, member_namespace, room} when namespace == :all or member_namespace == namespace ->
        :ets.delete_object(@members, {sid, member_namespace, room})
        :ets.delete_object(@rooms, {room, sid, member_namespace})

      _ ->
        :ok
    end)
  end

  defp delete_runners(_sid, namespace, _reason, _callbacks)
       when namespace not in [:all, "/runners"],
       do: :ok

  defp delete_runners(sid, namespace, reason, callbacks) do
    @runner_sessions
    |> :ets.lookup(sid)
    |> Enum.each(fn
      {^sid, owner_id, runner_namespace}
      when namespace == :all or runner_namespace == namespace ->
        case runner(owner_id) do
          {:ok, %{sid: ^sid, namespace: ^runner_namespace, metadata: metadata}} ->
            :ets.delete(@runners, owner_id)
            :ets.delete_object(@runner_sessions, {sid, owner_id, runner_namespace})
            safe_callback(callbacks, :disconnected, [owner_id, sid, metadata, reason])

          _ ->
            :ets.delete_object(@runner_sessions, {sid, owner_id, runner_namespace})
        end

      _ ->
        :ok
    end)
  end

  defp delete_runner_session_index(owner_id, {:ok, %{sid: sid, namespace: namespace}}),
    do: :ets.delete_object(@runner_sessions, {sid, owner_id, namespace})

  defp delete_runner_session_index(_owner_id, :error), do: :ok

  defp runner_value({:ok, value}), do: value
  defp runner_value(:error), do: nil

  defp safe_callback(module, function, arguments) do
    apply(module, function, arguments)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp valid_room?(room), do: is_binary(room) and byte_size(room) in 1..512
end
