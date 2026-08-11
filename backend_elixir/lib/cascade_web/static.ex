defmodule CascadeWeb.Static do
  @moduledoc "Vite asset and SPA serving with the current cache-control contract."

  # These contracts are implemented by the safe static/SPA fallback rather
  # than Plug.Router macros, so the parity extractor records them explicitly.
  # parity-route GET /
  # parity-route GET /download
  # parity-route GET *

  import Plug.Conn

  @one_year_seconds 365 * 24 * 60 * 60
  @reserved_prefixes ["/api/", "/socket.io/", "/p/"]

  def serve(conn) do
    root = Application.fetch_env!(:cascade_elixir, :client_dist_dir) |> Path.expand()

    cond do
      reserved?(conn.request_path) -> :not_found
      conn.request_path in ["/", "/download"] -> serve_landing_or_app(conn, root)
      true -> serve_asset_or_app(conn, root)
    end
  end

  def cache_control(path) do
    normalized = String.replace(path, "\\", "/")

    cond do
      String.contains?(normalized, "/assets/") ->
        "public, max-age=#{@one_year_seconds}, immutable"

      Path.basename(normalized) == "version.json" ->
        "no-store"

      String.ends_with?(normalized, ".html") ->
        "no-cache"

      true ->
        nil
    end
  end

  defp serve_landing_or_app(conn, root) do
    case safe_regular_file(root, "landing.html") do
      {:ok, path} -> send_static(conn, path)
      :error -> serve_app(conn, root)
    end
  end

  defp serve_asset_or_app(conn, root) do
    relative = conn.path_info |> Enum.join("/")

    case safe_regular_file(root, relative) do
      {:ok, path} -> send_static(conn, path)
      :error -> serve_app(conn, root)
    end
  end

  defp serve_app(conn, root) do
    case safe_regular_file(root, "app.html") do
      {:ok, path} -> send_static(conn, path)
      :error -> :not_found
    end
  end

  defp send_static(conn, path) do
    conn =
      conn
      |> put_resp_content_type(MIME.from_path(path))
      |> maybe_put_cache(path)

    {:served, send_file(conn, 200, path)}
  end

  defp maybe_put_cache(conn, path) do
    case cache_control(path) do
      nil -> conn
      value -> put_resp_header(conn, "cache-control", value)
    end
  end

  defp safe_regular_file(root, relative) do
    candidate = Path.expand(relative, root)

    if within_root?(candidate, root) and File.regular?(candidate) do
      {:ok, candidate}
    else
      :error
    end
  end

  defp within_root?(candidate, root),
    do: candidate == root or String.starts_with?(candidate, root <> "/")

  defp reserved?(path) do
    path == "/oembed" or Enum.any?(@reserved_prefixes, &String.starts_with?(path, &1))
  end
end
