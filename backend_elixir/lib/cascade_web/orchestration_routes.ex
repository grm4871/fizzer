defmodule CascadeWeb.OrchestrationRoutes do
  @moduledoc "Parity catalog for the isolated orchestration router."

  @routes [
    {"GET", "/api/vaults/:id/runs"},
    {"POST", "/api/vaults/:id/runs"},
    {"GET", "/api/vaults/:id/active-sessions"},
    {"POST", "/api/local-agents"},
    {"GET", "/api/runs/:id"},
    {"GET", "/api/runs/:id/events"},
    {"POST", "/api/runs/:id/cancel"},
    {"GET", "/api/me/desktop-runner"},
    {"GET", "/api/vaults/:id/managed-agent/entitlement"},
    {"PUT", "/api/vaults/:id/managed-agent/entitlement"},
    {"GET", "/api/vaults/:id/work-items"},
    {"POST", "/api/vaults/:id/work-items"},
    {"GET", "/api/work-items/:id"},
    {"PATCH", "/api/work-items/:id"},
    {"PUT", "/api/work-items/:id/git-state"},
    {"POST", "/api/work-items/:id/lease"},
    {"POST", "/api/work-items/:id/release"},
    {"POST", "/api/work-items/:id/runs"},
    {"POST", "/api/work-items/:id/handoff"},
    {"POST", "/api/work-items/:id/reviews"},
    {"POST", "/api/work-items/:id/stop"}
  ]

  def catalog, do: @routes
  def all, do: @routes
  def count, do: length(@routes)
end
