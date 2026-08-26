defmodule Cascade.Missions.Projection do
  @moduledoc """
  Mission status derivation and public projection synchronization.

  Refreshes derive status from task state and update the durable root projection
  without changing equivalent historical JSON bytes.
  """

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.WorkItems
  import Cascade.Missions.Rows

    def do_refresh(mission) do
      tasks = task_rows(mission.id)
      status = derive_status(mission, tasks)
  
      mission =
        if status != mission.status do
          SQL.exec("UPDATE chat_missions SET status=?,updated_at=datetime('now') WHERE id=?", [
            status,
            mission.id
          ])
  
          Cascade.Missions.Lifecycle.record_event(mission.id, %{
            kind: "mission_status_changed",
            title: mission.title,
            from_status: mission.status,
            to_status: status
          })
  
          mission_row(mission.id)
        else
          mission
        end
  
      projection = project(mission, tasks)
      encoded_projection = Jason.encode!(projection)
  
      # Startup refreshes must not rewrite historical message bytes just because
      # a JSON encoder chooses a different key order. The Node and Elixir APIs
      # expose the parsed projection; preserve an already-equivalent durable
      # value and write only when mission state actually changed.
      unless mission_projection_equal?(
               SQL.one(
                 "SELECT mission_json FROM chat_messages WHERE id=? AND channel_id=?",
                 [mission.root_message_id, mission.channel_id]
               ),
               encoded_projection
             ) do
        SQL.exec(
          "UPDATE chat_messages SET mission_json=? WHERE id=? AND channel_id=?",
          [encoded_projection, mission.root_message_id, mission.channel_id]
        )
      end
  
      %{
        mission: projection,
        vaultId: mission.vault_id,
        channelId: mission.channel_id,
        rootMessageId: mission.root_message_id,
        createdBy: mission.created_by
      }
    end
  
    def mission_projection_equal?([existing], encoded)
         when is_binary(existing) and is_binary(encoded) do
      case {Jason.decode(existing), Jason.decode(encoded)} do
        {{:ok, left}, {:ok, right}} -> left == right
        _ -> false
      end
    end
  
    def mission_projection_equal?(_, _), do: false
  
    def derive_status(%{status: "canceled"}, _tasks), do: "canceled"
    def derive_status(%{status: "completed"}, _tasks), do: "completed"
    def derive_status(_mission, []), do: "active"
  
    def derive_status(_mission, tasks) do
      by_id = Map.new(tasks, &{&1.id, &1})
  
      cond do
        Enum.any?(tasks, &(&1.status in ~w(failed blocked))) ->
          "attention"
  
        Enum.any?(tasks, &(&1.status == "pending" and Cascade.Missions.Lifecycle.dependency_attention?(&1, by_id))) ->
          "attention"
  
        Enum.all?(tasks, &(&1.status in ~w(completed canceled))) ->
          "reviewing"
  
        true ->
          "active"
      end
    end
  
    def project(mission, tasks) do
      member_channel_id =
        case Cascade.Missions.Store.owner_route(mission.created_by, mission.vault_id, mission.channel_id) do
          {:ok, route} -> route.localChannelId
          _ -> mission.channel_id
        end
  
      registrations =
        case Agents.list_members(member_channel_id, mission.created_by) do
          {:ok, members} -> members
          _ -> []
        end
  
      by_registration = Map.new(registrations, &{&1.id, &1})
      by_task = Map.new(tasks, &{&1.id, &1})
      coordinator = by_registration[mission.coordinator_registration_id]
  
      projected_tasks =
        Enum.map(tasks, fn task ->
          assignee = by_registration[task.assignee_registration_id]
          depends_on = Cascade.Missions.Lifecycle.dependencies(task)
  
          waiting_for =
            Enum.filter(depends_on, &(is_nil(by_task[&1]) or by_task[&1].status != "completed"))
  
        attention = task.status == "pending" and Cascade.Missions.Lifecycle.dependency_attention?(task, by_task)
          anonymous = task.anonymous != 0
          mention = if assignee, do: assignee.mention, else: ""
  
          base = %{
            id: task.id,
            title: task.title,
            assignee:
              if(anonymous,
                do: "#{agent_name(assignee)} subagent",
                else: if(assignee, do: agent_name(assignee), else: "Unassigned agent")
              ),
            assigneeMention: if(anonymous and mention != "", do: mention <> "·sub", else: mention),
            assigneeModel: if(assignee, do: assignee.model || "", else: ""),
            status: task.status,
            summary: task.summary || "",
            dependsOn: depends_on,
            waitingFor: waiting_for,
            priority: task.priority || 0,
            reasoningEffort: task.reasoning_effort || "",
            anonymous: anonymous,
            attempt: task.attempt || 0,
            queueReason: Cascade.Missions.Lifecycle.queue_reason(task, waiting_for, attention),
            updatedAt: task.updated_at
          }
  
          base
          |> maybe_put(:runId, task.run_id)
          |> add_work_item_projection(mission.created_by, task.work_item_id)
        end)
  
      %{
        id: mission.id,
        rootMessageId: mission.root_message_id,
        title: mission.title,
        objective: mission.objective,
        status: derive_status(mission, tasks),
        coordinator: if(coordinator, do: agent_name(coordinator), else: "Coordinator"),
        coordinatorMention: if(coordinator, do: coordinator.mention || "", else: ""),
        tasks: projected_tasks,
        summary: mission.summary || "",
        createdAt: mission.created_at,
        updatedAt: mission.updated_at
      }
    end
  
    def add_work_item_projection(task, _user_id, nil), do: task
  
    def add_work_item_projection(task, user_id, work_item_id) do
      case WorkItems.get(user_id, work_item_id) do
        {:ok, item} ->
          task
          |> Map.merge(%{
            workItemId: item.id,
            workItemStatus: item.status,
            workspaceMode: item.workspaceMode,
            baseCommit: item.baseCommit,
            branch: item.branch,
            worktreePath: item.worktreePath,
            reviewReady: item.reviewReadiness.ready,
            reviewBlockers: item.reviewReadiness.blockers,
            reviewState: review_state(item)
          })
          |> maybe_put_nonblank(:prUrl, item.prUrl)
          |> maybe_put_nonblank(:prState, item.prState)
          |> maybe_put_nonblank(:verification, item.verification)
          |> maybe_put(:gitState, projected_git_state(item))
  
        _ ->
          task
      end
    end
  
    def projected_git_state(%{gitState: state, gitStateUpdatedAt: updated}) when is_map(state) do
      %{
        changedFiles: state.changedFiles,
        dirty: state.dirty,
        behind: state.behind,
        updatedAt: updated || ""
      }
    end
  
    def projected_git_state(_), do: nil
    def review_state(%{status: "review", prUrl: url}) when url not in [nil, ""], do: "in_review"
    def review_state(%{status: "review"}), do: "requested"
  
    def review_state(%{status: "done", verification: value}) when value not in [nil, ""],
      do: "ready"
  
    def review_state(_), do: "none"
  
    def ensure_work_item(user_id, mission, task) do
      existing =
        cond do
          task.work_item_id ->
            case WorkItems.get(user_id, task.work_item_id) do
              {:ok, item} -> item
              _ -> nil
            end
  
          true ->
            nil
        end
  
      existing =
        existing ||
          case SQL.one(
                 "SELECT id FROM work_items WHERE vault_id=? AND source_kind='mission' AND source_id=? LIMIT 1",
                 [mission.vault_id, task.id]
               ) do
            [id] ->
              SQL.exec("UPDATE chat_mission_tasks SET work_item_id=? WHERE id=?", [id, task.id])
  
              case WorkItems.get(user_id, id) do
                {:ok, item} -> item
                _ -> nil
              end
  
            nil ->
              nil
          end
  
      if existing do
        existing
      else
        dependency_work_items =
          Cascade.Missions.Lifecycle.dependencies(task)
          |> Enum.flat_map(fn id ->
            case SQL.one(
                   "SELECT work_item_id FROM chat_mission_tasks WHERE mission_id=? AND id=? AND work_item_id IS NOT NULL",
                   [mission.id, id]
                 ) do
              [work_item_id] -> [work_item_id]
              _ -> []
            end
          end)
  
        input = %{
          title: task.title,
          brief: nonblank(task.prompt, task.title),
          channelId: mission.channel_id,
          priority: task.priority,
          sourceKind: "mission",
          sourceId: task.id,
          dependsOn: dependency_work_items,
          assigneeRegistrationId: task.assignee_registration_id,
          workspaceMode: "isolated",
          branch: work_item_branch(mission.id, task.id, task.title)
        }
  
        case WorkItems.create(user_id, mission.vault_id, input) do
          {:ok, item} ->
            SQL.exec("UPDATE chat_mission_tasks SET work_item_id=? WHERE id=?", [item.id, task.id])
            item
  
          {:error, reason} ->
            raise reason
        end
      end
    end
  
    def sync_work_item(user_id, mission, task, opts) do
      item = ensure_work_item(user_id, mission, task)
      run_id = Keyword.get(opts, :run_id)
  
      if is_integer(run_id) and run_id > 0, do: WorkItems.link_run(user_id, item.id, run_id)
  
      if Keyword.get(opts, :lease) do
        WorkItems.acquire_lease(user_id, item.id, task.assignee_registration_id)
      end
  
      reset = Keyword.get(opts, :reset, false)
  
      WorkItems.update(user_id, item.id, %{
        status: task_to_work_item_status(task.status),
        summary: if(reset, do: "", else: nonblank(task.summary, item.summary)),
        verification: if(reset, do: "", else: item.verification),
        stopReason: if(reset, do: "", else: item.stopReason),
        assigneeRegistrationId: task.assignee_registration_id
      })
  
      if Keyword.get(opts, :release) or
           task_to_work_item_status(task.status) in ~w(done canceled blocked) do
        WorkItems.release_lease(user_id, item.id)
      end
  
      :ok
    rescue
      _ -> :ok
    end
  
    def task_to_work_item_status("running"), do: "in_progress"
    def task_to_work_item_status(status) when status in ~w(blocked failed), do: "blocked"
    def task_to_work_item_status("completed"), do: "done"
    def task_to_work_item_status("canceled"), do: "canceled"
    def task_to_work_item_status(_), do: "open"
end
