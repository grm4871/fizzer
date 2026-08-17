defmodule CascadeWeb.RouteCatalogTest do
  use ExUnit.Case, async: true

  alias CascadeWeb.RouteCatalog

  @contract_path Path.expand("../../../scripts/backend-contract.v1.json", __DIR__)

  test "catalog covers every Node HTTP contract exactly once" do
    required =
      @contract_path
      |> File.read!()
      |> Jason.decode!()
      |> Map.fetch!("httpRoutes")
      |> Enum.map(&route_key/1)

    implemented = RouteCatalog.implemented() |> Enum.map(&route_key/1)

    assert length(required) == RouteCatalog.required_http_count()
    assert length(implemented) == RouteCatalog.required_http_count()
    assert MapSet.new(implemented) == MapSet.new(required)
    assert contract_fingerprint(required) == RouteCatalog.required_http_fingerprint()
    assert RouteCatalog.http_contract_fingerprint() == RouteCatalog.required_http_fingerprint()
  end

  test "catalog aggregation has no duplicate declarations" do
    declarations =
      root_routes() ++
        Enum.flat_map(CascadeWeb.Router.domains(), fn domain ->
          domain |> elem(0) |> apply(:catalog, [])
        end) ++ static_routes()

    assert length(declarations) == RouteCatalog.required_http_count()
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

  defp route_key(%{"method" => method, "path" => path}), do: route_key({method, path})

  defp route_key({method, path}) do
    normalized = Regex.replace(~r/:[A-Za-z0-9_]+/, path, ":")
    {method, normalized}
  end

  defp contract_fingerprint(routes) do
    routes
    |> Enum.map(fn {method, path} -> "#{method} #{path}" end)
    |> Enum.sort()
    |> Enum.join("\n")
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
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
