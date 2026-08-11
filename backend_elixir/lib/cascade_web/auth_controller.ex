defmodule CascadeWeb.AuthController do
  @moduledoc false

  import Plug.Conn

  alias Cascade.Auth.{Accounts, Password, Session, Token}
  alias CascadeWeb.{Auth, JSON}

  def login(conn) do
    username =
      conn.body_params
      |> Map.get("username", "")
      |> to_string()
      |> String.trim()
      |> String.downcase()

    password = conn.body_params |> Map.get("password", "") |> to_string()

    user =
      case Accounts.fetch_by_username(username) do
        {:ok, account} -> account
        :error -> nil
      end

    if Password.verify_login(password, user && user.password_hash) do
      respond_with_session(conn, user)
    else
      JSON.send(conn, 401, %{error: "Invalid username or password"})
    end
  end

  def session(conn) do
    case Session.authenticate(conn) do
      {:ok, %{access: "user"} = authenticated} ->
        conn
        |> maybe_migrate_bearer(authenticated)
        |> JSON.send(200, %{
          authenticated: true,
          user: Accounts.public_user(authenticated.user),
          owner: Accounts.owner?(authenticated.user.id)
        })

      _ ->
        JSON.send(conn, 200, %{authenticated: false})
    end
  end

  def me(conn) do
    with {:ok, conn} <- Auth.require(conn, access: :user),
         user <- conn.assigns.current_user do
      JSON.send(conn, 200, %{user: Accounts.public_user(user), owner: Accounts.owner?(user.id)})
    else
      {:error, conn} -> conn
    end
  end

  def logout(conn) do
    conn
    |> Session.clear_user_cookies()
    |> JSON.send(200, %{ok: true})
  end

  defp respond_with_session(conn, user) do
    token = Token.sign_user(user)
    browser? = get_req_header(conn, "x-cascade-browser") == ["1"]

    response = %{
      user: Accounts.public_user(user),
      owner: Accounts.owner?(user.id)
    }

    response = if browser?, do: response, else: Map.put(response, :token, token)

    conn
    |> Session.put_user_cookie(token)
    |> JSON.send(200, response)
  end

  defp maybe_migrate_bearer(conn, %{source: :bearer, token: token}) do
    if get_req_header(conn, "x-cascade-session-migrate") == ["1"] do
      Session.put_user_cookie(conn, token)
    else
      conn
    end
  end

  defp maybe_migrate_bearer(conn, _authenticated), do: conn
end
