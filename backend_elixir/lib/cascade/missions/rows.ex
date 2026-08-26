defmodule Cascade.Missions.Rows do
  @moduledoc """
  Mission, task, and event row decoding plus shared scalar helpers.

  Decoders preserve the SQL column order and normalize unknown persisted statuses
  to safe defaults used by the public mission wire shape.
  """

  alias Cascade.Accounts.SQL

  @mission_statuses ~w(active reviewing attention blocked completed canceled)
  @task_statuses ~w(pending running completed failed blocked canceled)

  @mission_select """
  id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,objective,
  status,summary,wake_sent,created_by,created_at,updated_at
  """
  @task_select """
  id,mission_id,title,assignee_registration_id,status,summary,prompt,depends_on_json,
  priority,reasoning_effort,anonymous,dispatch_id,run_id,attempt,work_item_id,
  created_at,updated_at
  """
  @qualified_task_select """
  t.id,t.mission_id,t.title,t.assignee_registration_id,t.status,t.summary,t.prompt,
  t.depends_on_json,t.priority,t.reasoning_effort,t.anonymous,t.dispatch_id,t.run_id,
  t.attempt,t.work_item_id,t.created_at,t.updated_at
  """

    def mission_row(id) do
      SQL.one("SELECT #{@mission_select} FROM chat_missions WHERE id=?", [id])
      |> mission_from_nullable_row()
    end
  
    def task_row(id) do
      SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE id=?", [id])
      |> task_from_nullable_row()
    end
  
    def task_rows(mission_id) do
      SQL.all(
        "SELECT #{@task_select} FROM chat_mission_tasks WHERE mission_id=? ORDER BY created_at ASC,rowid ASC",
        [mission_id]
      )
      |> Enum.map(&task_from_row/1)
    end
  
    def task_with_mission(id) do
      SQL.one(
        """
        SELECT #{@qualified_task_select},m.channel_id,m.created_by,m.status
        FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
        WHERE t.id=?
        """,
        [id]
      )
      |> case do
        nil ->
          nil
  
        row ->
          {task_values, [channel_id, created_by, mission_status]} = Enum.split(row, 17)
  
          task_values
          |> task_from_row()
          |> Map.merge(%{
            owner_channel_id: channel_id,
            created_by: created_by,
            mission_status: mission_status
          })
      end
    end
  
    def mission_from_nullable_row(nil), do: nil
    def mission_from_nullable_row(row), do: mission_from_row(row)
  
    def mission_from_row([
           id,
           vault_id,
           channel_id,
           root_message_id,
           coordinator_registration_id,
           title,
           objective,
           status,
           summary,
           wake_sent,
           created_by,
           created_at,
           updated_at
         ]) do
      %{
        id: id,
        vault_id: vault_id,
        channel_id: channel_id,
        root_message_id: root_message_id,
        coordinator_registration_id: coordinator_registration_id,
        title: title,
        objective: objective || "",
        status: if(status in @mission_statuses, do: status, else: "active"),
        summary: summary || "",
        wake_sent: wake_sent || 0,
        created_by: created_by,
        created_at: created_at,
        updated_at: updated_at
      }
    end
  
    def task_from_nullable_row(nil), do: nil
    def task_from_nullable_row(row), do: task_from_row(row)
  
    def task_from_row([
           id,
           mission_id,
           title,
           assignee_registration_id,
           status,
           summary,
           prompt,
           depends_on_json,
           priority,
           reasoning_effort,
           anonymous,
           dispatch_id,
           run_id,
           attempt,
           work_item_id,
           created_at,
           updated_at
         ]) do
      %{
        id: id,
        mission_id: mission_id,
        title: title,
        assignee_registration_id: assignee_registration_id,
        status: if(status in @task_statuses, do: status, else: "pending"),
        summary: summary || "",
        prompt: prompt || "",
        depends_on_json: depends_on_json || "[]",
        priority: priority || 0,
        reasoning_effort: reasoning_effort || "",
        anonymous: anonymous || 0,
        dispatch_id: dispatch_id,
        run_id: run_id,
        attempt: attempt || 0,
        work_item_id: work_item_id,
        created_at: created_at,
        updated_at: updated_at
      }
    end
  
    def event_from_row([
           id,
           mission_id,
           task_id,
           kind,
           title,
           from_status,
           to_status,
           summary,
           run_id,
           attempt,
           created_at
         ]) do
      %{
        id: id,
        missionId: mission_id,
        kind: kind,
        title: title,
        fromStatus: from_status,
        toStatus: to_status,
        summary: summary,
        attempt: attempt || 0,
        createdAt: created_at
      }
      |> maybe_put(:taskId, task_id)
      |> maybe_put(:runId, run_id)
    end
  
    def work_item_branch(mission_id, task_id, title) do
      slug =
        title
        |> clean(40)
        |> String.downcase()
        |> String.replace(~r/[^a-z0-9]+/, "-")
        |> String.trim("-")
        |> String.slice(0, 32)
        |> nonblank("task")
  
      "cascade/#{String.slice(mission_id, 0, 8)}/#{slug}-#{String.slice(task_id, 0, 6)}"
    end
  
    def clean_ids(values) do
      values
      |> List.wrap()
      |> Enum.map(&clean(&1, 80))
      |> Enum.reject(&(&1 == ""))
      |> Enum.uniq()
    end
  
    def field(nil, _key), do: nil
  
    def field(map, key) do
      Map.get(map, key, Map.get(map, Atom.to_string(key)))
    end
  
    def clean(nil, _max), do: ""
    def clean(value, max), do: value |> to_string() |> String.trim() |> String.slice(0, max)
    def integer(value, _fallback) when is_integer(value), do: value
    def integer(value, _fallback) when is_float(value), do: value |> Float.floor() |> trunc()
  
    def integer(value, fallback) do
      case Integer.parse(to_string(value || "")) do
        {number, _} -> number
        _ -> fallback
      end
    end
  
    def truthy?(value) when value in [nil, false, 0, 0.0, ""], do: false
    def truthy?(_value), do: true
    def nonblank(nil, fallback), do: fallback
    def nonblank("", fallback), do: fallback
    def nonblank(value, _fallback), do: value
    def agent_name(nil), do: "agent"
    def agent_name(agent), do: nonblank(agent.displayName, agent.mention)
    def maybe_put(map, _key, nil), do: map
    def maybe_put(map, key, value), do: Map.put(map, key, value)
    def maybe_put_nonblank(map, _key, value) when value in [nil, ""], do: map
    def maybe_put_nonblank(map, key, value), do: Map.put(map, key, value)
    def maybe_put_nonempty(map, _key, []), do: map
    def maybe_put_nonempty(map, key, value), do: Map.put(map, key, value)
end
