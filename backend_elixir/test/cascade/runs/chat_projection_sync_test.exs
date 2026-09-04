defmodule Cascade.Runs.ChatProjectionSyncTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.Runs.ChatProjection
  alias Cascade.Runs.Store

  setup do
    suffix = System.unique_integer([:positive])
    username = "proj-#{suffix}"
    vault_id = "proj-vault-#{suffix}"

    SQL.exec(
      "INSERT INTO users (username,password_hash,display_name,avatar_url) VALUES (?,?,?,?)",
      [username, "x", username, ""]
    )

    user_id = SQL.last_insert_id()

    SQL.exec("INSERT INTO vaults (id,name,root_path,created_by) VALUES (?,?,?,?)", [
      vault_id,
      "Projection",
      "/tmp/#{vault_id}",
      user_id
    ])

    on_exit(fn ->
      SQL.exec("DELETE FROM vaults WHERE id=?", [vault_id])
      SQL.exec("DELETE FROM users WHERE id=?", [user_id])
    end)

    %{vault_id: vault_id}
  end

  test "live sync matches a full rebuild and recovers from a seq gap", context do
    assert {:ok, run} = Store.start(context.vault_id, nil, "fold incrementally", "codex")

    assert %{type: "text"} =
             Store.publish(run.id, "text", %{
               chatVisible: true,
               message: %{content: "Hel"}
             })

    assert %{type: "harness"} = Store.publish(run.id, "harness", %{data: "trace-"})

    assert %{type: "text"} =
             Store.publish(run.id, "text", %{
               chatVisible: true,
               message: %{content: "lo"}
             })

    expected = ChatProjection.build(Store.events(run.id))
    incremental = ChatProjection.sync(run.id)
    assert incremental.body == expected.body
    assert incremental.harnessLog == expected.harnessLog
    assert incremental.status == expected.status
    assert incremental.body == "Hello"
    assert incremental.harnessLog == "trace-"

    run_id = run.id
    assert [{^run_id, cursor}] = :ets.lookup(:cascade_chat_projection, run_id)
    assert cursor.last_seq >= 3

    :ets.insert(
      :cascade_chat_projection,
      {run.id, %{cursor | last_seq: cursor.last_seq + 10}}
    )

    recovered = ChatProjection.sync(run.id)
    assert recovered.body == expected.body
    assert recovered.harnessLog == expected.harnessLog

    assert %{type: "status"} =
             Store.publish(run.id, "status", %{status: "completed", summary: "Hello"})

    done = ChatProjection.build(Store.events(run.id))
    assert done.body == "Hello"
    assert done.done
    assert :ets.lookup(:cascade_chat_projection, run.id) == []
  end
end
