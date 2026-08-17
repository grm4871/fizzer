defmodule Cascade.ManagedAgentsTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.ManagedAgents
  alias Cascade.Runs.Store

  setup do
    Cascade.Accounts.Schema.ensure!()
    Cascade.Runs.Schema.ensure!()
    suffix = System.unique_integer([:positive])
    username = "managed-#{suffix}"
    vault_id = "managed-vault-#{suffix}"

    SQL.exec(
      "INSERT INTO users (username,password_hash,display_name,avatar_url) VALUES (?,?,?,?)",
      [username, "x", username, ""]
    )

    user_id = SQL.last_insert_id()

    SQL.exec("INSERT INTO vaults (id,name,root_path,created_by) VALUES (?,?,?,?)", [
      vault_id,
      "Managed",
      "/tmp/#{vault_id}",
      user_id
    ])

    SQL.exec(
      "INSERT INTO vault_members (vault_id,user_id,role,invited_by) VALUES (?,?,?,?)",
      [vault_id, user_id, "owner", user_id]
    )

    on_exit(fn ->
      SQL.exec("DELETE FROM vaults WHERE id=?", [vault_id])
      SQL.exec("DELETE FROM users WHERE id=?", [user_id])
    end)

    assert {:ok, run} = Store.start(vault_id, nil, "managed run", "codex")
    %{user_id: user_id, vault_id: vault_id, run: run}
  end

  test "entitlements fail closed and reservations are idempotent and hard-capped", context do
    input = %{
      vaultId: context.vault_id,
      runId: context.run.id,
      model: "deepseek-v4-flash",
      estimatedMicros: 2_000
    }

    assert {:error, "Managed agents are not enabled for this vault"} =
             ManagedAgents.reserve(input)

    entitlement =
      ManagedAgents.set_entitlement(context.vault_id, %{
        enabled: true,
        monthlyCapMicros: 10_000,
        perRunCapMicros: 3_000,
        concurrencyLimit: 1,
        allowedModels: ["deepseek-v4-flash"]
      })

    assert entitlement.enabled
    assert {:ok, first} = ManagedAgents.reserve(input)
    refute first.reused
    assert {:ok, second} = ManagedAgents.reserve(input)
    assert second.reused
    assert second.id == first.id

    assert {:error, "Managed run already has an immutable reservation"} =
             ManagedAgents.reserve(%{input | estimatedMicros: 2_001})
  end

  test "dispatch capabilities, claim leases, checkpoints, and receipts are fail-closed",
       context do
    ManagedAgents.set_entitlement(context.vault_id, %{
      enabled: true,
      monthlyCapMicros: 10_000,
      perRunCapMicros: 3_000,
      concurrencyLimit: 1,
      allowedModels: ["deepseek-v4-flash"]
    })

    dispatch_input = %{
      vaultId: context.vault_id,
      runId: context.run.id,
      model: "deepseek-v4-flash",
      estimatedMicros: 2_000,
      executionOwner: "worker-a",
      provider: "native"
    }

    assert {:ok, dispatched} = ManagedAgents.dispatch(dispatch_input)

    assert {:error, "Managed execution claim denied"} =
             ManagedAgents.claim(%{
               executionId: dispatched.executionId,
               executionOwner: "worker-a",
               dispatchSecret: "wrong"
             })

    assert {:ok, claim} =
             ManagedAgents.claim(%{
               executionId: dispatched.executionId,
               executionOwner: "worker-a",
               dispatchSecret: dispatched.dispatchSecret,
               leaseMs: 30_000
             })

    lease = %{
      executionId: dispatched.executionId,
      executionOwner: "worker-a",
      claimToken: claim.claimToken
    }

    assert {:error, "Managed checkpoint exceeds the reserved hard cap"} =
             ManagedAgents.checkpoint(Map.put(lease, :observedMicros, 2_001))

    assert {:ok, checkpoint} =
             ManagedAgents.checkpoint(Map.put(lease, :observedMicros, 1_500))

    assert checkpoint.checkpointedMicros == 1_500

    receipt_input =
      Map.merge(lease, %{
        settledMicros: 1_800,
        outcome: "completed",
        providerRequestId: "provider-1"
      })

    assert {:ok, receipt} = ManagedAgents.settle_execution(receipt_input)
    refute receipt.reused
    assert {:ok, replay} = ManagedAgents.settle_execution(receipt_input)
    assert replay.reused

    status = ManagedAgents.operator_status(context.vault_id)
    serialized = Jason.encode!(status)
    refute serialized =~ dispatched.dispatchSecret
    refute serialized =~ claim.claimToken
    assert status.budget.settledMicros == 1_800
  end
end
