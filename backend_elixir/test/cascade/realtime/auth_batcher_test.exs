defmodule Cascade.Realtime.AuthBatcherTest do
  use ExUnit.Case, async: false

  alias Cascade.Realtime.AuthBatcher

  test "returns current user rows and does not cache auth versions" do
    user = insert_user("batch_auth_#{System.unique_integer([:positive])}")
    assert {:ok, %{id: id, auth_version: 0}} = AuthBatcher.fetch_by_id(user.id)
    assert id == user.id

    Cascade.Accounts.SQL.exec("UPDATE users SET auth_version=auth_version+1 WHERE id=?", [user.id])

    assert {:ok, %{auth_version: 1}} = AuthBatcher.fetch_by_id(user.id)
  end

  test "coalesces concurrent callers and preserves missing-user results" do
    user = insert_user("batch_wave_#{System.unique_integer([:positive])}")

    tasks =
      for _ <- 1..50 do
        Task.async(fn -> AuthBatcher.fetch_by_id(user.id) end)
      end

    assert Enum.all?(Task.await_many(tasks), fn
             {:ok, %{id: id}} -> id == user.id
             _ -> false
           end)

    assert :error = AuthBatcher.fetch_by_id(9_000_000_000)
  end

  defp insert_user(username) do
    Cascade.Accounts.SQL.exec(
      "INSERT INTO users(username,password_hash) VALUES(?,?)",
      [username, "not-a-login-hash"]
    )

    {:ok, user} = Cascade.Auth.Accounts.fetch_by_username(username)
    user
  end
end
