defmodule CascadeWeb.MountedRoutesTest do
  use ExUnit.Case, async: false

  import Plug.Conn
  import Plug.Test

  @router_options CascadeWeb.Router.init([])

  test "compatibility catalogs reflect the complete router declarations" do
    for domain <- CascadeWeb.Router.domains() do
      catalog = elem(domain, 0).catalog()
      assert catalog == elem(domain, 1).catalog()
      assert Enum.uniq(catalog) == catalog
    end

    assert CascadeWeb.MissionRoutes.count() == length(CascadeWeb.MissionRoutes.catalog())

    assert CascadeWeb.OrchestrationRoutes.count() ==
             length(CascadeWeb.OrchestrationRoutes.catalog())

    assert CascadeWeb.OrchestrationRoutes.all() == CascadeWeb.OrchestrationRoutes.catalog()
  end

  test "content uploads retain their larger parser budget through domain dispatch" do
    body = Jason.encode!(%{content: String.duplicate("x", 13 * 1_024 * 1_024)})

    response =
      conn(:post, "/api/notes/missing/assets", body)
      |> put_req_header("content-type", "application/json")
      |> CascadeWeb.Router.call(@router_options)

    assert response.status == 401
    assert response.body_params["content"] == Jason.decode!(body)["content"]
  end

  test "unknown API paths fall through without parsing malformed JSON" do
    response =
      conn(:post, "/api/missing", "invalid json")
      |> put_req_header("content-type", "application/json")
      |> CascadeWeb.Router.call(@router_options)

    assert response.status == 404
    assert %Plug.Conn.Unfetched{} = response.body_params
  end

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
