defmodule Cascade.Missions.MissionStateTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Channel, Messages, Schema}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.{Dispatches, Scheduler, Store}
  alias Cascade.Missions.Schema, as: MissionSchema
  alias Cascade.Runs.Store, as: RunStore
  alias Cascade.Runs.Schema, as: RunSchema

  setup do
    suffix = System.unique_integer([:positive])
    user_id = suffix + 500_000
    username = "mission_owner_#{suffix}"

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [user_id, username, "x", username]
    )

    vault = ContentStore.create_vault(user_id, %{name: "Mission #{suffix}"})

    channel =
      ContentStore.create_note(vault.id, user_id, %{
        title: "Mission room",
        content: "cascade://chat-channel"
      })

    Schema.ensure!()
    RunSchema.ensure!()
    MissionSchema.ensure!()

    {:ok, coordinator_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Sol",
        mention: "sol-#{suffix}",
        model: "gpt-5.6-sol"
      })

    {:ok, coordinator} =
      Agents.add_to_channel(user_id, vault.id, channel.id, coordinator_identity.id, %{
        orchestrator: true
      })

    {:ok, worker_identity} =
      Agents.upsert_identity(user_id, vault.id, %{
        agentId: "codex",
        displayName: "Terra",
        mention: "terra-#{suffix}",
        model: "gpt-5.6-terra"
      })

    {:ok, worker} =
      Agents.add_to_channel(user_id, vault.id, channel.id, worker_identity.id)

    user = %{id: user_id, username: username}

    {:ok, root} =
      Messages.create(user, vault.id, channel.id, %{
        id: "mission-root-#{suffix}",
        body: "Build and verify the native mission scheduler.",
        createdAt: "2026-08-10T12:00:00.000Z"
      })

    %{
      user: user,
      vault: vault,
      channel: channel,
      root: root,
      coordinator: coordinator,
      worker: worker,
      suffix: suffix
    }
  end

  test "dependency DAG, priority, occupancy, retries, history, and review wake are durable",
       ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Native scheduler"
      })

    {:ok, first} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Implement",
        assignee: ctx.worker.id,
        prompt: "Implement the native state machine.",
        priority: 20,
        reasoningEffort: "high"
      })

    {:ok, second} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Verify",
        assignee: ctx.worker.id,
        prompt: "Verify the native state machine.",
        dependsOn: [first.task.id],
        reasoningEffort: "low"
      })

    assert first.task.workItemId
    assert first.task.workspaceMode == "isolated"
    assert String.starts_with?(first.task.branch, "cascade/")
    assert second.task.waitingFor == [first.task.id]

    assert [candidate] = Store.schedulable(created.mission.id).candidates
    assert candidate.taskId == first.task.id
    assert candidate.reasoningEffort == "high"

    scheduled = Scheduler.schedule(created.mission.id)
    assert [%{dispatch: dispatch, message: message}] = scheduled.dispatches
    assert message.missionTaskId == first.task.id
    assert dispatch.reasoningEffort == "high"
    assert Store.schedulable(created.mission.id).candidates == []

    :ok = Dispatches.attach_run(dispatch.id, 900_000 + ctx.suffix)
    {:ok, running} = Store.attach_run(dispatch.id, 900_000 + ctx.suffix)
    assert hd(running.mission.tasks).status == "running"

    {:ok, settled} =
      Store.settle_run(900_000 + ctx.suffix, "failed", "Transient worker failure.")

    assert settled.update.mission.status == "attention"
    assert Enum.at(settled.update.mission.tasks, 1).status == "pending"
    assert Enum.at(settled.update.mission.tasks, 1).queueReason == "dependency-attention"
    assert settled.wake.coordinatorRegistrationId == ctx.coordinator.id
    assert {:ok, nil} == Store.claim_wake(created.mission.id)

    {:ok, retried} =
      Store.update_task(ctx.user.id, ctx.channel.id, first.task.id, %{
        status: "pending",
        summary: "Retry after transient failure."
      })

    retried_first = Enum.find(retried.mission.tasks, &(&1.id == first.task.id))
    assert retried.mission.status == "active"
    assert retried_first.attempt == 1
    assert [retry] = Store.schedulable(created.mission.id).candidates
    assert retry.taskId == first.task.id
    assert retry.attempt == 1

    {:ok, events} = Store.events(ctx.user.id, ctx.channel.id, created.mission.id)
    assert Enum.any?(events, &(&1.kind == "task_retried" and &1.taskId == first.task.id))
  end

  test "mission and task retries are idempotent while conflicting task options fail closed",
       ctx do
    input = %{
      rootMessageId: ctx.root.id,
      coordinatorRegistrationId: ctx.coordinator.id,
      title: "Durable work"
    }

    assert {:ok, first_mission} = Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, input)

    assert {:ok, retried_mission} =
             Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{input | title: "Changed"})

    assert retried_mission.mission.id == first_mission.mission.id
    assert retried_mission.mission.title == "Durable work"

    task_input = %{
      coordinatorRegistrationId: ctx.coordinator.id,
      title: "One assignment",
      assignee: ctx.worker.id,
      prompt: "Do it"
    }

    assert {:ok, first_task} =
             Store.add_task(ctx.user.id, ctx.channel.id, first_mission.mission.id, task_input)

    assert {:ok, retried_task} =
             Store.add_task(ctx.user.id, ctx.channel.id, first_mission.mission.id, task_input)

    assert retried_task.task.id == first_task.task.id
    assert length(retried_task.update.mission.tasks) == 1

    assert {:error, error} =
             Store.add_task(ctx.user.id, ctx.channel.id, first_mission.mission.id, %{
               task_input
               | prompt: "Different"
             })

    assert error =~ "different scheduling options"
  end

  test "refresh preserves semantically identical historical mission JSON bytes but writes real changes",
       ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Stable projection"
      })

    [encoded] =
      SQL.one("SELECT mission_json FROM chat_messages WHERE id=?", [ctx.root.id])

    historical = " \n" <> encoded <> "\n"
    SQL.exec("UPDATE chat_messages SET mission_json=? WHERE id=?", [historical, ctx.root.id])

    assert {:ok, _update} = Store.refresh(created.mission.id)

    assert [^historical] =
             SQL.one("SELECT mission_json FROM chat_messages WHERE id=?", [ctx.root.id])

    assert {:ok, _added} =
             Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               title: "Material projection change",
               assignee: ctx.worker.id
             })

    [changed] = SQL.one("SELECT mission_json FROM chat_messages WHERE id=?", [ctx.root.id])
    refute changed == historical
    assert {:ok, projection} = Jason.decode(changed)
    assert Enum.any?(projection["tasks"], &(&1["title"] == "Material projection change"))
  end

  test "legacy worker evidence repair chooses the first task row for a shared run", ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Deterministic repair"
      })

    run_id = 8_000_000 + ctx.suffix
    first_id = "repair-first-#{ctx.suffix}"
    second_id = "repair-second-#{ctx.suffix}"

    SQL.exec(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,run_id) VALUES(?,?,?,?,?)",
      [first_id, created.mission.id, "First", ctx.worker.id, run_id]
    )

    SQL.exec(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,run_id) VALUES(?,?,?,?,?)",
      [second_id, created.mission.id, "Second", ctx.worker.id, run_id]
    )

    SQL.exec("UPDATE chat_messages SET run_id=?,mission_task_id=NULL WHERE id=?", [
      run_id,
      ctx.root.id
    ])

    MissionSchema.ensure!()

    assert [^first_id] =
             SQL.one("SELECT mission_task_id FROM chat_messages WHERE id=?", [ctx.root.id])
  end

  test "a terminal runner event settles its mission task and materializes the review wake", ctx do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Runner settlement"
      })

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Finish from runner",
        assignee: ctx.worker.id
      })

    assert {:ok, _bound} =
             Cascade.WorkItems.bind_workspace(ctx.user.id, added.task.workItemId, %{
               repository: "/repo/#{ctx.suffix}",
               baseCommit: String.duplicate("a", 40),
               branch: added.task.branch,
               worktreePath: "/work/#{ctx.suffix}"
             })

    scheduled = Scheduler.schedule(created.mission.id)
    assert [%{dispatch: dispatch}] = scheduled.dispatches

    assert {:ok, run} =
             RunStore.start(ctx.vault.id, nil, "mission worker", "codex",
               conversation_id: "mission-worker-session",
               chat_dispatch_id: dispatch.id
             )

    assert :ok = Dispatches.attach_run(dispatch.id, run.id)
    assert {:ok, _running} = Store.attach_run(dispatch.id, run.id)
    assert :ok = RunStore.record_delegated(run.id, ctx.user.id)
    assert is_nil(RunStore.find_open_for_chat_registration(ctx.worker.id))

    assert {:ok, []} =
             Cascade.Realtime.DomainAdapter.handle_event(
               "/runners",
               "runner:runEvent",
               [
                 %{
                   runId: run.id,
                   type: "status",
                   payload: %{status: "completed", summary: "Worker evidence is complete."}
                 }
               ],
               %{id: ctx.user.id},
               %{}
             )

    assert {:ok, update} = Store.get(ctx.user.id, ctx.channel.id, created.mission.id)
    assert [settled_task] = update.mission.tasks
    assert settled_task.status == "completed"
    assert settled_task.summary == "Worker evidence is complete."
    assert update.mission.status == "reviewing"
    assert RunStore.get(run.id).status == "completed"

    assert {:ok, pending} = Dispatches.list_pending(ctx.user.id, ctx.channel.id)

    assert Enum.any?(
             pending,
             &String.starts_with?(&1.messageId, "sys-mission-#{created.mission.id}-")
           )
  end

  test "two anonymous missions run concurrently and wake only from bound worker evidence", ctx do
    {:ok, second_root} =
      Messages.create(ctx.user, ctx.vault.id, ctx.channel.id, %{
        id: "parallel-root-#{ctx.suffix}",
        body: "Run independently.",
        createdAt: "2026-08-10T12:01:00.000Z"
      })

    {:ok, first_mission} = mission(ctx, "Parallel A")

    {:ok, second_mission} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: second_root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Parallel B"
      })

    task_input = fn title ->
      %{
        coordinatorRegistrationId: ctx.coordinator.id,
        title: title,
        assignee: ctx.coordinator.id,
        anonymous: true
      }
    end

    {:ok, first} =
      Store.add_task(
        ctx.user.id,
        ctx.channel.id,
        first_mission.mission.id,
        task_input.("Worker A")
      )

    {:ok, second} =
      Store.add_task(
        ctx.user.id,
        ctx.channel.id,
        second_mission.mission.id,
        task_input.("Worker B")
      )

    scheduled = Scheduler.schedule()
    dispatch_by_task = Map.new(scheduled.dispatches, &{&1.message.missionTaskId, &1.dispatch})
    assert Map.has_key?(dispatch_by_task, first.task.id)
    assert Map.has_key?(dispatch_by_task, second.task.id)

    runs =
      for task <- [first.task, second.task] do
        assert {:ok, _bound} =
                 Cascade.WorkItems.bind_workspace(ctx.user.id, task.workItemId, %{
                   repository: "/repo/#{ctx.suffix}",
                   baseCommit: String.duplicate("b", 40),
                   branch: task.branch,
                   worktreePath: "/work/#{task.id}"
                 })

        dispatch = Map.fetch!(dispatch_by_task, task.id)

        assert {:ok, run} =
                 RunStore.start(ctx.vault.id, nil, task.title, "codex",
                   conversation_id: "parallel-#{task.id}",
                   chat_dispatch_id: dispatch.id
                 )

        assert :ok = Dispatches.attach_run(dispatch.id, run.id)
        assert {:ok, running} = Store.attach_run(dispatch.id, run.id)
        assert Enum.find(running.mission.tasks, &(&1.id == task.id)).status == "running"
        {task, run}
      end

    [{first_task, first_run}, {second_task, second_run}] = runs
    assert :ok = RunStore.finish(first_run.id, "completed", "Evidence A")
    assert {:ok, first_done} = Scheduler.settle_run(first_run.id, "completed", "Evidence A")
    assert first_done.settled.update.mission.status == "reviewing"

    assert {:ok, still_running} =
             Store.get(ctx.user.id, ctx.channel.id, second_mission.mission.id)

    assert Enum.find(still_running.mission.tasks, &(&1.id == second_task.id)).status == "running"
    assert still_running.mission.status == "active"

    assert :ok = RunStore.finish(second_run.id, "completed", "Evidence B")
    assert {:ok, second_done} = Scheduler.settle_run(second_run.id, "completed", "Evidence B")
    assert second_done.settled.update.mission.status == "reviewing"
    assert second_done.wakeDispatch.dispatch.runId == nil

    for {task, _run} <- [{first_task, first_run}, {second_task, second_run}] do
      {:ok, update} =
        Store.get(
          ctx.user.id,
          ctx.channel.id,
          if(task.id == first_task.id,
            do: first_mission.mission.id,
            else: second_mission.mission.id
          )
        )

      [projected] = update.mission.tasks
      assert projected.baseCommit == String.duplicate("b", 40)
      assert projected.verification in ["Evidence A", "Evidence B"]
    end
  end

  test "manual completion without a bound worker run cannot enter review or finish", ctx do
    {:ok, created} = mission(ctx, "No borrowed evidence")
    {:ok, added} = task(ctx, created.mission.id, "Pending worker")

    assert {:ok, updated} =
             Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{
               status: "completed",
               summary: "Unrelated preexisting commit deadbeef"
             })

    assert updated.mission.status == "attention"

    assert {:error, "Mission has no completed worker evidence"} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               summary: "Looks done"
             })
  end

  test "canceling every task closes the mission without manufacturing completion evidence", ctx do
    {:ok, created} = mission(ctx, "Canceled without evidence")
    {:ok, added} = task(ctx, created.mission.id, "Never ran")

    assert {:ok, update} =
             Store.update_task(ctx.user.id, ctx.channel.id, added.task.id, %{status: "canceled"})

    assert update.mission.status == "attention"

    assert {:ok, closed} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               summary: "Nothing ran"
             })

    assert closed.mission.status == "canceled"
    assert closed.mission.summary == "Nothing ran"
  end

  test "completion cannot cover active work and cancellation removes pending dispatches", ctx do
    {:ok, created} = mission(ctx, "Cancelable")
    {:ok, added} = task(ctx, created.mission.id, "Pending task")
    scheduled = Scheduler.schedule(created.mission.id)
    assert length(scheduled.dispatches) == 1
    assert {:ok, [_]} = Dispatches.list_pending(ctx.user.id, ctx.channel.id)

    assert {:error, "Mission still has active workers"} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "completed",
               summary: "Too soon"
             })

    assert {:ok, canceled} =
             Store.finish(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               status: "canceled",
               summary: "No longer needed"
             })

    assert canceled.mission.status == "canceled"
    assert hd(canceled.mission.tasks).status == "canceled"
    assert {:ok, []} == Dispatches.list_pending(ctx.user.id, ctx.channel.id)

    assert {:error, "Mission is already closed"} =
             Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
               coordinatorRegistrationId: ctx.coordinator.id,
               title: "Too late",
               assignee: ctx.worker.id
             })

    assert added.task.id
  end

  test "a linked-channel participant cannot create source-vault work without write authority",
       ctx do
    guest_id = ctx.user.id + 100_000
    guest_name = "mission_guest_#{ctx.suffix}"

    SQL.exec(
      "INSERT INTO users(id,username,password_hash,display_name,avatar_url,auth_version) VALUES(?,?,?,?,'',0)",
      [guest_id, guest_name, "x", guest_name]
    )

    guest_vault = ContentStore.create_vault(guest_id, %{name: "Guest mission"})

    guest_channel =
      ContentStore.create_note(guest_vault.id, guest_id, %{
        title: "Linked mission room",
        content: "cascade://chat-channel"
      })

    assert {:ok, _route} =
             Channel.link(
               ctx.vault.id,
               ctx.channel.id,
               guest_vault.id,
               guest_channel.id,
               ctx.user.id
             )

    {:ok, guest_coordinator_identity} =
      Agents.upsert_identity(guest_id, guest_vault.id, %{
        agentId: "codex",
        displayName: "Guest Sol",
        mention: "guest-sol-#{ctx.suffix}"
      })

    {:ok, guest_coordinator} =
      Agents.add_to_channel(
        guest_id,
        guest_vault.id,
        guest_channel.id,
        guest_coordinator_identity.id,
        %{orchestrator: true}
      )

    {:ok, guest_worker_identity} =
      Agents.upsert_identity(guest_id, guest_vault.id, %{
        agentId: "codex",
        displayName: "Guest Terra",
        mention: "guest-terra-#{ctx.suffix}"
      })

    {:ok, guest_worker} =
      Agents.add_to_channel(
        guest_id,
        guest_vault.id,
        guest_channel.id,
        guest_worker_identity.id
      )

    guest = %{id: guest_id, username: guest_name}

    {:ok, root} =
      Messages.create(guest, guest_vault.id, guest_channel.id, %{
        id: "guest-mission-root-#{ctx.suffix}",
        body: "Run my own agent through the linked channel."
      })

    {:ok, created} =
      Store.create(guest_id, guest_vault.id, guest_channel.id, %{
        rootMessageId: root.id,
        coordinatorRegistrationId: guest_coordinator.id,
        title: "Guest-owned mission"
      })

    assert created.mission.coordinator == "Guest Sol"

    assert {:error, "Vault not writable"} =
             Store.add_task(guest_id, guest_channel.id, created.mission.id, %{
               coordinatorRegistrationId: guest_coordinator.id,
               title: "Guest work",
               assignee: guest_worker.id
             })
  end

  test "schema creates every table and index with one-statement execution and upgrades legacy rows",
       ctx do
    for table <- ~w(chat_mission_events chat_mission_tasks chat_missions chat_agent_dispatches) do
      SQL.exec("DROP TABLE IF EXISTS #{table}")
    end

    SQL.exec("""
    CREATE TABLE chat_agent_dispatches (
      id TEXT PRIMARY KEY,message_id TEXT NOT NULL,channel_id TEXT NOT NULL,
      registration_id TEXT NOT NULL,run_id INTEGER,created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(message_id,registration_id)
    )
    """)

    SQL.exec("""
    CREATE TABLE chat_missions (
      id TEXT PRIMARY KEY,vault_id TEXT NOT NULL,channel_id TEXT NOT NULL,root_message_id TEXT NOT NULL,
      coordinator_registration_id TEXT NOT NULL,title TEXT NOT NULL,objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',summary TEXT NOT NULL DEFAULT '',wake_sent INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(channel_id,root_message_id)
    )
    """)

    SQL.exec("""
    CREATE TABLE chat_mission_tasks (
      id TEXT PRIMARY KEY,mission_id TEXT NOT NULL,title TEXT NOT NULL,
      assignee_registration_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
      summary TEXT NOT NULL DEFAULT '',dispatch_id TEXT,run_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """)

    SQL.exec(
      "INSERT INTO chat_missions(id,vault_id,channel_id,root_message_id,coordinator_registration_id,title,status,created_by) VALUES('legacy-mission',?,?,?,?,?,'blocked',?)",
      [ctx.vault.id, ctx.channel.id, ctx.root.id, ctx.coordinator.id, "Legacy", ctx.user.id]
    )

    SQL.exec(
      "INSERT INTO chat_mission_tasks(id,mission_id,title,assignee_registration_id,status,summary) VALUES('legacy-task','legacy-mission','Child',?,'blocked','Dependency “Parent” ended failed.')",
      [ctx.worker.id]
    )

    assert :ok == MissionSchema.ensure!()

    assert Enum.sort(SQL.columns("chat_mission_tasks")) |> Enum.member?("depends_on_json")
    assert "reasoning_effort" in SQL.columns("chat_agent_dispatches")

    for object <-
          ~w(chat_agent_dispatches_pending_idx chat_missions_channel_idx chat_mission_tasks_mission_idx chat_mission_tasks_dispatch_idx chat_mission_tasks_run_idx chat_mission_events_mission_idx) do
      assert SQL.one("SELECT 1 FROM sqlite_master WHERE name=?", [object]) == [1]
    end

    assert SQL.one("SELECT status,summary FROM chat_mission_tasks WHERE id='legacy-task'") == [
             "pending",
             ""
           ]

    assert SQL.one("SELECT status FROM chat_missions WHERE id='legacy-mission'") == ["active"]

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id='legacy-mission'")
           |> hd() >= 2

    before = SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id='legacy-mission'")
    assert :ok == MissionSchema.ensure!()

    assert SQL.one("SELECT COUNT(*) FROM chat_mission_events WHERE mission_id='legacy-mission'") ==
             before
  end

  defp mission(ctx, title) do
    Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
      rootMessageId: ctx.root.id,
      coordinatorRegistrationId: ctx.coordinator.id,
      title: title
    })
  end

  defp task(ctx, mission_id, title) do
    Store.add_task(ctx.user.id, ctx.channel.id, mission_id, %{
      coordinatorRegistrationId: ctx.coordinator.id,
      title: title,
      assignee: ctx.worker.id
    })
  end
end
