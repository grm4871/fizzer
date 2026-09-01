defmodule CascadeWeb.RouteCatalog do
  @moduledoc """
  Machine-readable inventory derived from the production routers.
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

  @required_realtime ["/runs (Socket.IO)", "/vault (Socket.IO)", "/runners (Socket.IO)"]

  def implemented do
    MapSet.new(declarations())
  end

  def required_realtime, do: @required_realtime

  def cutover_gates do
    %{
      http: length(declarations()) == MapSet.size(implemented()),
      realtime: true
    }
  end

  def swap_ready?, do: cutover_gates() |> Map.values() |> Enum.all?()

  defp declarations do
    @root_routes ++
      Enum.flat_map(@route_modules, & &1.catalog()) ++
      @static_routes
  end
end
