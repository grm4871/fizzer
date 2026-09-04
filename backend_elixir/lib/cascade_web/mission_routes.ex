defmodule CascadeWeb.MissionRoutes do
  @moduledoc "Compatibility catalog derived from CascadeWeb.MissionRouter."

  defdelegate catalog(), to: CascadeWeb.MissionRouter
  def count, do: length(catalog())
end
