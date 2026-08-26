defmodule Cascade.Missions.Store do
  @moduledoc """
  Authoritative mission/task state machine and materialized chat projection.

  Public operations preserve transactional task transitions, coordinator ownership,
  deterministic scheduling order, and the parsed mission wire projection. Invalid
  transitions return the existing `{:error, reason}` tuples.
  """

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages}
  alias Cascade.WorkItems
  import Cascade.Missions.Rows
  import Cascade.Missions.Projection
  import Cascade.Missions.Lifecycle
  import Cascade.Missions.Primary
  @mission_statuses ~w(active reviewing attention blocked completed canceled)
  @task_statuses ~w(pending running completed failed blocked canceled)
  @terminal_task_statuses ~w(completed failed blocked canceled)
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

  @event_select """
  id,mission_id,task_id,kind,title,from_status,to_status,summary,run_id,attempt,created_at
  """

  def create(user_id, vault_id, channel_id, input, opts \\ []) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         true <- route.localVaultId == vault_id,
         {:ok, coordinator} <-
           assert_coordinator(
             user_id,
             channel_id,
             field(input, :coordinatorRegistrationId)
           ),
         {:ok, root} <- Messages.get(channel_id, user_id, field(input, :rootMessageId)),
         title when title != "" <- clean(field(input, :title), 180) do
      objective = clean(nonblank(field(input, :objective), root.body), 4_000)

      result =
        SQL.transaction(fn ->
          existing =
            SQL.one(
              "SELECT id,coordinator_registration_id FROM chat_missions WHERE channel_id=? AND root_message_id=?",
              [route.sourceChannelId, root.id]
            )

          case existing do
            [_, registration_id] when registration_id != coordinator.id ->
              raise "Mission belongs to another coordinator"

            [mission_id, _] ->
              refresh!(mission_id)

            nil ->
              mission_id = Ecto.UUID.generate()

              SQL.exec(
                """
                INSERT INTO chat_missions
                  (id,vault_id,channel_id,root_message_id,coordinator_registration_id,
                   title,objective,created_by)
                VALUES (?,?,?,?,?,?,?,?)
                """,
                [
                  mission_id,
                  route.sourceVaultId,
                  route.sourceChannelId,
                  root.id,
                  coordinator.id,
                  title,
                  objective,
                  user_id
                ]
              )

              record_event(mission_id, %{
                kind: "mission_created",
                title: title,
                to_status: "active",
                summary: objective
              })

              refresh!(mission_id)
          end
        end)

      maybe_bind_primary(result, user_id, channel_id, opts)
    else
      false -> {:error, "Chat channel not found"}
      "" -> {:error, "Mission title is required"}
      {:error, "Message not found"} -> {:error, "Mission root message not found"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def get(user_id, channel_id, mission_ref, coordinator_registration_id \\ nil) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      row =
        if mission_ref in [nil, "", "current"] do
          coordinator = clean(coordinator_registration_id, 120)

          SQL.one(
            """
            SELECT #{@mission_select} FROM chat_missions
            WHERE channel_id=? AND (?='' OR coordinator_registration_id=?)
            ORDER BY
              CASE WHEN status IN ('active','reviewing','attention','blocked') THEN 0 ELSE 1 END,
              updated_at DESC,rowid DESC
            LIMIT 1
            """,
            [route.sourceChannelId, coordinator, coordinator]
          )
        else
          case mission_row(mission_ref) do
            %{channel_id: channel_id} = mission when channel_id == route.sourceChannelId ->
              mission

            _ ->
              nil
          end
        end

      case row do
        nil -> {:error, "Mission not found"}
        mission when is_map(mission) -> refresh(mission.id)
        mission -> mission |> mission_from_row() |> Map.fetch!(:id) |> refresh()
      end
    end
  end

  def list(user_id, channel_id, coordinator_registration_id \\ nil) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      coordinator = clean(coordinator_registration_id, 120)

      missions =
        SQL.all(
          """
          SELECT #{@mission_select} FROM chat_missions
          WHERE channel_id=? AND (?='' OR coordinator_registration_id=?)
          ORDER BY updated_at DESC,rowid DESC
          """,
          [route.sourceChannelId, coordinator, coordinator]
        )
        |> Enum.map(fn row -> row |> mission_from_row() |> then(&refresh!(&1.id).mission) end)

      {:ok, missions}
    end
  end

  def list_active(user_id, channel_id, limit \\ 3) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id) do
      limit = limit |> integer(3) |> max(1) |> min(10)

      missions =
        SQL.all(
          """
          SELECT #{@mission_select} FROM chat_missions
          WHERE channel_id=? AND status IN ('active','reviewing','attention','blocked')
          ORDER BY updated_at DESC,rowid DESC LIMIT ?
          """,
          [route.sourceChannelId, limit]
        )
        |> Enum.map(fn row ->
          mission = mission_from_row(row)
          project(mission, task_rows(mission.id))
        end)

      {:ok, missions}
    end
  end

  def events(user_id, channel_id, mission_id) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         %{channel_id: channel_id} <- mission_row(mission_id),
         true <- channel_id == route.sourceChannelId do
      result =
        SQL.all(
          "SELECT #{@event_select} FROM chat_mission_events WHERE mission_id=? ORDER BY created_at ASC,id ASC",
          [mission_id]
        )
        |> Enum.map(&event_from_row/1)

      {:ok, result}
    else
      _ -> {:error, "Mission not found"}
    end
  end

  def add_task(user_id, channel_id, mission_id, input, opts \\ []) do
    coordinator_id = field(input, :coordinatorRegistrationId)

    with {:ok, update} <- get(user_id, channel_id, mission_id, coordinator_id),
         mission <- mission_row(update.mission.id),
         :ok <- ensure_mission_open(mission.status),
         {:ok, coordinator} <- assert_coordinator(user_id, channel_id, coordinator_id),
         true <- mission.coordinator_registration_id == coordinator.id,
         {:ok, assignee} <- find_assignee(user_id, channel_id, field(input, :assignee)),
         anonymous <- truthy?(field(input, :anonymous)),
         :ok <- validate_self_assignment(assignee, coordinator, anonymous, opts),
         title when title != "" <- clean(field(input, :title), 240),
         dependencies <- clean_ids(field(input, :dependsOn)),
         :ok <- validate_dependencies(mission.id, dependencies),
         {:ok, effort} <- validate_effort(assignee, field(input, :reasoningEffort)) do
      priority = field(input, :priority) |> integer(0) |> max(-100) |> min(100)
      prompt = clean(nonblank(field(input, :prompt), title), 12_000)
      dependency_json = Jason.encode!(dependencies)
      anonymous_int = if anonymous, do: 1, else: 0

      result =
        SQL.transaction(fn ->
          existing =
            SQL.one(
              """
              SELECT #{@task_select} FROM chat_mission_tasks
              WHERE mission_id=? AND assignee_registration_id=? AND title=?
              ORDER BY created_at ASC,rowid ASC LIMIT 1
              """,
              [mission.id, assignee.id, title]
            )
            |> task_from_nullable_row()

          validate_idempotent_task!(
            existing,
            prompt,
            dependency_json,
            priority,
            effort,
            anonymous
          )

          task_id = if existing, do: existing.id, else: Ecto.UUID.generate()

          if is_nil(existing) do
            SQL.exec(
              """
              INSERT INTO chat_mission_tasks
                (id,mission_id,title,assignee_registration_id,prompt,depends_on_json,
                 priority,reasoning_effort,anonymous)
              VALUES (?,?,?,?,?,?,?,?,?)
              """,
              [
                task_id,
                mission.id,
                title,
                assignee.id,
                prompt,
                dependency_json,
                priority,
                effort,
                anonymous_int
              ]
            )

            SQL.exec(
              "UPDATE chat_missions SET status='active',wake_sent=0,updated_at=datetime('now') WHERE id=?",
              [mission.id]
            )

            if mission.status != "active" do
              record_event(mission.id, %{
                kind: "mission_status_changed",
                title: mission.title,
                from_status: mission.status,
                to_status: "active",
                summary: "Follow-up work added."
              })
            end

            task = task_row(task_id)
            ensure_work_item(user_id, mission, task)

            record_event(mission.id, %{
              task_id: task_id,
              kind: "task_added",
              title: title,
              to_status: "pending",
              summary: prompt,
              attempt: 0
            })
          else
            if is_nil(existing.work_item_id), do: ensure_work_item(user_id, mission, existing)
          end

          refreshed = refresh!(mission.id)

          %{
            update: refreshed,
            task: Enum.find(refreshed.mission.tasks, &(&1.id == task_id)),
            assignee: assignee
          }
        end)

      {:ok, result}
    else
      false -> {:error, "Mission belongs to another coordinator"}
      "" -> {:error, "Task title is required"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def schedulable(mission_id \\ nil), do: Cascade.Missions.SchedulingState.schedulable(mission_id)

  def link_dispatch(task_id, dispatch_id) do
    case task_row(task_id) do
      nil ->
        {:error, "Mission task not found"}

      task ->
        changed =
          SQL.changes(
            "UPDATE chat_mission_tasks SET dispatch_id=COALESCE(dispatch_id,?),updated_at=datetime('now') WHERE id=? AND dispatch_id IS NULL",
            [dispatch_id, task_id]
          )

        if changed > 0 do
          record_event(task.mission_id, %{
            task_id: task.id,
            kind: "task_dispatched",
            title: task.title,
            from_status: task.status,
            to_status: task.status,
            attempt: task.attempt
          })
        end

        refresh(task.mission_id)
    end
  end

  def attach_run(dispatch_id, run_id) when is_integer(run_id) and run_id > 0 do
    case SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE dispatch_id=?", [
           dispatch_id
         ]) do
      nil ->
        {:ok, nil}

      row ->
        task = task_from_row(row)

        if task.status in ~w(pending running) do
          SQL.exec(
            "UPDATE chat_mission_tasks SET run_id=?,status='running',updated_at=datetime('now') WHERE id=?",
            [run_id, task.id]
          )

          if task.status != "running" or task.run_id != run_id do
            record_event(task.mission_id, %{
              task_id: task.id,
              kind: "task_started",
              title: task.title,
              from_status: task.status,
              to_status: "running",
              run_id: run_id,
              attempt: task.attempt
            })
          end
        end

        mission = mission_row(task.mission_id)
        updated = task_row(task.id)

        if mission && updated,
          do: sync_work_item(mission.created_by, mission, updated, run_id: run_id, lease: true)

        refresh(task.mission_id)
    end
  end

  def attach_run(_dispatch_id, _run_id), do: {:error, "Invalid run id"}

  def update_task(user_id, channel_id, task_id, input) do
    with {:ok, route} <- Channel.assert_channel(channel_id, user_id),
         row when not is_nil(row) <- task_with_mission(task_id),
         :ok <- authorize_task_row(row, route, user_id),
         :ok <- ensure_mission_open(row.mission_status),
         status when status in @task_statuses <- clean(field(input, :status), 40) do
      summary = clean(field(input, :summary), 4_000)
      retrying = status == "pending" and row.status in @terminal_task_statuses

      cond do
        status == "pending" and row.status == "running" ->
          {:error, "Task is still running; cancel or wait for it before retrying"}

        retrying and active_run?(row.run_id) ->
          {:error, "Task run is still active; cancel or wait for it before retrying"}

        true ->
          result =
            SQL.transaction(fn ->
              if retrying do
                SQL.exec(
                  "DELETE FROM chat_agent_dispatches WHERE run_id IS NULL AND id=?",
                  [row.dispatch_id]
                )

                SQL.exec(
                  """
                  UPDATE chat_mission_tasks
                  SET status='pending',summary=?,dispatch_id=NULL,run_id=NULL,
                    attempt=attempt+1,updated_at=datetime('now') WHERE id=?
                  """,
                  [summary, task_id]
                )

                SQL.exec(
                  "UPDATE chat_missions SET status='active',wake_sent=0,updated_at=datetime('now') WHERE id=?",
                  [row.mission_id]
                )

                if row.mission_status != "active" do
                  record_event(row.mission_id, %{
                    kind: "mission_status_changed",
                    title: mission_row(row.mission_id).title,
                    from_status: row.mission_status,
                    to_status: "active",
                    summary: "Retrying #{row.title}."
                  })
                end

                record_event(row.mission_id, %{
                  task_id: task_id,
                  kind: "task_retried",
                  title: row.title,
                  from_status: row.status,
                  to_status: "pending",
                  summary: summary,
                  attempt: row.attempt + 1
                })
              else
                SQL.exec(
                  "UPDATE chat_mission_tasks SET status=?,summary=?,updated_at=datetime('now') WHERE id=?",
                  [status, summary, task_id]
                )

                if row.status != status or row.summary != summary do
                  record_event(row.mission_id, %{
                    task_id: task_id,
                    kind: "task_status_changed",
                    title: row.title,
                    from_status: row.status,
                    to_status: status,
                    summary: summary,
                    run_id: row.run_id,
                    attempt: row.attempt
                  })
                end
              end

              if status in @terminal_task_statuses do
                SQL.exec(
                  "DELETE FROM chat_agent_dispatches WHERE run_id IS NULL AND id=(SELECT dispatch_id FROM chat_mission_tasks WHERE id=?)",
                  [task_id]
                )
              end

              mission = mission_row(row.mission_id)
              task = task_row(task_id)

              sync_work_item(mission.created_by, mission, task,
                release: status in @terminal_task_statuses,
                reset: retrying
              )

              update = refresh!(row.mission_id)

              if status == "canceled" and not is_nil(row.run_id),
                do: Map.put(update, :canceledTaskRunIds, [row.run_id]),
                else: update
            end)

          {:ok, result}
      end
    else
      nil -> {:error, "Mission task not found"}
      status when is_binary(status) -> {:error, "Invalid mission task status"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def finish(user_id, channel_id, mission_id, input, opts \\ []) do
    coordinator_id = field(input, :coordinatorRegistrationId)

    with {:ok, update} <- get(user_id, channel_id, mission_id, coordinator_id),
         mission <- mission_row(update.mission.id),
         {:ok, coordinator} <- assert_coordinator(user_id, channel_id, coordinator_id),
         true <- mission.coordinator_registration_id == coordinator.id,
         status when status in ~w(completed canceled) <- field(input, :status) do
      if mission.status in ~w(completed canceled) do
        if mission.status == status,
          do: refresh(mission.id),
          else: {:error, "Mission is already closed"}
      else
        current_run_id = Keyword.get(opts, :current_run_id)
        summary = clean(field(input, :summary), 4_000)

        result =
          SQL.transaction(fn ->
            tasks =
              maybe_finish_primary(
                mission,
                task_rows(mission.id),
                status,
                current_run_id,
                summary
              )

            if status == "completed" and
                 Enum.any?(tasks, &(&1.status in ~w(pending running))) do
              raise "Mission still has active workers"
            end

            SQL.exec(
              "UPDATE chat_missions SET status=?,summary=?,wake_sent=1,updated_at=datetime('now') WHERE id=?",
              [status, summary, mission.id]
            )

            record_event(mission.id, %{
              kind: if(status == "completed", do: "mission_completed", else: "mission_canceled"),
              title: mission.title,
              from_status: mission.status,
              to_status: status,
              summary: summary
            })

            if status == "canceled", do: cancel_open_tasks(mission, tasks)
            cleanup = cleanup_stale_wakes(mission, current_run_id)

            Enum.each(task_rows(mission.id), fn task ->
              sync_work_item(user_id, mission, task, release: true)
            end)

            refresh!(mission.id) |> Map.merge(cleanup)
          end)

        {:ok, result}
      end
    else
      false -> {:error, "Mission belongs to another coordinator"}
      status when is_binary(status) -> {:error, "Invalid mission status"}
      {:error, _} = error -> error
    end
  rescue
    error -> {:error, Exception.message(error)}
  end

  def claim_wake(mission_id) do
    with {:ok, update} <- refresh(mission_id) do
      tasks = task_rows(mission_id)
      by_id = Map.new(tasks, &{&1.id, &1})

      all_settled =
        tasks != [] and Enum.all?(tasks, &(&1.status in @terminal_task_statuses))

      moving =
        Enum.any?(tasks, fn task ->
          task.status == "running" or
            (task.status == "pending" and not is_nil(task.dispatch_id)) or
            (task.status == "pending" and is_nil(task.dispatch_id) and
               Enum.all?(dependencies(task), &(by_id[&1] && by_id[&1].status == "completed")))
        end)

      stalled = update.mission.status in ~w(attention blocked) and not moving

      if (all_settled or stalled) and update.mission.status in ~w(reviewing attention blocked) do
        if SQL.changes(
             "UPDATE chat_missions SET wake_sent=1,updated_at=datetime('now') WHERE id=? AND wake_sent=0",
             [mission_id]
           ) > 0 do
          mission = mission_row(mission_id)

          {:ok,
           Map.put(
             refresh!(mission_id),
             :coordinatorRegistrationId,
             mission.coordinator_registration_id
           )}
        else
          {:ok, nil}
        end
      else
        {:ok, nil}
      end
    end
  end

  def settle_run(run_id, status, summary) when status in ~w(completed failed canceled) do
    case SQL.one("SELECT #{@task_select} FROM chat_mission_tasks WHERE run_id=? LIMIT 1", [run_id]) do
      nil ->
        {:ok, nil}

      row ->
        task = task_from_row(row)

        result =
          SQL.transaction(fn ->
            unless task.status in @terminal_task_statuses do
              next = if status == "completed", do: "completed", else: status
              cleaned = clean(summary, 4_000)

              SQL.exec(
                "UPDATE chat_mission_tasks SET status=?,summary=?,updated_at=datetime('now') WHERE id=?",
                [next, cleaned, task.id]
              )

              record_event(task.mission_id, %{
                task_id: task.id,
                kind: "task_status_changed",
                title: task.title,
                from_status: task.status,
                to_status: next,
                summary: cleaned,
                run_id: run_id,
                attempt: task.attempt
              })
            end

            mission = mission_row(task.mission_id)
            settled = task_row(task.id)
            sync_work_item(mission.created_by, mission, settled, run_id: run_id, release: true)
            update = refresh!(task.mission_id)
            {:ok, wake} = claim_wake(task.mission_id)
            %{update: wake || update, wake: wake}
          end)

        {:ok, result}
    end
  end

  def refresh(mission_id) do
    case mission_row(mission_id) do
      nil -> {:error, "Mission not found"}
      mission -> {:ok, do_refresh(mission)}
    end
  end

  def root_message(%{channelId: channel_id, createdBy: user_id, rootMessageId: message_id}) do
    case owner_route(user_id, nil, channel_id) do
      {:ok, route} -> Messages.get(route.localChannelId, user_id, message_id)
      error -> error
    end
  end

  @doc "Finds the mission owner's accessible local projection of a canonical source channel."
  def owner_route(user_id, source_vault_id, source_channel_id) do
    case Channel.assert_channel(source_channel_id, user_id) do
      {:ok, route} ->
        {:ok, route}

      _ ->
        source_vault_id =
          source_vault_id ||
            case SQL.one("SELECT vault_id FROM notes WHERE id=?", [source_channel_id]) do
              [vault_id] -> vault_id
              _ -> nil
            end

        if is_binary(source_vault_id) do
          route =
            Channel.list_routes(source_vault_id, source_channel_id)
            |> Enum.find(fn candidate ->
              SQL.one("SELECT created_by FROM vaults WHERE id=?", [candidate.localVaultId]) == [
                user_id
              ]
            end)

          if route, do: {:ok, route}, else: {:error, "Chat channel not found"}
        else
          {:error, "Chat channel not found"}
        end
    end
  end

  defp refresh!(mission_id) do
    case refresh(mission_id) do
      {:ok, update} -> update
      {:error, reason} -> raise reason
    end
  end
end
