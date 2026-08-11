defmodule Cascade.Runs.RunnerLifecycle do
  @moduledoc "Durable desktop-runner presence, reclaim, delegation, and ACK lifecycle."
  use GenServer

  @behaviour Cascade.Realtime.RunnerCallbacks

  alias Cascade.Realtime.Hub
  alias Cascade.Runs.Store

  @disconnect_grace 20_000
  @disconnect_flush_coalesce 1_000
  @orphan_reclaim 120_000

  def start_link(opts \\ []), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def register(owner_id, sid, metadata),
    do: GenServer.call(__MODULE__, {:register, owner_id, sid, normalize_metadata(metadata)})

  def report_plan_usage(owner_id, usage),
    do: GenServer.cast(__MODULE__, {:plan_usage, owner_id, clean_usage(usage)})

  def health(owner_id) do
    base = GenServer.call(__MODULE__, {:health, owner_id})
    %{base | online: online?(owner_id), activeRuns: Store.active_delegated_count(owner_id)}
  end

  def online?(owner_id) do
    case Hub.runner(owner_id) do
      {:ok, %{sid: sid}} -> match?({:ok, _pid}, Cascade.Realtime.lookup(sid))
      :error -> false
    end
  rescue
    _ -> false
  end

  def wait_online(owner_id, timeout_ms \\ 6_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    wait_online_until(owner_id, deadline)
  end

  def delegate(owner_id, payload) when is_map(payload) do
    with {:ok, %{sid: sid}} <- Hub.runner(owner_id),
         {:ok, _pid} <- Cascade.Realtime.lookup(sid),
         run_id when is_integer(run_id) <- field(payload, :runId) do
      Store.record_delegated(run_id, owner_id)
      Cascade.Realtime.emit(sid, "/runners", "run:delegate", [payload])
      true
    else
      _ -> false
    end
  rescue
    _ -> false
  end

  def cancel(owner_id, run_id, timeout \\ 15_000) do
    with {:ok, %{sid: sid}} <- Hub.runner(owner_id),
         {:ok, replies} <-
           Cascade.Realtime.emit_with_ack(
             sid,
             "/runners",
             "run:cancel",
             [%{runId: run_id}],
             timeout
           ),
         response when is_map(response) <- List.first(replies),
         true <- field(response, :success) == true do
      true
    else
      _ -> false
    end
  end

  def prepare_workspace(owner_id, payload, timeout \\ 30_000) do
    with {:ok, %{sid: sid}} <- Hub.runner(owner_id),
         {:ok, replies} <-
           Cascade.Realtime.emit_with_ack(
             sid,
             "/runners",
             "workspace:prepare",
             [payload],
             timeout
           ),
         response when is_map(response) <- List.first(replies),
         true <- field(response, :ok) == true,
         {:ok, prepared} <- complete_workspace(response) do
      {:ok, prepared}
    else
      {:error, _} = error -> error
      _ -> {:error, "Desktop workspace preparation failed"}
    end
  end

  def accept_event?(run_id, owner_id), do: Store.delegated_owner(run_id) == owner_id

  @impl true
  # DomainAdapter owns registration because its reclaimed IDs are part of the
  # runner:registered response. Hub owns transport replacement and invokes this
  # callback only after that domain action has already committed.
  def registered(_owner_id, _sid, _metadata, _previous), do: :ok

  @impl true
  def disconnected(owner_id, sid, _metadata, reason) do
    if Process.whereis(__MODULE__),
      do: GenServer.cast(__MODULE__, {:disconnected, owner_id, sid, reason}),
      else: :ok
  end

  @impl true
  def init(opts) do
    state = %{
      runners: %{},
      disconnect_timers: %{},
      disconnect_flush_timer: nil,
      disconnect_flush_due_at: nil,
      disconnect_flush_coalesce:
        Keyword.get(opts, :disconnect_flush_coalesce_ms, @disconnect_flush_coalesce),
      last_error: %{},
      plan_usage: %{},
      last_seen: %{},
      disconnect_grace: Keyword.get(opts, :disconnect_grace_ms, @disconnect_grace),
      orphan_reclaim: Keyword.get(opts, :orphan_reclaim_ms, @orphan_reclaim)
    }

    timer = Process.send_after(self(), :orphan_reclaim, state.orphan_reclaim)
    {:ok, Map.put(state, :orphan_timer, timer)}
  end

  @impl true
  def handle_call({:register, owner_id, sid, metadata}, _from, state) do
    state = cancel_disconnect_timer(owner_id, state)
    active_ids = Map.get(metadata, :activeRunIds, [])

    reclaimed =
      active_ids
      |> Enum.filter(&(Store.delegated_owner(&1) == owner_id))
      |> Enum.uniq()

    previous = state.runners[owner_id]
    next_instance = Map.get(metadata, :runnerInstanceId, "")
    previous_instance = previous && previous.instance_id

    state =
      if previous_instance not in [nil, ""] and next_instance != "" and
           previous_instance != next_instance do
        interrupted =
          Store.open_delegated()
          |> Enum.filter(&(&1.owner_user_id == owner_id and &1.run_id not in reclaimed))
          |> Enum.map(& &1.run_id)

        fail_runs(interrupted, "Desktop app restarted before this run completed.")

        if interrupted == [] do
          state
        else
          put_error(state, owner_id, "Desktop app restarted before this run completed.")
        end
      else
        state
      end

    now = iso_now()

    runner = %{
      sid: sid,
      instance_id: if(next_instance == "", do: previous_instance || "", else: next_instance),
      metadata: metadata
    }

    state = %{
      state
      | runners: Map.put(state.runners, owner_id, runner),
        last_seen: Map.put(state.last_seen, owner_id, now)
    }

    {:reply, {:ok, reclaimed}, state}
  end

  def handle_call({:health, owner_id}, _from, state) do
    error = state.last_error[owner_id]

    {:reply,
     %{
       online: false,
       activeRuns: 0,
       lastError: error && error.message,
       lastErrorAt: error && error.at,
       lastSeenAt: state.last_seen[owner_id],
       planUsage: state.plan_usage[owner_id]
     }, state}
  end

  @impl true
  def handle_cast({:plan_usage, owner_id, usage}, state) do
    {:noreply,
     %{
       state
       | plan_usage: Map.put(state.plan_usage, owner_id, usage),
         last_seen: Map.put(state.last_seen, owner_id, iso_now())
     }}
  end

  def handle_cast({:disconnected, owner_id, sid, _reason}, state) do
    case state.runners[owner_id] do
      %{sid: ^sid} ->
        state = cancel_disconnect_timer(owner_id, state)
        due_at = System.monotonic_time(:millisecond) + state.disconnect_grace

        state =
          state
          |> then(
            &%{
              &1
              | disconnect_timers:
                  Map.put(&1.disconnect_timers, owner_id, %{sid: sid, due_at: due_at})
            }
          )
          |> schedule_disconnect_flush()

        {:noreply, state}

      _ ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info(:disconnect_flush, state) do
    now = System.monotonic_time(:millisecond)

    {due, pending} =
      Enum.split_with(state.disconnect_timers, fn {_owner_id, entry} -> entry.due_at <= now end)

    state = %{
      state
      | disconnect_timers: Map.new(pending),
        disconnect_flush_timer: nil,
        disconnect_flush_due_at: nil
    }

    eligible =
      Enum.filter(due, fn {owner_id, %{sid: sid}} ->
        not online?(owner_id) and get_in(state, [:runners, owner_id, :sid]) == sid
      end)

    open_by_owner =
      if eligible == [] do
        %{}
      else
        :telemetry.execute(
          [:cascade, :runs, :runner_disconnect_flush],
          %{count: length(eligible)},
          %{outcome: :snapshot}
        )

        Store.open_delegated() |> Enum.group_by(& &1.owner_user_id, & &1.run_id)
      end

    state =
      Enum.reduce(eligible, state, fn {owner_id, _entry}, state ->
        failed = Map.get(open_by_owner, owner_id, [])
        fail_runs(failed, "Desktop agent runner disconnected.")

        state
        |> then(&%{&1 | runners: Map.delete(&1.runners, owner_id)})
        |> maybe_disconnect_error(owner_id, failed)
      end)

    {:noreply, schedule_disconnect_flush(state)}
  end

  def handle_info(:orphan_reclaim, state) do
    summary = "Desktop agent runner did not reclaim this run after server restart."

    Store.open_delegated()
    |> Enum.reject(fn row ->
      online?(row.owner_user_id) and
        get_in(state, [:runners, row.owner_user_id, :metadata, :activeRunIds])
        |> List.wrap()
        |> Enum.member?(row.run_id)
    end)
    |> Enum.each(fn row ->
      Store.finish(row.run_id, "failed", summary)
      Store.publish(row.run_id, "status", %{status: "failed", summary: summary})
    end)

    loose_summary = "Server restarted while this run was in progress."

    sql_all_loose_runs()
    |> Enum.each(fn run_id ->
      Store.finish(run_id, "failed", loose_summary)
      Store.publish(run_id, "status", %{status: "failed", summary: loose_summary})
    end)

    {:noreply, state}
  end

  defp sql_all_loose_runs do
    Cascade.Accounts.SQL.all("""
    SELECT id FROM runs WHERE status IN ('queued','running')
    AND id NOT IN (SELECT run_id FROM delegated_runs)
    """)
    |> Enum.map(&hd/1)
  end

  defp fail_runs(run_ids, reason) do
    Enum.each(run_ids, fn run_id ->
      Store.finish(run_id, "failed", reason)
      Store.publish(run_id, "status", %{status: "failed", summary: reason})
    end)
  end

  defp maybe_disconnect_error(state, _owner_id, []), do: state

  defp maybe_disconnect_error(state, owner_id, failed),
    do: put_error(state, owner_id, "Runner disconnected; #{length(failed)} run(s) failed.")

  defp put_error(state, owner_id, message) do
    %{state | last_error: Map.put(state.last_error, owner_id, %{message: message, at: iso_now()})}
  end

  defp cancel_disconnect_timer(owner_id, state) do
    state = %{state | disconnect_timers: Map.delete(state.disconnect_timers, owner_id)}

    if map_size(state.disconnect_timers) == 0 and state.disconnect_flush_timer do
      Process.cancel_timer(state.disconnect_flush_timer)
      %{state | disconnect_flush_timer: nil, disconnect_flush_due_at: nil}
    else
      state
    end
  end

  defp schedule_disconnect_flush(%{disconnect_timers: timers} = state)
       when map_size(timers) == 0,
       do: state

  defp schedule_disconnect_flush(state) do
    due_at =
      state.disconnect_timers
      |> Map.values()
      |> Enum.map(& &1.due_at)
      |> Enum.min()
      |> Kernel.+(state.disconnect_flush_coalesce)

    if state.disconnect_flush_timer && state.disconnect_flush_due_at <= due_at do
      state
    else
      if state.disconnect_flush_timer, do: Process.cancel_timer(state.disconnect_flush_timer)
      delay = max(due_at - System.monotonic_time(:millisecond), 0)
      timer = Process.send_after(self(), :disconnect_flush, delay)
      %{state | disconnect_flush_timer: timer, disconnect_flush_due_at: due_at}
    end
  end

  defp wait_online_until(owner_id, deadline) do
    cond do
      online?(owner_id) ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(250)
        wait_online_until(owner_id, deadline)
    end
  end

  defp normalize_metadata(metadata) when is_map(metadata) do
    ids =
      field(metadata, :activeRunIds)
      |> List.wrap()
      |> Enum.map(fn value -> if is_integer(value), do: value, else: nil end)
      |> Enum.reject(&is_nil/1)
      |> Enum.filter(&(&1 > 0))
      |> Enum.take(10_000)

    instance = field(metadata, :runnerInstanceId)

    %{
      activeRunIds: ids,
      runnerInstanceId: if(is_binary(instance), do: String.slice(instance, 0, 200), else: "")
    }
  end

  defp normalize_metadata(_), do: %{activeRunIds: [], runnerInstanceId: ""}

  defp clean_usage(usage) when is_map(usage) do
    usage
    |> Enum.reduce(%{}, fn {agent, raw}, acc ->
      agent = to_string(agent)

      if agent in ~w(claude-code codex grok nous) and is_map(raw) do
        Map.put(acc, agent, clean_plan(raw))
      else
        acc
      end
    end)
  end

  defp clean_usage(_), do: %{}

  defp clean_plan(raw) do
    status = if field(raw, :status) in ["ok", "error"], do: field(raw, :status), else: "unknown"
    percent = number(field(raw, :usedPercent))

    %{
      status: status,
      fetchedAt: clean_string(field(raw, :fetchedAt), 100, iso_now())
    }
    |> maybe_put(
      :usedPercent,
      if(status == "ok" and percent, do: clamp(percent, 0, 100), else: nil)
    )
    |> maybe_put(:windowMinutes, number(field(raw, :windowMinutes)))
    |> maybe_put(:resetsAt, string_or_nil(field(raw, :resetsAt), 100))
    |> maybe_put(:resetsLabel, string_or_nil(field(raw, :resetsLabel), 100))
    |> maybe_put(:planType, string_or_nil(field(raw, :planType), 100))
    |> maybe_put(:detail, string_or_nil(field(raw, :detail), 300))
  end

  defp complete_workspace(response) do
    fields = [:path, :repository, :branch, :baseBranch, :baseCommit]
    values = Map.new(fields, &{&1, clean_string(field(response, &1), 2_000, "")})

    if Enum.all?(fields, &(values[&1] != "")) do
      {:ok, Map.put(values, :resumed, field(response, :resumed) == true)}
    else
      {:error, "Desktop returned an incomplete workspace binding"}
    end
  end

  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
  defp number(value) when is_number(value), do: value * 1.0
  defp number(_), do: nil
  defp clamp(value, min, max), do: value |> Kernel.max(min) |> Kernel.min(max)

  defp string_or_nil(value, max),
    do: if(is_binary(value), do: String.slice(value, 0, max), else: nil)

  defp clean_string(value, max, fallback), do: string_or_nil(value, max) || fallback
  defp iso_now, do: DateTime.utc_now() |> DateTime.to_iso8601()
end
