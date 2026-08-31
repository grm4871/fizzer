defmodule CascadeWeb.Auth do
  @moduledoc "Reusable fail-closed authentication boundary for all HTTP domain ports."

  import Plug.Conn

  alias Cascade.Auth.Session
  alias CascadeWeb.{Authorization, JSON}

  def init(options), do: options

  def call(conn, options) do
    case __MODULE__.require(conn, options) do
      {:ok, conn} -> conn
      {:error, conn} -> conn
    end
  end

  @doc """
  Authenticates bearer first, then session cookies, and assigns
  `:current_user`, `:auth_access`, `:auth_source`, and `:auth_token`.

  Mutating controllers must pass `mutation_gate: :not_vault_scoped` or a
  two-argument vault policy function. Omitting it fails closed.
  """
  @spec require(Plug.Conn.t(), keyword()) :: {:ok, Plug.Conn.t()} | {:error, Plug.Conn.t()}
  def require(conn, options \\ []) do
    required_access = Keyword.get(options, :access, :any)

    with {:ok, session} <- Session.authenticate(conn),
         :ok <- authorize_access(session, required_access, conn),
         :ok <- authorize_mutation(session, conn, Keyword.get(options, :mutation_gate)) do
      conn =
        conn
        |> assign(:current_user, session.user)
        |> assign(:auth_access, session.access)
        |> assign(:auth_source, session.source)
        |> assign(:auth_token, session.token)
        |> Session.maybe_renew_user_cookie(session)
        |> maybe_migrate_bearer(session)
        |> maybe_register_agent_redaction(session)

      {:ok, conn}
    else
      {:error, :invalid_or_expired} -> reject(conn, 401, "Invalid or expired token")
      {:error, status, message} -> reject(conn, status, message)
    end
  end

  defp authorize_access(%{access: "agent"}, :user, _conn),
    do: {:error, 403, "This operation requires user access"}

  defp authorize_access(%{access: "user"}, :agent, _conn),
    do: {:error, 403, "This operation requires agent access"}

  defp authorize_access(%{access: "agent"}, _required, conn) do
    if Authorization.agent_route_allowed?(conn.method, conn.request_path) do
      :ok
    else
      {:error, 403, "This operation requires user access"}
    end
  end

  defp authorize_access(_session, _required, _conn), do: :ok

  defp authorize_mutation(session, conn, mutation_gate) do
    if Authorization.mutation?(conn.method) do
      Authorization.authorize_mutation(session, conn, mutation_gate)
    else
      :ok
    end
  end

  defp maybe_migrate_bearer(conn, %{source: :bearer, access: "user", token: token}) do
    if get_req_header(conn, "x-cascade-session-migrate") == ["1"] do
      Session.put_user_cookie(conn, token)
    else
      conn
    end
  end

  defp maybe_migrate_bearer(conn, _session), do: conn

  defp maybe_register_agent_redaction(conn, %{access: "agent"}) do
    register_before_send(conn, fn response ->
      case get_resp_header(response, "content-type") do
        ["application/json" <> _parameters] -> redact_json_response(response)
        _ -> response
      end
    end)
  end

  defp maybe_register_agent_redaction(conn, _session), do: conn

  defp redact_json_response(%Plug.Conn{resp_body: body} = conn) when is_binary(body) do
    with {:ok, decoded} <- Jason.decode(body),
         {:ok, encoded} <- Jason.encode(Authorization.sanitize_agent_json(decoded)) do
      conn
      |> delete_resp_header("content-length")
      |> Map.put(:resp_body, encoded)
    else
      _ -> conn
    end
  end

  defp redact_json_response(conn), do: conn

  defp reject(conn, status, message) do
    conn = conn |> JSON.send(status, %{error: message}) |> halt()
    {:error, conn}
  end
end
