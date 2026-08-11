defmodule CascadeWeb.ContentRoutes do
  @moduledoc "Explicit integration catalog for the isolated content-domain router."

  @routes [
    {"GET", "/api/vaults"},
    {"POST", "/api/vaults"},
    {"GET", "/api/vaults/:id"},
    {"PATCH", "/api/vaults/:id"},
    {"GET", "/api/vaults/:id/folders"},
    {"POST", "/api/vaults/:id/folders"},
    {"PATCH", "/api/folders/:id"},
    {"DELETE", "/api/folders/:id"},
    {"GET", "/api/vaults/:id/notes"},
    {"POST", "/api/vaults/:id/notes"},
    {"GET", "/api/notes/:id"},
    {"PUT", "/api/notes/:id"},
    {"POST", "/api/notes/:id/rename"},
    {"DELETE", "/api/notes/:id"},
    {"POST", "/api/notes/:id/move"},
    {"POST", "/api/notes/:id/unlist"},
    {"POST", "/api/notes/:id/pin"},
    {"POST", "/api/notes/:id/archive"},
    {"POST", "/api/notes/:id/assets"},
    {"GET", "/api/notes/:id/assets/:assetId"},
    {"GET", "/api/notes/:id/backlinks"},
    {"GET", "/api/vaults/:id/tags"},
    {"POST", "/api/notes/:id/tags"},
    {"DELETE", "/api/notes/:id/tags/:tagId"},
    {"GET", "/api/notes/:id/versions"},
    {"GET", "/api/notes/:id/diff"},
    {"GET", "/api/vaults/:id/graph"}
  ]

  def catalog, do: @routes
end
