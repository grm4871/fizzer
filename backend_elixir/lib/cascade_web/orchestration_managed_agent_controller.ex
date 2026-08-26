defmodule CascadeWeb.OrchestrationManagedAgentController do
  @moduledoc "HTTP endpoints for vault managed-agent entitlement and operator status."

  alias Cascade.Accounts.{VaultMembers}
  alias Cascade.Auth.Session
  alias Cascade.ManagedAgents
  alias CascadeWeb.JSON
  import CascadeWeb.OrchestrationHTTP

  def managed_entitlement(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      with_vault(conn, vault_id, user.id, fn ->
        JSON.send(conn, 200, %{
          entitlement: ManagedAgents.entitlement(vault_id),
          admin: VaultMembers.role(vault_id, user.id) == "owner",
          operator: ManagedAgents.operator_status(vault_id)
        })
      end)
    end)
  end

  def update_managed_entitlement(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      cond do
        is_nil(VaultMembers.accessible_vault(vault_id, user.id)) ->
          JSON.send(conn, 404, %{error: "Vault not found"})

        VaultMembers.role(vault_id, user.id) != "owner" ->
          JSON.send(conn, 403, %{error: "Only the vault owner can manage managed-agent budgets"})

        true ->
          JSON.send(conn, 200, %{entitlement: ManagedAgents.set_entitlement(vault_id, body(conn))})
      end
    end)
  end

end
