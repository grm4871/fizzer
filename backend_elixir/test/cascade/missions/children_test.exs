defmodule Cascade.Missions.ChildrenTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Agents, Messages}
  alias Cascade.Content.Store, as: ContentStore
  alias Cascade.Missions.{Dispatches, Scheduler, Store}
  alias Cascade.Missions.Children
  alias Cascade.Runs.Store, as: RunStore

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

  test "parallel children join once, resume their parent with artifacts, and gate completion",
       ctx do
    {mission, parent, run} = parent(ctx)

    {:ok, child} =
      Children.add(
        ctx.user.id,
        ctx.channel.id,
        mission.id,
        %{title: "Piece", prompt: "Implement piece"},
        run.id
      )

    assert child.task.parentTaskId == parent.id
    assert child.task.anonymous
    assert child.task.workspaceMode == "isolated"
    assert child.task.assigneeMention == ctx.worker.mention <> "·sub"
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)

    assert {:error, _} =
             Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{status: "completed"})

    assert {:ok, %{children: [%{id: child_id}]}} =
             Children.join(ctx.user.id, ctx.channel.id, run.id)

    assert child_id == child.task.id
    :ok = RunStore.finish(run.id, "completed", "Independent work done")
    {:ok, waiting} = Scheduler.settle_run(run.id, "completed", "Independent work done")
    assert waiting.scheduled.dispatches == []
    assert waiting.scheduled.wakeDispatches == []
    assert Children.joining?(parent.id)
    assert Store.schedulable(mission.id).candidates == []
    :ok = RunStore.finish(child_run.id, "completed", "Commit abc; focused test passed")

    {:ok, joined} =
      Scheduler.settle_run(child_run.id, "completed", "Commit abc; focused test passed")

    assert [%{dispatch: continuation, message: message}] = joined.scheduled.dispatches
    assert message.missionTaskId == parent.id
    assert message.body =~ "Commit abc"
    assert message.body =~ child.task.branch
    assert message.body =~ "Integrate and verify"
    assert joined.scheduled.wakeDispatches == []
    assert Scheduler.schedule(mission.id).dispatches == []
    assert {:ok, nil} = Store.settle_run(run.id, "completed", "duplicate")
    integrated = start(ctx, continuation)
    :ok = RunStore.finish(integrated.id, "completed", "Integrated and tested")
    {:ok, final} = Scheduler.settle_run(integrated.id, "completed", "Integrated and tested")

    assert final.settled.update.mission.tasks
           |> Enum.find(&(&1.id == parent.id))
           |> Map.get(:status) == "completed"

    assert length(final.scheduled.wakeDispatches) == 1
    assert Scheduler.schedule(mission.id).wakeDispatches == []
  end

  test "authority, one-level depth, stale runs, and fanout are bounded", ctx do
    {mission, parent, run} = parent(ctx)
    input = %{title: "Piece", prompt: "Only this piece"}
    assert {:error, _} = Children.add(ctx.user.id, ctx.channel.id, "elsewhere", input, run.id)
    assert {:error, _} = Children.add(ctx.user.id + 1, ctx.channel.id, mission.id, input, run.id)
    assert {:error, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, input, nil)
    {:ok, child} = Children.add(ctx.user.id, ctx.channel.id, mission.id, input, run.id)
    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)

    assert {:error, _} =
             Children.add(ctx.user.id, ctx.channel.id, mission.id, input, child_run.id)

    assert {:error, _} =
             Children.authorize_update(ctx.user.id, ctx.channel.id, parent.id, child_run.id)

    assert :ok = Children.authorize_update(ctx.user.id, ctx.channel.id, child.task.id, run.id)

    assert {:error, _} =
             Store.add_task(
               ctx.user.id,
               ctx.channel.id,
               mission.id,
               %{
                 coordinatorRegistrationId: ctx.coordinator.id,
                 title: "Escape",
                 assignee: ctx.worker.id
               },
               current_run_id: run.id
             )

    for n <- 2..8 do
      assert {:ok, _} =
               Children.add(
                 ctx.user.id,
                 ctx.channel.id,
                 mission.id,
                 %{title: "Piece #{n}"},
                 run.id
               )
    end

    assert {:error, _} =
             Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Ninth"}, run.id)

    :ok = RunStore.finish(run.id, "completed", "done")
    assert {:error, _} = Children.add(ctx.user.id, ctx.channel.id, mission.id, input, run.id)
  end

  test "parent cancellation propagates to running and queued children", ctx do
    {mission, parent, run} = parent(ctx)

    {:ok, first} =
      Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Running child"}, run.id)

    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)

    {:ok, second} =
      Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Queued child"}, run.id)

    {:ok, update} =
      Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{status: "canceled"})

    assert child_run.id in update.canceledTaskRunIds

    for child <- [first.task, second.task] do
      assert ["canceled"] =
               SQL.one("SELECT status FROM chat_mission_tasks WHERE id=?", [child.id])
    end

    assert Scheduler.schedule(mission.id).dispatches == []
  end

  test "failed results return to parent and cannot be silently completed", ctx do
    {mission, parent, run} = parent(ctx)

    {:ok, _} =
      Children.add(ctx.user.id, ctx.channel.id, mission.id, %{title: "Failing child"}, run.id)

    [%{dispatch: dispatch}] = Scheduler.schedule(mission.id).dispatches
    child_run = start(ctx, dispatch)
    :ok = RunStore.finish(child_run.id, "failed", "Test failed")
    {:ok, result} = Scheduler.settle_run(child_run.id, "failed", "Test failed")
    assert result.scheduled.wakeDispatches == []
    :ok = RunStore.finish(run.id, "completed", "join")
    {:ok, result} = Scheduler.settle_run(run.id, "completed", "join")
    assert [%{dispatch: dispatch}] = result.scheduled.dispatches
    integration = start(ctx, dispatch)

    assert {:error, _} =
             Store.update_task(ctx.user.id, ctx.channel.id, parent.id, %{status: "completed"})

    :ok = RunStore.finish(integration.id, "completed", "Ignored failure")
    {:ok, result} = Scheduler.settle_run(integration.id, "completed", "Ignored failure")

    assert Enum.find(result.settled.update.mission.tasks, &(&1.id == parent.id)).status ==
             "blocked"
  end

  defp parent(ctx) do
    {:ok, created} =
      Store.create(ctx.user.id, ctx.vault.id, ctx.channel.id, %{
        rootMessageId: ctx.root.id,
        coordinatorRegistrationId: ctx.coordinator.id,
        title: "Child lifecycle"
      })

    {:ok, added} =
      Store.add_task(ctx.user.id, ctx.channel.id, created.mission.id, %{
        coordinatorRegistrationId: ctx.coordinator.id,
        assignee: ctx.worker.id,
        title: "Parent"
      })

    [%{dispatch: dispatch}] = Scheduler.schedule(created.mission.id).dispatches
    {created.mission, added.task, start(ctx, dispatch)}
  end

  defp start(ctx, dispatch) do
    {:ok, run} = RunStore.start(ctx.vault.id, nil, "work", "codex", chat_dispatch_id: dispatch.id)
    :ok = Dispatches.attach_run(dispatch.id, run.id)
    {:ok, _} = Store.attach_run(dispatch.id, run.id)
    run
  end
end
