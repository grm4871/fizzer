defmodule Cascade.Missions.Recovery do
  @moduledoc "Reconciles missed settlement and wakes reviews only for changed evidence or a missing outbox entry."
  alias Cascade.Accounts.SQL

  # The scheduler holds the publisher lock and database transaction. A new
  # generation is allocated only after the previous review has terminated.
  def reconcile(mission_id) do
    filter = if mission_id, do: " AND m.id=?", else: ""

    SQL.all(
      """
      SELECT t.dispatch_id,r.id,r.status,COALESCE(r.summary,'')
      FROM chat_mission_tasks t JOIN chat_missions m ON m.id=t.mission_id
      JOIN chat_agent_dispatches d ON d.id=t.dispatch_id
      JOIN runs r ON r.chat_dispatch_id=d.id AND r.id=COALESCE(t.run_id,d.run_id)
      WHERE m.status NOT IN ('completed','canceled') AND t.status IN ('pending','running')
        AND r.status IN ('completed','failed','canceled') #{filter}
      """,
      if(mission_id, do: [mission_id], else: [])
    )
    |> Enum.each(fn [dispatch_id, run_id, status, summary] ->
      {:ok, _} = Cascade.Missions.Store.attach_run(dispatch_id, run_id)
      {:ok, _} = Cascade.Missions.Store.settle_run(run_id, status, summary)
    end)

    SQL.all(
      """
      SELECT m.id,m.review_fingerprint,d.run_id,r.status,msg.id,d.id
      FROM chat_missions m
      JOIN chat_messages msg ON msg.id=(
        SELECT msg2.id FROM chat_messages msg2
        WHERE msg2.id LIKE 'sys-mission-' || m.id || '-%'
        ORDER BY msg2.rowid DESC LIMIT 1)
      LEFT JOIN chat_agent_dispatches d ON d.message_id=msg.id
      LEFT JOIN runs r ON r.id=d.run_id
      WHERE m.status NOT IN ('completed','canceled') AND m.wake_sent=1
        AND (r.status IN ('failed','completed') OR d.id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM runs active JOIN chat_agent_dispatches ad ON ad.id=active.chat_dispatch_id
          WHERE ad.registration_id=m.coordinator_registration_id AND active.status IN ('queued','running'))
        #{filter}
      """,
      if(mission_id, do: [mission_id], else: [])
    )
    |> Enum.each(fn [id, previous, _run_id, _status, _message_id, dispatch_id] ->
      current = Cascade.Missions.Store.review_fingerprint(id)
      # Adopt the current state for legacy wakes. Deployment itself is not a
      # reason to repeat an already consumed review. Missing outbox entries
      # replay the same deterministic message, not a new recovery generation.
      cond do
        previous == "" and not is_nil(dispatch_id) ->
          SQL.exec("UPDATE chat_missions SET review_fingerprint=? WHERE id=?", [current, id])

        is_nil(dispatch_id) or previous != current ->
          SQL.exec("UPDATE chat_missions SET wake_sent=0 WHERE id=?", [id])

        true ->
          :ok
      end
    end)
  end

  # Retry provider cancellation after crashes/disconnects, outside SQL locks.
  def replay_cancellations(cancel \\ &cancel_run/2, mission_id \\ nil) do
    filter = if mission_id, do: " AND m.id=?", else: ""

    SQL.all(
      """
      SELECT r.id,m.created_by FROM chat_mission_tasks t
      JOIN chat_missions m ON m.id=t.mission_id JOIN runs r ON r.id=t.run_id
      WHERE t.status='canceled' AND r.status IN ('queued','running') #{filter}
      """,
      if(mission_id, do: [mission_id], else: [])
    )
    |> Enum.each(fn [run, user] ->
      if cancel.(user, run) do
        Cascade.Runs.Store.finish(run, "canceled", "Mission task canceled.")

        Cascade.Runs.Store.publish(run, "status", %{
          status: "canceled",
          summary: "Mission task canceled."
        })
      end
    end)
  end

  defp cancel_run(user, run), do: Cascade.Runs.RunnerLifecycle.cancel(user, run, 2_000)
end
