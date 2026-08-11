defmodule Cascade.ManagedAgents do
  @moduledoc "Credential-free managed-agent entitlement, capability, usage, and audit control plane."

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

  defp reserve_internal(input) do
    estimated = micros(field(input, :estimatedMicros), -1)
    vault_id = clean(field(input, :vaultId), 200)
    model = clean(field(input, :model), 120)
    run_id = field(input, :runId)

    cond do
      estimated < 0 ->
        {:error, "Invalid estimated managed cost"}

      true ->
        expire_internal(iso_now())

        case existing_reservation(run_id) do
          nil -> create_reservation(vault_id, run_id, model, estimated, field(input, :ttlMs))
          existing -> reuse_reservation(existing, vault_id, model, estimated)
        end
    end
  end

  defp create_reservation(vault_id, run_id, model, estimated, ttl_ms) do
    entitlement = entitlement(vault_id)
    key = month_key()

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

    active =
      scalar(
        "SELECT COUNT(*) FROM managed_usage_reservations WHERE vault_id=? AND state='reserved'",
        [vault_id]
      )

    cond do
      not entitlement.enabled ->
        {:error, "Managed agents are not enabled for this vault"}

      model not in entitlement.allowedModels ->
        {:error, "Managed model is not allowed for this vault"}

      entitlement.monthlyCapMicros == 0 or entitlement.perRunCapMicros == 0 ->
        {:error, "Managed budget is not configured"}

      estimated > entitlement.perRunCapMicros ->
        {:error, "Managed request exceeds the per-run hard cap"}

      reserved + settled + estimated > entitlement.monthlyCapMicros + entitlement.includedMicros ->
        {:error, "Managed budget exhausted"}

      active >= entitlement.concurrencyLimit ->
        {:error, "Managed concurrency limit reached"}

      true ->
        id = Ecto.UUID.generate()
        expires = iso_after(bounded_ms(ttl_ms, 600_000, 30_000, 3_600_000))

        SQL.exec(
          """
          INSERT INTO managed_usage_reservations
            (id,vault_id,run_id,model,estimated_micros,state,month_key,expires_at)
          VALUES (?,?,?,?,?,'reserved',?,?)
          """,
          [id, vault_id, run_id, model, estimated, key, expires]
        )

        {:ok, %{id: id, expiresAt: expires, estimatedMicros: estimated, reused: false}}
    end
  end

  defp reuse_reservation(existing, vault_id, model, estimated) do
    if existing.vault_id == vault_id and existing.model == model and
         existing.estimated_micros == estimated and existing.state == "reserved" do
      {:ok,
       %{
         id: existing.id,
         expiresAt: existing.expires_at,
         estimatedMicros: existing.estimated_micros,
         reused: true
       }}
    else
      {:error, "Managed run already has an immutable reservation"}
    end
  end

  defp settle_internal(input) do
    cost = micros(field(input, :settledMicros), -1)
    provider = clean_provider(field(input, :provider))
    outcome = clean(field(input, :outcome), 64)
    reservation_id = field(input, :reservationId)
    request_id = clean(field(input, :providerRequestId), 200)

    cond do
      cost < 0 -> {:error, "Invalid settled managed cost"}
      provider == "" -> {:error, "Invalid managed provider"}
      outcome == "" -> {:error, "Managed outcome is required"}
      true -> settle_receipt(reservation_id, provider, cost, outcome, request_id, input)
    end
  end

  defp settle_receipt(reservation_id, provider, cost, outcome, request_id, input) do
    reservation = reservation(reservation_id)
    existing = settlement(reservation_id)

    cond do
      is_nil(reservation) ->
        {:error, "Managed reservation not found"}

      existing && receipt_matches?(existing, provider, cost, outcome, request_id) ->
        {:ok,
         %{
           id: existing.id,
           vaultId: existing.vault_id,
           settledMicros: existing.settled_micros,
           reused: true
         }}

      existing ->
        {:error, "Managed reservation was already settled with different receipt data"}

      reservation.state != "reserved" ->
        {:error, "Managed reservation is not active"}

      cost > reservation.estimated_micros ->
        {:error, "Managed settled cost exceeds the reserved hard cap"}

      true ->
        insert_settlement(reservation, provider, cost, outcome, request_id, input)
    end
  end

  defp insert_settlement(reservation, provider, cost, outcome, request_id, input) do
    id = Ecto.UUID.generate()

    SQL.exec(
      """
      INSERT INTO managed_usage_ledger
        (id,reservation_id,vault_id,run_id,provider,model,input_tokens,cached_input_tokens,
         reasoning_tokens,output_tokens,estimated_micros,settled_micros,outcome,provider_request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      """,
      [
        id,
        reservation.id,
        reservation.vault_id,
        reservation.run_id,
        provider,
        reservation.model,
        micros(field(input, :inputTokens), 0),
        micros(field(input, :cachedInputTokens), 0),
        micros(field(input, :reasoningTokens), 0),
        micros(field(input, :outputTokens), 0),
        reservation.estimated_micros,
        cost,
        outcome,
        request_id
      ]
    )

    SQL.exec(
      """
      UPDATE managed_usage_reservations SET state='settled',settled_at=datetime('now'),
        checkpointed_micros=MAX(checkpointed_micros,?) WHERE id=?
      """,
      [cost, reservation.id]
    )

    {:ok, %{id: id, vaultId: reservation.vault_id, settledMicros: cost, reused: false}}
  end

  defp dispatch_internal(input, owner, provider) do
    with {:ok, reservation} <- reserve_internal(input) do
      case execution_by_reservation(reservation.id) do
        nil ->
          create_execution(input, reservation, owner, provider)

        %{execution_owner: ^owner, provider: ^provider} ->
          {:error, "Managed execution already dispatched; dispatch capability cannot be replayed"}

        _ ->
          {:error, "Managed execution owner is immutable"}
      end
    end
  end

  defp create_execution(input, reservation, owner, provider) do
    execution_id = Ecto.UUID.generate()
    secret = capability()
    idempotency = Ecto.UUID.generate()
    vault_id = field(input, :vaultId)

    SQL.exec(
      """
      INSERT INTO managed_agent_executions
        (id,reservation_id,vault_id,run_id,model,execution_owner,provider,state,
         dispatch_secret_hash,provider_idempotency_key)
      VALUES (?,?,?,?,?,?,?,'queued',?,?)
      """,
      [
        execution_id,
        reservation.id,
        vault_id,
        field(input, :runId),
        field(input, :model),
        owner,
        provider,
        capability_hash(secret),
        idempotency
      ]
    )

    audit(vault_id, execution_id, reservation.id, "control-plane", "dispatched", %{
      executionOwner: owner,
      provider: provider,
      model: field(input, :model),
      hardCapMicros: reservation.estimatedMicros
    })

    {:ok,
     %{
       executionId: execution_id,
       reservationId: reservation.id,
       dispatchSecret: secret,
       expiresAt: reservation.expiresAt,
       hardCapMicros: reservation.estimatedMicros
     }}
  end

  defp claim_internal(input, owner) do
    now = iso_now()
    execution = execution(field(input, :executionId))

    cond do
      is_nil(execution) or execution.execution_owner != owner or
          not capability_matches?(execution.dispatch_secret_hash, field(input, :dispatchSecret)) ->
        {:error, "Managed execution claim denied"}

      execution.state in @terminal ->
        {:error, "Managed execution is terminal"}

      (execution.state == "claimed" and execution.claim_expires_at) &&
          execution.claim_expires_at > now ->
        {:error, "Managed execution is already claimed"}

      true ->
        claim_available_execution(execution, input, now)
    end
  end

  defp claim_available_execution(execution, input, now) do
    reservation = reservation(execution.reservation_id)

    if is_nil(reservation) or reservation.state != "reserved" or reservation.expires_at <= now do
      {:error, "Managed execution reservation has expired"}
    else
      token = capability()
      expires = iso_after(bounded_ms(field(input, :leaseMs), 90_000, 15_000, 600_000))

      changed =
        SQL.changes(
          """
          UPDATE managed_agent_executions SET state='claimed',attempt=attempt+1,
            claim_token_hash=?,claim_expires_at=?,last_heartbeat_at=?,
            claimed_at=COALESCE(claimed_at,datetime('now'))
          WHERE id=? AND (state='queued' OR (state='claimed' AND
            (claim_expires_at IS NULL OR claim_expires_at<=?)))
          """,
          [capability_hash(token), expires, now, execution.id, now]
        )

      if changed != 1 do
        {:error, "Managed execution claim raced with another worker"}
      else
        audit(
          execution.vault_id,
          execution.id,
          execution.reservation_id,
          execution.execution_owner,
          "claimed",
          %{attempt: execution.attempt + 1}
        )

        {:ok,
         %{
           claimToken: token,
           claimExpiresAt: expires,
           provider: execution.provider,
           model: execution.model,
           hardCapMicros: reservation.estimated_micros,
           providerIdempotencyKey: execution.provider_idempotency_key
         }}
      end
    end
  end

  defp checkpoint_internal(input, observed) do
    with {:ok, execution} <- assert_claim(input) do
      reservation = reservation(execution.reservation_id)

      cond do
        is_nil(reservation) or reservation.state != "reserved" ->
          {:error, "Managed execution reservation is not active"}

        observed > reservation.estimated_micros ->
          {:error, "Managed checkpoint exceeds the reserved hard cap"}

        true ->
          request_id = clean(field(input, :providerRequestId), 200)

          SQL.exec(
            "UPDATE managed_usage_reservations SET checkpointed_micros=MAX(checkpointed_micros,?) WHERE id=?",
            [observed, reservation.id]
          )

          if request_id != "",
            do:
              SQL.exec(
                "UPDATE managed_agent_executions SET provider_request_id=CASE WHEN provider_request_id='' THEN ? ELSE provider_request_id END WHERE id=?",
                [request_id, execution.id]
              )

          {:ok,
           %{
             hardCapMicros: reservation.estimated_micros,
             checkpointedMicros: max(reservation.checkpointed_micros, observed)
           }}
      end
    end
  end

  defp settle_execution_internal(input) do
    execution = execution(field(input, :executionId))
    owner = clean_owner(field(input, :executionOwner))
    token = field(input, :claimToken)

    if is_nil(execution) or execution.execution_owner != owner or
         not capability_matches?(execution.claim_token_hash, token) do
      {:error, "Managed execution lease denied"}
    else
      request_id = clean(field(input, :providerRequestId) || execution.provider_request_id, 200)
      terminal_settle(execution, input, request_id)
    end
  end

  defp terminal_settle(execution, input, request_id) when execution.state in @terminal do
    existing = settlement(execution.reservation_id)
    cost = micros(field(input, :settledMicros), -1)
    outcome = clean(field(input, :outcome), 64)

    if existing && receipt_matches?(existing, execution.provider, cost, outcome, request_id) do
      {:ok,
       %{
         id: existing.id,
         vaultId: existing.vault_id,
         settledMicros: existing.settled_micros,
         reused: true
       }}
    else
      {:error, "Managed execution is terminal"}
    end
  end

  defp terminal_settle(execution, input, request_id) do
    with {:ok, _execution} <- assert_claim(input),
         {:ok, receipt} <-
           settle_internal(%{
             reservationId: execution.reservation_id,
             provider: execution.provider,
             settledMicros: field(input, :settledMicros),
             outcome: field(input, :outcome),
             providerRequestId: request_id,
             inputTokens: field(input, :inputTokens),
             cachedInputTokens: field(input, :cachedInputTokens),
             reasoningTokens: field(input, :reasoningTokens),
             outputTokens: field(input, :outputTokens)
           }) do
      outcome = clean(field(input, :outcome), 64)

      state =
        if outcome == "completed",
          do: "completed",
          else: if(outcome == "canceled", do: "canceled", else: "failed")

      SQL.exec(
        """
        UPDATE managed_agent_executions SET state=?,completed_at=datetime('now'),
          claim_expires_at=NULL,provider_request_id=CASE WHEN provider_request_id='' THEN ? ELSE provider_request_id END
        WHERE id=?
        """,
        [state, request_id, execution.id]
      )

      audit(
        execution.vault_id,
        execution.id,
        execution.reservation_id,
        execution.execution_owner,
        "settled",
        %{
          outcome: outcome,
          settledMicros: receipt.settledMicros,
          reused: receipt.reused
        }
      )

      {:ok, receipt}
    end
  end

  defp assert_claim(input) do
    execution = execution(field(input, :executionId))
    owner = clean_owner(field(input, :executionOwner))

    cond do
      is_nil(execution) or owner == "" or execution.execution_owner != owner or
          not capability_matches?(execution.claim_token_hash, field(input, :claimToken)) ->
        {:error, "Managed execution lease denied"}

      execution.state != "claimed" or is_nil(execution.claim_expires_at) or
          execution.claim_expires_at <= iso_now() ->
        {:error, "Managed execution lease expired"}

      true ->
        {:ok, execution}
    end
  end

  defp expire_internal(now) do
    changed =
      SQL.changes(
        "UPDATE managed_usage_reservations SET state='expired' WHERE state='reserved' AND expires_at<=?",
        [now]
      )

    SQL.exec(
      "UPDATE managed_agent_executions SET state='expired',completed_at=datetime('now') WHERE reservation_id IN (SELECT id FROM managed_usage_reservations WHERE state='expired') AND state IN ('queued','claimed')"
    )

    changed
  end

  defp existing_reservation(run_id) when is_integer(run_id),
    do:
      SQL.one(
        "SELECT id,vault_id,run_id,model,estimated_micros,checkpointed_micros,state,month_key,expires_at FROM managed_usage_reservations WHERE run_id=?",
        [run_id]
      )
      |> reservation_row()

  defp existing_reservation(_), do: nil

  defp reservation(id),
    do:
      SQL.one(
        "SELECT id,vault_id,run_id,model,estimated_micros,checkpointed_micros,state,month_key,expires_at FROM managed_usage_reservations WHERE id=?",
        [id]
      )
      |> reservation_row()

  defp reservation_row(nil), do: nil

  defp reservation_row([id, vault, run, model, estimated, checkpointed, state, month, expires]),
    do: %{
      id: id,
      vault_id: vault,
      run_id: run,
      model: model,
      estimated_micros: estimated,
      checkpointed_micros: checkpointed,
      state: state,
      month_key: month,
      expires_at: expires
    }

  defp execution(id) do
    case SQL.one(
           "SELECT id,reservation_id,vault_id,run_id,model,execution_owner,provider,state,attempt,dispatch_secret_hash,claim_token_hash,claim_expires_at,provider_idempotency_key,provider_request_id FROM managed_agent_executions WHERE id=?",
           [id]
         ) do
      nil ->
        nil

      [
        id,
        reservation,
        vault,
        run,
        model,
        owner,
        provider,
        state,
        attempt,
        dispatch_hash,
        claim_hash,
        claim_exp,
        idem,
        request
      ] ->
        %{
          id: id,
          reservation_id: reservation,
          vault_id: vault,
          run_id: run,
          model: model,
          execution_owner: owner,
          provider: provider,
          state: state,
          attempt: attempt,
          dispatch_secret_hash: dispatch_hash,
          claim_token_hash: claim_hash,
          claim_expires_at: claim_exp,
          provider_idempotency_key: idem,
          provider_request_id: request
        }
    end
  end

  defp execution_by_reservation(id) do
    case SQL.one("SELECT id FROM managed_agent_executions WHERE reservation_id=?", [id]) do
      [execution_id] -> execution(execution_id)
      nil -> nil
    end
  end

  defp settlement(id) do
    case SQL.one(
           "SELECT id,vault_id,settled_micros,provider,outcome,provider_request_id FROM managed_usage_ledger WHERE reservation_id=?",
           [id]
         ) do
      nil ->
        nil

      [receipt_id, vault, cost, provider, outcome, request] ->
        %{
          id: receipt_id,
          vault_id: vault,
          settled_micros: cost,
          provider: provider,
          outcome: outcome,
          provider_request_id: request
        }
    end
  end

  defp audit(vault, execution, reservation, actor, event, detail) do
    SQL.exec(
      "INSERT INTO managed_agent_audit (id,vault_id,execution_id,reservation_id,actor,event,detail_json) VALUES (?,?,?,?,?,?,?)",
      [
        Ecto.UUID.generate(),
        vault,
        execution,
        reservation,
        String.slice(actor, 0, 120),
        String.slice(event, 0, 80),
        Jason.encode!(detail)
      ]
    )
  end

  defp receipt_matches?(receipt, provider, cost, outcome, request),
    do:
      receipt.provider == provider and receipt.settled_micros == cost and
        receipt.outcome == outcome and receipt.provider_request_id == request

  defp capability, do: 32 |> :crypto.strong_rand_bytes() |> Base.url_encode64(padding: false)
  defp capability_hash(value), do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)

  defp capability_matches?(expected, provided) when is_binary(expected) and is_binary(provided),
    do: Plug.Crypto.secure_compare(expected, capability_hash(provided))

  defp capability_matches?(_, _), do: false
  defp clean_owner(value), do: regex_clean(value, ~r/^[a-z0-9._:@\/-]{1,120}$/i)
  defp clean_provider(value), do: regex_clean(value, ~r/^[a-z0-9._-]{1,80}$/i)

  defp regex_clean(value, regex) when is_binary(value),
    do: if(Regex.match?(regex, value), do: value, else: "")

  defp regex_clean(_, _), do: ""

  defp clean_models(value) when is_list(value),
    do:
      value
      |> Enum.filter(&(is_binary(&1) and Regex.match?(~r/^[a-z0-9._-]{1,120}$/i, &1)))
      |> Enum.uniq()
      |> Enum.take(20)

  defp clean_models(_), do: @default_models

  defp decode_models(value) do
    case Jason.decode(to_string(value || "")) do
      {:ok, models} -> clean_models(models)
      _ -> @default_models
    end
  end

  defp decode_object(value) do
    case Jason.decode(to_string(value || "")) do
      {:ok, map} when is_map(map) -> map
      _ -> %{}
    end
  end

  defp scalar(sql, params) do
    case SQL.one(sql, params) do
      [value] -> integer(value)
      _ -> 0
    end
  end

  defp month_key, do: Date.utc_today() |> Date.to_iso8601() |> String.slice(0, 7)
  defp iso_now, do: DateTime.utc_now() |> DateTime.to_iso8601()

  defp iso_after(ms),
    do: DateTime.utc_now() |> DateTime.add(ms, :millisecond) |> DateTime.to_iso8601()

  defp bounded_ms(value, fallback, min, max),
    do: if(is_number(value), do: clamp(floor(value), min, max), else: fallback)

  defp micros(value, _fallback) when is_integer(value) and value >= 0, do: value
  defp micros(_, fallback), do: fallback
  defp boolean_or(value, _fallback) when is_boolean(value), do: value
  defp boolean_or(_, fallback), do: fallback
  defp integer(value) when is_integer(value), do: value
  defp integer(_), do: 0
  defp clamp(value, min, max), do: value |> Kernel.max(min) |> Kernel.min(max)
  defp clean(nil, _max), do: ""
  defp clean(value, max), do: value |> to_string() |> String.trim() |> String.slice(0, max)
  defp present?(map, key), do: Map.has_key?(map, key) or Map.has_key?(map, Atom.to_string(key))
  defp field(map, key) when is_map(map), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  defp field(_, _), do: nil
end
