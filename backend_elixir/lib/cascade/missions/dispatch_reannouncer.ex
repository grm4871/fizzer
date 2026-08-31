defmodule Cascade.Missions.DispatchReannouncer do
  @moduledoc "Replays durable, unclaimed mission dispatches until a desktop claims them."

  use GenServer

  alias Cascade.Accounts.SQL
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
    Scheduler.reannounce_pending(events: Cascade.Realtime.Events)

    SQL.all("""
    SELECT m.created_by,m.channel_id,t.dispatch_id
    FROM chat_mission_tasks t
    JOIN chat_missions m ON m.id=t.mission_id
    JOIN chat_agent_dispatches d ON d.id=t.dispatch_id
    WHERE t.status='pending' AND t.run_id IS NULL AND d.run_id IS NULL
    """)
    |> Enum.each(fn [user_id, channel_id, dispatch_id] ->
      OrchestrationController.claim_mission_dispatch(user_id, channel_id, dispatch_id)
    end)

    Process.send_after(self(), :reannounce, interval)
    {:noreply, interval}
  end
end
