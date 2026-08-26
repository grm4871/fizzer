defmodule Cascade.Missions.Lifecycle do
  @moduledoc """
  Mission transition, authorization, event, and worker lifecycle invariants.

  Transition helpers retain coordinator ownership checks and emit one ordered
  event per durable state change inside the caller's SQL transaction.
  """

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel}
  import Cascade.Missions.Rows

  @terminal_task_statuses ~w(completed failed blocked canceled)

    def maybe_finish_primary(mission, tasks, "completed", run_id, summary)
         when is_integer(run_id) do
      primary =
        Enum.find(tasks, fn task ->
          task.status == "running" and task.run_id == run_id and
            task.assignee_registration_id == mission.coordinator_registration_id
        end)
  
      if primary do
        SQL.exec(
          "UPDATE chat_mission_tasks SET status='completed',summary=?,updated_at=datetime('now') WHERE id=?",
          [summary, primary.id]
        )
  
        record_event(mission.id, %{
          task_id: primary.id,
          kind: "task_status_changed",
          title: primary.title,
          from_status: primary.status,
          to_status: "completed",
          summary: summary,
          run_id: primary.run_id,
          attempt: primary.attempt
        })
  
        Cascade.Missions.Projection.sync_work_item(
          mission.created_by,
          mission,
          %{primary | status: "completed", summary: summary},
          release: true
        )
  
        task_rows(mission.id)
      else
        tasks
      end
    end
  
    def maybe_finish_primary(_mission, tasks, _status, _run_id, _summary), do: tasks
  
    def cancel_open_tasks(mission, tasks) do
      SQL.exec(
        "UPDATE chat_mission_tasks SET status='canceled',updated_at=datetime('now') WHERE mission_id=? AND status IN ('pending','running')",
        [mission.id]
      )
  
      Enum.each(Enum.filter(tasks, &(&1.status in ~w(pending running))), fn task ->
        record_event(mission.id, %{
          task_id: task.id,
          kind: "task_status_changed",
          title: task.title,
          from_status: task.status,
          to_status: "canceled",
          summary: "Mission canceled.",
          run_id: task.run_id,
          attempt: task.attempt
        })
      end)
  
      SQL.exec(
        "DELETE FROM chat_agent_dispatches WHERE run_id IS NULL AND id IN (SELECT dispatch_id FROM chat_mission_tasks WHERE mission_id=?)",
        [mission.id]
      )
    end
  
    def cleanup_stale_wakes(mission, current_run_id) do
      stale =
        SQL.all(
          """
          SELECT m.id,d.run_id FROM chat_messages m
          JOIN chat_agent_dispatches d ON d.message_id=m.id
          WHERE m.channel_id=? AND m.id LIKE ? AND d.registration_id=?
          """,
          [mission.channel_id, "sys-mission-#{mission.id}-%", mission.coordinator_registration_id]
        )
        |> Enum.reject(fn [_id, run_id] -> not is_nil(run_id) and run_id == current_run_id end)
  
      {removed, canceled} =
        Enum.reduce(stale, {[], []}, fn [message_id, run_id], {removed, canceled} ->
          carrier = String.replace_prefix(message_id, "sys-mission-", "agent-trace-")
  
          shell_ids =
            if is_nil(run_id) do
              []
            else
              SQL.all(
                "SELECT id FROM chat_messages WHERE channel_id=? AND run_id=? AND registration_id=?",
                [mission.channel_id, run_id, mission.coordinator_registration_id]
              )
              |> List.flatten()
            end
  
          ids = [message_id, carrier | shell_ids]
  
          removed_now =
            Enum.filter(ids, fn id ->
              SQL.changes("DELETE FROM chat_messages WHERE id=? AND channel_id=?", [
                id,
                mission.channel_id
              ]) > 0
            end)
  
          {removed ++ removed_now, if(is_nil(run_id), do: canceled, else: canceled ++ [run_id])}
        end)
  
      %{}
      |> maybe_put_nonempty(:removedWakeMessageIds, removed)
      |> maybe_put_nonempty(:canceledWakeRunIds, canceled)
    end
  
    def active_run?(nil), do: false
  
    def active_run?(run_id) do
      case SQL.one("SELECT status FROM runs WHERE id=?", [run_id]) do
        [status] -> status in ~w(queued running)
        _ -> false
      end
    end
  
    def assert_coordinator(user_id, channel_id, registration_id) do
      with {:ok, registration} <- find_registration(user_id, channel_id, registration_id),
           {:ok, route} <- Channel.assert_channel(channel_id, user_id),
           [^user_id] <-
             SQL.one(
               """
               SELECT va.owner_user_id FROM chat_agent_members m
               JOIN vault_agents va ON va.id=m.vault_agent_id
               WHERE m.id=? AND m.channel_id=?
               """,
               [registration.id, route.sourceChannelId]
             ) do
        {:ok, registration}
      else
        [_other] -> {:error, "Only the agent owner can operate its mission"}
        {:error, _} = error -> error
        _ -> {:error, "Only the agent owner can operate its mission"}
      end
    end
  
    def find_registration(user_id, channel_id, ref) do
      normalized = ref |> clean(120) |> String.trim_leading("@") |> String.downcase()
  
      with {:ok, members} <- Agents.list_members(channel_id, user_id) do
        case Enum.find(members, fn member ->
               member.id == ref or member.vaultAgentId == ref or
                 String.downcase(member.mention) == normalized or
                 String.downcase(member.displayName) == normalized
             end) do
          nil -> {:error, "Mission agent not found"}
          member -> {:ok, member}
        end
      end
    end
  
    def find_assignee(user_id, channel_id, ref) do
      case find_registration(user_id, channel_id, ref) do
        {:ok, registration} -> {:ok, registration}
        _ -> {:error, "No channel agent matches #{to_string(ref || "")}"}
      end
    end
  
    def validate_self_assignment(assignee, coordinator, anonymous, opts) do
      if assignee.id == coordinator.id and not anonymous and not Keyword.get(opts, :primary, false),
        do:
          {:error,
           "Delegate this task to another channel agent, or pass anonymous for a self-subagent"},
        else: :ok
    end
  
    def ensure_mission_open(status) when status in ~w(completed canceled),
      do: {:error, "Mission is already closed"}
  
    def ensure_mission_open(_status), do: :ok
  
    def authorize_task_row(row, route, user_id) do
      if row.owner_channel_id == route.sourceChannelId and row.created_by == user_id,
        do: :ok,
        else: {:error, "Mission task not found"}
    end
  
    def validate_dependencies(_mission_id, []), do: :ok
  
    def validate_dependencies(mission_id, dependencies) do
      placeholders = Enum.map_join(dependencies, ",", fn _ -> "?" end)
  
      found =
        SQL.one(
          "SELECT COUNT(*) FROM chat_mission_tasks WHERE mission_id=? AND id IN (#{placeholders})",
          [mission_id | dependencies]
        )
        |> hd()
  
      if found == length(dependencies),
        do: :ok,
        else: {:error, "Every dependency must be an existing task in this mission"}
    end
  
    def validate_effort(assignee, value) do
      effort = value |> clean(20) |> String.downcase()
  
      allowed =
        case assignee.agentId do
          "codex" -> ["" | ~w(low medium high xhigh max ultra)]
          "claude-code" -> ["" | ~w(low medium high xhigh max)]
          _ -> [""]
        end
  
      if effort in allowed,
        do: {:ok, effort},
        else:
          {:error,
           "#{nonblank(effort, "Reasoning effort")} is not supported by @#{assignee.mention}"}
    end
  
    def validate_idempotent_task!(nil, _prompt, _deps, _priority, _effort, _anonymous), do: :ok
  
    def validate_idempotent_task!(task, prompt, deps, priority, effort, anonymous) do
      if task.prompt != prompt or task.depends_on_json != deps or task.priority != priority or
           task.reasoning_effort != effort or task.anonymous != 0 != anonymous do
        raise "A task with this title already exists with different scheduling options; use a distinct title"
      end
    end
  
    def dependency_attention?(task, by_id, seen \\ MapSet.new()) do
      if MapSet.member?(seen, task.id) do
        false
      else
        seen = MapSet.put(seen, task.id)
  
        Enum.any?(dependencies(task), fn id ->
          case by_id[id] do
            nil -> false
            dependency when dependency.status in ~w(failed blocked canceled) -> true
            %{status: "pending"} = dependency -> dependency_attention?(dependency, by_id, seen)
            _ -> false
          end
        end)
      end
    end
  
    def dependencies(task) do
      case Jason.decode(task.depends_on_json || "[]") do
        {:ok, values} when is_list(values) -> Enum.filter(values, &is_binary/1)
        _ -> []
      end
    end
  
    def queue_reason(%{status: status}, _waiting, _attention) when status != "pending", do: ""
    def queue_reason(_task, waiting, true) when waiting != [], do: "dependency-attention"
    def queue_reason(_task, waiting, _attention) when waiting != [], do: "dependency"
    def queue_reason(%{dispatch_id: id}, _waiting, _attention) when not is_nil(id), do: "queued"
    def queue_reason(_task, _waiting, _attention), do: "agent-busy"
  
    def record_event(mission_id, input) do
      SQL.exec(
        """
        INSERT INTO chat_mission_events
          (mission_id,task_id,kind,title,from_status,to_status,summary,run_id,attempt)
        VALUES (?,?,?,?,?,?,?,?,?)
        """,
        [
          mission_id,
          input[:task_id],
          input.kind,
          input[:title] || "",
          input[:from_status] || "",
          input[:to_status] || "",
          input[:summary] || "",
          input[:run_id],
          input[:attempt] || 0
        ]
      )
    end
end
