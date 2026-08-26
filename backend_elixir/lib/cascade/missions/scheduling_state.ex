defmodule Cascade.Missions.SchedulingState do
  @moduledoc """
  Selects ready mission tasks while enforcing one active task per named agent.

  This module is the read-only scheduling projection. The Scheduler owns
  dispatch materialization and event publication; the Store owns durable state.
  """

  alias Cascade.Accounts.SQL
  import Cascade.Missions.Rows

  @mission_select """
  id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,objective,
  status,summary,wake_sent,created_by,created_at,updated_at
  """

  def schedulable(mission_id \\ nil) do
    {filter, params} = if mission_id, do: {"AND id=?", [mission_id]}, else: {"", []}

    missions =
      SQL.all(
        """
        SELECT #{@mission_select} FROM chat_missions
        WHERE status IN ('active','reviewing','attention','blocked') #{filter}
        ORDER BY created_at ASC,rowid ASC
        """,
        params
      )
      |> Enum.map(&mission_from_row/1)

    {candidates, _reserved} =
      Enum.reduce(missions, {[], MapSet.new()}, fn mission, {candidates, reserved} ->
        tasks = task_rows(mission.id)

        occupied =
          SQL.all(
            """
            SELECT DISTINCT t.assignee_registration_id
            FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
            WHERE m.channel_id=? AND m.status IN ('active','reviewing','attention','blocked')
              AND COALESCE(t.anonymous,0)=0
              AND (t.status='running' OR (t.status='pending' AND t.dispatch_id IS NOT NULL))
            """,
            [mission.channel_id]
          )
          |> Enum.map(&hd/1)
          |> MapSet.new()

        by_id = Map.new(tasks, &{&1.id, &1})

        ready =
          tasks
          |> Enum.with_index()
          |> Enum.filter(fn {task, _index} ->
            task.status == "pending" and is_nil(task.dispatch_id) and
              Enum.all?(
                Cascade.Missions.Lifecycle.dependencies(task),
                &(by_id[&1] && by_id[&1].status == "completed")
              )
          end)
          |> Enum.sort_by(fn {task, index} -> {-task.priority, index} end)

        Enum.reduce(ready, {candidates, reserved}, fn {task, _index}, {items, held} ->
          key = "#{mission.channel_id}:#{task.assignee_registration_id}"
          anonymous = task.anonymous != 0

          if not anonymous and
               (MapSet.member?(occupied, task.assignee_registration_id) or
                  MapSet.member?(held, key)) do
            {items, held}
          else
            candidate = %{
              taskId: task.id,
              missionId: mission.id,
              vaultId: mission.vault_id,
              channelId: mission.channel_id,
              createdBy: mission.created_by,
              coordinatorRegistrationId: mission.coordinator_registration_id,
              assigneeRegistrationId: task.assignee_registration_id,
              title: task.title,
              prompt: nonblank(task.prompt, task.title),
              reasoningEffort: task.reasoning_effort || "",
              anonymous: anonymous,
              attempt: task.attempt || 0
            }

            {items ++ [candidate], if(anonymous, do: held, else: MapSet.put(held, key))}
          end
        end)
      end)

    %{candidates: candidates, updates: []}
  end
end
