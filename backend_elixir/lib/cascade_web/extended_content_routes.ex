defmodule CascadeWeb.ExtendedContentRoutes do
  @moduledoc "Compatibility catalog derived from CascadeWeb.ExtendedContentRouter."

  defdelegate catalog(), to: CascadeWeb.ExtendedContentRouter
end
