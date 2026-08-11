defmodule Cascade.Auth.Session do
  @moduledoc "Bearer/cookie authentication with server-side auth-version revocation."

  import Plug.Conn

  alias Cascade.Auth.{Accounts, Token}

  @secure_cookie "__Host-cascade_session"
  @local_cookie "cascade_session"

  def authenticate(conn) do
    conn = fetch_cookies(conn)

    candidates =
      [bearer_candidate(conn), cookie_candidate(conn)]
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq_by(&elem(&1, 1))

    Enum.find_value(candidates, {:error, :invalid_or_expired}, &verify_candidate/1)
  end

  def cookie_token(conn) do
    conn = fetch_cookies(conn)
    conn.req_cookies[@secure_cookie] || conn.req_cookies[@local_cookie]
  end

  def put_user_cookie(conn, token) do
    name = if Cascade.Config.network_mode?(), do: @secure_cookie, else: @local_cookie

    secure =
      if Cascade.Config.network_mode?(), do: ["Secure", "SameSite=None"], else: ["SameSite=Lax"]

    cookie =
      [
        "#{name}=#{URI.encode_www_form(token)}",
        "Path=/",
        "HttpOnly"
      ] ++
        secure ++
        ["Max-Age=#{Token.user_session_max_age_seconds()}", "Priority=High"]

    put_resp_header(conn, "set-cookie", Enum.join(cookie, "; "))
  end

  def clear_user_cookies(conn) do
    secure = "#{@secure_cookie}=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0"
    local = "#{@local_cookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"

    conn
    |> put_resp_header("set-cookie", secure)
    |> prepend_resp_headers([{"set-cookie", local}])
  end

  def bearer?(conn), do: bearer_candidate(conn) != nil

  defp bearer_candidate(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] when token != "" -> {:bearer, token}
      _ -> nil
    end
  end

  defp cookie_candidate(conn) do
    case cookie_token(conn) do
      nil -> nil
      token -> {:cookie, token}
    end
  end

  defp verify_candidate({source, token}) do
    with {:ok, claims} <- Token.verify(token),
         {:ok, user} <- Accounts.fetch_by_id(claims.id),
         true <- user.username == claims.username,
         true <- user.auth_version == claims.auth_version do
      {:ok, %{source: source, token: token, user: user, access: claims.access}}
    else
      _ -> false
    end
  end
end
