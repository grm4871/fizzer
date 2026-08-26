defmodule CascadeWeb.OrchestrationWorkItemController do
  @moduledoc "HTTP endpoints for work-item lifecycle, leases, reviews, and run links."

  alias Cascade.Accounts.VaultMembers
  alias Cascade.Auth.Session
  alias Cascade.Runs.Store
  alias Cascade.WorkItems
  alias CascadeWeb.JSON
  import CascadeWeb.OrchestrationHTTP

  def list_work_items(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      opts =
        []
        |> maybe_option(:channel_id, conn.query_params["channelId"])
        |> maybe_option(:status, conn.query_params["status"])

      respond(conn, WorkItems.list(user.id, vault_id, opts), 200, :items, 404)
    end)
  end

  def create_work_item(conn, vault_id) do
    authenticated(conn, fn conn, user ->
      respond(conn, WorkItems.create(user.id, vault_id, body(conn)), 201, :item)
    end)
  end

  def get_work_item(conn, id) do
    authenticated(conn, fn conn, user ->
      with {:ok, item} <- WorkItems.get(user.id, id),
           {:ok, reviews} <- WorkItems.reviews(user.id, id),
           {:ok, siblings} <- WorkItems.siblings(user.id, id) do
        JSON.send(conn, 200, %{item: item, reviews: reviews, siblings: siblings})
      else
        {:error, message} -> JSON.send(conn, 404, %{error: message})
      end
    end)
  end

  def update_work_item(conn, id),
    do: work_action(conn, fn user -> WorkItems.update(user.id, id, body(conn)) end, 200, :item)

  def report_git_state(conn, id),
    do:
      work_action(
        conn,
        fn user -> WorkItems.report_git_state(user.id, id, body(conn)) end,
        200,
        :item
      )

  def lease_work_item(conn, id) do
    work_action(
      conn,
      fn user ->
        WorkItems.acquire_lease(
          user.id,
          id,
          body(conn)["holder"] || user.username || to_string(user.id),
          body(conn)["ttlMs"] || 30 * 60 * 1_000
        )
      end,
      200,
      :item
    )
  end

  def release_work_item(conn, id),
    do:
      work_action(
        conn,
        fn user -> WorkItems.release_lease(user.id, id, body(conn)["holder"]) end,
        200,
        :item
      )

  def link_work_item_run(conn, id),
    do:
      work_action(
        conn,
        fn user -> WorkItems.link_run(user.id, id, body(conn)["runId"]) end,
        200,
        :item
      )

  def handoff_work_item(conn, id),
    do: work_action(conn, fn user -> WorkItems.handoff(user.id, id, body(conn)) end, 201, nil)

  def review_work_item(conn, id),
    do: work_action(conn, fn user -> WorkItems.review(user.id, id, body(conn)) end, 201, :review)

  def stop_work_item(conn, id) do
    work_action(
      conn,
      fn user ->
        reason =
          if body(conn)["reason"] in ["completed", "token_budget", "failed"],
            do: body(conn)["reason"],
            else: "manual"

        case WorkItems.stop(user.id, id, reason, body(conn)["summary"] || "") do
          {:ok, item} = result ->
            Enum.each(item.runIds, fn run_id ->
              case Store.get(run_id) do
                %{status: status} when status in ["queued", "running"] -> Store.cancel(run_id)
                _ -> :ok
              end
            end)

            result

          error ->
            error
        end
      end,
      200,
      :item
    )
  end
  defp work_action(conn, callback, status, key) do
    authenticated(conn, fn conn, user ->
      case callback.(user) do
        {:ok, value} when is_nil(key) -> JSON.send(conn, status, value)
        {:ok, value} -> JSON.send(conn, status, %{key => value})
        {:error, message} -> JSON.send(conn, 400, %{error: message})
      end
    end)
  end

end
