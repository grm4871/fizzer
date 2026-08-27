defmodule CascadeWeb.SystemRouter do
  @moduledoc "Deploy-control and installer-download routes retained across the backend swap."

  use Plug.Router

  import Plug.Conn

  alias CascadeWeb.JSON

  @desktop_builds %{
    "mac-arm64" => "Fizzer-mac-arm64.dmg",
    "mac-x64" => "Fizzer-mac-x64.dmg",
    "windows" => "Fizzer-Setup.exe",
    "linux-deb" => "Fizzer-linux-x64.deb",
    "linux-rpm" => "Fizzer-linux-x64.rpm"
  }
  @android_version_code 11
  @android_version_name "beta-2026.08.27-mobile-vault-rail"

  plug :put_domain_options
  plug :match

  plug Plug.Parsers,
    parsers: [:json],
    pass: ["*/*"],
    json_decoder: Jason,
    length: 12 * 1_024 * 1_024

  plug :dispatch

  post "/api/deploy", do: queue_deploy(conn)
  post "/api/admin/deploy", do: queue_deploy(conn)
  get "/api/deploy/status", do: deploy_status(conn)
  get "/api/admin/deploy/status", do: deploy_status(conn)

  get "/download/android", do: android_download(conn)
  get "/api/system/android-update", do: android_update(conn)
  get "/download/mac", do: chooser(conn, "Download Fizzer for macOS", mac_choices())
  get "/download/linux", do: chooser(conn, "Download Fizzer for Linux", linux_choices())
  get "/download/:platform", do: desktop_download(conn, platform)

  match _, do: JSON.send(conn, 404, %{error: "Not found"})

  defp queue_deploy(conn) do
    with :ok <- deploy_auth(conn) do
      ref = body(conn, "ref") |> clean_ref()

      payload =
        Jason.encode!(%{requestedAt: DateTime.utc_now() |> DateTime.to_iso8601(), ref: ref})

      case File.write(request_file(conn), payload <> "\n") do
        :ok -> JSON.send(conn, 202, %{status: "queued", ref: ref})
        {:error, reason} -> JSON.send(conn, 500, %{error: file_error(reason)})
      end
    else
      {:error, message} -> JSON.send(conn, 401, %{error: message})
    end
  end

  defp deploy_status(conn) do
    with :ok <- deploy_auth(conn) do
      last =
        case File.read(result_file(conn)) do
          {:ok, body} ->
            case Jason.decode(body) do
              {:ok, value} -> value
              _ -> nil
            end

          _ ->
            nil
        end

      JSON.send(conn, 200, %{pending: File.exists?(request_file(conn)), last: last})
    else
      {:error, message} -> JSON.send(conn, 401, %{error: message})
    end
  end

  defp android_download(conn) do
    case Enum.find(android_candidates(conn), &File.regular?/1) do
      nil ->
        JSON.send(conn, 404, %{
          error: "Android build is not available",
          hint:
            "Sideload APK is published to the host data volume by deploy; rebuild with npm run android:apk"
        })

      filename ->
        send_download(conn, filename, "cascade-android.apk")
    end
  end

  defp android_update(conn) do
    available = Enum.any?(android_candidates(conn), &File.regular?/1)

    JSON.send(conn, 200, %{
      available: available,
      versionCode: @android_version_code,
      versionName: @android_version_name,
      url: "/download/android"
    })
  end

  defp desktop_download(conn, platform) do
    case @desktop_builds[platform] do
      nil ->
        JSON.send(conn, 404, %{error: "Unknown platform"})

      filename ->
        path = Path.join(downloads_dir(conn), filename)

        if File.regular?(path) do
          send_download(conn, path, filename)
        else
          JSON.send(conn, 404, %{
            error: "#{platform} build is not available yet",
            platform: platform
          })
        end
    end
  end

  defp chooser(conn, title, choices) do
    links =
      Enum.map_join(choices, "", fn {label, href, detail} ->
        ~s(<a href="#{href}"><strong>#{label}</strong><span>#{detail}</span></a>)
      end)

    html =
      ~s|<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>#{title} — Fizzer</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#12100e;color:#f1ede7;font:16px system-ui,sans-serif}.box{width:min(460px,calc(100% - 40px));padding:28px;border:1px solid #3c3328;border-radius:14px;background:#1a1714}h1{margin:0 0 8px;font-size:24px}p{margin:0 0 20px;color:#bcb4aa;line-height:1.45}a{display:block;margin:10px 0;padding:14px;border:1px solid #514432;border-radius:9px;color:inherit;text-decoration:none}a:hover{border-color:#d99a3e;background:#241d15}a span{display:block;margin-top:4px;color:#bcb4aa;font-size:13px}</style></head><body><main class="box"><h1>#{title}</h1><p>Choose the package for this computer.</p>#{links}</main></body></html>|

    conn |> put_resp_content_type("text/html") |> send_resp(200, html)
  end

  defp send_download(conn, path, filename) do
    conn
    |> put_resp_content_type(MIME.from_path(filename))
    |> put_resp_header("content-disposition", ~s(attachment; filename="#{filename}"))
    |> send_file(200, path)
  end

  defp deploy_auth(conn) do
    expected = option(conn, :deploy_secret, &Cascade.Config.deploy_secret!/0)

    supplied =
      case get_req_header(conn, "authorization") do
        ["Bearer " <> token] when token != "" -> token
        _ -> List.first(get_req_header(conn, "x-deploy-token"))
      end

    cond do
      is_nil(supplied) -> {:error, "Deploy token required"}
      byte_size(supplied) != byte_size(expected) -> {:error, "Invalid deploy token"}
      Plug.Crypto.secure_compare(supplied, expected) -> :ok
      true -> {:error, "Invalid deploy token"}
    end
  end

  defp android_candidates(conn) do
    data = data_dir(conn)
    client = client_dir(conn)

    [
      Path.join(client, "cascade-android.apk"),
      Path.join(data, "cascade-android.apk"),
      Path.join([data, "downloads", "cascade-android.apk"]),
      Path.join(downloads_dir(conn), "cascade-android.apk")
    ]
    |> Enum.uniq()
  end

  defp mac_choices do
    [
      {"Apple silicon", "/download/mac-arm64", "M1, M2, M3, M4, and later Macs"},
      {"Intel Mac", "/download/mac-x64", "Intel-based Macs"}
    ]
  end

  defp linux_choices do
    [
      {"Debian / Ubuntu", "/download/linux-deb", "Install the .deb package"},
      {"Fedora / RHEL / openSUSE", "/download/linux-rpm", "Install the .rpm package"}
    ]
  end

  defp request_file(conn) do
    data = data_dir(conn)
    File.mkdir_p!(data)
    Path.join(data, "deploy.request")
  end

  defp result_file(conn), do: Path.join(data_dir(conn), "deploy.result")
  defp data_dir(conn), do: option(conn, :data_dir, &Cascade.Config.data_dir/0)

  defp client_dir(conn),
    do:
      option(conn, :client_dir, fn ->
        Application.fetch_env!(:cascade_elixir, :client_dist_dir)
      end)

  defp downloads_dir(conn) do
    option(conn, :downloads_dir, fn ->
      System.get_env("CASCADE_DOWNLOADS_DIR") || Path.join(data_dir(conn), "downloads")
    end)
  end

  defp option(conn, key, default) do
    case Keyword.get(conn.assigns.domain_options, key) do
      nil -> default.()
      value when is_function(value, 0) -> value.()
      value -> value
    end
  end

  defp clean_ref(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      ref -> ref
    end
  end

  defp clean_ref(_), do: nil
  defp file_error(reason), do: "Could not queue deploy: #{:file.format_error(reason)}"
  defp body(conn, key), do: Map.get(conn.body_params, key)
  defp put_domain_options(%{assigns: %{domain_options: _options}} = conn, _compiled), do: conn
  defp put_domain_options(conn, options), do: assign(conn, :domain_options, options)
end
