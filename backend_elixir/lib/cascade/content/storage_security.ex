defmodule Cascade.Content.StorageSecurity do
  @moduledoc """
  Centralizes managed vault roots and path containment.

  Every filesystem path is expanded and checked beneath its vault root; invalid
  path segments raise instead of being silently rewritten.
  """

  def vaults_base_dir do
    case System.get_env("CASCADE_VAULTS_BASE_DIR", "") |> String.trim() do
      "" -> Path.join([System.user_home!(), ".cascade", "vaults"])
      configured -> Path.expand(configured)
    end
  end

  def sanitize_filename(title) do
    value =
      title
      |> to_string()
      |> String.replace(~r{[<>:"/\\|?*\x00-\x1f]}u, "_")
      |> String.replace(~r/\s+/u, " ")
      |> String.trim()

    if value == "", do: "Untitled", else: value
  end

  def sanitize_path_segment(name) do
    raw = name |> to_string() |> String.trim()

    if raw == "" or raw in [".", ".."] or String.contains?(raw, ["/", "\\"]) do
      raise ArgumentError, "Invalid folder or file name"
    end

    cleaned =
      raw
      |> sanitize_filename()
      |> String.replace(~r/^\.+/u, "")
      |> String.trim()

    if cleaned == "" or cleaned in [".", ".."] or String.starts_with?(cleaned, "..") do
      raise ArgumentError, "Invalid folder or file name"
    end

    cleaned
  end

  def resolve_under_vault(vault_root, parts) when is_list(parts) do
    root = Path.expand(vault_root)
    resolved = Path.expand(Path.join([root | parts]))

    if resolved == root or String.starts_with?(resolved, root <> "/") do
      resolved
    else
      raise ArgumentError, "Path escapes vault root"
    end
  end
end
