defmodule CascadeWeb.MissionRoutes do
  @moduledoc "Explicit integration catalog for native mission and durable dispatch routes."

  @routes [
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/agent-dispatches/pending"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/history"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/tasks"},
    {"PATCH", "/api/vaults/:vault_id/channels/:channel_id/missions/tasks/:task_id"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/missions/:mission_id/finish"}
  ]

  def catalog, do: @routes
  def count, do: length(@routes)
end
