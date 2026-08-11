defmodule Cascade.Missions.Scheduler do
  @moduledoc "Materializes ready mission tasks and one-shot coordinator review wakes into the dispatch outbox."

  alias Cascade.Accounts.SQL
  alias Cascade.Chat.{Events, Messages}
  alias Cascade.Missions.{Dispatches, Store}
  alias Cascade.Realtime.OrderedPublisher

  def schedule(mission_id \\ nil, opts \\ []) do
    OrderedPublisher.mutate(fn -> do_schedule(mission_id, opts) end)
  end

  defp do_schedule(mission_id, opts) do
    result =
      SQL.transaction(fn ->
        scheduled = Store.schedulable(mission_id)
        dispatches = Enum.map(scheduled.candidates, &materialize_candidate!/1)

        affected =
          (Enum.map(scheduled.updates, & &1.mission.id) ++
             Enum.map(scheduled.candidates, & &1.missionId) ++
             if(mission_id, do: [mission_id], else: []))
          |> Enum.uniq()

        wakes =
          Enum.flat_map(affected, fn id ->
            case Store.claim_wake(id) do
              {:ok, nil} -> []
              {:ok, wake} -> [wake]
              _ -> []
            end
          end)

        final_update =
          if mission_id do
            case Store.refresh(mission_id) do
              {:ok, update} -> update
              _ -> nil
            end
          end

        Map.merge(scheduled, %{
          dispatches: dispatches,
          wakes: wakes,
          finalUpdate: final_update
        })
      end)

    events = Keyword.get(opts, :events) || Cascade.Chat.Events.Noop
    Enum.each(result.updates, &emit_projection(&1, events))

    Enum.each(result.dispatches, fn item ->
      emit_message(item.update, "vault:chatMessageCreated", item.message, [item.dispatch], events)
      emit_projection(item.update, events)
    end)

    wake_dispatches =
      Enum.flat_map(result.wakes, fn wake ->
        case materialize_wake(wake, events) do
          {:ok, item} -> [item]
          _ -> []
        end
      end)

    if result.finalUpdate, do: emit_projection(result.finalUpdate, events)
    Map.put(result, :wakeDispatches, wake_dispatches)
  end

  def reannounce_pending(opts \\ []) do
    events = Keyword.get(opts, :events) || Cascade.Chat.Events.Noop

    SQL.all("""
    SELECT t.dispatch_id,m.created_by,m.vault_id,m.channel_id
    FROM chat_mission_tasks t
    JOIN chat_missions m ON m.id=t.mission_id
    JOIN chat_agent_dispatches d ON d.id=t.dispatch_id
    WHERE t.status='pending' AND t.run_id IS NULL
      AND d.run_id IS NULL AND t.dispatch_id IS NOT NULL
    """)
    |> Enum.reduce(0, fn [dispatch_id, user_id, vault_id, channel_id], count ->
      local_channel_id =
        case Store.owner_route(user_id, vault_id, channel_id) do
          {:ok, route} -> route.localChannelId
          _ -> channel_id
        end

      case Dispatches.get(user_id, local_channel_id, dispatch_id) do
        {:ok, dispatch} ->
          Events.emit(events, %{
            event: "vault:chatMessageUpdated",
            vaultId: vault_id,
            channelId: channel_id,
            message: dispatch.message,
            dispatches: [dispatch]
          })

          count + 1

        _ ->
          count
      end
    end)
  end

  def emit_projection(update, events \\ Cascade.Chat.Events.Noop) do
    events = events || Cascade.Chat.Events.Noop

    case Store.root_message(update) do
      {:ok, message} -> emit_message(update, "vault:chatMessageUpdated", message, [], events)
      _ -> :ok
    end
  end

  @doc "Settles a terminal worker run, schedules newly-ready work, and preserves the claimed review wake."
  def settle_run(run_id, status, summary, opts \\ []) do
    with {:ok, settled} <- Store.settle_run(run_id, status, summary) do
      if is_nil(settled) do
        {:ok, nil}
      else
        events = Keyword.get(opts, :events) || Cascade.Chat.Events.Noop
        emit_projection(settled.update, events)
        scheduled = schedule(settled.update.mission.id, events: events)

        wake_dispatch =
          if settled.wake && scheduled.dispatches == [] do
            case enqueue_wake(settled.wake, events: events) do
              {:ok, item} -> item
              _ -> nil
            end
          end

        {:ok, %{settled: settled, scheduled: scheduled, wakeDispatch: wake_dispatch}}
      end
    end
  end

  @doc "Materializes a previously claimed coordinator review wake."
  def enqueue_wake(wake, opts \\ []) do
    OrderedPublisher.mutate(fn ->
      materialize_wake(wake, Keyword.get(opts, :events) || Cascade.Chat.Events.Noop)
    end)
  end

  defp materialize_candidate!(candidate) do
    user = user!(candidate.createdBy)
    {:ok, route} = Store.owner_route(candidate.createdBy, candidate.vaultId, candidate.channelId)

    assignee_mention =
      assignee_mention(
        route.localChannelId,
        candidate.createdBy,
        candidate.assigneeRegistrationId
      )

    message_id =
      if candidate.attempt > 0,
        do: "mission-task-#{candidate.taskId}-#{candidate.attempt}",
        else: "mission-task-#{candidate.taskId}"

    {:ok, message} =
      Messages.create(
        user,
        route.localVaultId,
        route.localChannelId,
        %{
          id: message_id,
          body: "@#{assignee_mention} #{candidate.prompt}",
          createdAt: now(),
          registrationId: candidate.coordinatorRegistrationId,
          missionTaskId: candidate.taskId
        },
        access: :agent
      )

    {:ok, dispatch} =
      Dispatches.create(
        candidate.createdBy,
        route.localChannelId,
        message,
        candidate.assigneeRegistrationId,
        reasoning_effort: candidate.reasoningEffort
      )

    {:ok, update} = Store.link_dispatch(candidate.taskId, dispatch.id)
    %{message: message, dispatch: dispatch, update: update}
  end

  defp materialize_wake(wake, events) do
    suffix = Ecto.UUID.generate() |> String.slice(0, 8)
    carrier_id = "agent-trace-#{wake.mission.id}-#{suffix}"
    message_id = "sys-mission-#{wake.mission.id}-#{suffix}"
    user = user!(wake.createdBy)
    {:ok, route} = Store.owner_route(wake.createdBy, wake.vaultId, wake.channelId)

    task_lines =
      Enum.map(wake.mission.tasks, fn task ->
        line =
          "- #{task.title} — @#{nonblank(task.assigneeMention, task.assignee)}: #{task.status}"

        if task.summary == "", do: line, else: line <> " — " <> String.slice(task.summary, 0, 600)
      end)

    review_state =
      if wake.mission.status == "attention",
        do: "one or more tasks need attention; the mission remains open",
        else: wake.mission.status

    body =
      [
        "@#{wake.mission.coordinatorMention} Mission #{wake.mission.id} (“#{wake.mission.title}”) is ready for your review (#{review_state})."
        | task_lines
      ]
      |> Kernel.++([
        "",
        "Review the evidence, resolve or explain failures, perform any integration and verification still needed, then reply to the user with the outcome. Keep the mission state accurate."
      ])
      |> Enum.join("\n")

    with {:ok, carrier} <-
           Messages.create(
             user,
             route.localVaultId,
             route.localChannelId,
             %{
               id: carrier_id,
               body: "",
               createdAt: now(),
               registrationId: wake.coordinatorRegistrationId
             },
             access: :agent
           ),
         {:ok, message} <-
           Messages.create(
             user,
             route.localVaultId,
             route.localChannelId,
             %{
               id: message_id,
               body: body,
               createdAt: now(),
               registrationId: wake.coordinatorRegistrationId
             },
             access: :agent
           ),
         {:ok, dispatch} <-
           Dispatches.create(
             wake.createdBy,
             route.localChannelId,
             message,
             wake.coordinatorRegistrationId
           ) do
      emit_message(wake, "vault:chatMessageCreated", carrier, [], events)
      emit_message(wake, "vault:chatMessageCreated", message, [dispatch], events)
      {:ok, %{carrier: carrier, message: message, dispatch: dispatch}}
    end
  rescue
    _ -> {:error, "Mission coordinator wake could not be materialized"}
  end

  defp emit_message(update, event, message, dispatches, events) do
    payload = %{
      event: event,
      vaultId: update.vaultId,
      channelId: update.channelId,
      message: message
    }

    payload = if dispatches == [], do: payload, else: Map.put(payload, :dispatches, dispatches)

    if event == "vault:chatMessageCreated",
      do: OrderedPublisher.chat(events, payload),
      else: Events.emit(events, payload)
  end

  defp user!(user_id) do
    case SQL.one("SELECT username FROM users WHERE id=?", [user_id]) do
      [username] -> %{id: user_id, username: username}
      _ -> raise "Mission owner not found"
    end
  end

  defp assignee_mention(channel_id, user_id, registration_id) do
    case Cascade.Chat.Agents.list_members(channel_id, user_id) do
      {:ok, members} ->
        case Enum.find(members, &(&1.id == registration_id)) do
          nil -> "agent"
          member -> nonblank(member.mention, "agent")
        end

      _ ->
        "agent"
    end
  end

  defp now, do: DateTime.utc_now() |> DateTime.to_iso8601()
  defp nonblank(nil, fallback), do: fallback
  defp nonblank("", fallback), do: fallback
  defp nonblank(value, _fallback), do: value
end
