defmodule CascadeWeb.SystemRoutes do
  @moduledoc "Explicit parity catalog for installer downloads."

  @routes [
    {"GET", "/api/system/android-update"},
    {"GET", "/download/android"},
    {"GET", "/download/mac"},
    {"GET", "/download/linux"},
    {"GET", "/download/:platform"}
  ]

  def catalog, do: @routes
end
