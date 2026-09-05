defmodule Cascade.Missions.DispatchReannouncer do
  @moduledoc "Replays durable, unclaimed mission dispatches until a desktop claims them."

  use GenServer

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
    Scheduler.schedule(nil, events: Cascade.Realtime.Events)
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
