defmodule CascadeWeb.OrchestrationHTTP do
  @moduledoc "Shared orchestration HTTP authentication, vault ownership, response, body, and identifier helpers."

  alias Cascade.Accounts.VaultMembers
  alias Cascade.Auth.Session
  alias CascadeWeb.JSON

  def authenticated(conn, callback) do
    case Session.authenticate(conn) do
      {:ok, auth} -> callback.(conn, auth.user)
      _ -> JSON.send(conn, 401, %{error: "Invalid or expired token"})
    end
  end

  def with_vault(conn, vault_id, user_id, callback) do
    if VaultMembers.accessible_vault(vault_id, user_id),
      do: callback.(),
      else: JSON.send(conn, 404, %{error: "Vault not found"})
  end

  def respond(conn, {:ok, value}, status, key, _error_status), do: JSON.send(conn, status, %{key => value})
  def respond(conn, {:error, message}, _status, _key, error_status), do: JSON.send(conn, error_status, %{error: message})
  def respond(conn, result, status, key), do: respond(conn, result, status, key, 400)

  def maybe_option(options, _key, value) when value in [nil, ""], do: options
  def maybe_option(options, key, value), do: Keyword.put(options, key, value)

  def parse_id(value) when is_binary(value) do
    case Integer.parse(value) do
      {id, ""} when id > 0 -> id
      _ -> nil
    end
  end
  def parse_id(value) when is_integer(value) and value > 0, do: value
  def parse_id(_), do: nil

  def body(%Plug.Conn{body_params: %Plug.Conn.Unfetched{}}), do: %{}
  def body(conn) when is_map(conn.body_params), do: conn.body_params
  def body(_), do: %{}

  def blank_nil(value) when value in [nil, ""], do: nil
  def blank_nil(value), do: value
end
