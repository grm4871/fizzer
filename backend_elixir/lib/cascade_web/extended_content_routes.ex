defmodule CascadeWeb.ExtendedContentRoutes do
  @moduledoc "Explicit integration catalog for publishing, scratchpad, evolution, and QMD search."

  @routes [
    {"GET", "/p/:slug"},
    {"GET", "/p/:slug.json"},
    {"GET", "/oembed"},
    {"GET", "/api/notes/:id/publish"},
    {"POST", "/api/notes/:id/publish"},
    {"DELETE", "/api/notes/:id/publish"},
    {"GET", "/api/vaults/:id/search"},
    {"POST", "/api/vaults/:id/scratchpad/journal"},
    {"GET", "/api/vaults/:id/scratchpad/journal"},
    {"POST", "/api/vaults/:id/scratchpad/consolidate"},
    {"GET", "/api/vaults/:id/scratchpad/status"},
    {"GET", "/api/vaults/:id/scratchpad/threads"},
    {"POST", "/api/vaults/:id/scratchpad/threads"},
    {"POST", "/api/vaults/:id/scratchpad/threads/:threadId/close"},
    {"POST", "/api/vaults/:id/scratchpad/skills"},
    {"GET", "/api/vaults/:id/scratchpad/skills"},
    {"POST", "/api/vaults/:id/scratchpad/outcome"},
    {"POST", "/api/vaults/:id/scratchpad/promote"},
    {"GET", "/api/vaults/:id/scratchpad/recall"},
    {"POST", "/api/vaults/:id/chat-backlinks/backfill"},
    {"POST", "/api/vaults/:vaultId/channels/:channelId/distill"},
    {"GET", "/api/vaults/:id/agent-memory"},
    {"PUT", "/api/vaults/:id/agent-memory"}
  ]

  def catalog, do: @routes
end
