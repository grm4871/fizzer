defmodule CascadeWeb.OrchestrationRoutes do
  @moduledoc "Compatibility catalog derived from CascadeWeb.OrchestrationRouter."

  defdelegate catalog(), to: CascadeWeb.OrchestrationRouter
  def all, do: catalog()
  def count, do: length(catalog())
end
