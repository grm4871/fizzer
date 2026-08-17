defmodule Cascade.DB.Migration do
  @moduledoc false

  @callback version() :: pos_integer()
  @callback name() :: String.t()
  @callback statements() :: [String.t()]
  @callback checksum_material() :: term()
  @callback after_up() :: :ok

  defmacro __using__(_options) do
    quote do
      @behaviour Cascade.DB.Migration
      @impl true
      def checksum_material, do: statements()
      @impl true
      def after_up, do: :ok
      defoverridable checksum_material: 0, after_up: 0
    end
  end
end
