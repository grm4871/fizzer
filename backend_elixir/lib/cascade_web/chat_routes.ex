defmodule CascadeWeb.ChatRoutes do
  @moduledoc "Explicit integration catalog for the isolated native chat router."

  @routes [
    {"GET", "/api/vaults/:vault_id/vault-agents"},
    {"PUT", "/api/vaults/:vault_id/vault-agents"},
    {"GET", "/api/vaults/:vault_id/vault-agents/:agent_id"},
    {"DELETE", "/api/vaults/:vault_id/vault-agents/:agent_id"},
    {"DELETE", "/api/vaults/:vault_id/vault-agents/:agent_id/profile"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/messages"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/messages"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/embeds"},
    {"PATCH", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id"},
    {"DELETE", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/forward"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/approve"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/merge"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/collaborate"},
    {"POST",
     "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/clarification/answer"},
    {"POST",
     "/api/vaults/:vault_id/channels/:channel_id/messages/:message_id/clarification/accept"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/agents"},
    {"PUT", "/api/vaults/:vault_id/channels/:channel_id/agents"},
    {"POST", "/api/vaults/:vault_id/channels/:channel_id/agents/from-vault"},
    {"PUT", "/api/vaults/:vault_id/channels/:channel_id/agents/:registration_id/avatar"},
    {"DELETE", "/api/vaults/:vault_id/channels/:channel_id/agents/:registration_id"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/settings"},
    {"PUT", "/api/vaults/:vault_id/channels/:channel_id/settings"},
    {"GET", "/api/vaults/:vault_id/channels/:channel_id/presence"},
    {"DELETE", "/api/vaults/:vault_id/channels/:channel_id/members/me"},
    {"DELETE", "/api/vaults/:vault_id/channels/:channel_id/members/:username"}
  ]

  def catalog, do: @routes
end
