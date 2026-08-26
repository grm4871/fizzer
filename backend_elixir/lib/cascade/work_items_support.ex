defmodule Cascade.WorkItems.Support do
  @moduledoc """
  Rows, leases, dependency validation, and wire-shape helpers for work items.

  Helpers enforce immutable dependency membership and lease-holder ownership
  while keeping hydrated fields in the established camelCase wire format.
  """

  alias Cascade.Accounts.{SQL, VaultMembers}

  @statuses ~w(open leased in_progress review blocked done canceled)
  @modes ~w(shared isolated existing)
  @source_kinds ~w(message note kanban manual mission contract)
  @stop_reasons ~w(completed token_budget manual failed)
  @select """
  id,vault_id,channel_id,title,brief,status,priority,source_kind,source_id,
  assignee_registration_id,lease_holder,lease_expires_at,repository,base_commit,branch,
  workspace_mode,worktree_path,pr_number,pr_url,pr_state,summary,verification,
  git_state_json,git_state_updated_at,contract,token_budget,tokens_used,stop_reason,
  created_by,created_at,updated_at
  """

    def hydrate(row) do
      [
        id,
        vault_id,
        channel_id,
        title,
        brief,
        status,
        priority,
        source_kind,
        source_id,
        assignee,
        lease_holder,
        lease_expires,
        repository,
        base_commit,
        branch,
        workspace_mode,
        worktree_path,
        pr_number,
        pr_url,
        pr_state,
        summary,
        verification,
        git_json,
        git_updated,
        contract,
        token_budget,
        tokens_used,
        stop_reason,
        created_by,
        created_at,
        updated_at
      ] = row
  
      git_state = parse_git_state(git_json)
  
      %{
        id: id,
        vaultId: vault_id,
        channelId: channel_id,
        title: title,
        brief: brief || "",
        contract: contract || "",
        status: enum(status, @statuses, "open"),
        priority: priority || 0,
        sourceKind: enum(source_kind, @source_kinds, ""),
        sourceId: source_id || "",
        assigneeRegistrationId: assignee,
        leaseHolder: lease_holder,
        leaseExpiresAt: lease_expires,
        repository: repository || "",
        baseCommit: base_commit || "",
        branch: branch || "",
        workspaceMode: enum(workspace_mode, @modes, "shared"),
        worktreePath: worktree_path || "",
        prNumber: pr_number,
        prUrl: pr_url || "",
        prState: pr_state || "",
        summary: summary || "",
        verification: verification || "",
        gitState: git_state,
        gitStateUpdatedAt: git_updated,
        reviewReadiness:
          Cascade.WorkItems.readiness(%{
            baseCommit: base_commit,
            branch: branch,
            verification: verification,
            gitState: git_state
          }),
        tokenBudget: max(0, integer(token_budget)),
        tokensUsed: max(0, integer(tokens_used)),
        stopReason: enum(stop_reason, @stop_reasons, ""),
        dependsOn: dependency_ids(id),
        runIds: run_ids(id),
        createdBy: created_by,
        createdAt: created_at,
        updatedAt: updated_at
      }
    end
  
    def update_values(current, patch) do
      title = if present?(patch, :title), do: clean(field(patch, :title), 240), else: current.title
      status = if present?(patch, :status), do: field(patch, :status), else: current.status
  
      mode =
        if present?(patch, :workspaceMode),
          do: field(patch, :workspaceMode),
          else: current.workspaceMode
  
      cond do
        title == "" ->
          {:error, "Title is required"}
  
        status not in @statuses ->
          {:error, "Invalid status"}
  
        mode not in @modes ->
          {:error, "Invalid workspace mode"}
  
        true ->
          {:ok,
           [
             title,
             patch_text(patch, :brief, current.brief, 8_000),
             patch_text(patch, :contract, current.contract, 16_000),
             status,
             patch_integer(patch, :priority, current.priority, -100, 100),
             patch_nullable(patch, :assigneeRegistrationId, current.assigneeRegistrationId),
             patch_text(patch, :repository, current.repository, 500),
             patch_text(patch, :baseCommit, current.baseCommit, 80),
             patch_text(patch, :branch, current.branch, 200),
             mode,
             patch_text(patch, :worktreePath, current.worktreePath, 1_000),
             patch_nullable_integer(patch, :prNumber, current.prNumber),
             patch_text(patch, :prUrl, current.prUrl, 500),
             patch_text(patch, :prState, current.prState, 80),
             patch_text(patch, :summary, current.summary, 4_000),
             patch_text(patch, :verification, current.verification, 8_000),
             patch_integer(patch, :tokenBudget, current.tokenBudget, 0, 9_223_372_036_854_775_807),
             patch_integer(patch, :tokensUsed, current.tokensUsed, 0, 9_223_372_036_854_775_807),
             patch_text(patch, :stopReason, current.stopReason, 40)
           ]}
      end
    end
  
    def access(vault_id, user_id, write?) do
      role = VaultMembers.role(vault_id, user_id)
  
      cond do
        is_nil(role) -> {:error, if(write?, do: "Vault not writable", else: "Vault not found")}
        write? and not VaultMembers.can_write?(role) -> {:error, "Vault not writable"}
        true -> :ok
      end
    end
  
    def row(id), do: SQL.one("SELECT #{@select} FROM work_items WHERE id=?", [id])
  
    def dependency_ids(id),
      do:
        SQL.all("SELECT depends_on_id FROM work_item_dependencies WHERE work_item_id=?", [id])
        |> Enum.map(&hd/1)
  
    def run_ids(id),
      do:
        SQL.all("SELECT run_id FROM work_item_runs WHERE work_item_id=? ORDER BY linked_at ASC", [
          id
        ])
        |> Enum.map(&hd/1)
  
    def replace_dependencies(id, dependencies) do
      SQL.exec("DELETE FROM work_item_dependencies WHERE work_item_id=?", [id])
  
      Enum.each(
        dependencies,
        &SQL.exec("INSERT INTO work_item_dependencies (work_item_id,depends_on_id) VALUES (?,?)", [
          id,
          &1
        ])
      )
    end
  
    def validate_dependencies(_vault_id, [], _id), do: :ok
  
    def validate_dependencies(vault_id, dependencies, id) do
      cond do
        id in dependencies ->
          {:error, "A work item cannot depend on itself"}
  
        true ->
          placeholders = Enum.map_join(dependencies, ",", fn _ -> "?" end)
  
          found =
            SQL.one(
              "SELECT COUNT(*) FROM work_items WHERE vault_id=? AND id IN (#{placeholders})",
              [vault_id | dependencies]
            )
            |> hd()
  
          if found == length(dependencies),
            do: :ok,
            else: {:error, "Every dependency must be a work item in this vault"}
      end
    end
  
    def validate_optional_dependencies(_vault_id, nil, _id), do: :ok
  
    def validate_optional_dependencies(vault_id, deps, id),
      do: validate_dependencies(vault_id, deps, id)
  
    def optional_dependencies(patch),
      do: if(present?(patch, :dependsOn), do: clean_ids(field(patch, :dependsOn)), else: nil)
  
    def clean_ids(values),
      do:
        values |> List.wrap() |> Enum.map(&clean(&1, 80)) |> Enum.reject(&(&1 == "")) |> Enum.uniq()
  
    def list_filters(vault_id, opts) do
      channel = Keyword.get(opts, :channel_id)
      status = Keyword.get(opts, :status)
      base = {"WHERE vault_id=?", [vault_id]}
  
      base =
        if is_binary(channel) and channel != "",
          do: {elem(base, 0) <> " AND channel_id=?", elem(base, 1) ++ [channel]},
          else: base
  
      if status in @statuses,
        do: {elem(base, 0) <> " AND status=?", elem(base, 1) ++ [status]},
        else: base
    end
  
    def clean_git_state(value) when is_map(value) do
      head = clean(field(value, :headCommit), 80)
      base = clean(field(value, :baseBranch), 200)
      branch = clean(field(value, :branch), 200)
  
      if head == "" or base == "" or branch == "" do
        {:error, "A complete Git state, base commit, and branch are required"}
      else
        {:ok,
         %{
           headCommit: head,
           baseBranch: base,
           branch: branch,
           changedFiles: max(0, integer(field(value, :changedFiles))),
           dirty: field(value, :dirty) == true,
           ahead: max(0, integer(field(value, :ahead))),
           behind: max(0, integer(field(value, :behind))),
           unpushed: max(0, integer(field(value, :unpushed))),
           hasUpstream: field(value, :hasUpstream) == true
         }}
      end
    end
  
    def clean_git_state(_),
      do: {:error, "A complete Git state, base commit, and branch are required"}
  
    def parse_git_state(value) when is_binary(value) and value != "" do
      with {:ok, decoded} <- Jason.decode(value),
           {:ok, state} <- clean_git_state(decoded) do
        state
      else
        _ -> nil
      end
    end
  
    def parse_git_state(_), do: nil
  
    def git_blockers(nil, _branch, blockers),
      do: ["Git state has not been reported by a desktop workspace" | blockers]
  
    def git_blockers(git, branch, blockers) do
      blockers =
        if field(git, :branch) != branch,
          do: ["reported branch does not match the bound workspace" | blockers],
          else: blockers
  
      blockers =
        if field(git, :dirty) == true,
          do: ["working tree has uncommitted changes" | blockers],
          else: blockers
  
      behind = integer(field(git, :behind))
  
      blockers =
        if behind > 0,
          do: [
            "workspace is #{behind} commit#{if behind == 1, do: "", else: "s"} behind its base"
            | blockers
          ],
          else: blockers
  
      if integer(field(git, :changedFiles)) == 0,
        do: ["no base-relative changes were found" | blockers],
        else: blockers
    end
  
    def review_map([
           id,
           work_item_id,
           kind,
           author_id,
           username,
           from_id,
           to_id,
           note,
           path,
           line,
           base,
           head,
           status,
           created
         ]) do
      %{
        id: id,
        workItemId: work_item_id,
        kind: if(kind in ["comment", "change_request"], do: kind, else: "handoff"),
        authorUserId: author_id,
        authorUsername: username,
        fromRegistrationId: from_id,
        toRegistrationId: to_id,
        note: note,
        filePath: path || "",
        line: line,
        baseCommit: base || "",
        headCommit: head || "",
        status: status,
        createdAt: created
      }
    end
  
    def lease_available(item, who) do
      if item.leaseHolder && not lease_expired?(item.leaseExpiresAt) && item.leaseHolder != who,
        do: {:error, "Work item is leased by #{item.leaseHolder} until #{item.leaseExpiresAt}"},
        else: :ok
    end
  
    def lease_expired?(nil), do: true
  
    def lease_expired?(iso) do
      case DateTime.from_iso8601(iso) do
        {:ok, dt, _} -> DateTime.compare(dt, DateTime.utc_now()) != :gt
        _ -> true
      end
    end
  
    def holder_can_release(item, holder)
         when is_binary(holder) and holder != "" and is_binary(item.leaseHolder) and
                item.leaseHolder != holder,
         do: {:error, "Only the lease holder can release this lease"}
  
    def holder_can_release(_item, _holder), do: :ok
  
    def same_or_blank(existing, next, message),
      do: if(existing in [nil, ""] or existing == next, do: :ok, else: {:error, message})
  
    def review_evidence_error(item, input) do
      base = clean(field(input, :baseCommit), 80)
  
      if item && (item.baseCommit == "" or base != item.baseCommit),
        do: {:error, "Review base does not match this work item"},
        else: {:error, "Review head does not match the latest desktop Git evidence"}
    end
  
    def item_or_nil(user_id, id) do
      case Cascade.WorkItems.get(user_id, id) do
        {:ok, item} -> item
        _ -> nil
      end
    end
  
    def present?(map, key), do: Map.has_key?(map, key) or Map.has_key?(map, Atom.to_string(key))
    def field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))
  
    def patch_text(patch, key, old, max),
      do: if(present?(patch, key), do: clean(field(patch, key), max), else: old)
  
    def patch_nullable(patch, key, old),
      do: if(present?(patch, key), do: nil_if_blank(field(patch, key)), else: old)
  
    def patch_nullable_integer(patch, key, old),
      do: if(present?(patch, key), do: positive_or_nil(field(patch, key)), else: old)
  
    def patch_integer(patch, key, old, min, max),
      do: if(present?(patch, key), do: clamp(integer(field(patch, key)), min, max), else: old)
  
    def positive_or_nil(value), do: if(integer(value) > 0, do: integer(value), else: nil)
    def integer(value) when is_integer(value), do: value
    def integer(value) when is_float(value), do: floor(value)
    def integer(_), do: 0
    def clamp(value, min, max), do: value |> Kernel.max(min) |> Kernel.min(max)
    def enum(value, allowed, fallback), do: if(value in allowed, do: value, else: fallback)
    def clean(nil, _max), do: ""
    def clean(value, max), do: value |> to_string() |> String.trim() |> String.slice(0, max)
  
    def nil_if_blank(value) do
      case clean(value, 10_000) do
        "" -> nil
        text -> text
      end
    end
end
