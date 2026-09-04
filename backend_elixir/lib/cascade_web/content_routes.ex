defmodule CascadeWeb.ContentRoutes do
  @moduledoc "Compatibility catalog derived from CascadeWeb.ContentRouter."

  defdelegate catalog(), to: CascadeWeb.ContentRouter
end
