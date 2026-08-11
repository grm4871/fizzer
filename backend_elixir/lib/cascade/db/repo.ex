defmodule Cascade.DB.Repo do
  use Ecto.Repo,
    otp_app: :cascade_elixir,
    adapter: Ecto.Adapters.SQLite3

  def healthcheck do
    case Ecto.Adapters.SQL.query(__MODULE__, "SELECT 1", []) do
      {:ok, %{rows: [[1]]}} -> :ok
      {:ok, result} -> {:error, {:unexpected_result, result}}
      {:error, error} -> {:error, error}
    end
  end
end
