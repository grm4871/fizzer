defmodule Cascade.Missions.Recovery do
  @moduledoc "Bounded recovery of unfinished coordinator reviews; never retries worker side effects."
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
      SELECT m.id,m.review_attempt,d.run_id,COALESCE(r.status,'unclaimed wake removed'),msg.id
      FROM chat_missions m
      JOIN chat_messages msg ON msg.id=(
        SELECT msg2.id FROM chat_messages msg2
        WHERE msg2.id LIKE 'sys-mission-' || m.id || '-%'
        ORDER BY msg2.rowid DESC LIMIT 1)
      LEFT JOIN chat_agent_dispatches d ON d.message_id=msg.id
      LEFT JOIN runs r ON r.id=d.run_id
      WHERE m.status NOT IN ('completed','canceled') AND m.wake_sent=1
        AND m.review_attempt<=3 AND (r.status IN ('failed','completed') OR d.id IS NULL)
        AND datetime(COALESCE(r.finished_at,msg.created_at))<=datetime('now','-60 seconds')
        AND NOT EXISTS (SELECT 1 FROM chat_mission_tasks t WHERE t.mission_id=m.id AND (t.status='running' OR (t.status='pending' AND t.dispatch_id IS NOT NULL)))
        AND NOT EXISTS (
          SELECT 1 FROM runs active JOIN chat_agent_dispatches ad ON ad.id=active.chat_dispatch_id
          WHERE ad.registration_id=m.coordinator_registration_id AND active.status IN ('queued','running'))
        #{filter}
      """,
      if(mission_id, do: [mission_id], else: [])
    )
    |> Enum.each(fn [id, attempt, run_id, status, message_id] ->
      exhausted = attempt == 3

      summary =
        if exhausted,
          do:
            "Coordinator review recovery stopped after three retries (last run #{run_id}: #{status}). Inspect mission history and existing artifacts, then explicitly add follow-up work or close the mission with verification. No worker actions were automatically retried.",
          else:
            "Recover unfinished coordinator review after run #{run_id} ended #{status}; inspect existing effects before continuing."

      SQL.exec(
        "UPDATE chat_missions SET review_attempt=review_attempt+1,wake_sent=?,summary=?,updated_at=datetime('now') WHERE id=?",
        [if(exhausted, do: 1, else: 0), summary, id]
      )

      SQL.exec(
        "INSERT INTO chat_mission_events (mission_id,kind,summary,run_id,attempt,source_key) VALUES (?,?,?,?,?,?)",
        [
          id,
          if(exhausted, do: "review_recovery_exhausted", else: "review_recovery"),
          summary,
          run_id,
          attempt + 1,
          "review-recovery:#{message_id}"
        ]
      )
    end)
  end
end
