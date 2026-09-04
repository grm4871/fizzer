defmodule CascadeWeb.SystemRoutes do
  @moduledoc "Compatibility catalog derived from CascadeWeb.SystemRouter."

  defdelegate catalog(), to: CascadeWeb.SystemRouter
end
