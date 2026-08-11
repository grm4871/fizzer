defmodule CascadeCapacityProbe do
  @moduledoc """
  Runtime-only capacity instrumentation for the released Cascade backend.

  Load this file through the release RPC command on an isolated staging node.
  It does not change the application supervision tree, database, or HTTP API.
  """

  @table :cascade_capacity_probe
  @handler_id {__MODULE__, :capacity_events}
  @db_buckets_us [
    100,
    250,
    500,
    1_000,
    2_000,
    5_000,
    10_000,
    20_000,
    50_000,
    100_000,
    200_000,
    500_000,
    1_000_000,
    2_000_000,
    5_000_000,
    10_000_000
  ]
  @integer_buckets [
    0,
    1,
    2,
    4,
    8,
    16,
    32,
    64,
    128,
    256,
    512,
    1_024,
    2_048,
    4_096,
    8_192,
    16_384,
    32_768,
    65_536
  ]
  @percent_buckets [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

  def install do
    case Process.whereis(CascadeCapacityProbe.Server) do
      pid when is_pid(pid) ->
        {:ok, snapshot()}

      nil ->
        :telemetry.detach(@handler_id)

        with {:ok, _pid} <-
               GenServer.start(CascadeCapacityProbe.Server, [], name: CascadeCapacityProbe.Server),
             :ok <-
               :telemetry.attach_many(
                 @handler_id,
                 [
                   [:cascade, :db, :repo, :query],
                   [:cascade, :db, :write_lock, :wait],
                   [:cascade, :db, :write_lock, :hold],
                   [:cascade, :realtime, :auth],
                   [:cascade, :realtime, :presence_snapshot],
                   [:cascade, :chat, :list_routes],
                   [:cascade, :runs, :runner_disconnect_flush]
                 ],
                 &__MODULE__.handle_event/4,
                 nil
               ) do
          {:ok, snapshot()}
        end
    end
  end

  def uninstall do
    summary = summary()
    :telemetry.detach(@handler_id)

    case Process.whereis(CascadeCapacityProbe.Server) do
      pid when is_pid(pid) -> GenServer.stop(pid, :normal, 5_000)
      nil -> :ok
    end

    summary
  end

  def snapshot do
    case Process.whereis(CascadeCapacityProbe.Server) do
      pid when is_pid(pid) -> GenServer.call(pid, :snapshot, 10_000)
      nil -> %{error: "capacity probe is not installed"}
    end
  end

  def summary do
    case Process.whereis(CascadeCapacityProbe.Server) do
      pid when is_pid(pid) -> GenServer.call(pid, :summary, 10_000)
      nil -> %{error: "capacity probe is not installed"}
    end
  end

  def handle_event([:cascade, :db, :repo, :query], measurements, metadata, config) do
    handle_query(nil, measurements, metadata, config)
  end

  def handle_event([:cascade, :db, :write_lock, :wait], measurements, metadata, _config) do
    observe_time(:db_write_lock_wait_us, measurements[:duration])
    observe(:db_write_lock_queue_depth, metadata[:queue_depth], @integer_buckets)
  end

  def handle_event([:cascade, :db, :write_lock, :hold], measurements, metadata, _config) do
    observe_time(:db_write_lock_hold_us, measurements[:duration])
    observe(:db_write_lock_queue_depth, metadata[:queue_depth], @integer_buckets)

    if metadata[:outcome] == :owner_down,
      do: increment(:db_write_lock_owner_deaths)
  end

  def handle_event([:cascade, :realtime, :auth], measurements, metadata, _config) do
    amount = measurements[:count] || 1

    case metadata[:outcome] do
      :full -> increment(:realtime_auth_full, amount)
      :cache_hit -> increment(:realtime_auth_cache_hits, amount)
      :verified_token_cache_hit -> increment(:realtime_verified_token_cache_hits, amount)
      :verified_token_cache_miss -> increment(:realtime_verified_token_cache_misses, amount)
      :conflict -> increment(:realtime_auth_conflicts, amount)
      _ -> increment(:realtime_auth_unknown, amount)
    end
  end

  def handle_event(
        [:cascade, :realtime, :presence_snapshot],
        measurements,
        metadata,
        _config
      ) do
    amount = measurements[:count] || 1

    case metadata[:reason] do
      :initial -> increment(:presence_snapshot_initial, amount)
      :direct -> increment(:presence_snapshot_direct, amount)
      :dispatcher -> increment(:presence_snapshot_dispatcher, amount)
      _ -> increment(:presence_snapshot_other, amount)
    end
  end

  def handle_event([:cascade, :chat, :list_routes], measurements, metadata, _config) do
    amount = measurements[:count] || 1

    case metadata[:reason] do
      :message -> increment(:chat_list_route_message, amount)
      :direct -> increment(:chat_list_route_direct, amount)
      :dispatcher -> increment(:chat_list_route_dispatcher, amount)
      _ -> increment(:chat_list_route_other, amount)
    end
  end

  def handle_event(
        [:cascade, :runs, :runner_disconnect_flush],
        measurements,
        %{outcome: :snapshot},
        _config
      ) do
    increment(:runner_disconnect_flushes)
    increment(:runner_disconnect_flush_owners, measurements[:count] || 0)
  end

  def handle_query(_event, measurements, metadata, _config) do
    observe_time(:db_queue_us, measurements[:queue_time])
    observe_time(:db_query_us, measurements[:query_time])
    observe_time(:db_total_us, measurements[:total_time])

    query =
      metadata[:query]
      |> to_string()
      |> String.replace(~r/\s+/u, " ")
      |> String.trim()
      |> String.upcase()

    classify_query(query)

    if String.starts_with?(query, ["INSERT", "UPDATE", "DELETE", "REPLACE"]) do
      observe_time(:db_write_query_us, measurements[:query_time])
    else
      observe_time(:db_read_query_us, measurements[:query_time])
    end

    case metadata[:result] do
      {:error, error} ->
        increment(:db_errors)
        rendered = inspect(error)

        if String.contains?(String.downcase(rendered), ["busy", "locked"]),
          do: increment(:db_busy_or_locked_errors)

      _ ->
        :ok
    end
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp classify_query(query) do
    cond do
      String.contains?(query, "SELECT N.VAULT_ID,N.ID FROM NOTES N JOIN VAULTS V") ->
        increment(:presence_user_channel_reads)

      String.contains?(query, "SELECT VAULT_ID FROM NOTES WHERE ID=?") ->
        increment(:presence_channel_source_reads)

      String.starts_with?(query, "WITH SOURCE AS") and
          String.contains?(query, "PARTICIPANT_NAMES") ->
        increment(:presence_participant_snapshot_reads)

      String.contains?(query, "SELECT LOCAL_VAULT_ID,LOCAL_CHANNEL_ID FROM CHAT_CHANNEL_LINKS") ->
        increment(:chat_list_route_reads)

      String.contains?(query, "SELECT D.RUN_ID,D.OWNER_USER_ID FROM DELEGATED_RUNS") ->
        increment(:runner_delegated_snapshot_reads)

      String.contains?(query, "SELECT RUN_ID FROM DELEGATED_RUNS WHERE OWNER_USER_ID") ->
        increment(:runner_delegated_owner_reads)

      true ->
        :ok
    end
  end

  def observe(metric, value, buckets) when is_number(value) do
    value = max(round(value), 0)
    increment({:count, metric})
    increment({:sum, metric}, value)
    update_max(metric, value)
    bucket = Enum.find(buckets, &(value <= &1)) || :infinity
    increment({:histogram, metric, bucket})
    :ok
  rescue
    _ -> :ok
  end

  def observe(_metric, _value, _buckets), do: :ok

  def integer_buckets, do: @integer_buckets
  def percent_buckets, do: @percent_buckets

  def increment(key, amount \\ 1) do
    :ets.update_counter(@table, key, {2, amount}, {key, 0})
  rescue
    _ -> 0
  end

  defp observe_time(_metric, nil), do: :ok

  defp observe_time(metric, native) when is_integer(native) do
    observe(metric, System.convert_time_unit(native, :native, :microsecond), @db_buckets_us)
  end

  defp observe_time(_metric, _value), do: :ok

  defp update_max(metric, value) do
    key = {:max, metric}

    case :ets.lookup(@table, key) do
      [] -> :ets.insert_new(@table, {key, value})
      [{^key, current}] when value > current -> :ets.insert(@table, {key, value})
      _ -> true
    end
  end
end

defmodule CascadeCapacityProbe.Server do
  use GenServer

  @table :cascade_capacity_probe
  @pool_interval_ms 100
  @beam_interval_ms 1_000
  @deep_interval_ms 10_000

  @impl true
  def init(_options) do
    :ets.new(@table, [
      :named_table,
      :public,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    prior_scheduler_wall_time = :erlang.system_flag(:scheduler_wall_time, true)
    scheduler_previous = scheduler_rows()
    pool_size = Cascade.DB.Repo.config()[:pool_size] || 1
    database = Cascade.DB.Repo.config()[:database]

    state = %{
      started_at: DateTime.utc_now() |> DateTime.to_iso8601(),
      prior_scheduler_wall_time: prior_scheduler_wall_time,
      scheduler_previous: scheduler_previous,
      pool_pid: pool_pid(),
      pool_size: pool_size,
      database: database,
      current: %{}
    }

    schedule(:sample_pool, 0)
    schedule(:sample_beam, 0)
    schedule(:sample_deep, 0)
    {:ok, state}
  end

  @impl true
  def handle_call(:snapshot, _from, state) do
    {:reply, render_snapshot(state), state}
  end

  def handle_call(:summary, _from, state) do
    {:reply, render_summary(state), state}
  end

  @impl true
  def handle_info(:sample_pool, state) do
    {elapsed_us, {pool, state}} = :timer.tc(fn -> sample_pool(state) end)
    CascadeCapacityProbe.observe(:probe_pool_sample_us, elapsed_us, time_buckets())
    schedule(:sample_pool, @pool_interval_ms)
    {:noreply, put_in(state, [:current, :pool], pool)}
  end

  def handle_info(:sample_beam, state) do
    {elapsed_us, {beam, state}} = :timer.tc(fn -> sample_beam(state) end)
    CascadeCapacityProbe.observe(:probe_beam_sample_us, elapsed_us, time_buckets())
    schedule(:sample_beam, @beam_interval_ms)
    {:noreply, put_in(state, [:current, :beam], beam)}
  end

  def handle_info(:sample_deep, state) do
    {elapsed_us, deep} = :timer.tc(&sample_deep/0)
    CascadeCapacityProbe.observe(:probe_deep_sample_us, elapsed_us, time_buckets())
    schedule(:sample_deep, @deep_interval_ms)
    {:noreply, put_in(state, [:current, :deep], deep)}
  end

  def handle_info(_message, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    :erlang.system_flag(:scheduler_wall_time, state.prior_scheduler_wall_time)
    :ok
  end

  defp sample_pool(state) do
    pool_pid =
      if is_pid(state.pool_pid) and Process.alive?(state.pool_pid),
        do: state.pool_pid,
        else: pool_pid()

    metrics =
      case pool_pid do
        pid when is_pid(pid) -> DBConnection.get_connection_metrics(pid) |> List.first()
        _ -> nil
      end

    ready = if metrics, do: metrics.ready_conn_count, else: 0
    queue = if metrics, do: metrics.checkout_queue_length, else: 0
    busy = max(state.pool_size - ready, 0)
    utilization = busy / max(state.pool_size, 1) * 100

    CascadeCapacityProbe.observe(
      :db_pool_utilization_pct,
      utilization,
      CascadeCapacityProbe.percent_buckets()
    )

    CascadeCapacityProbe.observe(
      :db_checkout_queue_length,
      queue,
      CascadeCapacityProbe.integer_buckets()
    )

    if utilization > 80, do: CascadeCapacityProbe.increment(:db_pool_samples_above_80_pct)
    if queue > 0, do: CascadeCapacityProbe.increment(:db_pool_samples_queued)

    {%{
       size: state.pool_size,
       ready: ready,
       busy: busy,
       utilizationPct: utilization,
       queue: queue
     }, %{state | pool_pid: pool_pid}}
  rescue
    error ->
      CascadeCapacityProbe.increment(:probe_pool_errors)
      {%{error: Exception.message(error)}, state}
  catch
    kind, reason ->
      CascadeCapacityProbe.increment(:probe_pool_errors)
      {%{error: Exception.format(kind, reason, [])}, state}
  end

  defp sample_beam(state) do
    rows = scheduler_rows()
    {scheduler_utilization, scheduler_max} = scheduler_utilization(state.scheduler_previous, rows)
    run_queue = :erlang.statistics(:run_queue)
    memory = :erlang.memory() |> Map.new()
    process_count = :erlang.system_info(:process_count)
    port_count = :erlang.system_info(:port_count)
    sessions = safe_call(fn -> Cascade.Realtime.Hub.session_count() end, nil)
    wal_bytes = file_size(state.database <> "-wal")
    database_bytes = file_size(state.database)

    CascadeCapacityProbe.observe(
      :scheduler_utilization_pct,
      scheduler_utilization,
      CascadeCapacityProbe.percent_buckets()
    )

    CascadeCapacityProbe.observe(
      :scheduler_max_utilization_pct,
      scheduler_max,
      CascadeCapacityProbe.percent_buckets()
    )

    CascadeCapacityProbe.observe(:run_queue, run_queue, CascadeCapacityProbe.integer_buckets())

    CascadeCapacityProbe.observe(
      :process_count,
      process_count,
      CascadeCapacityProbe.integer_buckets()
    )

    CascadeCapacityProbe.observe(:port_count, port_count, CascadeCapacityProbe.integer_buckets())
    CascadeCapacityProbe.observe(:beam_memory_bytes, memory[:total], byte_buckets())
    CascadeCapacityProbe.observe(:wal_bytes, wal_bytes, byte_buckets())

    beam = %{
      schedulerUtilizationPct: scheduler_utilization,
      schedulerMaxUtilizationPct: scheduler_max,
      schedulersOnline: System.schedulers_online(),
      runQueue: run_queue,
      processCount: process_count,
      processLimit: :erlang.system_info(:process_limit),
      portCount: port_count,
      portLimit: :erlang.system_info(:port_limit),
      memory: memory,
      realtimeSessions: sessions,
      databaseBytes: database_bytes,
      walBytes: wal_bytes
    }

    {beam, %{state | scheduler_previous: rows}}
  rescue
    error ->
      CascadeCapacityProbe.increment(:probe_beam_errors)
      {%{error: Exception.message(error)}, state}
  catch
    kind, reason ->
      CascadeCapacityProbe.increment(:probe_beam_errors)
      {%{error: Exception.format(kind, reason, [])}, state}
  end

  defp sample_deep do
    mailboxes =
      Process.list()
      |> Enum.reduce(%{sum: 0, max: 0, over100: 0, over500: 0}, fn pid, acc ->
        case Process.info(pid, :message_queue_len) do
          {:message_queue_len, length} ->
            %{
              sum: acc.sum + length,
              max: max(acc.max, length),
              over100: acc.over100 + if(length > 100, do: 1, else: 0),
              over500: acc.over500 + if(length > 500, do: 1, else: 0)
            }

          _ ->
            acc
        end
      end)

    ets_bytes =
      :ets.all()
      |> Enum.reduce(0, fn table, total -> total + (:ets.info(table, :memory) || 0) end)
      |> Kernel.*(:erlang.system_info(:wordsize))

    memberships = table_size(Cascade.Realtime.Hub.Members)
    rooms = table_size(Cascade.Realtime.Hub.Rooms)
    runners = table_size(Cascade.Realtime.Hub.Runners)
    connections = bandit_connection_count()
    write_coordinator = safe_call(fn -> Cascade.DB.WriteCoordinator.stats() end, nil)

    presence_dispatcher =
      safe_call(fn -> Cascade.Realtime.PresenceDispatcher.stats() end, nil)

    CascadeCapacityProbe.observe(
      :mailbox_max,
      mailboxes.max,
      CascadeCapacityProbe.integer_buckets()
    )

    CascadeCapacityProbe.observe(
      :mailbox_sum,
      mailboxes.sum,
      CascadeCapacityProbe.integer_buckets()
    )

    CascadeCapacityProbe.observe(:ets_bytes, ets_bytes, byte_buckets())

    CascadeCapacityProbe.observe(
      :bandit_connections,
      connections,
      CascadeCapacityProbe.integer_buckets()
    )

    %{
      mailboxes: mailboxes,
      etsBytes: ets_bytes,
      realtimeMemberships: memberships,
      realtimeRoomEntries: rooms,
      registeredRunners: runners,
      banditConnections: connections,
      writeCoordinator: write_coordinator,
      presenceDispatcher: presence_dispatcher,
      cgroup: cgroup_snapshot()
    }
  rescue
    error ->
      CascadeCapacityProbe.increment(:probe_deep_errors)
      %{error: Exception.message(error)}
  catch
    kind, reason ->
      CascadeCapacityProbe.increment(:probe_deep_errors)
      %{error: Exception.format(kind, reason, [])}
  end

  defp render_snapshot(state) do
    %{
      observedAt: DateTime.utc_now() |> DateTime.to_iso8601(),
      startedAt: state.started_at,
      configuration: %{
        httpAcceptors: Application.get_env(:cascade_elixir, :http_acceptors),
        httpMaxConnections: Application.get_env(:cascade_elixir, :http_max_connections),
        httpBacklog: Application.get_env(:cascade_elixir, :http_backlog),
        networkMode: Application.get_env(:cascade_elixir, :network_mode),
        trustProxyHops: Application.get_env(:cascade_elixir, :trust_proxy_hops),
        qmdWorkerEnabled: Application.get_env(:cascade_elixir, :qmd_worker_enabled),
        realtimeHibernateAfterMs:
          Application.get_env(:cascade_elixir, :realtime_hibernate_after_ms),
        runnerOrphanReclaimMs: Application.get_env(:cascade_elixir, :runner_orphan_reclaim_ms),
        sqlitePoolSize: state.pool_size,
        sqliteBusyTimeoutMs: Cascade.DB.Repo.config()[:busy_timeout]
      },
      pool: state.current[:pool],
      beam: state.current[:beam],
      deep: state.current[:deep],
      metrics: render_metrics()
    }
  end

  defp render_summary(state) do
    %{snapshot: render_snapshot(state), metrics: render_metrics()}
  end

  defp render_metrics do
    :ets.tab2list(@table)
    |> Enum.reduce(%{}, fn
      {{:count, metric}, count}, acc ->
        update_metric(acc, metric, &Map.put(&1, :count, count))

      {{:sum, metric}, sum}, acc ->
        update_metric(acc, metric, &Map.put(&1, :sum, sum))

      {{:max, metric}, max_value}, acc ->
        update_metric(acc, metric, &Map.put(&1, :max, max_value))

      {{:histogram, metric, bucket}, count}, acc ->
        bucket = if bucket == :infinity, do: "infinity", else: Integer.to_string(bucket)

        update_metric(acc, metric, fn values ->
          Map.update(values, :histogram, %{bucket => count}, &Map.put(&1, bucket, count))
        end)

      {key, value}, acc ->
        Map.put(acc, key, value)
    end)
    |> Enum.into(%{}, fn {metric, values} -> {to_string(metric), values} end)
  end

  defp update_metric(metrics, metric, update) do
    Map.update(metrics, metric, update.(%{}), update)
  end

  defp scheduler_rows do
    online = System.schedulers_online()

    :erlang.statistics(:scheduler_wall_time)
    |> Enum.filter(fn {id, _active, _total} -> id <= online end)
    |> Map.new(fn {id, active, total} -> {id, {active, total}} end)
  end

  defp scheduler_utilization(previous, current) do
    deltas =
      Enum.flat_map(current, fn {id, {active, total}} ->
        case previous[id] do
          {prior_active, prior_total} when total > prior_total ->
            [{active - prior_active, total - prior_total}]

          _ ->
            []
        end
      end)

    total_active = Enum.sum(Enum.map(deltas, &elem(&1, 0)))
    total_time = Enum.sum(Enum.map(deltas, &elem(&1, 1)))
    utilization = if total_time > 0, do: total_active / total_time * 100, else: 0.0

    max_utilization =
      deltas
      |> Enum.map(fn {active, total} -> if total > 0, do: active / total * 100, else: 0.0 end)
      |> Enum.max(fn -> 0.0 end)

    {utilization, max_utilization}
  end

  defp pool_pid do
    Supervisor.which_children(Cascade.DB.Repo)
    |> Enum.find_value(fn
      {DBConnection.ConnectionPool, pid, :worker, _modules} when is_pid(pid) -> pid
      _ -> nil
    end)
  end

  defp bandit_connection_count do
    Supervisor.which_children(Cascade.Supervisor)
    |> Enum.find_value(0, fn
      {{Bandit, _reference}, pid, :supervisor, _modules} when is_pid(pid) ->
        case ThousandIsland.connection_pids(pid) do
          {:ok, connections} -> length(connections)
          _ -> 0
        end

      _ ->
        nil
    end)
  end

  defp table_size(table) do
    case :ets.info(table, :size) do
      :undefined -> nil
      size -> size
    end
  end

  defp file_size(path) do
    case File.stat(path) do
      {:ok, stat} -> stat.size
      _ -> 0
    end
  end

  defp cgroup_snapshot do
    root = "/sys/fs/cgroup"

    %{
      cpu: cgroup_key_values(Path.join(root, "cpu.stat")),
      memoryCurrent: cgroup_value(Path.join(root, "memory.current")),
      memoryPeak: cgroup_value(Path.join(root, "memory.peak")),
      memoryMax: cgroup_value(Path.join(root, "memory.max")),
      memorySwapCurrent: cgroup_value(Path.join(root, "memory.swap.current")),
      memorySwapMax: cgroup_value(Path.join(root, "memory.swap.max")),
      memoryEvents: cgroup_key_values(Path.join(root, "memory.events")),
      pidsCurrent: cgroup_value(Path.join(root, "pids.current")),
      pidsPeak: cgroup_value(Path.join(root, "pids.peak")),
      pidsMax: cgroup_value(Path.join(root, "pids.max")),
      io: read_file(Path.join(root, "io.stat")),
      cpuPressure: cgroup_pressure(Path.join(root, "cpu.pressure")),
      memoryPressure: cgroup_pressure(Path.join(root, "memory.pressure")),
      ioPressure: cgroup_pressure(Path.join(root, "io.pressure"))
    }
  end

  defp cgroup_key_values(path) do
    case File.read(path) do
      {:ok, body} ->
        body
        |> String.split("\n", trim: true)
        |> Map.new(fn line ->
          case String.split(line, ~r/\s+/, parts: 2) do
            [key, value] -> {key, parse_number(value)}
            [key] -> {key, nil}
          end
        end)

      _ ->
        nil
    end
  end

  defp cgroup_pressure(path) do
    case File.read(path) do
      {:ok, body} ->
        body
        |> String.split("\n", trim: true)
        |> Map.new(fn line ->
          [kind | fields] = String.split(line, ~r/\s+/, trim: true)

          values =
            Map.new(fields, fn field ->
              [key, value] = String.split(field, "=", parts: 2)
              {key, parse_number(value)}
            end)

          {kind, values}
        end)

      _ ->
        nil
    end
  end

  defp cgroup_value(path) do
    case read_file(path) do
      nil -> nil
      value -> parse_number(value)
    end
  end

  defp read_file(path) do
    case File.read(path) do
      {:ok, value} -> String.trim(value)
      _ -> nil
    end
  end

  defp parse_number(value) do
    case Integer.parse(value) do
      {parsed, ""} ->
        parsed

      _ ->
        case Float.parse(value) do
          {parsed, ""} -> parsed
          _ -> value
        end
    end
  end

  defp byte_buckets do
    [
      1_048_576,
      4_194_304,
      16_777_216,
      67_108_864,
      268_435_456,
      1_073_741_824,
      4_294_967_296,
      17_179_869_184
    ]
  end

  defp time_buckets do
    [
      100,
      250,
      500,
      1_000,
      2_000,
      5_000,
      10_000,
      20_000,
      50_000,
      100_000,
      250_000,
      500_000,
      1_000_000,
      2_000_000,
      5_000_000
    ]
  end

  defp safe_call(fun, fallback) do
    fun.()
  rescue
    _ -> fallback
  catch
    _, _ -> fallback
  end

  defp schedule(message, delay), do: Process.send_after(self(), message, delay)
end
