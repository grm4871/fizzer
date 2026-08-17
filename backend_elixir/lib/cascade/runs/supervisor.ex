defmodule Cascade.Runs.Supervisor do
  @moduledoc false
  use Supervisor

  def start_link(opts \\ []), do: Supervisor.start_link(__MODULE__, opts, name: __MODULE__)

  @impl true
  def init(opts) do
    opts =
      Keyword.put_new(
        opts,
        :orphan_reclaim_ms,
        Application.fetch_env!(:cascade_elixir, :runner_orphan_reclaim_ms)
      )

    children = [{Cascade.Runs.RunnerLifecycle, opts}]
    Supervisor.init(children, strategy: :one_for_one)
  end
end
