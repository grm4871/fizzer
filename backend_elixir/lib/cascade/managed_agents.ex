defmodule Cascade.ManagedAgents do
  @moduledoc """
  Credential-free managed-agent entitlement, capability, usage, and audit control plane.

  Reservations and execution claims are transactional and idempotent; invalid
  ownership, capability, budget, and terminal-state transitions return errors.
  """

  import Cascade.ManagedAgents.Support
  alias Cascade.Accounts.SQL

  @default_models ["deepseek-v4-flash"]
  @terminal ~w(completed failed canceled expired)

  def entitlement(vault_id) do
    case SQL.one(
           """
           SELECT enabled,monthly_cap_micros,per_run_cap_micros,included_micros,
             concurrency_limit,allowed_models_json
           FROM managed_agent_entitlements WHERE vault_id=?
           """,
           [vault_id]
         ) do
      nil ->
        %{
          vaultId: vault_id,
          enabled: false,
          monthlyCapMicros: 0,
          perRunCapMicros: 0,
          includedMicros: 0,
          concurrencyLimit: 1,
          allowedModels: @default_models
        }

      [enabled, monthly, per_run, included, concurrency, models_json] ->
        %{
          vaultId: vault_id,
          enabled: enabled != 0,
          monthlyCapMicros: micros(monthly, 0),
          perRunCapMicros: micros(per_run, 0),
          includedMicros: micros(included, 0),
          concurrencyLimit: clamp(micros(concurrency, 1), 1, 32),
          allowedModels: decode_models(models_json)
        }
    end
  end

  def set_entitlement(vault_id, input) do
    prior = entitlement(vault_id)

    next = %{
      vaultId: vault_id,
      enabled: boolean_or(field(input, :enabled), prior.enabled),
      monthlyCapMicros: micros(field(input, :monthlyCapMicros), prior.monthlyCapMicros),
      perRunCapMicros: micros(field(input, :perRunCapMicros), prior.perRunCapMicros),
      includedMicros: micros(field(input, :includedMicros), prior.includedMicros),
      concurrencyLimit:
        clamp(micros(field(input, :concurrencyLimit), prior.concurrencyLimit), 1, 32),
      allowedModels:
        if(present?(input, :allowedModels),
          do: clean_models(field(input, :allowedModels)),
          else: prior.allowedModels
        )
    }

    SQL.exec(
      """
      INSERT INTO managed_agent_entitlements
        (vault_id,enabled,monthly_cap_micros,per_run_cap_micros,included_micros,
         concurrency_limit,allowed_models_json,updated_at)
      VALUES (?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(vault_id) DO UPDATE SET enabled=excluded.enabled,
        monthly_cap_micros=excluded.monthly_cap_micros,
        per_run_cap_micros=excluded.per_run_cap_micros,
        included_micros=excluded.included_micros,
        concurrency_limit=excluded.concurrency_limit,
        allowed_models_json=excluded.allowed_models_json,updated_at=datetime('now')
      """,
      [
        vault_id,
        if(next.enabled, do: 1, else: 0),
        next.monthlyCapMicros,
        next.perRunCapMicros,
        next.includedMicros,
        next.concurrencyLimit,
        Jason.encode!(next.allowedModels)
      ]
    )

    next
  end

  def reap_expired(now \\ iso_now()) do
    SQL.transaction(fn -> expire_internal(now) end)
  end

  def reserve(input) do
    SQL.transaction(fn -> reserve_internal(input) end)
  end

  def settle(input) do
    SQL.transaction(fn -> settle_internal(input) end)
  end

  def dispatch(input) do
    owner = clean_owner(field(input, :executionOwner))
    provider = clean_provider(field(input, :provider))
    run_id = field(input, :runId)

    if owner == "" or provider == "" or not (is_integer(run_id) and run_id > 0) do
      {:error, "Invalid managed execution dispatch"}
    else
      SQL.transaction(fn -> dispatch_internal(input, owner, provider) end)
    end
  end

  def claim(input) do
    owner = clean_owner(field(input, :executionOwner))

    if owner == "" do
      {:error, "Invalid execution owner"}
    else
      SQL.transaction(fn -> claim_internal(input, owner) end)
    end
  end

  def heartbeat(input) do
    SQL.transaction(fn ->
      with {:ok, execution} <- assert_claim(input) do
        now = iso_now()
        expires = iso_after(bounded_ms(field(input, :leaseMs), 90_000, 15_000, 600_000))

        SQL.exec(
          "UPDATE managed_agent_executions SET claim_expires_at=?,last_heartbeat_at=? WHERE id=?",
          [expires, now, execution.id]
        )

        SQL.exec(
          "UPDATE managed_usage_reservations SET expires_at=? WHERE id=? AND state='reserved'",
          [iso_after(3_600_000), execution.reservation_id]
        )

        {:ok, %{claimExpiresAt: expires}}
      end
    end)
  end

  def checkpoint(input) do
    observed = micros(field(input, :observedMicros), -1)

    if observed < 0 do
      {:error, "Invalid managed checkpoint cost"}
    else
      SQL.transaction(fn -> checkpoint_internal(input, observed) end)
    end
  end

  def settle_execution(input) do
    SQL.transaction(fn -> settle_execution_internal(input) end)
  end

  def operator_status(vault_id) do
    key = month_key()
    entitlement = entitlement(vault_id)

    reserved =
      scalar(
        "SELECT COALESCE(SUM(estimated_micros),0) FROM managed_usage_reservations WHERE vault_id=? AND month_key=? AND state='reserved'",
        [vault_id, key]
      )

    settled =
      scalar(
        "SELECT COALESCE(SUM(settled_micros),0) FROM managed_usage_ledger WHERE vault_id=? AND substr(created_at,1,7)=?",
        [vault_id, key]
      )

    cap = entitlement.monthlyCapMicros + entitlement.includedMicros

    executions =
      SQL.all(
        """
        SELECT id,run_id,model,execution_owner,provider,state,attempt,claim_expires_at,
          last_heartbeat_at,provider_request_id,created_at,completed_at
        FROM managed_agent_executions WHERE vault_id=? ORDER BY created_at DESC LIMIT 20
        """,
        [vault_id]
      )
      |> Enum.map(fn [
                       id,
                       run_id,
                       model,
                       owner,
                       provider,
                       state,
                       attempt,
                       claim_exp,
                       heartbeat,
                       request_id,
                       created,
                       completed
                     ] ->
        %{
          id: id,
          run_id: run_id,
          model: model,
          execution_owner: owner,
          provider: provider,
          state: state,
          attempt: attempt,
          claim_expires_at: claim_exp,
          last_heartbeat_at: heartbeat,
          provider_request_id: request_id,
          created_at: created,
          completed_at: completed
        }
      end)

    audit_rows =
      SQL.all(
        """
        SELECT execution_id,reservation_id,actor,event,detail_json,created_at
        FROM managed_agent_audit WHERE vault_id=? ORDER BY created_at DESC LIMIT 20
        """,
        [vault_id]
      )
      |> Enum.map(fn [execution_id, reservation_id, actor, event, detail, created] ->
        %{
          execution_id: execution_id,
          reservation_id: reservation_id,
          actor: actor,
          event: event,
          detail: decode_object(detail),
          created_at: created
        }
      end)

    %{
      monthKey: key,
      budget: %{
        capMicros: cap,
        settledMicros: settled,
        reservedMicros: reserved,
        availableMicros: max(0, cap - settled - reserved)
      },
      executions: executions,
      audit: audit_rows
    }
  end

end
