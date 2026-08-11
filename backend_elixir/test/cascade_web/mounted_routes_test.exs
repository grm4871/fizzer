defmodule CascadeWeb.MountedRoutesTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  @router_options CascadeWeb.Router.init([])

  test "every completed domain catalog is reachable through the production router" do
    for domain <- CascadeWeb.Router.domains(),
        {method, pattern} <- elem(domain, 0).catalog() do
      path = materialize(pattern)

      response =
        conn(method, path, "{}")
        |> put_req_header("content-type", "application/json")
        |> CascadeWeb.Router.call(@router_options)

      refute response.status == 501,
             "#{method} #{pattern} fell through the production parity boundary"
    end
  end

  defp materialize(pattern) do
    Regex.replace(~r/:[A-Za-z0-9_]+/, pattern, "missing")
  end
end
