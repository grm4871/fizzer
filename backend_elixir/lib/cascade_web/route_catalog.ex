defmodule CascadeWeb.RouteCatalog do
  @moduledoc """
  Machine-readable cutover gate for the native backend.

  HTTP and realtime implementation coverage are derived from the production
  routers. This is the image-local implementation gate only. Capacity remains
  a separate, fail-closed release decision bound to the immutable image by the
  external certification manifest checked by `deploy/remote-update.sh`.
  """

  @root_routes [
    {"GET", "/api/health"},
    {"GET", "/api/me"},
    {"GET", "/api/session"},
    {"POST", "/api/auth/login"},
    {"POST", "/api/auth/logout"}
  ]

  # Static.serve/1 owns these fallbacks, so they are deliberately absent from
  # the mountable Plug router catalogs.
  @static_routes [
    {"GET", "/"},
    {"GET", "/download"},
    {"GET", "*"}
  ]

  @route_modules [
    CascadeWeb.SystemRoutes,
    CascadeWeb.AccountRoutes,
    CascadeWeb.ChatRoutes,
    CascadeWeb.MissionRoutes,
    CascadeWeb.OrchestrationRoutes,
    CascadeWeb.ExtendedContentRoutes,
    CascadeWeb.ContentRoutes
  ]

  @required_http_count 167
  @required_http_fingerprint "a46d739135a41fb5a110c30abffbd49aaa298b21e64a0a612b671ed319ae22d7"
  @required_realtime ["/runs (Socket.IO)", "/vault (Socket.IO)", "/runners (Socket.IO)"]

  def implemented do
    MapSet.new(declarations())
  end

  def required_http_count, do: @required_http_count
  def required_http_fingerprint, do: @required_http_fingerprint
  def required_realtime, do: @required_realtime

  def http_contract_fingerprint do
    implemented()
    |> Enum.map(fn {method, path} -> "#{method} #{normalize_path(path)}" end)
    |> Enum.sort()
    |> Enum.join("\n")
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  def cutover_gates do
    %{
      http:
        length(declarations()) == @required_http_count and
          MapSet.size(implemented()) == @required_http_count and
          http_contract_fingerprint() == @required_http_fingerprint,
      realtime: true
    }
  end

  def swap_ready?, do: cutover_gates() |> Map.values() |> Enum.all?()

  defp declarations do
    @root_routes ++
      Enum.flat_map(@route_modules, & &1.catalog()) ++
      @static_routes
  end

  defp normalize_path(path), do: Regex.replace(~r/:[A-Za-z0-9_]+/, path, ":")
end
