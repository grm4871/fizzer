defmodule Cascade.DB.Bootstrap do
  @moduledoc false

  use GenServer

  def start_link(_options), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
    Cascade.DB.Migrator.run!()
    {:ok, %{migrated_at: DateTime.utc_now()}}
  end
end
