defmodule Cascade.DB.BusyRecoveryTest do
  use ExUnit.Case, async: false

  alias Cascade.DB.Repo
  alias Cascade.Accounts.SQL, as: AccountsSQL
  alias Ecto.Adapters.SQL
  alias Exqlite.Sqlite3

  setup do
    SQL.query!(
      Repo,
      "CREATE TABLE IF NOT EXISTS busy_recovery_probe (value TEXT PRIMARY KEY)",
      []
    )

    SQL.query!(Repo, "DELETE FROM busy_recovery_probe", [])
    :ok
  end

  test "a transient external write lock waits and commits inside the configured busy timeout" do
    database = Repo.config() |> Keyword.fetch!(:database)
    assert Repo.config() |> Keyword.fetch!(:busy_timeout) == 5_000
    {:ok, lock} = Sqlite3.open(database, mode: [:readwrite])

    try do
      assert :ok = Sqlite3.execute(lock, "BEGIN IMMEDIATE")

      writer =
        Task.async(fn ->
          SQL.query!(Repo, "INSERT INTO busy_recovery_probe(value) VALUES ('after-lock')", [])
        end)

      Process.sleep(150)
      assert Task.yield(writer, 0) == nil
      assert :ok = Sqlite3.execute(lock, "COMMIT")
      assert %Exqlite.Result{num_rows: 1} = Task.await(writer, 2_000)

      assert [["after-lock"]] =
               SQL.query!(Repo, "SELECT value FROM busy_recovery_probe", []).rows
    after
      case Sqlite3.transaction_status(lock) do
        {:ok, :transaction} -> Sqlite3.execute(lock, "ROLLBACK")
        _ -> :ok
      end

      Sqlite3.close(lock)
    end
  end

  test "concurrent wrapper writers serialize without busy failures while reads retain pool access" do
    parent = self()
    release_owner = make_ref()

    owner =
      Task.async(fn ->
        Cascade.DB.WriteCoordinator.with_lock(fn ->
          send(parent, :write_lock_acquired)

          receive do
            ^release_owner -> :ok
          end
        end)
      end)

    assert_receive :write_lock_acquired

    writers =
      for writer <- 1..12 do
        Task.async(fn ->
          AccountsSQL.transaction(fn ->
            for ordinal <- 1..5 do
              AccountsSQL.exec(
                "INSERT INTO busy_recovery_probe(value) VALUES (?)",
                ["writer-#{writer}-#{ordinal}"]
              )

              id = AccountsSQL.last_insert_id()
              expected = "writer-#{writer}-#{ordinal}"

              assert [[^expected]] =
                       AccountsSQL.all(
                         "SELECT value FROM busy_recovery_probe WHERE rowid=?",
                         [id]
                       )

              Process.sleep(2)
            end
          end)
        end)
      end

    wait_until(fn -> Cascade.DB.WriteCoordinator.stats().queue_depth == 12 end)

    assert [[0]] =
             SQL.query!(Repo, "SELECT COUNT(*) FROM busy_recovery_probe", [], timeout: 250).rows

    send(owner.pid, release_owner)
    assert :ok = Task.await(owner, 1_000)
    assert Enum.all?(Task.await_many(writers, 5_000), &(length(&1) == 5))

    assert [[60]] = SQL.query!(Repo, "SELECT COUNT(*) FROM busy_recovery_probe", []).rows
    assert %{locked: false, queue_depth: 0} = Cascade.DB.WriteCoordinator.stats()
  end

  test "mutation-shaped reads fail closed instead of bypassing the writer queue" do
    assert_raise ArgumentError, ~r/write statement/, fn ->
      AccountsSQL.one("INSERT INTO busy_recovery_probe(value) VALUES ('bypass') RETURNING value")
    end

    assert [[0]] = SQL.query!(Repo, "SELECT COUNT(*) FROM busy_recovery_probe", []).rows
  end

  defp wait_until(fun, attempts \\ 100)

  defp wait_until(_fun, 0), do: flunk("condition did not become true")

  defp wait_until(fun, attempts) do
    if fun.() do
      :ok
    else
      Process.sleep(5)
      wait_until(fun, attempts - 1)
    end
  end
end
