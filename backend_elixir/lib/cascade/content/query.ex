defmodule Cascade.Content.Query do
  @moduledoc false

  alias Cascade.DB.Repo
  alias Cascade.DB.WriteCoordinator
  alias Ecto.Adapters.SQL

  def all(sql, params \\ []) do
    WriteCoordinator.assert_read_only!(sql)
    SQL.query!(Repo, sql, params).rows
  end

  def one(sql, params \\ []) do
    case all(sql, params) do
      [row | _] -> row
      [] -> nil
    end
  end

  def execute(sql, params \\ []) do
    WriteCoordinator.with_lock(fn -> SQL.query!(Repo, sql, params) end)
  end

  def maps(sql, params, fields) do
    Enum.map(all(sql, params), &row_map(&1, fields))
  end

  def map(sql, params, fields) do
    case one(sql, params) do
      nil -> nil
      row -> row_map(row, fields)
    end
  end

  def row_map(row, fields), do: fields |> Enum.zip(row) |> Map.new()

  def transaction(fun) do
    WriteCoordinator.with_lock(fn -> Repo.transaction(fun, timeout: :infinity) end)
  end
end
