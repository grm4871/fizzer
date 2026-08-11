defmodule Mix.Tasks.Cascade.Parity do
  use Mix.Task

  @shortdoc "Reports the embedded implementation gate for the Elixir backend"

  @impl true
  def run(_args) do
    Mix.shell().info("Implemented HTTP contracts:")

    CascadeWeb.RouteCatalog.implemented()
    |> Enum.sort()
    |> Enum.each(fn {method, path} -> Mix.shell().info("  #{method} #{path}") end)

    Mix.shell().info("Required realtime contracts:")
    Enum.each(CascadeWeb.RouteCatalog.required_realtime(), &Mix.shell().info("  #{&1}"))

    unless apply(CascadeWeb.RouteCatalog, :swap_ready?, []) do
      Mix.raise("Elixir backend implementation is not approved for certification")
    end
  end
end
