defmodule Cascade.WorkItemsTest do
  use ExUnit.Case, async: false

  alias Cascade.Accounts.SQL
  alias Cascade.WorkItems

  setup do
    Cascade.Accounts.Schema.ensure!()
    Cascade.Runs.Schema.ensure!()
    suffix = System.unique_integer([:positive])
    username = "work-items-#{suffix}"
    vault_id = "work-items-vault-#{suffix}"

    SQL.exec(
      "INSERT INTO users (username,password_hash,display_name,avatar_url) VALUES (?,?,?,?)",
      [username, "x", username, ""]
    )

    user_id = SQL.last_insert_id()

    SQL.exec("INSERT INTO vaults (id,name,root_path,created_by) VALUES (?,?,?,?)", [
      vault_id,
      "Work items",
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

    %{user_id: user_id, vault_id: vault_id}
  end

  test "dependencies, immutable workspace binding, leases, and token stops are durable",
       context do
    assert {:ok, dependency} =
             WorkItems.create(context.user_id, context.vault_id, %{title: "Dependency"})

    assert {:ok, item} =
             WorkItems.create(context.user_id, context.vault_id, %{
               title: "Candidate",
               dependsOn: [dependency.id],
               workspaceMode: "isolated",
               tokenBudget: 100
             })

    assert item.dependsOn == [dependency.id]

    assert {:error, "A work item cannot depend on itself"} =
             WorkItems.update(context.user_id, item.id, %{dependsOn: [item.id]})

    binding = %{
      repository: "org/repo",
      baseCommit: String.duplicate("a", 40),
      branch: "work/candidate",
      worktreePath: "/tmp/candidate"
    }

    assert {:ok, bound} = WorkItems.bind_workspace(context.user_id, item.id, binding)
    assert bound.repository == "org/repo"

    assert {:error, "Prepared branch does not match this work item"} =
             WorkItems.bind_workspace(context.user_id, item.id, %{binding | branch: "other"})

    assert {:ok, leased} =
             WorkItems.acquire_lease(context.user_id, item.id, "worker-a", 60_000)

    assert leased.status == "in_progress"

    assert {:error, lease_error} =
             WorkItems.acquire_lease(context.user_id, item.id, "worker-b", 60_000)

    assert lease_error =~ "Work item is leased by worker-a until "

    assert {:ok, %{budgetExceeded: true, item: stopped}} =
             WorkItems.add_token_usage(context.user_id, item.id, 100)

    assert stopped.status == "canceled"
    assert stopped.stopReason == "token_budget"
    assert stopped.leaseHolder == nil
  end

  test "review evidence is tied to the bound base and reported head", context do
    base = String.duplicate("b", 40)
    head = String.duplicate("c", 40)

    assert {:ok, item} =
             WorkItems.create(context.user_id, context.vault_id, %{
               title: "Reviewable",
               baseCommit: base,
               branch: "work/review",
               verification: "mix test"
             })

    state = %{
      branch: "work/review",
      headCommit: head,
      baseBranch: "main",
      ahead: 1,
      behind: 0,
      dirty: false,
      changedFiles: 1,
      hasUpstream: true
    }

    assert {:ok, reported} =
             WorkItems.report_git_state(context.user_id, item.id, %{
               baseCommit: base,
               branch: "work/review",
               state: state
             })

    assert reported.reviewReadiness.ready

    assert {:ok, review} =
             WorkItems.review(context.user_id, item.id, %{
               kind: "comment",
               note: "Looks correct",
               baseCommit: base,
               headCommit: head
             })

    assert review.status == "done"

    assert {:error, "Review head does not match the latest desktop Git evidence"} =
             WorkItems.review(context.user_id, item.id, %{
               kind: "comment",
               note: "Stale",
               baseCommit: base,
               headCommit: String.duplicate("d", 40)
             })
  end
end
