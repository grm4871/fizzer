defmodule CascadeWeb.SocketIOPlug do
  @moduledoc "Engine.IO v4 / Socket.IO v5 compatibility endpoint at `/socket.io/`."
  @behaviour Plug

  import Plug.Conn

  alias Cascade.Auth.Session, as: AuthSession
  alias Cascade.Realtime.Session

  @max_payload 1_000_000

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, opts) do
    conn = fetch_query_params(conn)

    cond do
      conn.query_params["EIO"] != "4" ->
        engine_error(conn, 5, "Unsupported protocol version")

      conn.query_params["transport"] not in ["polling", "websocket"] ->
        engine_error(conn, 0, "Transport unknown")

      conn.query_params["transport"] == "websocket" ->
        websocket(conn, opts)

      conn.method == "GET" ->
        polling_get(conn, opts)

      conn.method == "POST" ->
        polling_post(conn)

      true ->
        engine_error(conn, 2, "Bad handshake method")
    end
  end

  defp polling_get(conn, opts) do
    with {:ok, sid} <- ensure_polling_session(conn, opts),
         {:ok, payload} <- Session.poll(sid) do
      text(conn, 200, payload)
    else
      {:error, :capacity} -> engine_error(conn, 4, "Server capacity reached", 503)
      {:error, :overlapping_poll} -> engine_error(conn, 3, "Bad request")
      {:error, _reason} -> engine_error(conn, 1, "Session ID unknown")
    end
  end

  defp polling_post(conn) do
    sid = conn.query_params["sid"]

    with sid when is_binary(sid) and sid != "" <- sid,
         {:ok, body, conn} <- read_bounded_body(conn),
         :ok <- Session.receive_payload(sid, body) do
      text(conn, 200, "ok")
    else
      nil -> engine_error(conn, 1, "Session ID unknown")
      "" -> engine_error(conn, 1, "Session ID unknown")
      {:error, :payload_too_large, conn} -> engine_error(conn, 3, "Payload too large", 413)
      {:error, :unknown_sid} -> engine_error(conn, 1, "Session ID unknown")
      {:error, _reason} -> engine_error(conn, 3, "Bad request")
    end
  end

  defp websocket(%{method: "GET"} = conn, opts) do
    sid = conn.query_params["sid"]

    with {:ok, sid, mode} <- ensure_websocket_session(conn, sid, opts) do
      state = %{sid: sid, mode: mode}

      conn
      |> put_resp_header("cache-control", "no-store")
      |> upgrade_adapter(
        :websocket,
        {Cascade.Realtime.WebSocket, state,
         [compress: false, max_frame_size: @max_payload, timeout: 90_000]}
      )
      |> halt()
    else
      {:error, :capacity} -> engine_error(conn, 4, "Server capacity reached", 503)
      {:error, _reason} -> engine_error(conn, 1, "Session ID unknown")
    end
  end

  defp websocket(conn, _opts), do: engine_error(conn, 2, "Bad handshake method")

  defp ensure_polling_session(conn, opts) do
    case conn.query_params["sid"] do
      nil ->
        cookie_token = conn |> AuthSession.cookie_token()
        realtime_opts = session_opts(opts, cookie_token, :polling)

        case Cascade.Realtime.start_session(realtime_opts) do
          {:ok, sid, _pid} -> {:ok, sid}
          error -> error
        end

      sid when is_binary(sid) ->
        case Cascade.Realtime.lookup(sid) do
          {:ok, _pid} -> {:ok, sid}
          :error -> {:error, :unknown_sid}
        end
    end
  end

  defp ensure_websocket_session(conn, nil, opts) do
    cookie_token = conn |> AuthSession.cookie_token()
    realtime_opts = session_opts(opts, cookie_token, :websocket)

    case Cascade.Realtime.start_session(realtime_opts) do
      {:ok, sid, _pid} -> {:ok, sid, :direct}
      error -> error
    end
  end

  defp ensure_websocket_session(_conn, sid, _opts) do
    case Cascade.Realtime.lookup(sid) do
      {:ok, _pid} -> {:ok, sid, :upgrade}
      :error -> {:error, :unknown_sid}
    end
  end

  defp session_opts(opts, cookie_token, transport) do
    opts
    |> Keyword.take([
      :domain,
      :max_sessions,
      :max_queue_packets,
      :max_queue_bytes,
      :max_mailbox,
      :max_pending_acks
    ])
    |> Keyword.put(:cookie_token, cookie_token)
    |> Keyword.put(:transport, transport)
  end

  defp read_bounded_body(conn) do
    case read_body(conn, length: @max_payload, read_length: 64_000, read_timeout: 15_000) do
      {:ok, body, conn} -> {:ok, body, conn}
      {:more, _partial, conn} -> {:error, :payload_too_large, conn}
      {:error, _reason} -> {:error, :bad_body}
    end
  end

  defp text(conn, status, body) do
    conn
    |> put_resp_content_type("text/plain", "utf-8")
    |> put_resp_header("cache-control", "no-store")
    |> send_resp(status, body)
  end

  defp engine_error(conn, code, message, status \\ 400) do
    body = Jason.encode!(%{code: code, message: message})

    conn
    |> put_resp_content_type("application/json")
    |> put_resp_header("cache-control", "no-store")
    |> send_resp(status, body)
  end
end
