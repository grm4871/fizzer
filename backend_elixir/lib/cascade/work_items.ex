defmodule Cascade.WorkItems do
  @moduledoc """
  Durable work contracts, leases, workspace evidence, dependencies, and reviews.

  State changes enforce vault access and lease ownership, preserve dependency
  ordering, and return explicit `{:error, reason}` tuples for invalid transitions.
  """

  alias Cascade.Accounts.{SQL, VaultMembers}
  import Cascade.WorkItems.Support
  alias Cascade.Runs.Store

  @statuses ~w(open leased in_progress review blocked done canceled)
  @modes ~w(shared isolated existing)
  @source_kinds ~w(message note kanban manual mission contract)
  @stop_reasons ~w(completed token_budget manual failed)
  @lease_default 30 * 60 * 1_000

  @select """
  id,vault_id,channel_id,title,brief,status,priority,source_kind,source_id,
  assignee_registration_id,lease_holder,lease_expires_at,repository,base_commit,branch,
  workspace_mode,worktree_path,pr_number,pr_url,pr_state,summary,verification,
  git_state_json,git_state_updated_at,contract,token_budget,tokens_used,stop_reason,
  created_by,created_at,updated_at
  """

  def list(user_id, vault_id, opts \\ []) do
    with :ok <- access(vault_id, user_id, false) do
      {where, params} = list_filters(vault_id, opts)

      items =
        SQL.all(
          "SELECT #{@select} FROM work_items #{where} ORDER BY priority DESC,updated_at DESC,rowid DESC",
          params
        )
        |> Enum.map(&hydrate/1)

      {:ok, items}
    end
  end

  def get(user_id, id, write? \\ false) do
    case row(id) do
      nil ->
        {:error, "Work item not found"}

      row ->
        with :ok <- access(Enum.at(row, 1), user_id, write?) do
          {:ok, hydrate(row)}
        end
    end
  end

  def create(user_id, vault_id, input) when is_map(input) do
    with :ok <- access(vault_id, user_id, true),
         title when title != "" <- clean(field(input, :title), 240),
         dependencies <- clean_ids(field(input, :dependsOn)),
         :ok <- validate_dependencies(vault_id, dependencies, nil) do
      id = Ecto.UUID.generate()
      priority = clamp(integer(field(input, :priority)), -100, 100)
      source_kind = enum(field(input, :sourceKind), @source_kinds, "manual")
      mode = enum(field(input, :workspaceMode), @modes, "shared")

      SQL.transaction(fn ->
        SQL.exec(
          """
          INSERT INTO work_items (
            id,vault_id,channel_id,title,brief,contract,priority,source_kind,source_id,
            assignee_registration_id,repository,base_commit,branch,workspace_mode,
            worktree_path,verification,token_budget,created_by
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          """,
          [
            id,
            vault_id,
            nil_if_blank(field(input, :channelId)),
            title,
            clean(field(input, :brief), 8_000),
            clean(field(input, :contract), 16_000),
            priority,
            source_kind,
            clean(field(input, :sourceId), 120),
            nil_if_blank(field(input, :assigneeRegistrationId)),
            clean(field(input, :repository), 500),
            clean(field(input, :baseCommit), 80),
            clean(field(input, :branch), 200),
            mode,
            clean(field(input, :worktreePath), 1_000),
            clean(field(input, :verification), 8_000),
            max(0, integer(field(input, :tokenBudget))),
            user_id
          ]
        )

        replace_dependencies(id, dependencies)
      end)

      get(user_id, id)
    else
      "" -> {:error, "Title is required"}
      {:error, _} = error -> error
    end
  end

  def update(user_id, id, patch) when is_map(patch) do
    with {:ok, current} <- get(user_id, id, true),
         {:ok, values} <- update_values(current, patch),
         dependencies <- optional_dependencies(patch),
         :ok <- validate_optional_dependencies(current.vaultId, dependencies, id) do
      SQL.transaction(fn ->
        SQL.exec(
          """
          UPDATE work_items SET title=?,brief=?,contract=?,status=?,priority=?,
            assignee_registration_id=?,repository=?,base_commit=?,branch=?,workspace_mode=?,
            worktree_path=?,pr_number=?,pr_url=?,pr_state=?,summary=?,verification=?,
            token_budget=?,tokens_used=?,stop_reason=?,updated_at=datetime('now') WHERE id=?
          """,
          values ++ [id]
        )

        if is_list(dependencies), do: replace_dependencies(id, dependencies)
      end)

      get(user_id, id)
    end
  end

  def report_git_state(user_id, id, input) do
    with {:ok, item} <- get(user_id, id, true),
         base when base != "" <- clean(field(input, :baseCommit), 80),
         branch when branch != "" <- clean(field(input, :branch), 200),
         {:ok, state} <- clean_git_state(field(input, :state)),
         :ok <-
           same_or_blank(
             item.baseCommit,
             base,
             "Reported base commit does not match this work item"
           ),
         :ok <-
           same_or_blank(item.branch, branch, "Reported branch does not match this work item"),
         true <- state.branch == branch do
      SQL.exec(
        """
        UPDATE work_items SET
          base_commit=CASE WHEN base_commit='' THEN ? ELSE base_commit END,
          branch=CASE WHEN branch='' THEN ? ELSE branch END,
          git_state_json=?,git_state_updated_at=datetime('now'),updated_at=datetime('now')
        WHERE id=?
        """,
        [base, branch, Jason.encode!(state), id]
      )

      get(user_id, id)
    else
      "" -> {:error, "A complete Git state, base commit, and branch are required"}
      false -> {:error, "Reported Git branch does not match the workspace branch"}
      {:error, _} = error -> error
    end
  end

  def bind_workspace(user_id, id, input) do
    with {:ok, item} <- get(user_id, id, true),
         true <- item.workspaceMode in ["isolated", "existing"],
         values <- %{
           repository: clean(field(input, :repository), 500),
           baseCommit: clean(field(input, :baseCommit), 80),
           branch: clean(field(input, :branch), 200),
           worktreePath: clean(field(input, :worktreePath), 1_000)
         },
         true <- Enum.all?(values, fn {_key, value} -> value != "" end),
         :ok <-
           same_or_blank(
             item.repository,
             values.repository,
             "Prepared repository does not match this work item"
           ),
         :ok <-
           same_or_blank(
             item.baseCommit,
             values.baseCommit,
             "Prepared base commit does not match this work item"
           ),
         :ok <-
           same_or_blank(
             item.branch,
             values.branch,
             "Prepared branch does not match this work item"
           ),
         :ok <-
           same_or_blank(
             item.worktreePath,
             values.worktreePath,
             "Prepared path does not match this work item"
           ) do
      SQL.exec(
        """
        UPDATE work_items SET
          repository=CASE WHEN repository='' THEN ? ELSE repository END,
          base_commit=CASE WHEN base_commit='' THEN ? ELSE base_commit END,
          branch=CASE WHEN branch='' THEN ? ELSE branch END,
          worktree_path=CASE WHEN worktree_path='' THEN ? ELSE worktree_path END,
          updated_at=datetime('now') WHERE id=?
        """,
        [values.repository, values.baseCommit, values.branch, values.worktreePath, id]
      )

      get(user_id, id)
    else
      false -> {:error, "Work item does not permit a managed workspace"}
      {:error, _} = error -> error
    end
  end

  def acquire_lease(user_id, id, holder, ttl_ms \\ @lease_default) do
    with {:ok, item} <- get(user_id, id, true),
         who when who != "" <- clean(holder, 120),
         false <- item.status in ["done", "canceled"],
         :ok <- lease_available(item, who) do
      expiry =
        DateTime.utc_now()
        |> DateTime.add(max(60_000, integer(ttl_ms)), :millisecond)
        |> DateTime.to_iso8601()

      status = if item.status in ["open", "leased"], do: "in_progress", else: item.status

      SQL.exec(
        "UPDATE work_items SET lease_holder=?,lease_expires_at=?,status=?,updated_at=datetime('now') WHERE id=?",
        [who, expiry, status, id]
      )

      get(user_id, id)
    else
      "" -> {:error, "Lease holder is required"}
      true -> {:error, "Work item is closed"}
      {:error, _} = error -> error
    end
  end

  def release_lease(user_id, id, holder \\ nil) do
    with {:ok, item} <- get(user_id, id, true),
         :ok <- holder_can_release(item, holder) do
      status = if item.status in ["in_progress", "leased"], do: "open", else: item.status

      SQL.exec(
        "UPDATE work_items SET lease_holder=NULL,lease_expires_at=NULL,status=?,updated_at=datetime('now') WHERE id=?",
        [status, id]
      )

      get(user_id, id)
    end
  end

  def reap_expired_leases(now \\ DateTime.utc_now() |> DateTime.to_iso8601()) do
    SQL.changes(
      """
      UPDATE work_items SET lease_holder=NULL,lease_expires_at=NULL,
        status=CASE WHEN status IN ('leased','in_progress') THEN 'open' ELSE status END,
        updated_at=datetime('now')
      WHERE lease_expires_at IS NOT NULL AND lease_expires_at<?
        AND status NOT IN ('done','canceled')
      """,
      [now]
    )
  end

  def link_run(user_id, id, run_id) do
    with {:ok, item} <- get(user_id, id, true),
         true <- is_integer(run_id) and run_id > 0,
         false <- item.status in ["done", "canceled"] or item.stopReason != "" do
      SQL.exec("INSERT OR IGNORE INTO work_item_runs (work_item_id,run_id) VALUES (?,?)", [
        id,
        run_id
      ])

      status = if item.status in ["open", "leased"], do: "in_progress", else: item.status

      SQL.exec("UPDATE work_items SET status=?,updated_at=datetime('now') WHERE id=?", [
        status,
        id
      ])

      get(user_id, id)
    else
      false -> {:error, "Invalid run id"}
      true -> {:error, "Work item is stopped"}
      {:error, _} = error -> error
    end
  end

  def stop(user_id, id, reason, summary \\ "") do
    with {:ok, item} <- get(user_id, id, true),
         true <- reason in @stop_reasons do
      if item.status in ["done", "canceled"] and item.stopReason != "" do
        {:ok, item}
      else
        status = if reason == "completed", do: "done", else: "canceled"
        summary = clean(summary, 4_000)

        SQL.exec(
          """
          UPDATE work_items SET status=?,stop_reason=?,
            summary=CASE WHEN ?!='' THEN ? ELSE summary END,
            lease_holder=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?
          """,
          [status, reason, summary, summary, id]
        )

        get(user_id, id)
      end
    else
      false -> {:error, "Stop reason is required"}
      {:error, _} = error -> error
    end
  end

  def add_token_usage(user_id, id, tokens) do
    with {:ok, item} <- get(user_id, id, true) do
      delta = max(0, integer(tokens))

      if delta > 0 and item.status not in ["done", "canceled"] do
        SQL.exec(
          "UPDATE work_items SET tokens_used=COALESCE(tokens_used,0)+?,updated_at=datetime('now') WHERE id=?",
          [delta, id]
        )
      end

      {:ok, updated} = get(user_id, id)

      if updated.tokenBudget > 0 and updated.tokensUsed >= updated.tokenBudget and
           updated.status not in ["done", "canceled"] do
        {:ok, stopped} =
          stop(
            user_id,
            id,
            "token_budget",
            "Token budget #{updated.tokenBudget} reached (#{updated.tokensUsed} used)."
          )

        {:ok, %{item: stopped, budgetExceeded: true}}
      else
        {:ok, %{item: updated, budgetExceeded: false}}
      end
    end
  end

  def linked_to_run(run_id) when is_integer(run_id) and run_id > 0 do
    SQL.all("SELECT work_item_id FROM work_item_runs WHERE run_id=?", [run_id]) |> Enum.map(&hd/1)
  end

  def linked_to_run(_), do: []

  def handoff(user_id, id, input) do
    with {:ok, _item} <- get(user_id, id, true),
         target when target != "" <- clean(field(input, :toRegistrationId), 120) do
      review_id = Ecto.UUID.generate()

      SQL.transaction(fn ->
        SQL.exec(
          """
          INSERT INTO work_item_reviews
            (id,work_item_id,from_registration_id,to_registration_id,note,status)
          VALUES (?,?,?,?,?,'requested')
          """,
          [
            review_id,
            id,
            nil_if_blank(field(input, :fromRegistrationId)),
            target,
            clean(field(input, :note), 2_000)
          ]
        )

        SQL.exec(
          """
          UPDATE work_items SET status='review',assignee_registration_id=?,
            lease_holder=NULL,lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?
          """,
          [target, id]
        )
      end)

      with {:ok, item} <- get(user_id, id),
           {:ok, reviews} <- reviews(user_id, id),
           review when not is_nil(review) <- Enum.find(reviews, &(&1.id == review_id)) do
        {:ok, %{item: item, review: review}}
      else
        _ -> {:error, "Review handoff was not persisted"}
      end
    else
      "" -> {:error, "Handoff target is required"}
      {:error, _} = error -> error
    end
  end

  def review(user_id, id, input) do
    with {:ok, item} <- get(user_id, id, true),
         kind when kind in ["comment", "change_request"] <- clean(field(input, :kind), 40),
         note when note != "" <- clean(field(input, :note), 8_000),
         base <- clean(field(input, :baseCommit), 80),
         head <- clean(field(input, :headCommit), 80),
         true <- item.baseCommit != "" and item.baseCommit == base,
         true <- is_map(item.gitState) and item.gitState.headCommit == head do
      review_id = Ecto.UUID.generate()
      status = if kind == "change_request", do: "requested", else: "done"
      line = positive_or_nil(field(input, :line))

      SQL.exec(
        """
        INSERT INTO work_item_reviews
          (id,work_item_id,kind,author_user_id,note,file_path,line,base_commit,head_commit,status)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        [
          review_id,
          id,
          kind,
          user_id,
          note,
          clean(field(input, :filePath), 1_000),
          line,
          base,
          head,
          status
        ]
      )

      {:ok, all} = reviews(user_id, id)
      {:ok, Enum.find(all, &(&1.id == review_id))}
    else
      kind when is_binary(kind) and kind not in ["comment", "change_request"] ->
        {:error, "Invalid review kind"}

      "" ->
        {:error, "Review comment is required"}

      false ->
        review_evidence_error(item_or_nil(user_id, id), input)

      {:error, _} = error ->
        error
    end
  end

  def reviews(user_id, id) do
    with {:ok, _item} <- get(user_id, id) do
      rows =
        SQL.all(
          """
          SELECT r.id,r.work_item_id,r.kind,r.author_user_id,COALESCE(u.username,''),
            r.from_registration_id,r.to_registration_id,r.note,r.file_path,r.line,
            r.base_commit,r.head_commit,r.status,r.created_at
          FROM work_item_reviews r LEFT JOIN users u ON u.id=r.author_user_id
          WHERE r.work_item_id=? ORDER BY r.created_at ASC,r.id ASC
          """,
          [id]
        )

      {:ok, Enum.map(rows, &review_map/1)}
    end
  end

  def siblings(user_id, id) do
    with {:ok, item} <- get(user_id, id) do
      if item.repository == "" do
        {:ok, []}
      else
        {:ok, all} = list(user_id, item.vaultId)

        {:ok,
         Enum.filter(
           all,
           &(&1.id != id and &1.repository == item.repository and
               &1.status not in ["done", "canceled"])
         )}
      end
    end
  end

  def account_terminal_run(run_id) do
    summary =
      case Store.get(run_id) do
        nil -> ""
        run -> run.summary || ""
      end

    estimate = max(800, div(String.length(summary) + 3, 4) + 400)

    Enum.each(linked_to_run(run_id), fn id ->
      case row(id) do
        nil ->
          :ok

        row ->
          user_id = Enum.at(row, 28)

          case add_token_usage(user_id, id, estimate) do
            {:ok, %{item: item, budgetExceeded: true}} ->
              Enum.each(item.runIds, fn linked_run ->
                if linked_run != run_id do
                  case Store.get(linked_run) do
                    %{status: status} when status in ["queued", "running"] ->
                      Store.cancel(linked_run)

                    _ ->
                      :ok
                  end
                end
              end)

            _ ->
              :ok
          end
      end
    end)
  end

  def readiness(input) do
    blockers = []

    blockers =
      if clean(field(input, :baseCommit), 80) == "",
        do: ["workspace base is not bound" | blockers],
        else: blockers

    blockers =
      if clean(field(input, :branch), 200) == "",
        do: ["workspace branch is not bound" | blockers],
        else: blockers

    git = field(input, :gitState)
    blockers = git_blockers(git, field(input, :branch), blockers)

    blockers =
      if clean(field(input, :verification), 8_000) == "",
        do: ["verification evidence is missing" | blockers],
        else: blockers

    blockers = Enum.reverse(blockers)
    %{ready: blockers == [], blockers: blockers}
  end

end
