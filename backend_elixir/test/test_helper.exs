System.put_env("JWT_SECRET", "cascade-elixir-tests-use-an-explicit-secret")
ExUnit.start()

defmodule Cascade.TestHelpers do
  import Plug.Conn
  import Plug.Test

  def owner_vault(prefix) do
    alias Cascade.Accounts.SQL

    suffix = System.unique_integer([:positive])
    username = "#{prefix}-#{suffix}"
    vault_id = "#{prefix}-vault-#{suffix}"

    SQL.exec(
      "INSERT INTO users (username,password_hash,display_name,avatar_url) VALUES (?,?,?,?)",
      [username, "x", username, ""]
    )

    user_id = SQL.last_insert_id()

    SQL.exec("INSERT INTO vaults (id,name,root_path,created_by) VALUES (?,?,?,?)", [
      vault_id,
      prefix |> String.replace("-", " ") |> String.capitalize(),
      "/tmp/#{vault_id}",
      user_id
    ])

    SQL.exec(
      "INSERT INTO vault_members (vault_id,user_id,role,invited_by) VALUES (?,?,?,?)",
      [vault_id, user_id, "owner", user_id]
    )

    ExUnit.Callbacks.on_exit(fn ->
      SQL.exec("DELETE FROM vaults WHERE id=?", [vault_id])
      SQL.exec("DELETE FROM users WHERE id=?", [user_id])
    end)

    %{user_id: user_id, username: username, vault_id: vault_id}
  end

  def json_conn(method, path, body \\ nil, token \\ nil) do
    conn =
      if is_nil(body),
        do: conn(method, path),
        else:
          conn(method, path, Jason.encode!(body))
          |> put_req_header("content-type", "application/json")

    if token, do: put_req_header(conn, "authorization", "Bearer #{token}"), else: conn
  end
end
