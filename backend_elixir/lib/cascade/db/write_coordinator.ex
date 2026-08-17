defmodule Cascade.DB.WriteCoordinator do
  @moduledoc false

  use GenServer

  @lock_key {__MODULE__, :lock}

  def start_link(options \\ []) do
    case Keyword.get(options, :name, __MODULE__) do
      nil -> GenServer.start_link(__MODULE__, :ok)
      name -> GenServer.start_link(__MODULE__, :ok, name: name)
    end
  end

  def with_lock(fun) when is_function(fun, 0), do: with_lock(__MODULE__, fun)

  def with_lock(server, fun) when is_function(fun, 0) do
    key = {@lock_key, server}

    case Process.get(key) do
      nil ->
        {:ok, token} = GenServer.call(server, :acquire, :infinity)
        Process.put(key, token)

        try do
          fun.()
        after
          Process.delete(key)
          :ok = GenServer.call(server, {:release, token}, :infinity)
        end

      _token ->
        fun.()
    end
  end

  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  def assert_read_only!(statement) when is_binary(statement) do
    normalized = String.trim_leading(statement)

    read_only =
      Regex.match?(~r/^(SELECT|EXPLAIN|VALUES)\b/i, normalized) or
        Regex.match?(
          ~r/^PRAGMA\s+(table_info|foreign_key_list|foreign_key_check)\b/i,
          normalized
        ) or
        (Regex.match?(~r/^WITH\b/i, normalized) and
           not Regex.match?(
             ~r/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX|ATTACH|DETACH)\b/i,
             normalized
           ))

    if read_only do
      :ok
    else
      raise ArgumentError,
            "write statement passed to a read-only SQL helper; use exec/2 or transaction/1"
    end
  end

  @impl true
  def init(:ok) do
    {:ok, %{owner: nil, queue: :queue.new(), waiters: %{}, completed: 0, owner_deaths: 0}}
  end

  @impl true
  def handle_call(:acquire, from = {pid, _tag}, %{owner: nil} = state) do
    now = System.monotonic_time()
    token = make_ref()
    monitor = Process.monitor(pid)
    emit_wait(now, now, 0)

    {:reply, {:ok, token}, %{state | owner: owner(from, pid, monitor, token, now)}}
  end

  def handle_call(:acquire, from = {pid, _tag}, state) do
    monitor = Process.monitor(pid)
    token = make_ref()
    enqueued_at = System.monotonic_time()
    waiter = owner(from, pid, monitor, token, enqueued_at)

    state = %{
      state
      | queue: :queue.in(monitor, state.queue),
        waiters: Map.put(state.waiters, monitor, waiter)
    }

    {:noreply, state}
  end

  def handle_call({:release, token}, {pid, _tag}, %{owner: %{pid: pid, token: token}} = state) do
    state = finish_owner(state, :released)
    {:reply, :ok, promote(state)}
  end

  def handle_call({:release, _token}, _from, state) do
    {:reply, {:error, :not_owner}, state}
  end

  def handle_call(:stats, _from, state) do
    {:reply,
     %{
       locked: state.owner != nil,
       queue_depth: map_size(state.waiters),
       completed: state.completed,
       owner_deaths: state.owner_deaths
     }, state}
  end

  @impl true
  def handle_info(
        {:DOWN, monitor, :process, _pid, _reason},
        %{owner: %{monitor: monitor}} = state
      ) do
    state = finish_owner(state, :owner_down)
    {:noreply, promote(%{state | owner_deaths: state.owner_deaths + 1})}
  end

  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    {:noreply, %{state | waiters: Map.delete(state.waiters, monitor)}}
  end

  defp promote(%{owner: nil} = state) do
    case :queue.out(state.queue) do
      {{:value, monitor}, queue} ->
        case Map.pop(state.waiters, monitor) do
          {nil, waiters} ->
            promote(%{state | queue: queue, waiters: waiters})

          {waiter, waiters} ->
            now = System.monotonic_time()
            emit_wait(waiter.started_at, now, map_size(waiters))
            GenServer.reply(waiter.from, {:ok, waiter.token})

            %{state | owner: %{waiter | started_at: now}, queue: queue, waiters: waiters}
        end

      {:empty, queue} ->
        %{state | queue: queue}
    end
  end

  defp finish_owner(%{owner: owner} = state, outcome) do
    Process.demonitor(owner.monitor, [:flush])

    :telemetry.execute(
      [:cascade, :db, :write_lock, :hold],
      %{duration: System.monotonic_time() - owner.started_at},
      %{outcome: outcome, queue_depth: map_size(state.waiters)}
    )

    %{state | owner: nil, completed: state.completed + 1}
  end

  defp emit_wait(enqueued_at, granted_at, queue_depth) do
    :telemetry.execute(
      [:cascade, :db, :write_lock, :wait],
      %{duration: granted_at - enqueued_at},
      %{queue_depth: queue_depth}
    )
  end

  defp owner(from, pid, monitor, token, started_at) do
    %{from: from, pid: pid, monitor: monitor, token: token, started_at: started_at}
  end
end
