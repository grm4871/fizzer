defmodule CascadeWeb.RouteCatalogTest do
  use ExUnit.Case, async: true

  alias CascadeWeb.RouteCatalog

  test "catalog aggregation has no duplicate declarations" do
    declarations =
      root_routes() ++
        Enum.flat_map(CascadeWeb.Router.domains(), fn domain ->
          domain |> elem(0) |> apply(:catalog, [])
        end) ++ static_routes()

    assert MapSet.size(MapSet.new(declarations)) == length(declarations)
  end

  test "the embedded gate covers implementation while capacity stays external" do
    assert RouteCatalog.required_realtime() == [
             "/runs (Socket.IO)",
             "/vault (Socket.IO)",
             "/runners (Socket.IO)"
           ]

    assert RouteCatalog.cutover_gates() == %{http: true, realtime: true}
    assert RouteCatalog.swap_ready?()
  end

  defp root_routes do
    [
      {"GET", "/api/health"},
      {"GET", "/api/me"},
      {"GET", "/api/session"},
      {"POST", "/api/auth/login"},
      {"POST", "/api/auth/logout"}
    ]
  end

  defp static_routes, do: [{"GET", "/"}, {"GET", "/download"}, {"GET", "*"}]
end
