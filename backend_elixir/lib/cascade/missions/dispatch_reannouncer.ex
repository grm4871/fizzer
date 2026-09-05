defmodule Cascade.Missions.DispatchReannouncer do
  @moduledoc "Replays durable, unclaimed mission dispatches until a desktop claims them."

  use GenServer

  alias Cascade.Accounts.SQL
  alias Cascade.Runs.RunnerLifecycle
  alias Cascade.Missions.Scheduler
  alias CascadeWeb.OrchestrationController

  @default_interval 10_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    interval = Keyword.get(opts, :interval, @default_interval)
    send(self(), :reannounce)
    {:ok, interval}
  end

  @impl true
  def handle_info(:reannounce, interval) do
    # No owner runner can act during a disconnected/maintenance boot. Preserve
    # the database until reconnect, including the deploy snapshot verification.
    SQL.all(
      "SELECT id,created_by FROM chat_missions WHERE status NOT IN ('completed','canceled')"
    )
    |> Enum.each(fn [mission_id, owner_id] ->
      if RunnerLifecycle.online?(owner_id),
        do: Scheduler.schedule(mission_id, events: Cascade.Realtime.Events)
    end)

    Scheduler.reannounce_pending(events: Cascade.Realtime.Events)

    Scheduler.pending_dispatches()
    |> Enum.each(fn [dispatch_id, user_id, vault_id, channel_id] ->
      {:ok, route} = Cascade.Missions.Store.owner_route(user_id, vault_id, channel_id)
      OrchestrationController.claim_mission_dispatch(user_id, route.localChannelId, dispatch_id)
    end)

    Process.send_after(self(), :reannounce, interval)
    {:noreply, interval}
  end
end
