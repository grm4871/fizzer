defmodule CascadeWeb.JSON do
  @moduledoc false

  import Plug.Conn

  def send(conn, status, body) do
    conn
    |> delete_resp_header("cache-control")
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(body))
  end
end
