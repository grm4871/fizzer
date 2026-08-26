defmodule Cascade.Missions.Primary do
  @moduledoc """
  Primary coordinator task binding for agent-owned mission runs.

  Binding is idempotent through the existing mission task, dispatch, and run
  links; failures retain the caller's error tuple contract.
  """

  alias Cascade.Accounts.SQL

    def maybe_bind_primary(update, user_id, channel_id, opts) do
      run_id = Keyword.get(opts, :current_run_id)
  
      if Keyword.get(opts, :agent, false) and is_integer(run_id) and run_id > 0 do
        mission = Cascade.Missions.Rows.mission_row(update.mission.id)
  
        active =
          SQL.one(
            """
            SELECT d.id FROM runs r JOIN chat_agent_dispatches d ON d.id=r.chat_dispatch_id
            WHERE r.id=? AND r.status IN ('queued','running')
              AND d.registration_id=? AND d.channel_id=?
            """,
            [run_id, mission.coordinator_registration_id, update.channelId]
          )
  
        case active do
          [dispatch_id] ->
            {:ok, added} =
              Cascade.Missions.Store.add_task(
                user_id,
                channel_id,
                mission.id,
                %{
                  coordinatorRegistrationId: mission.coordinator_registration_id,
                  title: "Primary task",
                  assignee: mission.coordinator_registration_id,
                  prompt: update.mission.objective
                },
                primary: true
              )
  
            {:ok, linked} = Cascade.Missions.Store.link_dispatch(added.task.id, dispatch_id)
  
            case Cascade.Missions.Store.attach_run(dispatch_id, run_id) do
              {:ok, nil} -> {:ok, linked}
              result -> result
            end
  
          nil ->
            {:ok, update}
        end
      else
        {:ok, update}
      end
    end
end
