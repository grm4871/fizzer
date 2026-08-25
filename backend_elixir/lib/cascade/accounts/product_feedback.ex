defmodule Cascade.Accounts.ProductFeedback do
  @moduledoc "Authenticated product feedback submitted from the in-app guide assistant."

  alias Cascade.Accounts.SQL
  alias Cascade.Auth.Accounts

  @statuses ~w(open dismissed resolved)
  @max_body 4_000

  def status?(value), do: value in @statuses
  def server_owner?(user_id), do: Accounts.owner?(user_id)

  def create(user_id, input) do
    body = input[:body] || input["body"] || ""
    body = body |> to_string() |> String.trim()
    source = clean(input[:source] || input["source"], 80)
    surface = clean(input[:surface] || input["surface"], 120)

    cond do
      body == "" ->
        {:error, "Feedback is required"}

      String.length(body) > @max_body ->
        {:error, "Feedback must be 4,000 characters or fewer"}

      true ->
        SQL.exec(
          "INSERT INTO product_feedback (reporter_user_id, body, source, surface) VALUES (?, ?, ?, ?)",
          [user_id, body, source, surface]
        )

        {:ok, get(SQL.last_insert_id())}
    end
  end

  def list(actor_id, status) do
    if not server_owner?(actor_id) do
      {:error, "Owner only"}
    else
      requested = if status in [nil, ""], do: "open", else: status

      if requested != "all" and not status?(requested) do
        {:error, "Invalid feedback status"}
      else
        filter = if requested == "all", do: "", else: "WHERE f.status = ?"
        params = if requested == "all", do: [], else: [requested]

        rows =
          SQL.all(
            """
            SELECT f.id, f.body, f.source, f.surface, f.status, f.created_at,
                   f.reviewed_at, f.reviewed_by, u.username,
                   COALESCE(NULLIF(u.display_name, ''), u.username)
            FROM product_feedback f
            JOIN users u ON u.id = f.reporter_user_id
            #{filter}
            ORDER BY f.created_at DESC, f.id DESC
            """,
            params
          )

        {:ok, Enum.map(rows, &feedback_row/1)}
      end
    end
  end

  def review(id, actor_id, action) do
    cond do
      not server_owner?(actor_id) ->
        {:error, "Owner only"}

      not is_integer(id) or id < 1 ->
        {:error, "Invalid feedback id"}

      action not in ["dismiss", "resolve"] ->
        {:error, "Invalid feedback action"}

      SQL.changes(
        "UPDATE product_feedback SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?",
        [if(action == "resolve", do: "resolved", else: "dismissed"), actor_id, id]
      ) == 0 ->
        {:error, "Feedback not found"}

      true ->
        {:ok, get(id)}
    end
  end

  defp get(id) do
    SQL.one(
      """
      SELECT f.id, f.body, f.source, f.surface, f.status, f.created_at,
             f.reviewed_at, f.reviewed_by, u.username,
             COALESCE(NULLIF(u.display_name, ''), u.username)
      FROM product_feedback f
      JOIN users u ON u.id = f.reporter_user_id
      WHERE f.id = ?
      """,
      [id]
    )
    |> case do
      nil -> nil
      row -> feedback_row(row)
    end
  end

  defp feedback_row([
         id,
         body,
         source,
         surface,
         status,
         created_at,
         reviewed_at,
         reviewed_by,
         username,
         display_name
       ]) do
    %{
      id: id,
      body: body,
      source: source,
      surface: surface,
      status: status,
      createdAt: created_at,
      reviewedAt: reviewed_at,
      reviewedBy: reviewed_by,
      reporterUsername: username,
      reporterDisplayName: display_name
    }
  end

  defp clean(value, max) do
    value
    |> to_string()
    |> String.trim()
    |> String.slice(0, max)
  end
end
