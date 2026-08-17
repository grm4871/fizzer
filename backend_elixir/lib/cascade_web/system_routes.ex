defmodule CascadeWeb.SystemRoutes do
  @moduledoc "Explicit parity catalog for deploy control and installer downloads."

  @routes [
    {"POST", "/api/deploy"},
    {"POST", "/api/admin/deploy"},
    {"GET", "/api/deploy/status"},
    {"GET", "/api/admin/deploy/status"},
    {"GET", "/api/system/android-update"},
    {"GET", "/download/android"},
    {"GET", "/download/mac"},
    {"GET", "/download/linux"},
    {"GET", "/download/:platform"}
  ]

  def catalog, do: @routes
end
