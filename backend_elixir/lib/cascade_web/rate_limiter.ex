defmodule CascadeWeb.RateLimiter do
  @moduledoc "Concurrent bounded fixed-window rate limiter backed by ETS."

  use GenServer

  @table __MODULE__
  @sweep_interval_ms 60_000
  @max_keys 50_000

  def start_link(_options), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  def check(bucket, key, max, window_ms) do
    now = System.monotonic_time(:millisecond)
    actual_key = bounded_key(bucket, key)
    check_entry({bucket, actual_key}, max, window_ms, now)
  end

  @impl true
  def init(:ok) do
    :ets.new(@table, [
      :named_table,
      :public,
      :set,
      read_concurrency: true,
      write_concurrency: true
    ])

    schedule_sweep()
    {:ok, %{}}
  end

  @impl true
  def handle_info(:sweep, state) do
    now = System.monotonic_time(:millisecond)
    :ets.select_delete(@table, [{{:"$1", :"$2", :"$3"}, [{:<, :"$3", now}], [true]}])
    schedule_sweep()
    {:noreply, state}
  end

  defp check_entry(key, max, window_ms, now) do
    case :ets.lookup(@table, key) do
      [] ->
        if :ets.insert_new(@table, {key, 1, now + window_ms}) do
          :ok
        else
          check_entry(key, max, window_ms, now)
        end

      [{^key, count, reset_at}] when reset_at <= now ->
        :ets.delete_object(@table, {key, count, reset_at})
        check_entry(key, max, window_ms, now)

      [{^key, _count, reset_at}] ->
        try do
          count = :ets.update_counter(@table, key, {2, 1})

          if count > max do
            {:error, max(div(reset_at - now + 999, 1_000), 1)}
          else
            :ok
          end
        rescue
          ArgumentError -> check_entry(key, max, window_ms, now)
        end
    end
  end

  defp bounded_key(bucket, key) do
    candidate = {bucket, key}

    if :ets.info(@table, :size) < @max_keys or :ets.member(@table, candidate) do
      key
    else
      :overflow
    end
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)
end
