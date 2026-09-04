defmodule CascadeWeb.ChatRoutes do
  @moduledoc "Compatibility catalog derived from CascadeWeb.ChatRouter."

  defdelegate catalog(), to: CascadeWeb.ChatRouter
end
