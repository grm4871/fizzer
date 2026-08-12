defmodule Cascade.Realtime.RunnerCallbacks do
  @moduledoc """
  Transport lifecycle callbacks for the durable runner coordinator.

  The domain implementation owns durable reclaim and restart reconciliation;
  this edge reports registrations, replacements, and disconnects without inventing run outcomes.
  """

  @callback registered(integer(), binary(), map(), map() | nil) :: any()
  @callback disconnected(integer(), binary(), map(), term()) :: any()
end

defmodule Cascade.Realtime.RunnerCallbacks.Noop do
  @moduledoc false
  @behaviour Cascade.Realtime.RunnerCallbacks

  @impl true
  def registered(_owner_id, _sid, _metadata, _previous), do: :ok

  @impl true
  def disconnected(_owner_id, _sid, _metadata, _reason), do: :ok
end
