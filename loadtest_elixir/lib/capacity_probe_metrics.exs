defmodule CascadeCapacityProbe do
  @moduledoc """
  Telemetry collector for DB, realtime, chat, and runner evidence.

  Invariant: collectors are best-effort and never crash the released node.
  Failure mode: malformed telemetry is counted or ignored, while probe lifecycle
  failures remain visible in the summary consumed by the monitor.
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
