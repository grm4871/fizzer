defmodule Cascade.Accounts.Bootstrap do
  @moduledoc "Optional supervisor child that applies account/social semantic migrations before mounting routes."

  use GenServer

  def start_link(options), do: GenServer.start_link(__MODULE__, options, name: __MODULE__)

  @impl true
  def init(_options) do
    :ok = Cascade.Accounts.Schema.ensure!()
    {:ok, %{migrated_at: DateTime.utc_now()}}
  end
end
